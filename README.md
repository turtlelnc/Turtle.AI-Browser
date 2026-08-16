# TIbrowser - 中文版

> 基于 Chromium 内核的 AI 安全浏览器 —— 拥有 Chrome 的大部分功能，内置 AI 助手与本地安全服务。

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-33-47848F.svg)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-18-61dafb.svg)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6.svg)](https://www.typescriptlang.org/)

TIbrowser 使用 **Electron（内嵌 Chromium 内核）+ React + TypeScript** 构建。它不依赖任何 Google 账号/同步服务，AI 能力完全由用户自备的 **OpenAI 兼容 API**（DeepSeek / OpenAI / 通义千问 / Moonshot / 智谱 …）驱动。

> 软件局限性与安全局限性：本软件仅供日常使用，不能用于重要场合；本软件由Deepseek V4-Pro生成，可能出现错误。

## ✨ 功能特性

### 浏览器核心（Chrome 大部分功能）
- 多标签页浏览（新建 / 切换 / 关闭 / 拖拽排序）
- 智能地址栏（Omnibox）：URL 与搜索自动识别、历史联想、安全状态标识
- 前进 / 后退 / 刷新 / 主页、缩放、页内查找、全屏
- 书签（星标收藏、书签栏、管理器）、历史记录、下载管理
- 无痕（隐身）浏览窗口、新标签页（搜索框 + 快捷方式速拨）
- 完整菜单与快捷键（Ctrl+T / W / L / F / D / R / +/- / 0 等）
- 浅色 / 深色 / 跟随系统三套主题、毛玻璃（Acrylic）效果

### AI 助手与智能体
- 内置对话侧边栏，流式输出
- **AI 智能体**：可调用浏览器工具（控制网页、帮用户设置、抓包、读写页面等），4 档权限控制（关闭 / 日常 / 开发 / 全部）
- 快捷功能：总结 / 翻译 / 润色 / 解释代码 / 生成笔记 / 写邮件
- API Key 使用系统安全存储（`safeStorage`）加密落盘，绝不明文保存

### 本地安全服务
- 钓鱼 / 恶意网址拦截：本地黑名单 + 启发式扫描（裸 IP、同形异义仿冒域名、可疑关键词）
- HTTPS 自动升级、广告拦截、追踪器拦截、可疑下载拦截
- 黑名单支持运行时扩展（`resources/blocklists/*.txt`）

### 扩展与数据迁移
- 扩展程序：开发者模式 + 本地加载 `.crx` / 已解压的扩展
- 配置文件同步：一键导出 / 导入 `.tbuser` 文件，跨电脑迁移

## 📥 下载与安装

### 方式一：下载安装包（Windows）

到本仓库 [release](release/) 目录下载安装包，或直接点击：

[⬇️ 下载 TIbrowser Setup 0.1.0.exe](release/TIbrowser%20Setup%200.1.0.exe)（约 79 MB）

1. 双击运行安装包，按向导完成安装
2. 从桌面或开始菜单启动 **TIbrowser**

> 首次运行 Windows SmartScreen 可能提示「未知发布者」，点击「更多信息 → 仍要运行」即可（本安装包未做代码签名）。

### 方式二：从源码构建

见下方 [本地开发](#-本地开发)。

## 🚀 使用指南

### 配置 AI 助手

1. 打开右上角「⋮」菜单 → **设置**，或点击侧边栏的齿轮
2. 在「AI 助手」中填入你的服务商信息：
   - **DeepSeek**：API 地址 `https://api.deepseek.com/v1`，模型 `deepseek-chat`
   - **OpenAI**：API 地址 `https://api.openai.com/v1`，模型 `gpt-4o-mini`
3. 填入 API Key，点击「保存设置」

### 使用 AI 智能体

在 AI 侧边栏顶部的「控制权限」中选择档位：
- **关闭**：仅普通对话
- **日常**：可控制网页、帮你设置等安全操作
- **开发**：额外增加抓包、执行 JS、读源码等开发功能
- **全部**：完全控制浏览器（含清空数据等危险操作，请谨慎开启）

### 安装扩展

设置 → 扩展程序 → 开启「开发者模式」→ 加载 `.crx` 或已解压的扩展。

## 🛠️ 本地开发

### 前置要求
- **Node.js ≥ 20**
- Windows 10/11（毛玻璃效果需 Windows 11）

### 开始
```bash
git clone git@github.com:turtlelnc/Turtle.AI-Browser.git
cd Turtle.AI-Browser
npm install
npm run dev          # 开发模式（热更新）
```

### 构建与打包
```bash
npm run typecheck    # 类型检查
npm run build        # 编译
npm run build:win    # 打包 → release/TIbrowser Setup 0.1.0.exe
npm run build:dir    # 免安装目录 → release/win-unpacked/
```

> **国内网络加速**：Electron 二进制默认从 GitHub 下载，国内可能很慢，可先设置镜像：
> ```bash
> export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
> ```

## 📁 目录结构

```
Turtle.AI-Browser/
├── src/                        # 源代码
│   ├── main/                   # Electron 主进程（窗口/标签页/安全/AI/存储）
│   ├── preload/                # 预加载脚本（contextBridge 桥接）
│   ├── renderer/               # React 渲染进程（UI）
│   └── shared/                 # 跨进程共享的类型与常量
├── resources/blocklists/       # 可扩展的本地黑名单
├── build/                      # 打包资源（图标）
├── release/                    # 构建产物（安装包等）
├── electron.vite.config.ts
├── electron-builder.yml
└── package.json
```

## 🛠️ 技术栈

Electron 33 · React 18 · TypeScript 5 · electron-vite 2 · electron-builder 25

## ⚠️ 说明与限制

- **不包含 Google 账号同步与 Chrome 扩展商店**。
- Electron 对 Chrome 扩展 API 支持有限，只有内容脚本/后台脚本类扩展能较完整运行。
- 内置黑名单为演示样例，正式使用请接入真实、及时更新的威胁情报源。
- 安装包未做代码签名，正式分发建议配置签名证书。

## 📄 许可证

[GPL-3.0](LICENSE)
