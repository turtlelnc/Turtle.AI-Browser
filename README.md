# TIbrowser —— 基于 Chromium 内核的 AI 浏览器

> 真正的 Chromium 内核（CEF）+ React 外壳 + 可选 AI 边车服务。
> 我们的官网 turtleweb.cc.cd ——— 基于 [README.md](https://github.com/turtlelnc/Turtle.AI-Browser/blob/main/README.md) 的内容进行 **生动立体** 的解释
> [🔗 点击前往官网](https://turtleweb.cc.cd)

[![Version](https://img.shields.io/badge/version-v1.0.1--rc2%20(build%20260918)-orange.svg)](#)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Chromium](https://img.shields.io/badge/Chromium%20%2F%20CEF-150-4285F4.svg)](https://cef-builds.spotifycdn.com/)
[![React](https://img.shields.io/badge/React-18-61dafb.svg)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933.svg)](https://nodejs.org/)

**当前版本：`v1.0.1-rc2 (build 260918)`** —— 发布通道为 **rc（候选发布）**，功能已落地但稳定性仍在收敛，请勿用于重要场合。

> 说明与免责：本项目为参考实现，按「现状」提供，可能出现错误。本软件仅供日常使用，不能用于重要场合。

## 🧭 架构

**v1.0.0-rc1 起舍弃 Electron 运行时。** 浏览器主程序是**原生 C++ 可执行文件**，直接链接
**CEF（Chromium Embedded Framework）**，也就是**真正的 Chromium 内核**（Chromium 150 / CEF 150），
不再有「Electron 内嵌 Chromium」这一层中间商。

- **浏览器本体**：原生 C++ + CEF，窗口、标签、地址栏、安全浏览、无痕、能效策略都在这一层。
- **进程模型（请如实理解）**：默认运行在**单进程兼容模式**——本机网络服务子进程无法启动
  （见 [`docs/STATUS.md`](docs/STATUS.md) §3），多进程宿主会直接白屏。因此默认档位下
  renderer 与网络服务都在主进程内，**没有 renderer 沙箱隔离**；命令行加 `--multi-process`
  可切回标准多进程模型。启动日志与「关于」页都会如实显示当前进程模型，不假装是标准隔离。
- **AI / 存储 / 自动化**：由一个**可选的 Node 边车进程**（`tib-service`）承载，
  通过 `127.0.0.1` 上的 HTTP + SSE（随机端口 + Bearer token）与浏览器通信。
  边车是独立进程，可关闭；在「即开即用」能效档下不启动边车，此时 AI 能力降级并明确提示。
- **UI**：React 18 + TypeScript 5 绘制的浏览器外壳（标签栏 / 地址栏 / 菜单 / 侧边栏），
  **Apple 风格**，可切换 **TiBrowser / Edge / Chrome 三套皮肤**。

接口契约（`window.tib` 桥、RPC、安全档位、共享类型）以
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 为唯一事实来源。

## ✨ 功能特性（v1.0.1-rc2 十五项）

### 1. 完全 Chromium 内核
浏览器主程序直接链接 CEF，运行真正的 Chromium 150 内核，多进程架构与 renderer 沙箱均来自 Chromium 本体。

### 2. Edge / Chrome 全量能力 + UI 大更新
对齐 Edge / Chrome 的日常浏览能力（多标签、Omnibox 地址栏联想、书签栏、历史、下载、页内查找、
缩放、全屏、快捷键），并配套一次 UI 大更新。

**网页右键菜单**（原生 Views 菜单，22 个条目按上下文动态启用/禁用）：返回 / 前进 / 重新加载 / 停止加载、
在新标签页中打开链接·图片、复制链接地址·图片地址、链接另存为、图片另存为、撤销 / 重做 / 剪切 / 复制 /
粘贴 / 删除 / 全选、搜索选中内容、放大 / 缩小 / 重置为 100%、打印为 PDF、查看页面源代码、检查元素。

### 3. Microsoft / Google 账户登录与同步
支持 Microsoft 与 Google 账户登录，并提供同步状态与手动同步入口
（`tib.signIn(provider)` / `tib.getSyncState()` / `tib.syncNow()`）。
> 需用户自备 OAuth client id；云端同步能力**尚不完整**，详见「已知限制」。

### 4. 无痕模式 2.0 / 指纹可改
无痕模式升级为**无痕++**：不留历史、不写书签、关窗即清会话，并支持**指纹改写**
（User-Agent、平台、时区、语言、屏幕、CPU 并发数、DNT，以及 Canvas / WebGL 噪声，可一键随机化）。
改写脚本在无痕窗口每次主框架开始加载时注入，**并在页面加载完成后把页面自己读到的值回读回来做逐项比对**
（日志里的「无痕指纹回读 / 无痕指纹比对」，验收脚本会断言「不一致 0 项」）。
> 诚实说明：只做到页面级属性改写 + 噪声，**不是完整的指纹隔离**；也没有使用独立的
> `RequestContext`（单进程模式下创建它会崩溃），因此 Cookie 仍写入默认 profile 分区。
> 详见 [`docs/STATUS.md`](docs/STATUS.md)。

### 5. 安全浏览三档
| 档位 | 值 | 中文说明 |
|---|---|---|
| **增强型防护** | `enhanced` | 实时比对更多站点数据；对未知危险站点也警告（可忽略）；深度扫描可疑下载；登录后跨服务保护；发送混淆后的 URL 片段 + 少量页面内容 + 下载/扩展/系统信息样本。 |
| **标准防护** | `standard` | 通过可隐藏 IP 的隐私服务器发送混淆 URL 片段；可疑时补发完整 URL 与少量页面内容；本地黑名单 + 启发式。 |
| **不防护** | `none` | 不拦截；但仍保留「下载放行名单」提示（不阻断）。 |

### 6. 不安全安装包可保留 + turtlelnc 内容自动放行
可疑/不安全的下载不再被直接删除，用户可**选择保留**：下载在开始前先过一遍安全判定
（`CheckDownload`），命中可执行安装包（.exe/.msi/.bat/...）时**只警告不拦截**——
文件照常落盘、记录里标为「可疑」并写清中文原因，界面上可自行决定是否保留。
同时对 turtlelnc 相关内容自动放行、防误杀
（`github.com/turtlelnc/*`、`*.turtlelnc.*`、官网 `turtleweb.cc.cd` 及已签名发布物在任何档位下不拦截、不警告、不计入威胁统计）。

### 7. 生成网页应用
把任意网站一键安装为独立网页应用（`tib.installWebApp()`），可启动、可卸载，拥有独立窗口与应用列表。

### 8. TiBrowser / Edge / Chrome 皮肤切换
一套外壳三套皮肤，切换即生效（`tib.setSkin()`），布局与交互随皮肤调整。

### 9. AI 连接支持 API / MCP / OAuth(SDK)
AI 接入方式三种并存：**OpenAI 兼容 API**、**MCP 客户端**（工具/上下文扩展）、**OAuth(SDK) 登录**，
用户可继续使用自备的 DeepSeek / OpenAI / 通义千问 / Moonshot / 智谱等服务。

### 10. 整合各浏览器优点
把 Chrome 的兼容与性能、Edge 的侧边栏与效率、以及国内浏览器的实用细节整合到同一外壳下。

### 11. 一个浏览器解决所有事
浏览、AI 对话与智能体、安全防护、办公与开发模式、网页应用、账户与同步，都在同一个浏览器内完成。

### 12. AI 侧本地办公模式与本地开发模式
- **本地办公模式（WorkBuddy 能力）**：文档整理、总结、写作、表格/邮件等日常办公任务。
- **本地开发模式（Tare / codex 能力）**：代码读写、终端类任务、仓内改动等开发工作流。

### 13. 能效四档
| 档位 | 值 | 说明 |
|---|---|---|
| **标准** | `standard` | 默认档，性能与功耗平衡。 |
| **快速** | `fast` | 优先响应速度，前台优先调度。 |
| **低占用** | `low` | 降低后台与渲染开销，适合多标签长驻。 |
| **即开即用** | `instant` | 预加载与快速启动优先（此档不启动 AI 边车，AI 能力降级并提示）。 |

四档通过 `tib.setEnergyMode(m)` 切换，底层对应 `process-per-site` / 预加载 / 隐藏节流 / 即开即用策略。

### 14. Apple 风格 UI 优化
以 Apple 设计语言重做视觉与动效：留白、圆角、层级、过渡曲线，兼顾浅色 / 深色 / 跟随系统。

### 15. 面向用户自有 AI 工具 / CLI / harness 的本地控制接口
边车暴露本地自动化 API（`tib.automationInfo()` 返回 `baseUrl` 与一次性 `token`），
供用户自己的 AI 工具、CLI、harness 驱动浏览器。

## 📥 下载与安装

### Windows 10/11

| 架构 | 安装包 | 适用 |
|---|---|---|
| **x64**（64 位） | `TiBrowserSetup.exe` + 同级的 `dist/` | 绝大多数电脑（推荐） |

当前发布只提供 **x64**。x86（32 位）与 ARM64 需要相应的 CEF 发行包并另行构建，本版本未产出。

1. 把 `TiBrowserSetup.exe` 与 `dist/` 放在**同一个文件夹**里，双击安装包，按向导完成安装
   （用户级安装到 `%LOCALAPPDATA%\Programs\TiBrowser`，不需要管理员权限）
2. 从桌面或开始菜单启动 **TiBrowser**

> 首次运行 Windows SmartScreen 可能提示「未知发布者」，点击「更多信息 → 仍要运行」即可（本安装包**未做代码签名**）。

### Linux / macOS

Linux（AppImage）与 macOS（dmg）产物**需在对应系统或 CI 上构建**，无法在 Windows 上交叉打包。

> **从 v0.1.0 / 1.0.0-beta 升级**：内核与数据目录均已更换，**旧配置不会自动迁移**，详见
> [`release/README.md`](release/README.md) 的「升级说明」。

## 🛠️ 从源码构建

### 前置要求

| 依赖 | 版本 |
|---|---|
| **Node.js** | ≥ 20（构建边车与 UI） |
| **CMake** | ≥ 3.21 |
| **Ninja** | 任意近期版本 |
| **MSVC** | Visual Studio 2022 / 2026 Build Tools（含 C++ 桌面工作负载） |
| **Windows SDK** | 随 Build Tools 安装 |

### 构建步骤

```bash
# 0) 拉取 CEF 内核（来自 cef-builds.spotifycdn.com，体积较大，只需一次）
npm run fetch:cef

# 1) 构建 React 外壳 UI
npm run ui:build

# 2) 构建 Node 边车服务
npm run service:build

# 3) 配置并编译原生浏览器（C++ / CEF）
npm run native:configure
npm run native:build

# 4) 运行
npm run native:run
```

### 打包与分发

```bash
npm run dist          # 组装免安装发行目录 → release/dist（约 417 MB）
npm run native:setup  # 编译安装器 → build-installer/TiBrowserSetup.exe
npm run check         # 发行一致性自检（版本号/许可证/产物/危险残留）
```

分发时把 `TiBrowserSetup.exe` 与 `dist/` 放在**同一个文件夹**里：

```
TiBrowser-1.0.1-rc2-win-x64/
├── TiBrowserSetup.exe   # 双击安装（用户级，不需要管理员）
└── dist/                # 程序本体（安装器的 payload）
```

安装器支持 `--silent`（静默）、`--dir=<路径>`（指定目录）、`--uninstall [--silent]`（卸载）。
也可以完全跳过安装：直接把 `dist/` 复制到任意位置运行 `TiBrowser.exe`。

> 安装器为自研实现（`installer/setup.cpp`）：本机没有 NSIS / Inno Setup / 7-Zip，
> 且 winget 装包会卡在网络上，因此用 MSVC 工具链自带能力实现，依赖为零。
> 未做代码签名，Windows SmartScreen 会提示"未知发布者"。

其他可用脚本：`npm run ui:dev`（UI 热更新开发）、`npm run service:test`（边车自检）。

> **镜像提示**：`ELECTRON_MIRROR` 那一套镜像配置**已经不再需要**——rc2 的浏览器主程序不依赖
> Electron，内核由 `scripts/fetch-cef.mjs` 从 `cef-builds.spotifycdn.com` 获取。
> 但如果你在国内，`npm install` 仍建议配置 npm 镜像以加速依赖下载：
> ```bash
> npm config set registry https://registry.npmmirror.com
> ```

## 📁 目录结构

与 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §2 的契约一致：

```
Turtle.AI-Browser/
├── native/                 # C++ 原生浏览器（CEF）：窗口/标签/本地 HTTP/安全/无痕/能效/边车通信
│   ├── CMakeLists.txt
│   ├── include/
│   └── src/
├── installer/              # 自研原生安装器（Win32 + Shell API，零外部依赖）
├── service/                # Node 边车：AI（API/MCP/OAuth）、存储、办公/开发模式、自动化 API
│   └── src/
├── src/
│   ├── shared/             # 三方共享类型与常量（唯一契约）
│   ├── bootstrap/          # 注入脚本（window.tib 桥接）
│   ├── renderer/           # React 浏览器外壳 UI
│   └── main/ preload/      # v0.1.0 的 Electron 实现，已退役，仅作只读参考
├── resources/              # 黑名单、诊断页、内置页面
├── docs/                   # 架构、状态、接口文档
├── scripts/                # 取内核 / 构建 / 打包 / 自检脚本
└── release/                # 最终用户使用的部分（安装器与发行目录）
```

> ⚠️ `src/main/` 与 `src/preload/` 存放 **已退役的 v0.1.0 Electron 实现，仅供查阅参考**，
> 不参与 rc2 的构建，也不要在此基础上改功能。
>
> 📌 实现状态与踩过的坑见 [`docs/STATUS.md`](docs/STATUS.md) —— 改代码前建议先读它的 §3。

## ⚠️ 已知限制

以下限制是**已知且未完全解决**的，请据此判断是否适合你的场景：

- **通道为 rc**：功能已落地但稳定性仍在收敛，**可能崩溃**，请勿用于重要场合，注意备份数据。
- **默认单进程兼容模式**：本机网络服务子进程无法启动，因此默认无 renderer 沙箱隔离；
  `--multi-process` 可切回多进程模型（需所在机器能启动网络服务子进程）。
- **不支持运行浏览器扩展**：CEF 150 已**移除扩展 API**（头文件里既没有 `LoadExtension`
  也没有 `CefExtensionHandler`），因此「扩展程序」页只提供**导入 / 解包（.crx 与 zip）/ 清单校验 /
  登记 / 启用禁用 / 删除**，**不会真正运行**扩展的脚本与后台任务，界面上也如实标注了这一点。
- **未实现系统打印对话框**：提供「打印为 PDF」（右键菜单 → 打印为 PDF…，落盘到数据目录
  `Downloads/`），但 `window.print()` 与系统打印机流程未接入（需要完整的 `CefPrintHandler`）。
- **本地黑名单仅为样例**：未接入真实、及时更新的威胁情报源，防护效果有限。
- **增强型防护部分能力本地不可用**：其中依赖 Google 云端的能力（如实时站点比对、登录后跨服务保护）
  在本实现中不可用，**界面会明确标注**，不会假装生效。
- **账户同步不完整**：登录与同步需要用户**自备 OAuth client id**；云端同步能力**尚不完整**。
- **安装包未做代码签名**：SmartScreen 会提示「未知发布者」，正式分发建议配置签名证书。
- **Linux / macOS 产物需在对应系统或 CI 上构建**，Windows 上无法交叉打包。
- **性能与兼容数据未做基准测试**：本项目不提供、也未发布任何跑分或兼容性基准数字，
  请以你自己的实际体验为准。

## 📄 许可证

[GPL-3.0](LICENSE)
