# 更新日志

本项目的所有重要变更都会记录在本文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0-rc1] - 2026-09-13 (build 260913)

首个候选发布（rc）版本。**本版本舍弃 Electron 运行时**：浏览器主程序改为原生 C++ 可执行文件，
直接链接 CEF（Chromium Embedded Framework），即真正的 Chromium 内核；
AI / 存储 / 自动化改由可选的 Node 边车进程承载。

### 新增

1. **完全 Chromium 内核** —— 主程序直接链接 CEF 150（Chromium 150），多进程宿主与 renderer 沙箱来自 Chromium 本体。
2. **Edge / Chrome 全量能力 + UI 大更新** —— 对齐 Edge / Chrome 的日常浏览能力，并配套一次整体 UI 翻新。
3. **Microsoft / Google 账户登录与同步** —— 新增账户登录、同步状态查询与手动同步（`tib.signIn` / `tib.getSyncState` / `tib.syncNow`）。
4. **无痕模式 2.0 / 指纹可改** —— 独立 `RequestContext` 不落盘，新增指纹画像调整与一键随机化，能力接近指纹浏览器。
5. **安全浏览三档** —— 增强型防护 / 标准防护 / 不防护，三档行为与云端请求范围在界面中完整说明。
6. **不安全安装包可保留 + turtlelnc 内容自动放行** —— 可疑下载可保留而非直接删除；`github.com/turtlelnc/*`、`*.turtlelnc.*`、官网及已签名发布物在任何档位下不拦截、不警告、不计入威胁统计。
7. **生成网页应用** —— 任意网站可安装为独立网页应用（`tib.installWebApp` / `launchWebApp` / `uninstallWebApp`）。
8. **TiBrowser / Edge / Chrome 皮肤切换** —— 一套外壳三套皮肤，切换即生效。
9. **AI 连接支持 API / MCP / OAuth(SDK)** —— OpenAI 兼容 API、MCP 客户端、OAuth(SDK) 登录三种接入方式并存。
10. **整合各浏览器优点** —— 整合 Chrome 的兼容与性能、Edge 的侧边栏与效率、以及国内浏览器的实用细节。
11. **一个浏览器解决所有事** —— 浏览、AI 对话与智能体、安全防护、办公/开发模式、网页应用、账户同步收敛到同一外壳。
12. **AI 侧本地办公模式与本地开发模式** —— 本地办公模式（WorkBuddy 能力）与本地开发模式（Tare / codex 能力）。
13. **能效四档** —— 标准 / 快速 / 低占用 / 即开即用；「即开即用」档不启动 AI 边车，AI 能力降级并明确提示。
14. **Apple 风格 UI 优化** —— 按 Apple 设计语言重做视觉、留白、圆角与动效。
15. **面向用户自有 AI 工具 / CLI / harness 的本地控制接口** —— 边车暴露本地自动化 API（`tib.automationInfo()` 返回 `baseUrl` 与一次性 token）。

### 变更

- **运行时架构更换**：Electron 主进程 → 原生 C++ + CEF 浏览器宿主；AI / 存储 / 自动化迁移至可选的 Node 边车进程（独立进程、可关闭，通过本机 HTTP + SSE 通信）。
- **数据目录更换**：用户数据目录随新内核调整，与 v0.1.0 / 1.0.0-beta 互不覆盖（详见「已知问题」与 `release/README.md` 的升级说明）。
- **UI 技术栈**：外壳 UI 改为通过 `tib://ui` 加载的 React 18 应用，经 `window.tib` 桥与原生通信。
- **版本元数据**：`package.json` 版本由 `1.0.0-beta` 升为 `1.0.0-rc1`；`package-lock.json` 根版本同步为 `1.0.0-rc1`。
- **构建脚本**：新增 `ui:dev` / `ui:build` / `service:build` / `service:test` / `native:configure` / `native:build` / `native:run` / `fetch:cef`（原有 Electron 相关脚本保留未动）。
- 文档：`README.md` 与 `release/README.md` 按 rc1 重写，接口契约集中在 `docs/ARCHITECTURE.md`。

### 移除

- **移除 Electron 运行时**：不再以 Electron 作为浏览器宿主，安装包不再内嵌 Electron 运行时。
- 旧的基于 Electron 的浏览器实现退役，代码保留在 `src/legacy-electron/`，**仅作只读参考**，不参与 rc1 构建。
- 旧的 `ELECTRON_MIRROR` 类内核镜像配置不再需要（CEF 由 `scripts/fetch-cef.mjs` 从 `cef-builds.spotifycdn.com` 获取）。

### 修复

- **`package-lock.json` 版本字段污染**：`node_modules/is-unicode-supported` 与 `node_modules/yocto-queue` 两个条目的 `version` 字段被错误写成项目版本 `1.0.0-beta`，与各自 `resolved` 指向的 tarball 及 `integrity` 不一致；现按 `resolved` URL 与 integrity 哈希校正为实际上游版本（均为 `0.1.0`，与依赖方声明的 `^0.1.0` 区间一致）。
- **许可证不一致**：仓库 `LICENSE` 为 GPL-3.0，但 `package.json` 与 `package-lock.json` 根条目声明为 MIT；现统一为 `GPL-3.0-only`。
- **扩展启用 / 禁用缺失**：补齐扩展启用与禁用能力（`tib.setExtensionEnabled(id, on)`）。
- **对话历史持久化**：修复 AI 对话历史未能持久化的问题，重启后可恢复会话记录。
- **原子写回归**：修复设置 / 数据落盘的原子写回归问题，避免异常中断导致配置文件损坏。

### 已知问题

- 发布通道为 **rc**，稳定性仍在收敛，**可能崩溃**，请勿用于重要场合。
- 本地黑名单为**样例数据**，未接入真实、及时更新的威胁情报源。
- **增强型防护中依赖 Google 云端的能力在本地不可用**，界面会明确标注，不会假装生效。
- 账户同步需用户**自备 OAuth client id**，云端同步能力**尚不完整**。
- 扩展兼容性仍受 Chromium 嵌入方案限制，部分扩展无法完整运行。
- **安装包未做代码签名**，Windows SmartScreen 会提示未知发布者。
- **Linux / macOS 产物需在对应系统或 CI 上构建**，无法在 Windows 上交叉打包。
- **v0.1.0 / 1.0.0-beta 与 1.0.0-rc1 数据不互通**：内核与数据目录均已更换，旧配置不会自动迁移；`.tbuser` 导入仅迁移书签 / 历史 / 设置。
- 本版本未提供任何性能或兼容性基准数据。

[1.0.0-rc1]: https://github.com/turtlelnc/Turtle.AI-Browser/releases/tag/v1.0.0-rc1
