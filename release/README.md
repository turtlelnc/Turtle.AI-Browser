# release —— 最终用户使用的部分

运行 `npm run build:win` 后，electron-builder 会把打包产物输出到本目录。

## 目录内容

- `TIbrowser Setup 0.1.0.exe` — NSIS 安装包（**已纳入版本管理**，用户可直接从 GitHub 下载）
- `win-unpacked/` — 免安装的解包版（体积大，不提交到 git）

## 说明

- 安装包 `TIbrowser Setup 0.1.0.exe`（约 79 MB）已提交到仓库，见 [主 README](../README.md) 的「下载与安装」。
- `win-unpacked/` 因包含超过 GitHub 单文件上限（100MB）的 `TIbrowser.exe`（约 181MB），不随仓库提交；需要时运行 `npm run build:dir` 本地生成。
- 应用图标来自 `build/icon.png`（`electron-builder.yml` 的 `win.icon` 引用），换图标只需替换该文件后重新打包。

## 源码与产物分离

- 源代码位于上一级 `src/` 目录。
- 本 `release/` 目录存放最终用户使用的构建产物。
