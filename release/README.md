# release —— 最终用户使用的部分

运行 `npm run build:win` 后，electron-builder 会把打包产物输出到本目录。

## 目录内容

| 文件 | 说明 |
|---|---|
| `TIbrowser-1.0.0-beta-x64-setup.exe` | Windows 64 位安装包（推荐） |
| `TIbrowser-1.0.0-beta-ia32-setup.exe` | Windows 32 位安装包 |
| `TIbrowser-1.0.0-beta-arm64-setup.exe` | Windows ARM64 安装包 |

> Linux（AppImage）与 macOS（dmg）版本需在对应系统上构建（`npx electron-builder --linux` / `--mac`），配置见 `electron-builder.yml`。

## 说明

- 安装包已纳入版本管理，用户可直接从 GitHub 下载，见 [主 README](../README.md)。
- `.blockmap` / `latest.yml` 为自动更新元数据（未启用自动更新），随构建生成、未提交到 git。
- 应用图标来自 `build/icon.png`，换图标只需替换该文件后重新打包。

## 源码与产物分离

- 源代码位于上一级 `src/` 目录。
- 本 `release/` 目录存放最终用户使用的构建产物。
