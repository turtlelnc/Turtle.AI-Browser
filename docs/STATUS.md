# TiBrowser v1.0.1-rc2 当前状态（build 260918）

> 本文件是**当前实现的权威状态记录**。只写已验证的事实，不写愿望。
> 最后更新：rc2（多标签崩溃与关窗不退出已修 + 右键菜单 + 下载管线 + 指纹回读验证 +
> 版本号全线对齐 + 9 个用例 43 项断言的验收脚本全绿）

## 1. 一句话状态

**骨架与日常路径已经可用，验收脚本全绿**：原生 Chromium 内核、界面渲染、真实外网页面、
多标签稳定、书签/历史/下载/设置/皮肤/无痕指纹/安全档位/账户/网页应用/快捷键/右键菜单/
下载安全判定全部可用且都有日志或文件证据；扩展可解包登记但**内核不执行扩展脚本**（CEF 已移除扩展 API）。

**仍然存在的实质缺口**（不掩盖）：默认跑单进程兼容模式（无 renderer 沙箱隔离，因为本机
网络服务子进程起不来）、没有系统打印对话框、没有密码管理器、没有阅读模式与页面翻译、
云端同步与增强型防护需要用户自备凭据、安装包未做代码签名。

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
| 多标签稳定性 | 3 标签页连续存活 60 秒（此前必崩的场景）；快捷键自检 40 秒；`--multi-process` 下 2 标签 30 秒 |
| 关窗即退出 | `--tib-close-after=8000` → 9.1 秒内进程退出，退出码 0，日志 `最后一个窗口已销毁，结束消息循环` + `收尾完成，进程退出` |
| 网页右键菜单 | `右键菜单自检：合成上下文（链接+图片+可编辑+有选区）构造出 22 项` + `模型自身状态 … 重做=禁用 … 重置为 100%=禁用` + `可用性判断 正确`；`--tib-menu-probe=show` 实测弹出后自己收起、进程继续存活 |
| 下载落盘与安全判定 | `下载开始…/下载完成：…（68 字节）`，文件真实存在于 `<数据目录>\Downloads\`，`downloads.json` 记录 `state=completed`；`.exe` 探针 → `已标记为可疑，可自行保留` 且文件仍保留（需求 6） |
| 无痕指纹真的生效 | 预置 `language=en-GB / timezone=Asia/Tokyo / cores=4 / screen=2560x1440 / DNT=1` 后启动无痕窗口：`无痕指纹比对：一致 6 项、跟随系统 2 项、不一致 0 项`（页面自己回读的值） |
| 阅读模式 | `--tib-reader-probe`（文章探针页）：`阅读模式：已进入（标题=Chromium 嵌入方案里的正文提取为什么难，正文 865 字符、6 段）` → `阅读模式：已退出，页面恢复原样`，进程稳定 30 秒。标题取自正文 h1 而非页面标题，可证明提取的是正文而非整页 |
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
| 2 | 具备 Chrome/Edge 的内容能力 | 🟡 大体可用 | 导航、标签、书签、历史、下载、缩放、页内查找、**键盘快捷键**、**网页右键菜单（22 项，按上下文启用/禁用）**、**阅读模式（F9）**、**打印为 PDF** 已可用；密码管理、系统打印对话框、页面翻译尚未做 |
| 3 | 登录 Microsoft/Google 并同步 | 🟡 部分 | 登录态、同步开关与状态已实现；**云端同步需自备 OAuth client id**，否则明确报错；可用的实际同步方式是本地文件夹 |
| 4 | 无痕模式 2.0（可改指纹） | 🟡 部分 | 指纹画像的编辑/随机化/持久化已完成，注入后在页面里**回读验证一致 6 项、不一致 0 项**；受单进程模式限制无法使用独立 `CefRequestContext`，因此不等同于最严格的 incognito 语义（代码内已注明） |
| 5 | 三档安全浏览 | 🟡 部分 | 三档设置、拦截执行、本地黑名单、启发式扫描、统计已可用；**增强型依赖云端威胁库的能力本地不可用**，界面明确标注 |
| 6 | 不安全安装包可保留 + turtlelnc 自动放行 | ✅ 已完成 | 下载**真正接入**了判定（`CheckDownload`）：`.exe/.msi/...` 只警告不拦截、文件照常保留并在记录里标可疑+中文原因；turtlelnc 在任何档位放行 |
| 7 | 生成网页应用 | ✅ 已完成 | 安装/卸载/启动 + `appsChanged` 事件 |
| 8 | TiBrowser/Edge/Chrome 皮肤切换 | ✅ 已完成 | 94 个设计令牌、三套皮肤，运行时切换并持久化（实测重启后 `skin=edge` 生效） |
| 9 | AI 连接：API / MCP / OAuth(SDK) | 🟡 部分 | 边车已实现 OpenAI 兼容协议、MCP stdio 客户端、OAuth PKCE 回环；原生侧异步转发已通；**需要用户自备凭据** |
| 10 | 整合各浏览器优点 | ✅ 持续进行 | 架构上已统一（见 §3） |
| 11 | 一个浏览器解决所有事 | 🟡 持续进行 | 地基已通，功能在补齐 |
| 12 | 本地办公模式 / 本地开发模式 | 🟡 部分 | 边车已实现能力清单与执行器（含沙箱工作区、命令白名单、演练模式）；原生转发已通，界面可调用 |
| 13 | 能效四档 | 🟡 部分 | 四档设置、持久化、差异化进程开关、快速模式**按物理内存真实探测**（并把判定理由回给界面）已完成；缺的是实测各档内存占用曲线与自动推荐档位 |
| 14 | Apple 风格 UI | ✅ 已完成 | 设计令牌、动效、低性能降级（`data-perf`）齐备 |
| 15 | 供用户自有 AI 工具/CLI 操控的接口 | ✅ 已完成 | 边车提供 HTTP + WebSocket 自动化 API，带 Bearer 鉴权、39 个动作、默认关闭、发现文件 |
| — | 扩展加载（.crx / 已解压） | 🟡 只能登记 | 原生对话框选择、CRX2/CRX3 解包、清单读取、启用禁用、去重与删除均已完成，`downloads`/`extensions` 数据也补齐了 `fromCrx`；但 **CEF 150 已移除扩展运行 API**（头文件里没有 `LoadExtension`、也没有 `CefExtensionHandler`），所以扩展脚本与后台任务**不会被执行**。界面与 `extensions.runtime` 接口都如实说明这一点 |

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
3. **`CreateBrowserView` 的返回值只能有一份引用**。正确写法是把工厂返回的 `CefRefPtr`
   直接 `std::move` 给成员；用 `.get()` 会触发 `Check failed: !needs_adopt_ref_`，
   而旧的 `.release()` + 裸指针赋值会让引用计数变成 2 却只有一个持有者（视图与其
   `CefBrowser` 永不销毁，实测 `HasOneRef()` 由"是"变"否"）。
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
12. **在窗口创建过程中不要摘除已挂载的 BrowserView**。
    原实现用 `RemoveChildView(旧视图) + AddChildView(新视图)` 切换标签，
    当这件事发生在 `CefWindow::CreateTopLevelWindow` 还没返回时
    （`OnWindowCreated` / `--open=` / 快捷键自检都会走到这条路径），
    会让 CEF 内部的窗口/视图状态错乱，随后 UI 线程任务踩到空对象而 AV。
    实测证据（崩溃处理器落盘到 `build-native/tibrowser-crash.log`）：
    ```
    异常码=0xC0000005  线程=UI 线程
    访问违例：读取 地址 0x00000000000000F0
    RIP=libcef+0x43208B0   RAX=0x0  RCX=0xF0        ← 空对象上的虚调用
    #00 libcef+0x43208B0   #01 libcef+0x1FB2F38   #02 libcef+0x3AA929
    #12 TiBrowser.exe+0x2EC6  wWinMain+0x1716       ← CefRunMessageLoop()
    ```
    **精确的触发条件**（做了时间对照实验，这一点很关键）：
    - 旧行为 + 第二个标签页**在 `OnWindowCreated` 内立即创建** → 1~14 秒内必崩；
    - 旧行为 + 第二个标签页**延后 150ms / 250ms / 800ms / 4000ms** 创建
      （即窗口创建完成之后再摘视图）→ 4/4 全部存活 ≥20 秒，**不崩**；
    - 修复版在同一时机**只挂新视图、不摘旧视图** → 稳定存活。
    所以不是"只要摘视图就崩"，而是"**在窗口创建过程中摘视图**"才崩。
    **修法仍建议统一为「只切可见性（`SetVisible`），视图一旦挂上就不再摘」** ——
    虽然窗口创建完成后再摘实测不崩，但这条路径依赖 CEF 内部时序，不值得赌。
    排查开关：`--tib-legacy-detach=create|activate|both` 可打开旧行为复现崩溃
    （2 标签页 2 秒内崩、切换场景 0.9 秒崩），默认关闭。
13. **`CefPostDelayedTask` 本身是可靠的**（此条为更正）。早期把"进程退出"归因于延迟任务，
    实际根因是第 12 条的"窗口创建过程中摘视图"，以及一个自检任务里存了**裸 `TibWindow*`**。
    更正依据：修复后 `StartUiDiagnostics` 的延迟探针每 2 秒跑一次，连续 60 秒正常执行。
    **教训**：延迟任务里必须用 `CefRefPtr<TibWindow>` 持有窗口（窗口的唯一保活引用是
    全局窗口表，`OnWindowDestroyed` 会把自己摘掉）。
    另一个实测限制：**视图菜单（`CefWindow::ShowMenu`）的嵌套消息循环不会派发 CEF 延迟任务** ——
    `--tib-menu-probe=show` 里安排的"1.5 秒后收起"实测在 `ShowMenu` 返回之后才执行。
14. **关窗后必须主动结束消息循环**。多进程模式下 CEF 会在最后一个顶层窗口关闭时
    自动退出消息循环，但**单进程兼容模式下不会** —— 实测关窗后进程一直挂着不退出。
    这对"即开即用"档位是直接的承诺违背（用户以为关了，进程还在占内存）。
    修法：`OnWindowDestroyed` 里在窗口表清空后调用 `CefQuitMessageLoop()`。

**崩溃诊断工具**：`native/src/main.cpp` 里装了「最后机会」异常过滤器
（`CrashRawAppend` + dbghelp），在进程真要死时把出错线程、指令地址、访问违例地址、
寄存器与调用栈写成 `build-native/tibrowser-crash.log`（纯 Win32 文件 API，
不走 CRT/iostream，避免堆已损坏时二次卡死）。这个项目后面还会遇到 CEF 内部崩溃，
有它就不必只靠 WER 事件猜偏移。

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
npm run acceptance        # rc 验收测试（会自行起停进程，约 7 分钟，9 个用例）
node scripts/acceptance.mjs --only=7   # 只跑某个用例（调试用）
```

排查用的命令行开关（都在 `native/src/window.cpp` 里，默认关闭）：

| 开关 | 用途 |
|---|---|
| `--diag` | 首个标签页改为脚本执行探针，周期性把 UI/页面状态回流日志 |
| `--shortcut-test` | 直接调用快捷键处理逻辑（本机无法真实按键） |
| `--tib-close-after=<ms>` | 到点走正常关窗路径，验证"关窗即退出" |
| `--tib-legacy-detach=create\|activate\|both` | 打开旧的"摘视图切标签"行为，用于复现历史崩溃 |
| `--tib-menu-probe[=show]` | 右键菜单自检（构造菜单并打印模型状态；`show` 会真实弹出） |
| `--tib-reader-probe` | 首个标签页换成文章探针，5 秒后进入阅读模式、12 秒后退出 |
| `--tib-download-probe[=<文件名>]` | 打开会触发下载的本地探针（带 `Content-Disposition: attachment`） |
| `--multi-process` | 退出单进程兼容模式（需要本机能启动网络服务子进程） |

⚠️ `ui:build` 之后必须让 `build-native/ui` 用上新产物（CMake POST_BUILD 会自动复制；
手动构建时容易漏，漏了就会用到**过期的 tib-host.js** —— 这个坑真实发生过，
症状是桥"完全不工作且没有任何报错"）。

⚠️ **重建前必须先结束所有 `TiBrowser.exe`**，否则链接会报
`LNK1104: 无法打开文件 TiBrowser.exe`。

## 6. 下一步（按价值排序）

1. **代码签名**：安装包与主程序都未签名，SmartScreen 会提示"未知发布者"。需要证书，本机无法解决。
2. **补齐 Chrome 常见能力**：密码管理器、系统打印对话框（需要完整 `CefPrintHandler`）、
   页面翻译。右键菜单、阅读模式与"打印为 PDF"已完成。
3. **能效四档**：差异化进程开关已落地（见 `native/src/app.cpp` 的 `ApplyEnergyModeSwitches`），
   快速模式按物理内存真实探测。仍缺：实测各档的内存占用曲线、以及"根据设备自动推荐档位"。
4. **增强型防护的云端部分**：需要用户配置服务商 Key，否则只能本地启发式。
5. **账户同步的云端部分**：需要用户自备 OAuth client id 与同步后端。
6. **根治网络服务崩溃**：它是环境层面的问题（换 CEF 版本 / 换机器对比），
   修好后可以退回多进程模式，从而恢复 renderer 沙箱与无痕的独立 `RequestContext`。
7. **扩展运行能力**：受限于 CEF 150 已移除扩展 API，本嵌入方案内无法实现；
   若将来确有需要，只能换用带扩展支持的 Chromium 嵌入方案（等于换内核方案）。
