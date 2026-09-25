# 更新日志

## [1.0.1-rc2] - 2026-09-18 (build 260918)

### 新增
- **扩展管理**：支持 .crx（CRX2 / CRX3）与已解压目录，经原生文件对话框选择。
  内置最小 ZIP 解包器（store + deflate，走系统 cabinet.dll），带目录穿越防护；
  直接以 zip 分发的扩展也能加载。**注意：只能登记，不能运行**（原因见"已知问题"）。
- **无痕模式 2.0 的指纹注入**：按指纹画像生成改写脚本
  （UA / 平台 / 时区 / 语言 / 屏幕 / 并发数 / DNT + Canvas 与 WebGL 噪声），
  在无痕窗口每次主框架开始加载时注入。
- **键盘快捷键**：Ctrl+T / Ctrl+W / Ctrl+Shift+T / Ctrl+Tab / Ctrl+1..9 /
  Ctrl+L / Ctrl+F / Ctrl+R / Ctrl+D / Ctrl+H / Ctrl+J / Ctrl+± / Ctrl+0 /
  Alt+←→ / F5 / F11 / F12，且焦点在网页输入框内时同样生效。
- 页面加载完成时记录历史（无痕窗口自动跳过）。
- **网页右键菜单**（原生 Views 菜单，共 22 项，按上下文动态启用/禁用）：
  返回 / 前进 / 重新加载 / 停止加载、在新标签页中打开链接与图片、复制链接地址与图片地址、
  链接另存为、图片另存为（PNG 落盘并记入下载列表）、撤销 / 重做 / 剪切 / 复制 / 粘贴 / 删除 / 全选、
  搜索选中内容、放大 / 缩小 / 重置为 100%、打印为 PDF、查看页面源代码、检查元素。
  在此之前网页区域的右键不会弹出任何菜单（CEF 默认菜单被清空、外壳 UI 又收不到网页的右键事件）。
- **下载管线**：接入 `CefDownloadHandler`，下载落到 `<数据目录>\Downloads`，
  进度与结果写入下载列表（`downloads.json`），完成/取消/中断都有中文日志。
- **下载安全判定真正接上了**：`CheckDownload` 此前只是实现了却从未被调用；
  现在每个下载都会过一遍 —— 不安全安装包（.exe/.msi/.bat/...）**只警告不拦截**，
  文件照常保留、记录标为可疑并写明原因，turtlelnc 发布物直接放行（对应需求 6）。
- **无痕指纹回读验证**：页面加载完成后在页面里回读 `navigator` / `screen` / `Intl` 的实际取值，
  与原生日志里的指纹画像逐项比对（`无痕指纹回读` / `无痕指纹比对`）。
  只证明"注入了一段脚本"是不够的，这条路径证明的是"页面真的读到了改写后的值"。
- **扩展运行能力如实上报**：新增 `extensions.runtime` 接口与对应的界面说明。
- **新增验收用例 7/8/9/10**：右键菜单自检、下载落盘与安全判定、不安全安装包只警告不拦截、
  命令行开关真的生效。用例 4 增加指纹回读断言。整套验收现在 10 个用例 54 项断言。
- **新增排查开关**：`--tib-menu-probe[=show]`（右键菜单自检，`show` 会真实弹出）、
  `--tib-download-probe[=<文件名>]`（打开带 `Content-Disposition: attachment` 的本地下载探针）。

### 变更
- 版本号全线升到 `v1.0.1-rc2 (build 260918)` —— 这次不只改 `package.json`：
  Windows 资源里的文件版本（用户在"属性"里看到的就是它）、边车 `package-lock.json`、
  边车握手自报版本、UI 构建号兜底值、README 徽章与安装包名全部对齐，
  并由 `npm run check` 加了防回归检查（含全仓扫描旧版本号）。
- `check-release.mjs` 新增 6 项一致性检查：边车锁文件、边车共享常量、Windows 资源版本
  （字符串与数值两份）、UI 构建号兜底写法、以及"源码/文档里不得残留旧版本号"。
- `vite.config.ts` 的内核版本与构建号不再手抄：内核版本从 `third_party/cef/include/cef_version.h`
  推导，构建号从 `src/shared/constants.ts` 读取。
- 界面与文档中关于扩展的表述改为如实说明（见下方"已知问题"）。
- `--shortcut-test` 开关：直接调用快捷键处理逻辑，便于自动化验证
  （本机前台被占用时无法用 SendKeys 真实按键）。

### 修复
- **开第二个标签页后约 9 秒必定崩溃**（`libcef+0x43208B0`，0xC0000005）：
  根因是在 `CefWindow::CreateTopLevelWindow` 尚未返回时把已挂载的 `BrowserView`
  从窗口上摘除，破坏了 CEF 内部的视图/窗口状态。改为**切标签只切可见性、视图一旦挂上不再摘除**；
  保留 `--tib-legacy-detach=create|activate|both` 用于复现旧行为做回归验证。
- **关闭窗口后进程不退出**（单进程模式下 CEF 不会自动结束消息循环，用户以为关了、进程还在占内存）：
  窗口表清空时调用 `CefQuitMessageLoop()`，并调整收尾顺序为
  停边车 → 停本地服务器 → `CefShutdown()`。
- **外壳 UI 被首次导航覆盖**：`LoadChromeUi()` 在 `CreateBrowserView` 期间调用会被排入的
  `about:blank` 覆盖，改为只在 `OnWindowCreated` 末尾调用一次。
- **设置改完重启不生效**的最后一环：`GetStateJson()` 与 `__TIB_BOOT__` 曾按默认值下发，
  会覆盖 UI 从 `getSettings()` 拿到的真实设置。
- 验收脚本自身的两个问题：用例 5 先写好 `settings.json` 又被清空数据目录（四条断言假红）、
  用例 6 到早期日志里找只在收尾时写的行；另新增 `--only=` 便于单跑用例。
- `service/package-lock.json` 的许可证仍写着 `MIT`（与 `GPL-3.0-only` 不一致），已改正。
- 扩展列表缺 `fromCrx` 字段，界面上"来自 .crx / 已解压目录"徽标永远显示后者。
- **`--user-data-dir` 与 `--multi-process` 静默失效**：两者都在 `CefInitialize` 之前
  调用 `CefCommandLine::GetGlobalCommandLine()`，而那时它返回的是**空对象**，
  于是分支根本不进入。表现极具迷惑性：启动日志里"生效的命令行开关"照样列出
  `--user-data-dir=…`，但"用户数据目录"仍是默认值（实测确认 profile 写在默认目录）。
  现在改为先取全局命令行、取不到就从原始命令行构造，再做全部开关解析；
  并新增验收用例 10 专门盯这两个开关（对照实际落盘路径，而不是看日志里有没有这个开关）。

### 已知问题
- 本机仍需单进程兼容模式（Chromium 网络服务子进程在此环境启动即崩），
  因此默认没有 renderer 沙箱隔离；`--multi-process` 可切回标准多进程模型。
- **扩展只能登记、不能运行**：CEF 150 已移除扩展 API（头文件里既没有 `LoadExtension`
  也没有 `CefExtensionHandler`）。导入 / 解包 / 清单校验 / 开关 / 删除可用，
  但扩展脚本与后台任务不会被执行 —— 界面与 `extensions.runtime` 都如实说明。
- 未实现系统打印对话框（`window.print()` 与打印机流程需要完整的 `CefPrintHandler`），
  提供的是"打印为 PDF"。
- 增强型安全防护中依赖云端威胁库的部分、以及账户同步的云端部分需要自备凭据。
- 安装包与主程序**未做代码签名**，Windows SmartScreen 会提示"未知发布者"。

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
