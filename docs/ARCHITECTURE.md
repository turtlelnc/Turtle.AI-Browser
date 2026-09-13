# TiBrowser v1.0.0-rc1 架构（build 260913）

> 本文件是 **接口契约的唯一事实来源**。native / service / renderer 三方必须严格按此实现，
> 任何一方需要扩展接口时，先改本文件，再改代码。

## 1. 目标架构（与 v0.1.0 的根本差异）

v0.1.0 是 Electron（内嵌 Chromium）。v1.0.0-rc1 **舍去 Electron 运行时**，
浏览器主程序是原生 C++ 可执行文件，直接链接 **CEF（Chromium Embedded Framework）**，
即真正的 Chromium 内核（Chromium 150 / CEF 150.0.20）。

```
┌──────────────────────────────────────────────────────────────────────┐
│ TiBrowser.exe  （原生 C++，Chromium 多进程宿主）                        │
│                                                                      │
│  browser 进程（本 exe）                                                │
│   ├── AppHandler / WindowHandler（CefWindowDelegate：无边框窗口）       │
│   ├── TibWindow：多标签模型 + 每个标签一个 CefBrowserView（Views 模式）  │
│   ├── ChromeView：React 绘制的浏览器外壳（标签栏/地址栏/菜单）            │
│   ├── 自定义协议 tib://  →  从磁盘提供 UI 与内置页面资源                  │
│   ├── CefMessageRouter（tib.* 查询）→  窗口/标签/导航/设置/安全           │
│   ├── 安全浏览三档（增强型 / 标准 / 不防护）                             │
│   ├── 无痕模式 2.0（独立 RequestContext + 指纹改写）                     │
│   ├── 能效四档（process-per-site / 预加载 / 隐藏节流 / 即开即用）          │
│   └── AiBridge：用 CefURLRequest 调本地 sidecar 与模型 API              │
│                                                                      │
│  renderer 进程（Chromium 自带，sandbox 开启）：网页 + React 外壳 UI       │
│  gpu / utility / network 进程：Chromium 自带                          │
└──────────────────────────────────────────────────────────────────────┘
                    ▲ HTTP + SSE（127.0.0.1，随机端口 + Bearer token）
                    │
┌──────────────────────────────────────────────────────────────────────┐
│ tib-service.exe / node service（Node 20+ 边车进程，可选、可关闭）        │
│   ├── 设置与密钥存储（DPAPI 加密，绝不落盘明文）                          │
│   ├── 书签 / 历史 / 下载记录（JSON + SQLite 可选）                       │
│   ├── AI：OpenAI 兼容协议、MCP 客户端、OAuth(SDK) 登录                   │
│   ├── 本地办公模式（WorkBuddy 能力）/ 本地开发模式（Tare + codex 能力）    │
│   └── 自动化 API（本地 HTTP/WS，供用户自己的 AI 工具 / CLI / harness 调用） │
└──────────────────────────────────────────────────────────────────────┘
```

**为什么要有边车**：AI 流式对话、MCP、OAuth、办公/开发模式需要大量生态库（Node 生态最全），
而 C++ 侧只保留「浏览器本体」。边车是**独立进程**，不作为浏览器进程的一部分，
浏览器在「即开即用模式」下可以不启动边车（此时 AI 能力降级并明确提示用户）。

## 2. 目录结构

```
Turtle.AI-Browser/
├── native/                 # C++ 原生浏览器（CEF）
│   ├── CMakeLists.txt
│   ├── include/            # 头文件
│   └── src/
│       ├── main.cpp        # 入口 + CefMainArgs + 子进程分发
│       ├── app.h/.cpp      # CefApp / CefBrowserProcessHandler
│       ├── window.h/.cpp   # TibWindow：多标签 + Views 布局
│       ├── chrome_view.*   # React 外壳（tib://ui）
│       ├── scheme.*        # tib:// 自定义协议与资源映射
│       ├── router.*        # CefMessageRouter ↔ tib.* 查询分发
│       ├── security.*      # 三档安全浏览、下载放行、turtlelnc 例外
│       ├── incognito.*     # 无痕 2.0：指纹改写、独立上下文
│       ├── energy.*        # 能效四档
│       └── service_client.*# 与 sidecar 的 HTTP/SSE 通信
├── service/                # Node 边车（AI / 存储 / 自动化 API）
│   └── src/
├── src/
│   ├── shared/             # 三方共享的类型与常量（唯一契约）
│   ├── renderer/           # React 浏览器外壳 UI（tib://ui）
│   └── legacy-electron/    # v0.1.0 的 Electron 实现（保留只读参考）
├── resources/              # 黑名单、图标、内置页面
├── docs/                   # 架构与接口文档
├── scripts/                # 构建 / 取内核 / 打包脚本
└── release/                # 最终用户使用的部分（安装包）
```

## 3. UI ↔ 原生：`window.tib` 桥

外壳 UI 通过 `tib://ui/index.html` 加载，注入 `window.tib`。所有调用都是
`Promise`（底层是 CefMessageRouter 的 query），事件通过 `window.tib.on(evt, cb)` 订阅。

### 3.1 命令（UI → 原生）

| 方法 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `tib.getState()` | — | `BrowserState` | 全量状态，UI 首次加载时拉取 |
| `tib.newTab(input?, opts?)` | `string?`, `{incognito?:boolean, appId?:string}` | `{tabId}` | 新建标签页 |
| `tib.closeTab(tabId)` | `string` | `{ok}` | 关闭标签页 |
| `tib.activateTab(tabId)` | `string` | `{ok}` | 激活标签页 |
| `tib.moveTab(tabId, index)` | `string, number` | `{ok}` | 拖拽排序 |
| `tib.navigate(input)` | `string` | `{ok, blocked?, verdict?}` | 地址栏/搜索 |
| `tib.goBack()` / `tib.goForward()` / `tib.reload()` / `tib.stop()` | — | `{ok}` | 导航控制 |
| `tib.goHome()` | — | `{ok}` | 主页 |
| `tib.setZoom(level)` / `tib.zoomIn()` / `tib.zoomOut()` / `tib.zoomReset()` | `number?` | `{ok}` | 缩放 |
| `tib.proceed()` | — | `{ok}` | 忽略安全警告继续访问 |
| `tib.findInPage(text)` / `tib.findStop()` | `string` | `{ok}` | 页内查找 |
| `tib.setFindOpen(open)` | `boolean` | `{ok}` | 查找栏展开/收起（影响内容区布局） |
| `tib.setOverlay(name)` | `OverlayName` | `{ok}` | 覆盖层打开时隐藏网页 |
| `tib.toggleSidebar(open?)` | `boolean?` | `{ok}` | AI 侧边栏 |
| `tib.setSidebarWidth(w)` | `number` | `{ok}` | 侧边栏宽度 |
| `tib.toggleBookmarkBar()` | — | `{ok}` | 书签栏 |
| `tib.windowAction(action)` | `'minimize'\|'maximize'\|'restore'\|'close'` | `{ok}` | 窗口控制 |
| `tib.getSettings()` | — | `Settings` | 设置（API key 只回掩码） |
| `tib.setSettings(patch)` | `Partial<Settings>` | `Settings` | 写设置 |
| `tib.setApiKey(key)` | `string` | `{ok}` | 保存密钥（加密） |
| `tib.getBookmarks()` / `tib.addBookmark(t)` / `tib.removeBookmark(id)` / `tib.toggleBookmark()` | — | `BookmarkNode[]` | 书签 |
| `tib.getHistory(q?, limit?)` / `tib.clearHistory()` / `tib.removeHistory(id)` | — | `HistoryItem[]` | 历史 |
| `tib.getDownloads()` / `tib.openDownload(id)` / `tib.openDownloadFolder()` | — | `DownloadItem[]` | 下载 |
| `tib.omniboxSuggest(q)` | `string` | `OmniboxSuggestion[]` | 地址栏联想 |
| `tib.getSecurityReport()` | — | `SecurityReport` | 安全浏览当前档位与拦截统计 |
| `tib.setProtectionLevel(level)` | `ProtectionLevel` | `{ok}` | 三档安全浏览 |
| `tib.getFingerprintProfile()` / `tib.setFingerprintProfile(p)` / `tib.randomizeFingerprint()` | — | `FingerprintProfile` | 无痕 2.0 |
| `tib.getEnergyMode()` / `tib.setEnergyMode(m)` | `EnergyMode` | `{ok, applied}` | 能效四档 |
| `tib.getSkin()` / `tib.setSkin(s)` | `BrowserSkin` | `{ok}` | 皮肤切换（tibrowser/edge/chrome） |
| `tib.getInstalledApps()` / `tib.installWebApp(url, name, icon)` / `tib.uninstallWebApp(id)` / `tib.launchWebApp(id)` | — | `WebApp[]` | 生成网页应用 |
| `tib.getAccounts()` / `tib.signIn(provider)` / `tib.signOut(provider)` / `tib.getSyncState()` / `tib.syncNow()` | — | — | 账户与同步 |
| `tib.getExtensions()` / `tib.loadUnpackedExtension(path)` / `tib.loadCrx(path)` / `tib.removeExtension(id)` / `tib.setExtensionEnabled(id, on)` | — | `ExtensionInfo[]` | 扩展 |
| `tib.profileExport()` / `tib.profileImport()` | — | `ProfileExportResult` | `.tbuser` 迁移 |
| `tib.aiChat(payload)` / `tib.aiAbort(requestId)` | `{requestId, messages, mode}` | `{requestId}` | AI 对话（流式见事件） |
| `tib.aiAgent(payload)` | `{requestId, messages, permission}` | `{requestId}` | AI 智能体 |
| `tib.serviceStatus()` | — | `{running, mode, port, version}` | 边车状态 |
| `tib.automationInfo()` | — | `{enabled, baseUrl, token, docs}` | 本地自动化接口信息 |

### 3.2 事件（原生 → UI）

| 事件 | 载荷 | 时机 |
|---|---|---|
| `state` | `BrowserState` | 任何状态变化（节流 16ms） |
| `findResult` | `{matches, activeMatchOrdinal, finalUpdate}` | 页内查找 |
| `windowState` | `{isMaximized, isFullscreen}` | 窗口状态 |
| `download` | `DownloadItem` | 下载进度 |
| `aiChunk` | `{requestId, delta}` | AI 流式增量 |
| `aiDone` | `{requestId, content}` | AI 完成 |
| `aiError` | `{requestId, message}` | AI 失败 |
| `aiTool` | `{requestId, name, detail, phase}` | 工具调用状态 |
| `securityEvent` | `{url, verdict, action}` | 安全拦截 |
| `accountsChanged` | `{accounts, syncState}` | 登录态变化 |
| `appsChanged` | `WebApp[]` | 网页应用变化 |
| `extensionsChanged` | `ExtensionInfo[]` | 扩展变化 |

## 4. 原生 ↔ 边车：本地 RPC

- 传输：`http://127.0.0.1:<port>`，端口在握手文件中交换，随机 32 字节 Bearer token。
- 握手：原生启动时生成 token，写 `<userData>/service.json`（`{port, token, pid}`）；
  边车启动后写入自己的 `port`。两侧都用 0600 权限写文件（Windows 用 ACL 收紧）。
- 流式：`text/event-stream`，事件名与第 3.2 节 `ai*` 一致。
- 端点：`POST /rpc/<method>`（JSON 请求体）、`GET /events?token=`（SSE）、
  `GET /health`（`{ok, version, build, capabilities[]}`）。

## 5. 三档安全浏览（对齐 Chrome）

| 档位 | 值 | 行为 |
|---|---|---|
| 增强型防护 | `enhanced` | 实时比对更多站点数据；对未知危险站点也警告（可忽略）；深度扫描可疑下载；登录后跨服务保护；发送混淆后的 URL 片段 + 少量页面内容 + 下载/扩展/系统信息样本 |
| 标准防护 | `standard` | 通过可隐藏 IP 的隐私服务器发送混淆 URL 片段；可疑时补发完整 URL 与少量页面内容；本地黑名单 + 启发式 |
| 不防护 | `none` | 不拦截；但仍保留「下载放行名单」提示（不阻断） |

**turtlelnc 例外**：`github.com/turtlelnc/*`、`*.turtlelnc.*`、官网
`turtleweb.cc.cd`、以及已签名的 turtlelnc 发布物，在**任何档位**下：
不拦截、不警告、不计入威胁统计（防止误杀开发本浏览器的团队）。该例外在
`native/src/security.cpp` 与 `service/src/security/trusted.ts` 双向实现，规则集中在一处常量。

## 6. 契约类型

所有跨进程类型定义在 `src/shared/types.ts`，常量在 `src/shared/constants.ts`。
新增字段一律**可选**并在实现中给默认值，保证皮肤/档位降级不崩 UI。

`APP_VERSION = '1.0.0-rc1'`，`APP_BUILD = 260913`，展示格式 `v1.0.0-rc1 (build 260913)`。
