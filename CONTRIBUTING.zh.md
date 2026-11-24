# 参与贡献

[English](CONTRIBUTING.md) | 中文

本仓库是**qialike 桌面应用**：一个 基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建的
桌面端智能体。
以 [MIT](LICENSE) 许可发布。
支持系统：Linux、Windows,任意模型、插件化设计。
**使用者不需要自己构建**——按 [README.md](README.zh.md) 的说明安装发布出来的 AppImage、deb 或 Windows
安装包即可。

## 动手之前

**本仓库是三个仓库之一，而且它可以往另外两个里写东西吗——不可以。** 本应用由两个上游 checkout——
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与 qialike CLI——组装而成，两者都是
**只读输入**。本仓库想在它们里面做的任何改动，都在构建时以**补丁**的形式应用到 `.farm/` 下的一份副本上
（见下文「补丁层」）。往任一 checkout 里写，无论本地多方便，都是缺陷。

**有两份指南不在本仓库里**，而在它旁边的 `docs/desktop/`，因为它们记录的是被否决的方案与被取代的决策
——那不是一份代码 checkout 应该携带的东西：

| 文档 | 负责什么 |
|---|---|
| `../docs/desktop/DESIGN.md` | 为什么本应用是在 harness 浏览器界面上叠加一层而不是重写，以及 CLI 的哪些部分被复用、哪些被重新实现 |
| `../docs/desktop/qialike-desktop-dev.md` | 各平台的构建、打包与发布，发布脚本，工程说明，以及各项取舍背后的测量数据 |

## 构建

前置条件：

- **Node.js `^22.19.0 || >=24.0.0`** 与 **pnpm `11.28.5`**（后者由 `packageManager` 锁定）。Node 的下限
  来自 harness 自身。
- **两个上游 checkout，且都已经构建过。** 构建会读取它们各自的产物，缺了就失败：先在 harness checkout
  里跑 `pnpm install && pnpm build`，CLI 也要构建过。
- 两者都必须落在本仓库强制的版本范围里。**该范围的唯一来源是
  `apps/desktop-bin/lib/harness-version.mjs`**——`HARNESS_VERSION_MIN`、`HARNESS_VERSION_MAX`，以及紧挨
  着的 CLI 自己的上限。请去那里读，不要相信任何文档里写的数字，包括本文；并且只在针对新版本验证过之后
  才抬高它。

两个 checkout 的定位顺序如下，且**永不往它们里面写**：

| checkout | 环境变量 | 默认 |
|---|---|---|
| DeepSeek Harness | `DSH_HARNESS` | `../deepseek-harness` |
| qialike CLI | `DSH_QIALIKE` | `../qialike`，再退到 `~/deepseek/qialike` |

`apps/desktop-bin/lib/paths.mjs` 才是契约——去读它，不要凭记忆复述那条链；并注意**空值**变量等同于
"未设置"。

```sh
pnpm install
cp .env.example .env.local  # 可选：checkout、store、更新源与签名设置
pnpm run build:packages   # 编译 bundle、provider 行、Host 与外壳
pnpm run build            # 组装农场（.farm/）与运行时树（dist/runtime/dsh）
pnpm run gates            # 三个构建门禁
pnpm test
pnpm run typecheck
pnpm run package:linux    # AppImage + deb 输出到 dist/packages/（其它平台是 package:mac / package:win）
```

**没有任何东西会自动读取 `.env.local`**——把它载入 shell（`set -a; . ./.env.local; set +a`）或直接
export 变量。`.env.example` 写明了每个变量及其默认值；第一次构建真正相关的只有 `DSH_HARNESS` 与
`DSH_QIALIKE`，而且只有在这两个 checkout 不是本仓库的同级目录时才需要设。

**`pnpm install` 与 `pnpm run build:packages` 不需要任何上游 checkout。** 从 `pnpm run build` 起才需要，
这也正是 CI 划的那条线：它可以编译并类型检查一份全新克隆，然后跑只读本仓库的那部分测试套件。

**农场是一份副本**，而 `pnpm run build` 会**替换 `dist/runtime/dsh`**——若重建时应用正开着，重建会打断它。

**打包按平台进行，且拒绝在别的平台上跑**，因为原生组件无法跨平台产出：在非 macOS 上跑 `package:mac`
是被策略拒绝的，不是碰巧失败。

## 测试与检查

| 命令 | 作用 |
|---|---|
| `pnpm test` | 完整测试套件——单元与集成，由 vitest 运行；需要两个 checkout 都已构建 |
| `pnpm run test:hygiene` | 不需要任何 checkout 的那部分套件——CI 跑的就是它 |
| `pnpm run typecheck` | 对整个工作区做类型检查 |
| `pnpm run gates` | 三个构建门禁：共享 UI 没有被 fork、profile 包完整、运行时树确实是它声称的那棵树 |
| `pnpm run test:boot` | 单独跑 profile 启动路径 |

门禁值得理解而不是当成走过场：一棵组装出来的运行时树能出错的方式，恰好就是那些**看起来仍然正常**的方式。

**CI 跑 `pnpm run typecheck` 与 `pnpm run test:hygiene`**（`.github/workflows/ci.yml`），两者在
`pnpm install` 与 `pnpm run build:packages` 之后都能从一份全新克隆复现。`test:hygiene` 排除的是那些要读
checkout、或要读由 checkout 生成的文件的套件；`vitest.hygiene.config.mjs` 逐个列出并说明原因。远端门禁
就这么多——补丁锚点、主题令牌、农场、组装出来的运行时树，以及任何需要打包产物的东西，**都不在那里检查**。

进一步的验证——发布链，以及需要真实窗口的探针——由**本仓库之外**的脚本驱动，在它旁边的
`scripts/desktop/` 里。它们有意不进版本控制：那是本机的工具，不是产品。开发文档记录了它们，包括哪些探针
已经被测试套件覆盖。

## 补丁层

本仓库对上游 checkout 做的所有改动，都由 `apps/desktop-bin/lib/apply-patches.mjs` 应用到**农场副本**上，
**永不**应用到 checkout。目前有七个补丁，来自两处：

- **两个是 CLI 自己的**，从它的 `apps/tui-bin/harness-patches/` 按路径 import，好让两个产品以完全相同的
  方式修改共享引擎，而不是各自留一份会漂移的拷贝。它们是关于受限 token 可触范围、以及由该范围生成的那句
  提示语的安全相关的一对，**必须一起应用**：后者用一次对前者的活调用来生成那句话。
- **五个写在本仓库**：Windows 可写根收窄、应用 scheme、品牌标题、hero 标题，以及会话列表对齐。

**权威的计数与清单是那个模块里的 `applied[...]` 赋值，不是这一段**——那个模块自己的注释早前写着"five"，
错了两个补丁的时间。锚点移位的补丁会让**构建失败**，而不是悄悄放行一个没打上补丁的边界；这正是把它放在
这里而不是手工做的意义。

## 贡献方式

- **许可**：贡献按覆盖本仓库的 [MIT](LICENSE) 许可接受（inbound = outbound）。提交 pull request 即表示你
  确认有权按该条款提交这份工作；没有单独的 CLA 要签。
- **安全**：**不要**为安全漏洞开公开 issue——见 [SECURITY.md](SECURITY.zh.md)。
- **提交信息**：Conventional Commits——`type(scope): subject`，破坏性变更在 type 或 scope 后加 `!`。让每个
  改动可以独立审阅。
- **依赖**：如果你新增了依赖，请在同一个改动里把它加进
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。没有任何东西强制那个文件，所以也没有任何东西会提醒你。
- **用户可见的改动**：在 `CHANGELOG.md` **和** `CHANGELOG.zh.md` 各加一行。两个语言列出的改动点数量必须
  相同，且 `tests/changelog-format.test.mjs` 会约束最新一节的格式——一行一条、改动点加粗在前、不带提交号。

## 仓库布局

```
apps/desktop/           Electron 外壳：main、preload、应用 scheme、窗口
apps/desktop-host/      外壳启动并监管的 Host 进程
apps/desktop-bin/       工具：构建、打包、门禁、探针，以及路径/版本契约
apps/desktop-web/       被服务页面里属于我们的那一半：文档、样式表、品牌资产
packages/qialike-desktop-app/          那个 bundle：叠加在 dsh-base + dsh-web-app 之上
packages/qialike-desktop-providers/    provider 行与设置页
packages/qialike-desktop-brand/        标记、字标，以及它们占据的席位
packages/qialike-desktop-policy/       被编译进来的 CLI policy 模块
packages/qialike-desktop-theme/        配色方案
packages/qialike-desktop-edit-follow/  跟随被编辑的文件
tests/                  测试套件，由 `pnpm test` 运行
docs/                   关于上游、而其自身 checkout 未记录的笔记
```

这是地图，不是清单：哪些包存在由 `pnpm-workspace.yaml` 决定。
