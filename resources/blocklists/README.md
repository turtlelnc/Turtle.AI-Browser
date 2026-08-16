# 本地黑名单扩展

TIbrowser 的安全服务启动时，会合并两类数据源：

1. **内置黑名单**：`src/main/security/blocklists/blocklist.json`（编译进应用）。
2. **运行时黑名单**：本目录下的 `malware.txt` / `phishing.txt` / `ads.txt` / `tracking.txt`。

## 格式

每行一个域名，支持注释（`#` 开头）与 hosts 文件常见前缀（`0.0.0.0` / `127.0.0.1`）：

```
# 广告域名
0.0.0.0 ad.example.com
tracker.example.net
```

## 使用真实威胁情报

将公开的恶意/钓鱼域名源（URLhaus、PhishTank、开源 hosts 列表等）转换为上述四个 `.txt` 文件后放入本目录，重新启动应用即可自动生效，无需改动代码。打包后该目录位于安装目录的 `resources/blocklists/`。

> 注意：内置列表为演示用样例，请务必替换为真实、及时更新的情报源以保证防护效果。
