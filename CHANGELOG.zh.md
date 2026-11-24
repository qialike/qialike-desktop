# 更新日志

Qialike Desktop 的重要变更，最新在前。**本文件从 0.9.0 开始**——那是源码首次发布在本仓库的版本。

版本号遵循 [SemVer](https://semver.org/)。内嵌的 DeepSeek Harness 尚属开发者预览，在此期间次版本号
升级可能带有破坏性变更——这类变更标记为 `!`。

**每个改动点一行。**

## [0.9.0] - 2026-11-23

### 变更

- **Harness 升到 `0.2.2-rc.5`，CLI 升到 `0.16.0`** —— 鉴权方法反转，一处 base 默认值移动。

### 修复

- **Host 在 rc.5 上能启动** —— `connection.authenticatedUrl()` 回来了。
- **web 搜索固定在按次 API** —— 不跟随模型路由。
