# qialike desktop

[English](README.md) | 中文

[qialike](https://github.com/qialike/qialike) 的桌面应用，基于
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 构建。

**它与 qialike CLI 共用同一个 home。** 会话、凭据、provider 配置与配色方案都是同一批文件，所以你在
终端里开的会话会出现在这里，而这里配的 provider 就是终端在用的那个。

## 安装

**支持的目标是 Linux x86-64 与 Windows x86-64。** 每个目标必须在自己的平台上构建——原生组件无法
跨平台产出——所以一次发布会为每个平台各带一个安装包。

```sh
# Linux
chmod +x qialike-desktop-linux-*.AppImage
./qialike-desktop-linux-*.AppImage

sudo dpkg -i qialike-desktop-linux-*.deb     # 或安装 deb 包

# Windows
qialike-desktop-win-x64.exe                  # 按用户安装，不需要管理员权限
```

| | |
|---|---|
| **AppImage** | 自包含，约 232 MB。需要 **libfuse2**；没有它就用 `./qialike-desktop-linux-*.AppImage --appimage-extract-and-run`。 |
| **deb** | 约 173 MB，面向 **Debian 系**发行版。可执行文件名是 `qialike`。 |
| **Windows 安装包** | NSIS，约 204 MB，按用户安装。可执行文件名是 `qialike-desktop`。除非发布说明写明，否则**未签名**，首次运行会被 SmartScreen 拦一下。 |
| **glibc** | **≥ 2.28**（Ubuntu 20.04 及以上）。不支持 musl 系发行版。 |
| **架构** | **仅 x86-64。** arm64 不在目标内，因此会被**明确拒绝**而不是尝试。 |
| **macOS** | **未构建。** 原生组件无法跨平台产出，所以每个目标必须在自己的平台上构建。 |

用随产物一起发布的 `SHA256SUMS` 校验下载：

```sh
sha256sum -c SHA256SUMS
```

从[发布页](https://github.com/qialike/qialike-desktop/releases/latest)或其 GitCode 镜像下载最新产物。
每次发布都带安装包、上面的 `SHA256SUMS`，以及 `latest*.yml` 更新清单。

## 首次运行

应用会打开一个欢迎页，询问模型 provider 与 API key。密钥存放在 `~/.dsh/.credentials.yaml`——
**正是 CLI 读的同一个文件**，所以在任意一边配置就等于两边都配好了。

欢迎页由那份凭据存储驱动，而不是由一个"已看过"的标志：

- 先在 CLI 里配好密钥，这里就**不会出现**该页面；
- 清空凭据存储，它就**会重新出现**——因为对本应用来说，那就等于什么都没配。

这些以后都可以在 **设置 → Providers** 里再改：增删改停用路由，以及从 provider 自身发现新模型。

## 与 CLI 共享什么

| 路径 | 是否共享 | 说明 |
|---|---|---|
| `~/.dsh/sessions/` | **共享** | 会话语料。任一边开的会话，另一边都能打开。 |
| `~/.dsh/storages/` | **共享** | workspace 注册表与会话投影。 |
| `~/.dsh/.credentials.yaml` | **共享** | API key 与授权。 |
| `~/.dsh/qialike.json`、`~/.dsh/themes/` | **共享** | provider 路由、配色方案、你自己的方案。 |
| `~/.dsh/profiles/qialike-desktop/` | 独占 | 只有可执行状态：包集、lockfile、补丁层。 |
| harness 设置（按 profile） | 独占 | **不共享。** 在这里改的设置不会出现在 CLI 里，反之亦然。 |

`$DSH_HOME` 可以改变这个共享 home 的位置，默认是 `~/.dsh`。

## 使用

**右侧栏。** 会话 workspace 的文件树、文档预览（Markdown、代码、纯文本、PDF、图片、表格、Word 与
PowerPoint）以及一个终端。**文件变化时预览会自行重载**——包括被本应用之外的程序改动时。

**跟随被编辑的文件**（默认开启，在 **设置 → 通用**）会把该预览切到 agent 正在编辑的文件。三条规则
保证它不会夺走整个窗口，而它们**不是可选项**：

- **右侧栏收起时绝不切换**——打开预览会同时展开侧栏，那会重排一个你并没在看的窗口；
- **你一旦自己打开别的文件就停止**，下一轮、或把开关关了再开，就会恢复；
- **子代理只报告，不跟随。** 子代理在自己的会话里干活，就在你视线的背后，所以由会话头部点名
  **哪个子代理**改了**哪个文件**，并提供 **「查看」**跳过去、**「忽略」**不予理会。子代理重写三十个
  文件也只留一行，且**同时最多三行**。

一步之内改动超过三个文件时也不切换：那时并不存在单一的"正在编辑的文件"，随便挑一个只是把猜测包装成
功能。关掉这个开关即可全部停用。

**配色方案。** **设置 → 通用 → 主题**提供 CLI 的十五套方案——十三个 classic 皮肤，加上 Atom One Light
与 One Dark——以及 harness 自带的两套。把你自己的 `{ "name": …, "palette": … }` 文件放进
`~/.dsh/themes/`，它就会出现在列表里。选择会写进 `qialike.json`，所以终端里的 `/theme dracula` 与
这里点一下是同一个动作。

**语言。** **设置 → 通用 → 语言**在英文与中文之间切换，本应用新增的行会跟着一起翻译。

**权限。** 新会话以 **Workspace Write** 开始，审批为**逐次询问**。两者都可以在输入框那里按会话修改；
审批提示会说明请求的是什么、由谁请求。

**Session log 上传。** **设置 → 通用 →「在使用官方模型 API 时上传 Session Log」**默认开启，而且在它
变成一个开关之前就是开启的——这个开关的意义就是**可以关掉**。日常使用不会上传任何东西；只有你在应用内
**发送反馈**时才会释放该日志。

**更新。** 如果构建时配置了更新源，应用会检查更新并显示状态徽标。没有更新源时——自己构建的正常情况
——启动时只打一行日志，徽标不打扰你。窗口只会拿到阶段、版本与进度，**拿不到更新源地址**，也没有自行
开始安装的权限。

## 排障

**窗口还在，但什么都动不了。** 后端是一个子进程，它死掉时窗口可能活着。崩溃会写一份报告到
`~/.config/@qialike/desktop/crashes/host-<时间>.txt`（权限 0600，因为它含路径与后端打印的内容），并弹出一个
对话框指出该路径，提供退出或重启。文件写在对话框**之前**，所以即使你不看直接点掉，它也还在。正常
退出不会产生这个文件。（该目录名取自包名，所以它**真的**是 `@qialike/desktop`——不是写错了。）

**看日志。** 没有日志文件：应用写到标准输出。想看就从终端启动：

```sh
./qialike-desktop-linux-*.AppImage               # 或：qialike
```

`qialike desktop: no update feed configured; update checks are disabled` 对没有更新源的构建是正常的。
出现关于**被拒绝的 WebSocket 握手**的行，说明外壳拒绝认证某个连接并指出了它的 origin；那行日志存在
的理由正是：这个失败在其它任何方向上都不可见。

**第二次启动不了。** 应用运行期间 profile 是被锁住的。如果上一次实例是被强杀而不是正常退出，那道锁
就会拒绝下一次启动——正常退出它，或删掉 `~/.dsh/profiles/qialike-desktop/` 下的陈旧锁。日志里会写明
是哪个实例占着锁。

**截图工具或第二块屏幕访问不到这个窗口。** 界面通过一个私有应用 scheme 提供，而不是本地 HTTP 端口，
这是刻意的：机器上其它东西都连不上这个后端。

## 未验证的部分

照实列出，因为只列成功项的用户指南是更差的指南：

- **观感。** 对比度是算出来并断言的；结果**好不好看**没有验证，本项目也不声称。
- **应用更新。** 下载与校验端到端验证过；**安装**会替换正在运行的文件并重启它，既毁掉观察者又不可逆，
  请当作未验证。
- **真实崩溃时的对话框。** 报告格式与观察者都针对真实子进程测过；对话框没有被一次真实的后端死亡
  产生过。
- **macOS。** 未构建。配置完整，且构建策略拒绝在它自己的平台之外产出。
- **已签名的 Windows 构建。** 除非提供签名材料，否则 Windows 安装包是未签名的，首次运行要手动
  越过 SmartScreen。
- **arm64。** 不在目标内。

## 问题与贡献

- **报告问题 / 请求功能**：[GitHub Issues](https://github.com/qialike/qialike-desktop/issues)。
- **报告漏洞**：**不要**开公开 issue——看 [SECURITY.md](SECURITY.zh.md)，那里有私有渠道、范围，以及哪些行为属于刻意设计。
- **贡献**：看 [CONTRIBUTING.md](CONTRIBUTING.zh.md)——两个只读上游 checkout、构建顺序、CI 在全新克隆上跑哪些测试，以及补丁层。
- **看改了什么**：[CHANGELOG.md](CHANGELOG.zh.md)；更早的版本在[发布页](https://github.com/qialike/qialike-desktop/releases)。
- **行为准则**：参与本项目即适用 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.zh.md)。

## 文档

| 文档 | 是什么 |
|---|---|
| [`README.md`](README.md) / `README.zh.md` | **本文件**——用户使用指南，英文与中文两版 |
| [`CHANGELOG.md`](CHANGELOG.md) / [`CHANGELOG.zh.md`](CHANGELOG.zh.md) | 每个版本改了什么，最新在前 |
| [`SECURITY.md`](SECURITY.zh.md) | 如何报告漏洞，以及哪些行为属于刻意设计 |
| [`CONTRIBUTING.md`](CONTRIBUTING.zh.md) | 从源码构建、测试与发布工具，以及补丁层 |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.zh.md) | 参与本项目的行为期望 |
| [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) | 本应用直接引入的第三方包 |

## 致谢

qialike desktop 基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建，并组
合了 [qialike CLI](https://github.com/qialike/qialike)，而不是重新实现它已经做好的部分。qialike 是
独立的社区项目，与深度求索不存在隶属、合作、授权或背书关系。"DeepSeek Harness" 是深度求索公司的注册
商标，此处仅用于准确说明技术来源及与上游软件的关系。

## 许可证

[MIT](LICENSE)

**名称与字标不在许可证授权范围内**：MIT 授予的使用、修改与再分发权利只覆盖**软件本身**，不包含对
`qialike` 名称或字标的任何授权——它们仅用于标识本项目。再分发或修改代码时，请勿暗示官方背书或合作。

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
