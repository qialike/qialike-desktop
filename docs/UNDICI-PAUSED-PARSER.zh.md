# paused-parser 断言：它是什么，以及 `forwardWebRequest` 的修复方案

[English](UNDICI-PAUSED-PARSER.md) | 中文

**状态**：**已在 0.6.1 实现** —— `forwardWebRequest` 把该读完的 body 读完，把不能读的取消掉。此前
作为热补丁发布、随后进入 0.6.0 的外壳侧止血措施见 §9。

> **§3.1 的初稿错了一件事，这里保留记录而不是悄悄改掉。** 初稿说只有 JSON 需要缓冲，前提是
> 「这是 JSON 的问题」。**不是。** `tests/undici-response-policies.mjs` 第一部分用六种 content-type、
> 32 KiB 的 body 驱动原来的透传策略，**每一种都是 5/5 崩溃**：json、octet-stream、event-stream、
> html、png、docx 一视同仁——parser 并不知道自己搬的是什么。若按 JSON 白名单实现，Office 预览、
> 导出、下载、以及应用自己的图片都会留在崩溃那一侧，而所有只请求 `/api/…` JSON 的测试都会通过。
> 因此发布的规则是**按 `content-length` 的预算**加一个排除项，不是类型白名单；下面 §3.1 / §3.2
> 描述的是代码的实际行为。

**症状**。主进程弹出模态框：

```
A JavaScript error occurred in the main process
Uncaught Exception:
AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:

  assert(!this.paused)

    at Parser.finish (node:internal/deps/undici/undici:7388:9)
    at Socket.onHttpSocketEnd (node:internal/deps/undici/undici:7827:34)
    at Socket.emit (node:events:521:24)
    at endReadableNT (node:internal/streams/readable:1729:12)
```

窗口仍能继续工作，所以这个弹窗是唯一的痕迹。它被反馈为「每个任务结束后弹一次」，这是完全正确的
反应：用户没做任何引起它的事，也没有任何办法能修好它。

---

## 1. 到底哪里错了

`forwardWebRequest`（`apps/desktop/src/web-document.ts`）把每个应用请求都通过 Node 的全局
`fetch`（也就是 undici）转发给 Host，然后把 undici 的响应体原样交给 Chromium：

```ts
return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outgoing })
```

这一行的两个性质——在本文件其它地方都是刻意的——合起来为崩溃上好了膛：

| 要素 | 出处 |
| --- | --- |
| 每个响应之后连接就结束 | `headers.set('connection', 'close')`——是刻意加的，见 web-document.ts:242 的注释 |
| 响应体可以被不读完就丢弃 | 是否读取由 Chromium 决定；一次导航、一个 `AbortController`、一个只想要状态码的调用方、或一个被新请求顶掉的请求，都会把 body 丢掉 |

当一个 body 被丢弃且长度超过 undici 的 pause 阈值时，它的 HTTP parser 会为背压而 **pause**。
接着 `connection: close` 送来了 FIN。undici 的 socket `end` 处理函数调用 `parser.finish()`，
而该函数的第一句就断言 parser **没有** 处于 paused：

```js
// node:internal/deps/undici/undici
function finish() { assert(!this.paused); ... }
```

这个断言是从事件回调里抛出的，所以本仓库里任何 `try`/`catch` 都够不到它。整个 bug 就这一件事
——它是 undici 的 bug，[nodejs/undici#5360][issue]，上游已在 [#5474][pr] 修复，但 **Node 24
和 Electron 44 所带的 undici 里没有**。

[issue]: https://github.com/nodejs/undici/issues/5360
[pr]: https://github.com/nodejs/undici/pull/5474

## 2. 触发窗口不是「大响应」

关于这个 bug 的公开分析把它定位在 64 KiB 以上。**在这台机器上它在 64 KiB 以下**，而这个差异
正是「用尺寸阈值来修」是错的原因。

数据由 `tests/undici-window.mjs` 测得。该脚本随仓库提供，以便在出问题的机器上重新测量：
回环服务器发送 `n` 字节 `application/json` 并带 `connection: close`；客户端 fetch 之后从不读
body；每个尺寸跑五次，每次都在独立子进程里，因为该断言是致命的。

Node **v24.22.0 / undici 7.29.1**，每个响应用一次 `res.end(body)`：

| body | 4 KiB | 8 KiB | 12 KiB | 16 KiB | 24–63.5 KiB | 64 KiB | 65–512 KiB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 崩溃 | 0/5 | 0/5 | 0/5 | **5/5** | **5/5** | 0/5 | 0/5 |

同样的扫描，但把 body 拆成两次写入、中间隔 20 ms：

| body | 4–12 KiB | 16 KiB | 24 KiB | 32 KiB 及以上 |
| --- | --- | --- | --- | --- |
| 崩溃 | 0/5 | **5/5** | **5/5** | 0/5 |

所以触发条件不是一个尺寸，而是三件事同时成立：

1. body 大到超过 undici 的 pause 阈值（这里是约 16 KiB，报告者那边的 Node 24.21 是 64 KiB）；
2. 整个 body 仍然落在 **一次 socket read** 里，于是 FIN 与已 pause 的数据在同一次 read 中到达；
3. 这次 read 在 parser 处于 paused 时被处理。

边界 1 随 undici 版本变化；边界 2 随写入方式、socket 缓冲区和 MTU 变化。**每一条都在本仓库
控制之外。** 因此写成 `if (size > 64 * 1024) buffer()` 的防护，在这台机器上护住的恰好是窗口的
空的那一半，而漏掉真正会触发的那一半。

## 3. 修复

该缓冲的 body 缓冲，该取消的取消，剩下的继续流式转发。

### 3.1 哪些可以缓冲

**实际发布的规则是：声明了 `content-length`、且在预算内的 body 一律读完；唯一例外是事件流。**
类型只决定用哪个预算。

| 响应 | 是否读完 | 原因 |
| --- | --- | --- |
| `application/json`，`content-length` ≤ 8 MiB | **是** | 有限文档。本产品最大的 JSON 是会话记录，远低于此；上限的作用是让单个 handler 无法无界占用进程内存。 |
| 其他类型，`content-length` ≤ 256 KiB | **是** | **实测而非推断**：崩溃与 content-type 无关（见上方状态说明），而触发窗口要求整个 body 在**一次** socket 读里到达，回环上这个量级只有几十 KiB。256 KiB 高于所有危险尺寸、低于所有值得流式的尺寸。 |
| `text/event-stream` | **否** | 唯一绝不能读干的类型：它没有终点，在这里读完会把一条活连接变成一个永不返回的请求。Host 自己的 gzip 过滤器已特判它（`packages/host/webserver/src/index.ts:227`），这是「不能半路动它」的独立证据。 |
| 没有 `content-length`（分块） | **否** | 没有任何东西给缓冲区封顶。实测安全：把 body 分四次写、客户端读一个 chunk 后丢弃，所有策略均 0/5 崩溃。 |
| 超出预算的 body | **否** | 它们跨多次读到达，而多次读的场景即使被丢弃实测也不崩（64 KiB 及以上 0/5）。 |

`application/octet-stream`、`multipart/form-data`、`image/*` **不再被排除**：那是方案初稿的规则，
已被实测推翻。它们只是「小的时候才读」。

### 3.2 改动

在 `web-document.ts` 中，与其他头部常量放在一起：

```ts
/** 唯一一个绝不能在这里读完的 content type。 */
const STREAMED_CONTENT_TYPE = /^text\/event-stream\b/iu

/** 有限 JSON 文档的类型；对应 MAX_BUFFERED_JSON_BYTES。 */
const JSON_CONTENT_TYPE = /^(?:application|text)\/(?:[\w.+-]+\+)?json\b/iu

const MAX_BUFFERED_JSON_BYTES = 8 * 1024 * 1024    // 会话记录是本产品最大的 JSON
const MAX_BUFFERED_OTHER_BYTES = 256 * 1024        // 高于所有「一次读完」的危险尺寸
```

以及 `forwardWebRequest` 的尾部：

```ts
  const contentType = response.headers.get('content-type') ?? ''
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  const budget = JSON_CONTENT_TYPE.test(contentType) ? MAX_BUFFERED_JSON_BYTES : MAX_BUFFERED_OTHER_BYTES
  const drain = response.body !== null
    && !STREAMED_CONTENT_TYPE.test(contentType)
    && Number.isFinite(declared)
    && declared <= budget

  if (!drain) {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outgoing })
  }

  let body: ArrayBuffer
  try {
    body = await response.arrayBuffer()
  } catch (error) {
    // 读失败同样能把上游留在「已暂停」状态，而 socket 正在关闭——同一条崩溃的另一条路径。
    await response.body?.cancel().catch(() => {})
    throw error
  }

  outgoing.set('content-length', String(body.byteLength))
  return new Response(body, { status: response.status, statusText: response.statusText, headers: outgoing })
```

回填的 `content-length` 是 Chromium 真正会读的长度，而不是 Host 发来的压缩长度——这正是它被
**替换**而不是被转发的原因。

同一文件里的 `authenticateWebHost` 早就是这么做的，是本次遵循的先例——它一个字节都不保留：

```ts
await response.body?.cancel()   // web-document.ts:179
```
### 3.3 已有的错误路径

`installProtocolHandler`（`main.ts`）用 `try`/`catch` 包住 `forwardWebRequest`，并在出错时返回
一个 502 JSON 响应。那里什么都不用改：由于 body 在构造 `Response` 之前就已经读干，能走到
`catch` 的唯一情况，是一个从未产出 body 的 `fetch`。

## 4. 代价

| | 改动前 | 改动后 |
| --- | --- | --- |
| JSON 响应 | 流式交给 Chromium | 主进程中多一次拷贝 |
| JSON 的首字节时间 | 立即 | 读完 body 之后（回环上 32 KiB 约 1 ms） |
| 事件流、下载、上传 | 流式 | 不变 |
| 峰值内存 | 每个在途请求一个 body | 相同，但由 body 预算封顶，且在 `Response` 被回收时立即释放 |

这次拷贝正是重点：由 `ArrayBuffer` 构造的 `Response` 背后没有 socket，因此没有任何东西可以被
pause。

## 5. 为什么不用另外两个选项

**用 keep-alive 取代 `connection: close`。** 这会移除「每个响应之后必有 FIN」这个让崩溃可达的
条件——同时把现有注释里详细测量过的 60 秒挂起重新引进来（web-document.ts:242）。FIN 不是 bug；
丢弃 body 才是。

**换更新的 undici / Node。** 方向正确，也值得按自己的节奏去做，但它救不了今天的安装：Electron
44 自带 Node 24.18.1 / undici 7.29.0，而「钉死到另一个 Electron 补丁版本」正是 [#5360][issue]
针对 Node 明确警告过的那种推理。

**全局 `uncaughtException` 处理器。** 作为止血措施是必要的（§9），作为修复是不充分的：它挡住
弹窗，但挡不住被丢掉的请求。两者都应该存在——处理器应对下一个未知，排空应对这一个已知。

## 6. 如何证明

### 6.1 单元层（`tests/shell-web-document.test.mjs`，新增 7 条）

这些用例用假 `fetch` 驱动 `forwardWebRequest`，这正是「外壳到底读了哪些 body」该断言的那一层。
它们断言不了崩溃本身，因为「通过」等于「没死」。

| 用例 | 断言 |
| --- | --- |
| JSON，32 KiB | body 逐字节读回，**并且响应可以被 clone 后再次读完**——这是 `ArrayBuffer` body 才有的性质，活流产做不到 |
| 读干之后的 `content-length` | 等于解码后的字节长度，而不是上游那个压缩长度 |
| `application/octet-stream`，64 KiB | 按较小的预算读干；content-type 不能豁免一个 body |
| `text/event-stream` | 不读干：长度仍然缺失，且第一个分块在上游关闭之前就到达 |
| 分块 JSON（无 `content-length`） | 不读干；body 仍然读得对 |
| JSON 声明 `8 MiB + 1` | 不读干 |
| 在 body 中途断开的接口 | 以**上游的错误**抛出，而不是以清理过程的错误抛出 |

### 6.2 进程层（`tests/undici-response-policies.mjs`）

每种策略各跑在自己的 Node 子进程里：它发出 body、fetch 下来、按 `forwardWebRequest` 的方式
转发，然后让转发出去的 `Response` 被丢弃。今天在这台机器上测得（Node 24.22.0 / undici 7.29.1，
32 KiB body，各五次）——**正是这次运行推翻了 JSON 白名单**：

**第一部分：崩溃与 content-type 无关**（passthrough 策略）

| 类型 | 崩溃 |
| --- | --- |
| `application/json` | 5/5 |
| `application/octet-stream` | 5/5 |
| `text/event-stream` | 5/5 |
| `text/html` | 5/5 |
| `image/png` | 5/5 |
| `…wordprocessingml.document` | 5/5 |

**第二部分：什么能修好它——用的是白名单会漏掉的非 JSON body**

| 策略 | 崩溃 | 存活 |
| --- | --- | --- |
| `new Response(response.body, …)`——外壳原来的做法 | **5/5** | 0/5 |
| `await response.body.cancel()` 后 `new Response(null, …)` | 0/5 | 5/5 |
| `await response.arrayBuffer()` 后 `new Response(bytes, …)` | 0/5 | 5/5 |
| 先建 passthrough，再取消转发出去的 body | 0/5 | 5/5 |
| 交出一个自有 `ReadableStream`，其 `cancel` 释放上游 | 0/5 | 5/5 |

五种里有三种安全，所以**读干并不是唯一出路**——但它是唯一一种连 socket 都一并消除的做法，这也是
发布它的原因。

如果 passthrough 对照组 **不再** 崩溃，脚本会失败——因为一个不再复现该 bug 的对照组，是一个
已经不再测试任何东西的脚手架。这里第一次测量用的是 80 KiB body，结果存活了：一个错的尺寸看起来
和「修好了」一模一样，这正是对照组必须被断言、而不能被假定成立的原因。

### 6.3 用第三种方式量那个窗口

把 body 分四次、每次 8 KiB 写，客户端只读一个分块然后丢弃：**passthrough 0/5、owned-stream 0/5、
buffered 0/5**。崩溃要求整个 body 在一次读里到达，所以多次读这条路径本来就不危险——这正是非 JSON
用 256 KiB 预算是「安全」而不是「顺手」的理由。

### 6.4 之后看什么

主进程日志（`$DSH_HOME/qialike-desktop.log`）一直在收到来自 §9 处理器的
`main process: uncaught exception (undici-paused-parser)` 条目——**2026-11-02 到 2026-11-07 之间
共 6 条**，这正是发现本修复所补缺口的经过。本修复落地之后，这些条目应当停止出现。如果有一条出现在
**已读干** 的路由上，说明预算写错了，那行日志就是证据——但它不会说明是哪条路由，这是本次没有补上的
唯一诊断缺口：守卫看到的是栈，不是 URL。所以第二次出现时，应当先给条目加上路径，而不是凭猜测放宽预算。
## 7. 风险

- **某个 JSON 接口其实是隐藏的流。** 白名单假定不存在这种东西。这一点已核查过（运行时里
  任何地方都不出现 `x-ndjson` 和 `jsonl`），但将来可能有人新增一个，症状是请求永不返回。
  缓解措施：`text/event-stream` 的单元用例把预期契约写了下来，且新的流式接口不得以
  `application/json` 提供服务。
- **内存。** 由每个在途请求的 `MAX_BUFFERED_JSON_BYTES` / `MAX_BUFFERED_OTHER_BYTES` 封顶。N 个并发请求时最坏为 N × 8 MiB。
  Host 已经把这类工作的大部分串行化了，所以 N 很小；若这一点不再成立，请调低上限，而不是
  去掉它。
- **延迟。** renderer 看到第一个字节之前要完整读一次 body。在回环上，涉及的量级是亚毫秒；
  对很长的会话记录则不是免费的——这正是设置上限的原因。

## 8. 检查清单

- [x] `STREAMED_CONTENT_TYPE`、`JSON_CONTENT_TYPE`、`MAX_BUFFERED_JSON_BYTES`、`MAX_BUFFERED_OTHER_BYTES` 连同注释一起加入——**取代**初稿那条单一 JSON 白名单，因为 §6.2 的扫描证明崩溃与类型无关
- [x] `forwardWebRequest` 读干该读的、失败时取消、恢复 `content-length`
- [x] §6.1 的单元用例，包括那些 **必须不** 被读干的用例
- [x] `undici-response-policies.mjs` 扩展：content-type 扫描与四种非 passthrough 策略成为永久对照组
- [x] `typecheck` 与 `vitest run` 干净（§10 列出的四个既存失败除外）
- [ ] 手工跑一个打包构建：打开会话、执行任务、并在流中途导航离开——然后 `Select-String -Path ~\.dsh\qialike-desktop.log -Pattern 'undici-paused-parser'` 应当没有输出

## 9. 先于本修复发布的部分

`apps/desktop/src/main-crash-guard.ts` 加上 `main.ts` 里的 20 行。它增加了 **一个**
`uncaughtException` 监听器，而这正是 Electron 自己的处理器在弹出对话框之前所检查的条件
（`listenerCount('uncaughtException') > 1`），因此对话框不再出现；失败改写入
`qialike-desktop.log`，带运行时版本和一句说明它意味着什么的话。

它最初是一个**替换已安装 `app.asar` 的热补丁**——用 PowerShell 脚本把两个编译产物
（`lib/main.js`、`lib/main-crash-guard.js`）嫁接进归档，脚本会留备份、也能回滚。对「5 天 6 次」
来说那是对的工具，但不是一个该长期待着的地方：升级会覆盖它，它无法被审查，而且它让 0.6.0 在
流通中留下了三份不同的拷贝。从 0.6.0 起它是普通源码，热补丁包因此退役。

它没有修掉丢请求这件事——那正是 §3，而**证明它仍然必要的，就是日志本身**：在守卫已安装、弹窗
不再出现的那些天里，日志里仍有 **6 条 `undici-paused-parser`**（2026-11-02 至 2026-11-07）。
把症状静音，是可以被测量为「症状仍在发生」的。

已在真实的 Electron 44 进程中验证（`tests/crash-guard-probe.mjs`）：不加时 1 个监听器，
加后 2 个；前者出现对话框，后者不出现；日志条目能命名 `undici-paused-parser`。

本文档依赖的三个脚手架，都可按现状运行：

```powershell
node tests/undici-response-policies.mjs   # 策略 A/B 与类型扫描，约 2 分钟
node tests/undici-window.mjs              # 尺寸扫描，约 2 分钟
node tests/crash-guard-probe.mjs          # Electron A/B，需要一个 Electron 二进制
```
## 10. 本来就已经失败的测试

四个测试套件在干净的 `e3daddb` 检出上就失败，早于上述任何改动：

```
tests/office-engine-install.test.mjs   3 failures
tests/release-config.test.mjs          1 failure
tests/running-instance.test.mjs        3 failures
tests/shell-packaging.test.mjs         5 failures   (EPERM on symlink creation under Windows)
```

已通过 stash 掉 crash-guard 相关改动并重跑，确认它们保持不变。它们不是本方案造成的，
在核对上面的检查清单时也不应与本方案混为一谈。
