# TIbrowser

> 基于 Chromium 内核的 AI 安全浏览器 —— 拥有 Chrome 的大部分功能，内置 AI 助手与本地安全服务。

TIbrowser 使用 **Electron（内嵌 Chromium 内核）+ React + TypeScript** 构建。它不依赖任何 Google 账号/同步服务，AI 能力完全由用户自备的 **OpenAI 兼容 API**（DeepSeek / OpenAI / 通义千问 / Moonshot / 智谱 …）驱动。

## ✨ 功能特性

### 浏览器核心（Chrome 大部分功能）
- 多标签页浏览（新建 / 切换 / 关闭 / 中键关闭 / 拖拽排序接口）
- 智能地址栏（Omnibox）：URL 与搜索自动识别、历史联想、安全状态标识
- 前进 / 后退 / 刷新 / 主页、缩放、页内查找、全屏
- 书签（星标收藏、书签栏、书签管理器）
- 历史记录（自动记录、清理）
- 下载管理（进度显示、打开 / 定位文件、可疑文件拦截）
- 无痕（隐身）浏览窗口
- 新标签页（搜索框 + 快捷方式速拨）
- 完整菜单与快捷键（Ctrl+T / W / L / F / D / R / +/- / 0 等）
- 浅色 / 深色 / 跟随系统三套主题

### AI 助手（用户自备 API Key）
- 内置对话侧边栏，流式输出
- 「总结当前页面」：一键提取网页正文并生成中文摘要
- API Key 使用系统安全存储（`safeStorage`）加密落盘，绝不明文保存
- 支持任意 OpenAI 兼容服务商，填 API 地址 + Key + 模型名即可

### 本地安全服务（保证上网安全）
- **钓鱼 / 恶意网址拦截**：本地黑名单 + 启发式扫描（裸 IP、同形异义仿冒域名、可疑关键词）
- **HTTPS 自动升级**
- **广告拦截** 与 **追踪器拦截**（基于域名黑名单）
- **可疑下载拦截**（.exe / .msi 等）
- 黑名单支持运行时扩展（`resources/blocklists/*.txt`）

### 界面
- 模仿 Chrome 的简洁 UI，自绘标题栏与标签栏
- **毛玻璃（Acrylic）效果**，可在设置中一键关闭以适配低性能设备
- 低性能设备优化：后台标签节流、沙箱隔离、可关闭毛玻璃

## 📁 目录结构

```
TIbrowser/
├── src/                        # 源代码
│   ├── main/                   # Electron 主进程（窗口/标签页/安全/AI/存储）
│   ├── preload/                # 预加载脚本（contextBridge 桥接）
│   ├── renderer/               # React 渲染进程（UI）
│   └── shared/                 # 跨进程共享的类型与常量
├── resources/blocklists/       # 可扩展的本地黑名单
├── build/                      # 打包资源（图标）
├── release/                    # 最终用户使用的构建产物（由打包命令生成）
├── electron.vite.config.ts
├── electron-builder.yml
└── package.json
```

## 🚀 快速开始

### 前置要求
- **Node.js ≥ 20**（当前环境尚未安装，请先到 <https://nodejs.org> 下载 LTS 版本并安装）
- Windows 10/11（毛玻璃效果需 Windows 11）

### 开发调试
```bash
npm install
npm run dev          # 启动开发模式（热更新）
```

### 类型检查
```bash
npm run typecheck
```

### 打包（输出到 release/）
```bash
npm run build:win    # 生成 NSIS 安装包 → release/TIbrowser Setup 0.1.0.exe
npm run build:dir    # 仅生成免安装目录 → release/win-unpacked/
```

> **国内网络加速**：Electron 二进制默认从 GitHub 下载，国内可能很慢。可先设置镜像再安装/打包：
> ```bash
> export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
> ```
> **npm 11+ 说明**：新版 npm 默认会拦截依赖的安装脚本，本项目已在 `package.json` 的 `allowScripts` 中放行 `electron` 与 `esbuild`；若仍被拦截，执行 `npm approve-scripts electron esbuild` 即可。

## ⚙️ 配置说明

1. **AI 助手**：打开「设置 → AI 助手」，填入你的服务商信息，例如：
   - DeepSeek：API 地址 `https://api.deepseek.com/v1`，模型 `deepseek-chat`
   - OpenAI：API 地址 `https://api.openai.com/v1`，模型 `gpt-4o-mini`
2. **应用图标**：已使用项目根目录的 `ico.png` 作为图标（放大后的 512×512 副本在 `build/icon.png`，由 `electron-builder.yml` 的 `win.icon` 引用）。换图标只需替换 `build/icon.png` 后重新打包。
3. **扩展黑名单**：向 `resources/blocklists/*.txt` 追加域名，重启生效。

## ⚠️ 说明与限制

- 这是教学/个人用途的参考实现，**不包含 Google 账号同步与扩展商店（Chrome Web Store）**。
- 内置黑名单为演示样例，正式使用请接入真实、及时更新的威胁情报源。
- 首次 `npm install` 会下载 Electron 运行时（约 100MB+），请保持网络畅通。
- 本仓库未初始化 git，如需版本管理可执行 `git init`。

## 🛠 技术栈

Electron 33 · React 18 · TypeScript 5 · electron-vite 2 · electron-builder 25
