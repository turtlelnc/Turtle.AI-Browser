# TiBrowser v1.0.0-rc1 当前状态（build 260913）

> 本文件是**当前实现的权威状态记录**，每次有实质进展都要更新。
> 目标读者：接手继续开发的人（包括未来的我）。只写已验证的事实，不写愿望。

## 1. 一句话状态

原生 CEF 外壳**能启动、能显示、桥接通、页面能加载**；
但网络服务子进程在本机只能通过 `--single-process` 绕过，**尚未找到根本原因**。

## 2. 已验证可用（有日志证据）

| 能力 | 证据 |
|---|---|
| 原生 CEF 外壳编译 | `npm run native:build` → `TiBrowser.exe`（2.5 MB）+ CEF 运行时 743 MB |
| Chromium 内核启动 | 日志 `CEF 上下文初始化完成，内核版本 150.0.20+ga832838+chromium-150.0.7871.253` |
| 外壳 UI 加载 | 日志 `外壳 UI 加载完成：http://127.0.0.1:<port>/<token>/ui/index.html（HTTP 200）` |
| UI 资源齐全 | 服务器日志：`index.html` 8449 B、`assets/index.js` 277236 B、`assets/index.css` 42647 B，全部 200 |
| React 已挂载 | 自检 `rootKids=1`、`appBox=1200x82`、`skin=tibrowser` |
| **桥双向连通** | 自检 `getState 往返成功：标签数=1 皮肤=tibrowser` |
| 多标签 | 页面视图与外壳视图分别创建并挂载（`OnTabCreated: 视图已挂载=是`） |
| 产品图标 | `ExtractAssociatedIcon` 可从 exe 提取；由 根目录 `ico.png` 生成多尺寸 ico |
| 边车服务 | `service/` 自检 100/100 通过（`SELFTEST OK`） |
| 版本号 | `v1.0.0-rc1 (build 260913)` 已写入 native / package.json / CHANGELOG / README |

## 3. 本机环境的坑（已定位并绕过）

这四条是本机（Windows + VS2026 BuildTools + SDK 10.0.26100 + OneDrive 同步 %APPDATA%）特有的，
换机器可能不复现，但每一条都曾表现为「进程在跑、界面空白」，记录在此避免重复踩：

### 3.1 网络服务子进程启动即崩 → 必须用 `--single-process` 绕过（未根治）

现象：`cef.log` 反复刷
`ERROR:content\browser\network_service_instance_impl.cc:721] Network service crashed or was terminated, restarting service.`
后果极具迷惑性：**导航事件、标题更新都正常，但任何 HTTP 请求都发不出去**，页面永远空白。
子进程在打日志之前就死了，主进程日志看不到原因。

当前处理：默认**不**自动启用 `--single-process`；本机需要显式加该开关才能加载页面。
`--no-sandbox` 一并加上（`--single-process` 与沙箱不兼容）。

**待办**：在目标机器上二分定位网络服务崩溃的真正原因（见 §6）。

### 3.2 `%APPDATA%` 被 OneDrive 同步 → 默认数据目录改到 `%LOCALAPPDATA%`

`%APPDATA%\TiBrowser` 在同步盘上会出现缓存文件占用冲突
（`Failed to open persistent cache files ... 另一个程序正在使用此文件`），
并伴随网络服务崩溃。现默认使用 `%LOCALAPPDATA%\TiBrowser`。

### 3.3 视图加载的时序（改成确定性顺序后才通）

三条相互纠缠的时序问题，写错任何一条都表现为「页面空白且服务器收不到请求」：

1. `CefBrowserViewDelegate::OnBrowserCreated` 是在 `CreateBrowserView` **内部同步**触发的 ——
   此时 `chrome_view_` 还没赋值，用 `browser_view == chrome_view_` 认领回调必然失败。
   → 由 `ChromeViewDelegate` / `PageViewDelegate` 各自携带身份。
2. 在 `CreateBrowserView` 期间调用 `LoadURL` 会被丢弃（服务器收不到任何请求）。
   → 外壳 UI 的加载放在 `ChromeViewDelegate::OnBrowserCreated`；
     标签页的首次导航用 `Tab::pending_url`，在 `OnTabCreated` 里执行。
3. `ExecuteJavaScript` 打在 detached frame 上会被 CEF 丢弃
   （日志：`SendJavaScript sent to detached frame ... will be ignored`）。
   → `RunInChrome` 先检查 `frame->IsValid()`；状态推送与自检放到 `OnLoadEnd` 之后。

### 3.4 不要用 `CefMessageRouterBrowserSide`

它会触发 `cef_ref_counted.h:240 Check failed: !needs_adopt_ref_` 导致进程直接退出。
上行通道改用渲染进程 console 消息（前缀 `__TIB_CALL__`），
下行回执用 `ExecuteJavaScript` 调 `window.__tibDeliverReply`。

另外两条与"看不见的窗口"有关：
- `CefWindowDelegate::GetInitialBounds()` 必须实现，否则窗口初始位置是 `-21333,-21333`。
- CEF 首次创建 Alloy 窗口会落在最小化状态，`Show()` 之后需要补一次 `Restore()`
  （已由 `EnsureVisibleOnScreen()` 在窗口创建 1.2 秒后兜底执行）。

## 4. 界面截屏在本机拿不到（工具限制，非产品缺陷）

- `PrintWindow` 对 GPU 合成的 Chromium 窗口只能抓到白屏。
- 从屏幕 DC 抓像素要求窗口真的在前台，而本机 DSH 窗口长期占用前台，
  `SetForegroundWindow` / `SetWindowPos(HWND_TOPMOST)` 均无法把 TiBrowser 提到前台。

因此**不要**用截图判断界面是否正常，用自检日志（§2 的 `getState 往返成功`）。

## 5. 目录与构建

```
native/        C++ 外壳（CMake + Ninja + MSVC）
service/       Node 边车（RPC / AI / 安全 / 自动化）
src/renderer/  React 外壳 UI（Apple 风格，三套皮肤）
src/bootstrap/ 注入脚本（window.tib）
src/shared/    三方共享契约
scripts/       取内核、构建、图标、自检工具
resources/     黑名单、诊断页
docs/          本文件、ARCHITECTURE.md、SERVICE-API.md、AUTOMATION.md
```

构建顺序（缺一步都会出问题）：

```bash
npm run fetch:cef        # 下载 CEF 发行包（约 330 MB）
npm run ui:build         # 构建 UI + 注入脚本 → dist/ui
npm run service:build    # 构建边车
npm run native:configure # CMake 配置
npm run native:build     # 编译 → build-native/TiBrowser.exe
npm run native:run       # 运行
```

`ui:build` 之后必须把 `dist/ui` 同步到 `build-native/ui`（CMake 的 POST_BUILD 会做，
手动构建时容易漏，漏了就会用到**过期的 tib-host.js** —— 这个坑真实发生过）。

## 6. 下一步（按优先级）

1. **根治网络服务崩溃**（§3.1）。它是唯一还没解释清楚的问题。
   建议方向：用 Process Monitor 看子进程启动失败在哪一步；
   或换一个 CEF 版本（beta 154）对比；或在另一台机器上验证是否本机特有。
   解决后即可去掉 `--single-process`，恢复正常的进程隔离。
2. **补齐原生方法集**。当前 `Dispatch` 只实现了 30 余个方法，
   UI 的 `TibBridge` 契约有 85 个方法。未实现的会返回中文原因（不会假装成功），
   但界面上的书签/历史/下载/扩展/账户等分区因此是空的。
3. **把 15 项功能的内核强制点接上**：三档安全浏览的拦截执行、
   无痕 2.0 的指纹注入（目前只有接口占位）、能效四档的进程模型、
   网页应用、MCP/OAuth、本地办公/开发模式、自动化接口。
4. **打 rc1 安装包**（当前 `release/` 里仍是旧的 beta Electron 安装包）。
