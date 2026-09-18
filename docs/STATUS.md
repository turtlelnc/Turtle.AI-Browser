# TiBrowser v1.0.1-rc2 当前状态（build 260918）

> 本文件是**当前实现的权威状态记录**。只写已验证的事实，不写愿望。
> 最后更新：rc2（原生 UI 桥全通 + 完整 API + 快捷键 + 扩展解包 + 无痕指纹注入 + 可分发包）

## 1. 一句话状态

**地基已经打通，但还有一个影响日常使用的稳定性缺陷**：单标签页可稳定运行，
**开第二个标签页后约 9 秒必定崩溃**（`libcef.dll`，0xc0000005）。
除此之外：原生 Chromium 内核、界面渲染、真实外网页面、书签/历史/下载/设置/皮肤/
无痕指纹/安全档位/账户/网页应用/快捷键全部可用，扩展可解包登记，
AI 能力经边车进程打通，17/17 桥接接口可用。

## 2. 已验证可用（均有日志证据）

### 2.1 内核与界面

| 能力 | 证据 |
|---|---|
| 原生 CEF 外壳编译 | `npm run native:build` → `TiBrowser.exe`（2.76 MB） |
| Chromium 内核启动 | `CEF 上下文初始化完成，内核版本 150.0.20+ga832838+chromium-150.0.7871.253` |
| 界面渲染 | `[UI 自检] ready=complete \| tib=object \| appBox=1200x82 \| visibleEls=59 \| overflowX=no \| skin=edge` |
| 真实网页加载 | `标签页标题更新：Example Domain` |
| 设置持久化 | 写入 `settings.json` 后重启，`注入首屏引导：皮肤=edge 主题=dark`，UI 实际 `data-skin=edge` |
| 键盘快捷键 | `快捷键自检：Ctrl+T 后标签数 2 \| Ctrl+2 → 切换成功 \| Ctrl+Tab → 切换成功 \| Ctrl+Shift+T 恢复=成功，标签数 2 → 3` |
| 单标签稳定性 | 默认启动存活 40 秒以上（多标签见 §4 已知崩溃） |
| 产品图标 | 由根目录 `ico.png` 生成多尺寸 ico，`ExtractAssociatedIcon` 可提取 |

### 2.2 完整 UI 桥接契约（17/17 接口可用）

实测输出（默认启动 + 真实外网页面）：

```
接口探测：getSecurityReport=ok | getProtectionLevel=ok | getFingerprintProfile=ok |
  getEnergyMode=ok | getSkin=ok | getSettings=ok | getBookmarks=ok | getHistory=ok |
  getDownloads=ok | getInstalledApps=ok | getExtensions=ok | getAccounts=ok |
  getSyncState=ok | getAiConnection=ok | getAiMode=ok | serviceStatus=ok | automationInfo=ok
```

### 2.3 15 项功能对照

| # | 功能 | 状态 | 说明 |
|---|---|---|---|
| 1 | 完全 Chromium 内核，舍弃 Electron | ✅ 已完成 | 原生 C++ + CEF 150，进程树里没有 Electron |
| 2 | 具备 Chrome/Edge 的内容能力 | 🟡 大体可用 | 导航、标签、书签、历史、下载、缩放、页内查找、**键盘快捷键**已可用；密码管理、打印、阅读模式、右键菜单尚未做 |
| 3 | 登录 Microsoft/Google 并同步 | 🟡 部分 | 登录态、同步开关与状态已实现；**云端同步需自备 OAuth client id**，否则明确报错；可用的实际同步方式是本地文件夹 |
| 4 | 无痕模式 2.0（可改指纹） | 🟡 部分 | 指纹画像的编辑/随机化/持久化已完成，**且在无痕窗口真正注入生效**（实测注入 646 字节脚本）；受单进程模式限制，无法使用独立的 `CefRequestContext`，因此不等同于最严格的 incognito 语义（代码内已注明） |
| 5 | 三档安全浏览 | 🟡 部分 | 三档设置、拦截执行、本地黑名单、启发式扫描、统计已可用；**增强型依赖云端威胁库的能力本地不可用**，界面明确标注 |
| 6 | 不安全安装包可保留 + turtlelnc 自动放行 | ✅ 已完成 | 下载判定返回 warn/allow，turtlelnc 在任何档位放行 |
| 7 | 生成网页应用 | ✅ 已完成 | 安装/卸载/启动 + `appsChanged` 事件 |
| 8 | TiBrowser/Edge/Chrome 皮肤切换 | ✅ 已完成 | 94 个设计令牌、三套皮肤，运行时切换并持久化（实测重启后 `skin=edge` 生效） |
| 9 | AI 连接：API / MCP / OAuth(SDK) | 🟡 部分 | 边车已实现 OpenAI 兼容协议、MCP stdio 客户端、OAuth PKCE 回环；原生侧异步转发已通；**需要用户自备凭据** |
| 10 | 整合各浏览器优点 | ✅ 持续进行 | 架构上已统一（见 §3） |
| 11 | 一个浏览器解决所有事 | 🟡 持续进行 | 地基已通，功能在补齐 |
| 12 | 本地办公模式 / 本地开发模式 | 🟡 部分 | 边车已实现能力清单与执行器（含沙箱工作区、命令白名单、演练模式）；原生转发已通，界面可调用 |
| 13 | 能效四档 | 🟡 部分 | 四档设置、持久化、`fastSupported` 探测与说明已完成；**实际的进程模型切换尚未按档位差异化生效** |
| 14 | Apple 风格 UI | ✅ 已完成 | 设计令牌、动效、低性能降级（`data-perf`）齐备 |
| 15 | 供用户自有 AI 工具/CLI 操控的接口 | ✅ 已完成 | 边车提供 HTTP + WebSocket 自动化 API，带 Bearer 鉴权、39 个动作、默认关闭、发现文件 |
| — | 扩展加载（.crx / 已解压） | 🟡 部分 | 原生对话框选择、CRX2/CRX3 解包、清单读取、启用禁用已完成并登记进扩展列表；**Chromium 侧的实际加载尚未接入** |

### 2.4 边车（Node）

- 65 个 RPC 方法，自检 `SELFTEST OK`（100 项检查通过）
- 原生 → 边车异步转发已通（`CefURLRequest` + 回调回执，不阻塞 UI）
- 握手：原生显式传 `--user-data`，两侧指向同一目录

## 3. 关键架构决策（改代码前必读）

完整清单见 `docs/ARCHITECTURE.md` §7；这里只列最容易踩的几条：

1. **不要用 `CefMessageRouterBrowserSide`** —— 会触发 CEF 内部断言导致进程退出。
   上行通道是渲染进程 console 消息（前缀 `__TIB_CALL__`），下行是 `ExecuteJavaScript`。
2. **`CefBrowserViewDelegate::GetBrowserRuntimeStyle()` 必须返回 `CEF_RUNTIME_STYLE_ALLOY`**，
   否则 CEF 会静默丢弃视图（表现为窗口全白）。
3. **`CreateBrowserView` 的返回值必须用 `.release()`**，用 `.get()` 会触发 adopt 断言。
4. **`OnBrowserCreated` 是在 `CreateBrowserView` 内部同步触发的**，
   此时视图成员还没赋值；且在 `CreateBrowserView` 期间 `LoadURL` 会被丢弃。
   因此外壳 UI 的加载放在 `ChromeViewDelegate::OnBrowserCreated`，
   标签页首次导航用 `Tab::pending_url` 在 `OnTabCreated` 里执行。
5. **资源处理器的 `Open()` 不能加 `CEF_REQUIRE_IO_THREAD()`** —— 会在页面加载时 FATAL。
6. **`GetInitialBounds()` 必须实现**，否则窗口初始位置在屏幕外；
   且 CEF 首窗会落在最小化态，`Show()` 之后需要补一次 `Restore()`。
7. **`OnTabCreated` 会被触发两次**（`PageClient::OnAfterCreated` 与
   `PageViewDelegate::OnBrowserCreated` 都会走到它）。必须用 `Tab::navigated` 之类的
   标志只让第一次真正发起导航，否则第二次会用新标签页地址**覆盖**首次导航 ——
   表现为"用 --url= 打开的页面被新标签页顶掉"。
8. **状态推送里的设置快照必须读真实设置**。`GetStateJson()` 早期写死过默认值，
   于是每次状态推送都会把 UI 从 `getSettings()` 拿到的真实设置覆盖回默认值 ——
   表现为"改了皮肤/主题，看起来保存了却不生效"。这是最难查的一类 bug：
   两处都"工作正常"，只是后者覆盖前者。
9. **首屏引导数据（`__TIB_BOOT__`）也必须读真实设置**，否则首帧会按默认值绘制。
10. **外壳 UI 只能有一个加载入口**。同时从 `ChromeViewDelegate::OnBrowserCreated`
    与 `OnWindowCreated` 调 `LoadChromeUi()` 会让页面加载两遍，
    第二遍重置第一遍的 DOM 状态，制造出偶发、难复现的时序问题。
11. **单进程兼容模式下不要创建 `CefRequestContext`** —— 会让 `CreateBrowserView`
    卡死或崩溃（两套写法都试过）。无痕隔离因此不依赖自定义上下文。
12. **切换标签页不要「摘视图再挂载」**。原实现用
    `RemoveChildView(旧视图) + AddChildView(新视图)`，会让被摘下视图底层的
    render widget / native window 被销毁，而 `CefBrowser` 仍然存活；
    此后任意一次对它的虚调用就是 AV 崩溃。
    实测证据（崩溃处理器落盘）：`libcef+0x43208B0`，空对象虚调用（`RAX=0`，读偏移 `0xF0`），
    崩在 UI 线程、调用栈自 `CefRunMessageLoop` 起。用 `--tib-legacy-detach` 打开旧行为
    可稳定复现（2 标签页 2 秒内崩、切换场景 0.9 秒崩），关掉后 1/2/3 标签页各 60 秒稳定。
    **正确做法：只切可见性（`SetVisible`），视图始终挂在窗口上。**
13. **`CefPostDelayedTask` 在本机不稳定**：同样的代码加上延迟任务后进程会退出，
    去掉后稳定存活 40 秒以上。定时逻辑（自检、兜底）请优先用别的方式实现。

## 4. 本机环境特有的坑

| 现象 | 根因 | 当前处理 |
|---|---|---|
| 网络服务子进程启动即崩 → **任何网页都打不开** | 本机 Chromium 网络服务在此环境无法作为子进程启动 | 默认单进程兼容模式；`--multi-process` 可退出 |
| 缓存文件占用冲突 | `%APPDATA%` 被 OneDrive 同步 | 数据目录改用 `%LOCALAPPDATA%\TiBrowser` |
| 边车"已启动"但握手超时 | 边车与原生用了不同数据目录 | 原生显式传 `--user-data` |
| 界面截屏拿不到 | GPU 合成窗口 + 前台被占 | 用自检日志判断，不要用截图 |
| 开第二个标签页后 ~9 秒崩溃 | 摘视图切标签（见 §3 第 12 条） | 已改为只切可见性；`--tib-legacy-detach` 保留旧行为供复现 |
| 启动即退出且无 WER 事件、退出码 -1 | 被 `Stop-Process -Force` 强杀，**不是崩溃** | 排查时先确认没有外部强杀，否则实验数据会被污染 |

## 5. 构建与打包

```bash
npm run fetch:cef         # 下载 CEF 发行包（约 330 MB，仅首次）
npm run ui:build          # 构建 UI + 注入脚本 → dist/ui
npm run service:build     # 构建边车
npm run native:configure  # CMake 配置
npm run native:build      # 编译 → build-native/TiBrowser.exe
npm run native:setup      # 编译安装器 → build-installer/TiBrowserSetup.exe
npm run dist              # 组装可分发的 release/dist（约 417 MB）
npm run check             # 发行一致性自检
npm run acceptance        # rc 验收测试（会自行起停进程，约 4 分钟）
```

⚠️ `ui:build` 之后必须让 `build-native/ui` 用上新产物（CMake POST_BUILD 会自动复制；
手动构建时容易漏，漏了就会用到**过期的 tib-host.js** —— 这个坑真实发生过，
症状是桥"完全不工作且没有任何报错"）。

⚠️ **重建前必须先结束所有 `TiBrowser.exe`**，否则链接会报
`LNK1104: 无法打开文件 TiBrowser.exe`。

## 6. 下一步（按价值排序）

1. **确认"开第二个标签页崩溃"已彻底修好**（根因与证据见 §3 第 12 条）。
   修复方式是"只切可见性、不摘视图"；`--tib-legacy-detach` 保留旧行为供复现验证。
   验收标准：`npm run acceptance` 的"三标签页稳定 60 秒"用例通过。
2. **安装器**：已完成（`installer/`，自研、零外部依赖、用户级安装）。
   仍缺的是**代码签名** —— 需要证书，无法在本机解决。
3. **能效四档的进程模型**：目前只有 `--renderer-process-limit` 这一层，
   缺预加载（fast）、标签休眠（low）、退出即释放（ondemand）的真实实现。
4. **增强型防护的云端部分**：需要用户配置服务商 Key，否则只能本地启发式。
5. **补齐 Chrome 常见能力**：右键菜单、密码管理、打印、阅读模式、页面翻译。
6. **根治网络服务崩溃**：它是环境层面的问题（换 CEF 版本 / 换机器对比）。
7. **扩展的实际加载生效**：`.crx` 解包与清单读取已完成，
   但 Chromium 侧的 `LoadExtension` 尚未接入（当前只登记在扩展列表里）。
