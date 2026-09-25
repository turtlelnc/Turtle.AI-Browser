# TiBrowser 边车服务 API（tib-service）

> 适用版本：1.0.1-rc2 (build 260918)　｜　本文档由 `service/src/tools/gen-docs.ts` 自动生成，请勿手工编辑。

本文件描述 Node 边车（`tib-service`）对原生浏览器暴露的**本地 RPC 接口**，契约见 `docs/ARCHITECTURE.md` 第 4 节。

## 1. 传输与握手

| 项目 | 说明 |
|---|---|
| 监听地址 | `127.0.0.1`（仅回环，绝不监听 0.0.0.0） |
| 端口 | 默认 `0`（系统分配）；可用 `--port <n>` 指定 |
| 鉴权 | 每个请求都必须带 `Authorization: Bearer <token>`（32 字节随机 token） |
| 握手文件 | 启动后写入 `<userData>/service.json`：`{port, token, pid, version, build, updatedAt}` |
| 就绪信号 | stdout **只输出一行** JSON：`{"ready":true,"port":<n>,"version":"…","build":…,"capabilities":[…]}` |
| 日志 | 全部写 stderr，保证 stdout 干净 |

### 1.1 端点一览

| 端点 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/rpc/<method>` | POST | 需要 | 调用下面表格中的任意方法，请求体 `{"params":{…}}` |
| `/events?token=<t>` | GET | 需要（query 传 token） | SSE 事件流，事件名见 1.3 |
| `/health` | GET | **不需要** | `{ok, version, build, capabilities[]}`，不含敏感信息 |
| `/automation/<action>` | POST | 需要 | 本地自动化 API，见 [`AUTOMATION.md`](./AUTOMATION.md) |
| `/automation-ws?token=<t>` | WS | 需要（query 传 token） | 自动化 WebSocket 通道（事件推送 + 动作调用） |

### 1.2 响应格式

成功：

```json
{ "ok": true, "result": { } }
```

失败（`message` 一律中文，`code` 为机器可读常量）：

```json
{ "ok": false, "error": { "code": "unknown-method", "message": "未知的 RPC 方法：xxx" } }
```

| HTTP | code | 含义 |
|---|---|---|
| 400 | `bad-json` / `bad-param` | 请求体不是合法 JSON / 参数不合法 |
| 401 | `unauthorized` | 缺少或错误的 Bearer token |
| 404 | `unknown-method` / `not-found` | 方法不存在 / 端点不存在 |
| 500 | `handler-failed` / `internal` | 方法执行异常（细节见 stderr 日志） |

### 1.3 SSE 事件（与 ARCHITECTURE.md §3.2 对齐）

| 事件 | 载荷 |
|---|---|
| `aiChunk` | `{requestId, delta}` |
| `aiDone` | `{requestId, content}` |
| `aiError` | `{requestId, message}` |
| `aiTool` | `{requestId, name, detail, phase}` |
| `securityEvent` | `{url, verdict, action}` |
| `accountsChanged` | `{accounts, syncState}` |
| `appsChanged` | `WebApp[]` |
| `extensionsChanged` | `ExtensionInfo[]` |

连接建立后会先收到一帧 `event: ready`（含 subscriberId）。服务端每 **15 秒**发送一次心跳注释（`: heartbeat <ts>`），客户端断开时自动清理。

```bash
curl -N "http://127.0.0.1:<port>/events?token=<token>"
```

## 2. 方法清单

共 **65** 个方法。

### 2.1 账户与同步

| 方法 | 说明 |
|---|---|
| `accounts.backendInfo` | 查看当前同步后端信息与限制 |
| `accounts.getSyncState` | 读取同步状态（后端、上次同步时间、待同步数、冲突） |
| `accounts.list` | 列出账户记录（是否已登录、中文备注） |
| `accounts.setSyncFolder` | 设置同步目录（可指向 OneDrive 等网盘的本地同步文件夹） |
| `accounts.signIn` | 标记某服务商已登录（令牌必须已由 ai.oauth.* 写入，否则不会标记成功） |
| `accounts.signOut` | 登出某服务商（删除令牌，不删除本地数据） |
| `accounts.syncNow` | 立即同步（文件级；冲突需指定 keep-local 或 use-remote） |

### 2.2 AI · 对话与智能体

| 方法 | 说明 |
|---|---|
| `ai.abort` | 取消一个正在进行的流式请求（按 requestId） |
| `ai.agent` | 运行一次 AI 智能体（最多 8 轮工具调用）；工具执行回调原生浏览器 |
| `ai.providers` | 列出内置服务商预设（baseUrl / 默认模型 / 是否需要自备 client_id） |
| `ai.stream` | 发起一次流式对话：增量通过 SSE 的 aiChunk/aiDone/aiError 事件推送 |

### 2.3 AI · MCP 客户端

| 方法 | 说明 |
|---|---|
| `ai.mcp.addServer` | 添加（或覆盖）一个 MCP 服务器并立即尝试启动（stdio 传输） |
| `ai.mcp.callTool` | 调用 MCP 服务器上的工具 |
| `ai.mcp.listServers` | 列出 MCP 服务器及其状态（含已发现的工具） |
| `ai.mcp.removeServer` | 移除一个 MCP 服务器（停止进程并删除配置） |

### 2.4 AI · 本地办公 / 本地开发模式

| 方法 | 说明 |
|---|---|
| `ai.modes.dev` | 执行一项本地开发能力（读/写文件、运行命令、跑测试、生成补丁、解释报错） |
| `ai.modes.devStatus` | 查看本地开发模式沙箱状态（工作区根目录、演练模式、命令白名单） |
| `ai.modes.list` | 列出本地办公模式与本地开发模式的全部能力及其边界说明 |
| `ai.modes.office` | 执行一项本地办公能力（文档摘要/表格处理/邮件草拟/会议纪要/日程整理/演示大纲） |

### 2.5 AI · OAuth 2.0 (PKCE)

| 方法 | 说明 |
|---|---|
| `ai.oauth.buildUrl` | 仅生成授权 URL（不启动回环监听，便于自定义回调） |
| `ai.oauth.refresh` | 刷新 OAuth 令牌 |
| `ai.oauth.signOut` | 删除某服务商的 OAuth 令牌 |
| `ai.oauth.start` | 开始 OAuth 2.0 PKCE 回环授权：返回授权地址与回调地址（需用户自备 client_id） |
| `ai.oauth.status` | 查询某服务商的 OAuth 令牌状态（不返回令牌本身） |

### 2.6 AI · 工具清单

| 方法 | 说明 |
|---|---|
| `ai.tools` | 列出 AI 智能体可用工具（可按档位过滤） |

### 2.7 本地自动化 API

| 方法 | 说明 |
|---|---|
| `automation.actions` | 列出全部自动化动作（名称、分组、参数、是否高风险） |
| `automation.bridge` | 读取或设置原生浏览器自动化端点（baseUrl + token） |
| `automation.info` | 读取自动化接口信息（开关、地址、发现文件路径） |
| `automation.setEnabled` | 开启或关闭本地自动化 API（默认关闭） |

### 2.8 书签

| 方法 | 说明 |
|---|---|
| `bookmarks.add` | 添加书签 |
| `bookmarks.list` | 列出全部书签（按创建时间升序） |
| `bookmarks.remove` | 删除书签（按 id） |
| `bookmarks.toggle` | 切换书签状态（返回切换后是否已收藏） |

### 2.9 下载记录

| 方法 | 说明 |
|---|---|
| `downloads.list` | 列出下载记录（默认 200 条，按时间倒序去重） |
| `downloads.record` | 记录或更新一条下载（原生下载进度/完成时调用） |
| `downloads.remove` | 删除一条下载记录（不影响已下载的文件） |

### 2.10 浏览历史

| 方法 | 说明 |
|---|---|
| `history.add` | 记录一条历史（原生导航完成后调用） |
| `history.clear` | 清空全部浏览历史（危险操作，需用户确认） |
| `history.list` | 列出浏览历史（默认 500 条，可按关键词过滤） |
| `history.remove` | 删除单条历史（按 id） |

### 2.11 配置迁移（.tbuser）

| 方法 | 说明 |
|---|---|
| `profile.export` | 导出 .tbuser 配置文件（用户数据目录打包，排除缓存） |
| `profile.import` | 导入 .tbuser 配置文件并覆盖用户数据（含 zip slip 防护） |
| `profile.peek` | 查看 .tbuser 文件的清单（不落地任何文件） |

### 2.12 安全浏览

| 方法 | 说明 |
|---|---|
| `security.blocklists` | 查看本地黑名单统计，并可重新加载运行时黑名单 |
| `security.capabilityMatrix` | 读取三档保护的完整能力矩阵（含本地不可用能力的原因） |
| `security.checkReputation` | 查询用户自建的信誉端点（未配置时返回未查询及原因） |
| `security.downloadVerdict` | 对一次下载给出放行/警告/阻断结论（安装包警告但可保留） |
| `security.downloadVerdictForLevel` | 按指定保护档位给出下载结论（档位可覆盖） |
| `security.level` | 读取当前保护档位与完整能力矩阵 |
| `security.reviewExtension` | 静态审查一个已解包的扩展目录，输出中文风险清单 |
| `security.scanUrl` | 扫描一个 URL（本地启发式，含 turtlelnc 白名单豁免） |

### 2.13 服务自身

| 方法 | 说明 |
|---|---|
| `service.capabilities` | 返回能力清单，以及当前平台**不可用**能力的中文原因 |
| `service.emit` | 内部使用：向 SSE 客户端广播一个事件（供原生转发） |
| `service.events` | 返回 SSE 事件名清单（与 ARCHITECTURE.md §3.2 一致） |
| `service.ping` | 健康检查，返回版本与时间戳 |
| `service.shutdown` | 请求边车优雅退出（原生关闭时调用） |
| `service.status` | 边车运行状态（端口、密钥后端、黑名单、MCP、自动化、账户） |

### 2.14 设置与密钥

| 方法 | 说明 |
|---|---|
| `store.getSettings` | 读取设置（API Key 只返回掩码 ••••••••） |
| `store.hasApiKey` | 查询是否已设置 API Key（不返回值） |
| `store.secretBackend` | 查询密钥加密后端（dpapi / weak）与安全说明 |
| `store.setApiKey` | 保存或清除 API Key（DPAPI 加密写入 secrets.json，绝不落盘明文） |
| `store.setProtectionLevel` | 设置安全浏览档位（enhanced / standard / none） |
| `store.setSettings` | 写入设置（传入的 apiKey 会被忽略，密钥请用 store.setApiKey） |

### 2.15 本地工作区

| 方法 | 说明 |
|---|---|
| `workspace.grant` | 授权工作区根目录（本地办公/开发模式的必需前置条件） |
| `workspace.status` | 查看工作区授权状态（根目录、演练模式、命令白名单） |

详细的参数与返回结构见各方法的实现（`service/src/rpc/methods.ts`）；
每条方法的中文说明即上表，参数名与返回值字段与实现同源。

## 3. 安全与密钥

- API Key 与 OAuth 令牌写入 `<userData>/secrets.json`，Windows 上使用 **DPAPI** 加密（`ConvertTo-SecureString`/`ConvertFrom-SecureString`），密文与当前 Windows 用户账户绑定；
- 非 Windows 或 PowerShell 不可用时退化为 `weak:` base64 弱混淆，并在文件中写入 `"insecure": true`，同时在日志与 `store.secretBackend` 中明确告知——**不谎称已加密**；
- `store.getSettings` 返回的 API Key 恒为掩码 `••••••••`；
- 所有 JSON 写入均为「临时文件 + fsync + rename」原子写（v0.1.0 曾出现半截文件导致数据丢失的回归）。

## 4. AI 能力

### 4.1 服务商预设

| id | 名称 | 默认地址 | 默认模型 | 支持 tools | OAuth |
|---|---|---|---|---|---|
| `deepseek` | DeepSeek（深度求索） | `https://api.deepseek.com/v1` | `deepseek-chat` | 是 | 不支持 |
| `openai` | OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | 是 | 需自备 client_id |
| `moonshot` | Moonshot（月之暗面 Kimi） | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | 是 | 不支持 |
| `zhipu` | 智谱 AI（GLM） | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | 是 | 不支持 |
| `qwen` | 通义千问（阿里云百炼） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | 是 | 不支持 |
| `custom` | 自定义 OpenAI 兼容 | `http://127.0.0.1:11434/v1` | `qwen2.5:7b` | 是 | 不支持 |

### 4.2 智能体工具与权限档位

共 **45** 个工具（浏览器层 27 个，边车本地层 18 个）：

| 档位 | 可用工具数 | 中文名 |
|---|---|---|
| `off` | 0 | 关闭（不暴露任何工具） |
| `daily` | 23 | 日常 |
| `developer` | 41 | 开发 |
| `full` | 45 | 全部 |

| 工具 | 最低档位 | 层 | 说明 |
|---|---|---|---|
| `navigate` | daily | 浏览器（回调原生） | 在当前标签页导航到指定网址（支持网址或搜索词） |
| `get_page_text` | daily | 浏览器（回调原生） | 读取当前网页的正文文本 |
| `get_page_info` | daily | 浏览器（回调原生） | 获取当前页面的标题与网址 |
| `get_tabs` | daily | 浏览器（回调原生） | 列出所有打开的标签页 |
| `open_tab` | daily | 浏览器（回调原生） | 在新标签页打开网址 |
| `close_current_tab` | daily | 浏览器（回调原生） | 关闭当前标签页 |
| `switch_tab` | daily | 浏览器（回调原生） | 切换到指定标签页（index 从 0 开始） |
| `go_back` | daily | 浏览器（回调原生） | 后退到上一页 |
| `go_forward` | daily | 浏览器（回调原生） | 前进到下一页 |
| `reload_page` | daily | 浏览器（回调原生） | 刷新当前页面 |
| `go_home` | daily | 浏览器（回调原生） | 打开浏览器主页 |
| `click` | daily | 浏览器（回调原生） | 点击页面上的元素（CSS 选择器） |
| `fill` | daily | 浏览器（回调原生） | 在页面输入框中填写内容（CSS 选择器） |
| `scroll` | daily | 浏览器（回调原生） | 滚动页面（down/up/top/bottom） |
| `screenshot` | daily | 浏览器（回调原生） | 对当前页面截图，返回 base64 PNG（可用于确认页面状态） |
| `get_bookmarks` | daily | 边车本地 | 列出所有书签 |
| `add_bookmark` | daily | 边车本地 | 添加书签 |
| `get_settings` | daily | 边车本地 | 读取浏览器当前设置（不含 API Key，只返回掩码） |
| `update_setting` | daily | 边车本地 | 修改浏览器设置。key 可选：searchEngine(bing/baidu/google/duckduckgo)、homepage、theme(system/light/dark)、frostedGlass、bookmarkBarVisible、showHomeButton、safeBrowsing、httpsUpgrade、adBlock、trackerBlock |
| `open_settings_page` | daily | 浏览器（回调原生） | 打开浏览器的设置页面 |
| `list_workspace_files` | daily | 边车本地 | 列出本地工作区中的文件（需用户已授权工作区目录） |
| `read_workspace_file` | daily | 边车本地 | 读取本地工作区中的文本文件内容（需用户已授权工作区目录） |
| `get_page_source` | developer | 浏览器（回调原生） | 获取当前网页的 HTML 源码（默认截断 15000 字符） |
| `execute_js` | developer | 浏览器（回调原生） | 在当前页面执行一段 JavaScript 代码并返回结果 |
| `extract_links` | developer | 浏览器（回调原生） | 提取页面上所有链接 |
| `extract_images` | developer | 浏览器（回调原生） | 提取页面上所有图片地址 |
| `get_browser_state` | developer | 浏览器（回调原生） | 获取浏览器完整状态（标签页列表、侧边栏、当前覆盖层等） |
| `get_history` | developer | 边车本地 | 读取浏览历史记录（本地存储，最近 50 条） |
| `get_downloads` | developer | 边车本地 | 读取下载记录 |
| `start_capture` | developer | 浏览器（回调原生） | 开始抓包（记录网络请求） |
| `stop_capture` | developer | 浏览器（回调原生） | 停止抓包 |
| `get_captured` | developer | 浏览器（回调原生） | 获取抓包到的网络请求列表 |
| `write_workspace_file` | developer | 边车本地 | 在本地工作区写入或修改文件（需工作区授权；演练模式下只返回将要写入的内容而不落盘） |
| `run_command` | developer | 边车本地 | 在本地工作区执行一条白名单内的命令（如 npm test、node script.js），返回 stdout/stderr（演练模式下只返回将执行的命令） |
| `sleep` | developer | 边车本地 | 等待若干毫秒（用于等待页面加载完成后再次读取） |
| `set_protection_level` | developer | 边车本地 | 设置安全浏览档位（enhanced 增强型 / standard 标准 / none 不防护） |
| `set_energy_mode` | developer | 浏览器（回调原生） | 设置能效档位（performance / balanced / saver / instant） |
| `mcp_call` | developer | 边车本地 | 调用已配置的 MCP 服务器上的工具（server 为服务器名，tool 为工具名） |
| `clear_history` | full | 边车本地 | 清空浏览历史（危险操作） |
| `clear_browsing_data` | full | 浏览器（回调原生） | 清空所有浏览数据，含缓存与 Cookie（危险操作） |
| `close_all_tabs` | full | 浏览器（回调原生） | 关闭所有标签页（保留一个）（危险操作） |
| `remove_bookmark` | daily | 边车本地 | 删除书签 |
| `remove_history` | developer | 边车本地 | 删除单条浏览历史（危险操作） |
| `clear_downloads` | developer | 边车本地 | 清空下载记录（不影响已下载的文件） |
| `reset_settings` | full | 边车本地 | 把浏览器设置恢复为默认值（危险操作；API Key 与工作区授权不受影响） |

> **执行位置**：标记为「浏览器」的工具由边车把动作（`PROTOCOL_ACTIONS`）POST 回原生自动化端点执行；
> 原生端点地址由 `<userData>/native-bridge.json` 配置（`automation.bridge`）。未配置时工具返回明确的中文错误，不会伪造成功。

### 4.3 本地办公模式能力

| id | 能力 | 需要工作区 | 说明 |
|---|---|---|---|
| `doc-summary` | 文档摘要 | 是 | 读取本地文本文件并生成摘要。仅支持**纯文本类**文件；PDF/Word 二进制格式不会被解析（边车不内置解析库，也不谎称支持）。 |
| `sheet-process` | 表格处理 | 是 | 边车**本地真实解析 CSV**（支持引号转义与双引号转义），统计结果由代码计算而非模型估算。仅支持逗号分隔的 CSV；xlsx 需用户先另存为 CSV。 |
| `email-draft` | 邮件草拟 | 否 | 只生成草稿文本，**不会发送邮件**、不访问邮箱、不读取通讯录。需要发送请用户自行复制到邮件客户端。 |
| `meeting-minutes` | 会议纪要 | 是 | 基于用户提供的**文本**记录整理。边车不做语音转写（无本地 ASR 能力），需要用户自行提供文字稿。 |
| `schedule-organize` | 日程整理 | 是 | 整理文本形式的日程。边车**不接入**系统日历/Outlook/Google Calendar（无凭据、无 API），只做文本层面的整理。 |
| `slide-outline` | 演示大纲 | 否 | 生成 Markdown 大纲文本。边车**不生成** .pptx 文件（不内置 Office 文档库），用户可用大纲在任意演示工具中落地。 |

### 4.4 本地开发模式能力

| id | 能力 | 需要工作区 | 说明 |
|---|---|---|---|
| `read` | 读取工程文件 | 是 | 读取工作区内的文本文件（二进制文件会被拒绝，单次默认最多 64 KiB）。 |
| `write` | 写入工程文件 | 是 | 写入或覆盖工作区内的文本文件（原子写：临时文件 + rename）。演练模式下只返回将要写入的内容，不落盘。 |
| `run` | 运行命令 | 是 | 在工作区内执行白名单命令（默认 node/npm/npx/git/tsc），不经 shell，含危险命令模式拦截与超时。 |
| `test` | 运行测试 | 是 | 自动识别工程类型（package.json / pyproject / Cargo.toml 等）并执行对应测试命令；识别失败时回退到用户配置的 testCommand。 |
| `patch` | 生成补丁 | 是 | 给定「原文件路径 + 目标文件路径（或新内容）」，生成统一 diff 补丁文本并写入 .patch 文件；不自动应用。 |
| `explain-error` | 解释报错 | 否 | 结合报错文本与相关源码，给出中文原因分析、定位线索与修复建议；不做 AST 级自动修复。 |

## 5. 自动化接口

共 **39** 个动作，详见 [AUTOMATION.md](./AUTOMATION.md)。**默认关闭**（`automation.enabled=false`），开启后写入 `<userData>/automation.json` 供用户自己的工具发现。

## 6. 安全浏览三档（诚实能力矩阵）

### 增强型防护（`enhanced`）

本地全部能力 + 可选自建信誉端点 + 深度下载检查 + 扩展审查。云端实时威胁库、内容上报、跨服务保护在本地不可用，已在下方明确标注。

| 能力 | 是否本地可用 | 说明 |
|---|---|---|
| 本地黑名单 + 启发式扫描 | ✅ 本地实现 | 内置/运行时域名黑名单、同形异义仿冒、公网裸 IP、强钓鱼关键词、URL 内嵌凭据、可疑端口检测。 |
| 广告 / 追踪器拦截 | ✅ 本地实现 | 按本地黑名单拦截子资源请求（ads / tracking 分类），不影响主文档加载。 |
| HTTP 自动升级 HTTPS | ✅ 本地实现 | 非本机/内网地址的 http:// 请求自动改写为 https://。 |
| 自建 URL 信誉端点查询 | ⚙️ 需用户配置 | 对本地未命中的可疑 URL，向用户自行配置的 `reputationEndpoint` 发起一次最小化查询（仅发送域名与路径哈希，不发送完整 URL、不发送页面内容）。　**限制**：需要用户在设置中填写 `reputationEndpoint` 并自行承担该服务的可信度；未配置时此能力不生效。 |
| 深度下载检查（文件签名 + 熵扫描） | ✅ 本地实现 | 识别 PE/ELF/Mach-O/脚本/压缩包/宏文档等真实文件类型（不信任扩展名），计算 Shannon 熵与可疑指令密度，检测双扩展名、不可打印长串、嵌入 URL 等特征；结论为「放行 / 警告 / 阻断」，安装包默认**警告且允许保留**。 |
| 扩展程序安全审查 | ✅ 本地实现 | 读取扩展 manifest.json，检查权限组合（<all_urls> + 内容脚本注入 + webRequest）、远程代码执行特征（eval / new Function / 远程 script）、可疑域名，输出中文风险清单。 |
| turtlelnc 白名单豁免 | ✅ 本地实现 | github.com/turtlelnc/*、*.turtlelnc.*、turtleweb.cc.cd 与已验签发布物在任何档位都不拦截、不警告、不计入统计。 |
| 实时云端威胁库比对 | ☁️ 仅云端（本地不可用） | （Chrome 增强型防护的核心能力）　**限制**：必须使用 Google Safe Browsing / 微软 SmartScreen 的云端接口，需要官方 API Key 与网络回传。TiBrowser 边车不内置任何第三方云服务的密钥，因此本地**无法**提供此能力。 |
| 混淆 URL 片段 / 页面内容 / 下载样本上报 | ☁️ 仅云端（本地不可用） | （Chrome 增强型防护的上报链路）　**限制**：上报涉及用户隐私数据出境，且需要云服务账号。本地不可用；如企业自建了接收端，可通过 `reputationEndpoint` 配置项接入自有的最小化上报。 |
| 登录后跨服务保护（账号级威胁关联） | ☁️ 仅云端（本地不可用） | （Chrome 的账号级保护）　**限制**：依赖 Google/微软账号体系与云端风控，本地无法实现。 |

### 标准防护（`standard`）

本地黑名单 + 启发式 + 广告/追踪拦截；不发起任何深度下载分析或扩展审查。

| 能力 | 是否本地可用 | 说明 |
|---|---|---|
| 本地黑名单 + 启发式扫描 | ✅ 本地实现 | 内置/运行时域名黑名单、同形异义仿冒、公网裸 IP、强钓鱼关键词、URL 内嵌凭据、可疑端口检测。 |
| 广告 / 追踪器拦截 | ✅ 本地实现 | 按本地黑名单拦截子资源请求（ads / tracking 分类），不影响主文档加载。 |
| HTTP 自动升级 HTTPS | ✅ 本地实现 | 非本机/内网地址的 http:// 请求自动改写为 https://。 |
| turtlelnc 白名单豁免 | ✅ 本地实现 | github.com/turtlelnc/*、*.turtlelnc.*、turtleweb.cc.cd 与已验签发布物在任何档位都不拦截、不警告、不计入统计。 |
| 自建 URL 信誉端点查询 | ⚙️ 需用户配置 | 对本地未命中的可疑 URL，向用户自行配置的 `reputationEndpoint` 发起一次最小化查询（仅发送域名与路径哈希，不发送完整 URL、不发送页面内容）。　**限制**：标准档位不启用信誉端点查询（仅增强型启用）。 |
| 实时云端威胁库比对 | ☁️ 仅云端（本地不可用） | （Chrome 增强型防护的核心能力）　**限制**：必须使用 Google Safe Browsing / 微软 SmartScreen 的云端接口，需要官方 API Key 与网络回传。TiBrowser 边车不内置任何第三方云服务的密钥，因此本地**无法**提供此能力。 |

### 不防护（`none`）

不拦截任何网址；仅保留可疑下载的放行提示（不阻断），并继续豁免 turtlelnc 官方内容。

| 能力 | 是否本地可用 | 说明 |
|---|---|---|
| 下载放行提示 | ✅ 本地实现 | 不防护档位下仍然提示可疑下载并记录来源，但不阻断（用户可保留文件）。 |
| turtlelnc 白名单豁免 | ✅ 本地实现 | github.com/turtlelnc/*、*.turtlelnc.*、turtleweb.cc.cd 与已验签发布物在任何档位都不拦截、不警告、不计入统计。 |
| 本地黑名单 + 启发式扫描 | ⚙️ 需用户配置 | 规则仍然可用，但结果只作为提示，不产生拦截。　**限制**：本档位不产生任何拦截动作。 |

### turtlelnc 白名单（特性 6）

以下内容在**任何档位**下都不拦截、不警告、不计入威胁统计：

- GitHub 组织：`github.com/turtlelnc/*`
- 根域及其子域：`*.turtlelnc.com`、`*.turtleweb.cc.cd`
- 精确主机：`turtlelnc.com`、`turtleweb.cc.cd`
- 已验签发布者：`turtlelnc`、`Turtle Inc.`、`TiBrowser`

规则常量集中在 `service/src/security/trusted.ts`，native 侧（`native/src/security.cpp`）按同一清单同步实现。

### 危险下载闸门（特性 6 新行为）

`security.downloadVerdict` 返回三态结论：

| action | 触发条件 | 行为 |
|---|---|---|
| `allow` | 未发现本地可见风险；或 turtlelnc 官方内容 | 直接放行 |
| `warn` | 安装包 / 未知可执行 / 加壳高熵 / 宏文档 / 双扩展名 / 可疑来源 | **警告但可以保留**（不自动删除） |
| `block` | 命中黑名单域名下载、EICAR 等本地高置信度恶意特征 | 阻断 |

## 7. 配置与文件位置

用户数据目录（对齐 Electron 的 userData 路径）：Windows = `%APPDATA%/TiBrowser`。

| 文件 | 内容 | 是否加密 |
|---|---|---|
| `settings.json` | 设置（含 protectionLevel / automation / workspace / syncFolder） | 否（不含密钥） |
| `secrets.json` | API Key 与 OAuth 令牌 | **DPAPI**（否则 weak + insecure:true） |
| `bookmarks.json` / `history.json` / `downloads.json` | 本地数据 | 否 |
| `mcp.json` | MCP 服务器配置 | 否 |
| `accounts.json` / `sync-manifest.json` | 账户记录与同步清单 | 否 |
| `service.json` | 握手文件（port/token/pid） | 否（ACL 收紧） |
| `automation.json` | 自动化发现文件（含 token，**仅开启时**） | 否 |
| `native-bridge.json` | 原生自动化端点地址与 token | 否 |

## 8. 启动参数

```text
node dist/index.js [--port <n>] [--token-file <path>] [--token <t>] [--energy-mode <m>]
                    [--user-data <dir>] [--blocklists <dir>] [--headless] [--help]
```

| 参数 | 说明 |
|---|---|
| `--port <n>` | 监听端口，默认 0（系统分配） |
| `--token-file <path>` | 从握手文件读取 token（默认约定为 `<userData>/service.json`） |
| `--token <t>` | 直接指定 token（自检/调试用） |
| `--energy-mode <m>` | 能效档位（performance/balanced/saver/instant） |
| `--user-data <dir>` | 覆盖用户数据目录 |
| `--blocklists <dir>` | 运行时黑名单目录 |
| `--headless` | 不自动拉起 MCP 服务器、不写自动化发现文件 |

## 9. 自检

```bash
cd service
npm install
npm run build
npm run self-test   # 打印 SELFTEST OK 表示通过
```

自检**不联网、不需要浏览器**：在临时目录里启动真实 RPC 服务器，用本地假 OpenAI 服务端与假 MCP 服务器验证智能体循环与 MCP stdio 往返。
