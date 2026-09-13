# TiBrowser 本地自动化 API

> 适用版本：1.0.0-rc1 (build 260913)　｜　边车服务：`tib-service`　｜　本文档由 `service/src/automation/docs.ts` 自动生成，请勿手工编辑。

TiBrowser 提供一个**仅监听本机回环地址**的自动化接口，让你自己的 AI 工具 / CLI / 脚本 / harness 直接驱动浏览器：打开页面、读取正文、点击与填写、执行脚本、截图、抓包……

## 1. 默认状态与开启方式

- **默认关闭**。关闭时接口不返回任何动作结果，只返回中文错误 `automation-disabled`，且发现文件中**不会写入 token**。
- 开启方式：设置 `automation.enabled = true`（通过设置界面或 RPC `store.setSettings`）。
- 自动化动作最终由原生浏览器执行，因此还需要原生侧暴露自动化端点；边车通过 `native-bridge.json` 记录的地址转发（见第 4 节）。

## 2. 发现文件

边车启动后会在用户数据目录写入 `automation.json`：

```text
%APPDATA%\TiBrowser\automation.json
```

```json
{
  "enabled": true,
  "baseUrl": "http://127.0.0.1:51234/automation",
  "wsUrl": "ws://127.0.0.1:51234/automation-ws",
  "token": "（开启自动化时才写入的 64 位十六进制随机串）",
  "version": "1.0.0-rc1",
  "build": 260913,
  "docs": "docs/AUTOMATION.md"
}
```

也可以直接查询健康检查端点获取端口与能力清单（无需 token，不含敏感信息）：

```bash
curl -s http://127.0.0.1:<port>/health
# {"ok":true,"version":"1.0.0-rc1","build":260913,"capabilities":[...]}
```

## 3. 鉴权

所有 `/automation/*` 请求都必须带 Bearer token（与边车 RPC 同一个 token）：

```bash
curl -s -X POST http://127.0.0.1:<port>/automation/getTabs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"params":{}}'
```

错误的 token 会得到 `401`：

```json
{ "ok": false, "error": { "code": "unauthorized", "message": "鉴权失败：缺少或错误的 Bearer token。……" } }
```

> 安全提示：token 等价于浏览器控制权。不要把它写进会被同步/提交的文件，也不要暴露到非本机网络。

## 4. 请求与响应格式

```http
POST /automation/<action>
Content-Type: application/json
Authorization: Bearer <token>

{ "params": { ... } }
```

成功：

```json
{ "ok": true, "result": { ... }, "action": "getTabs" }
```

失败：

```json
{ "ok": false, "action": "navigate", "error": { "code": "missing-param", "message": "动作「navigate」缺少必填参数：url。" } }
```

常见错误码：

| code | 中文含义 | 处理方式 |
|---|---|---|
| `unauthorized` | token 缺失或错误 | 检查发现文件中的 token |
| `automation-disabled` | 自动化接口未开启 | 设置 `automation.enabled = true` |
| `unknown-action` | 动作名不存在 | 对照第 6 节动作表 |
| `missing-param` | 缺少必填参数 | 按动作表的 required 补齐 |
| `native-endpoint-missing` | 未连接到原生浏览器自动化端点 | 确认浏览器已启动并写入了桥接配置 |
| `network-error` | 调用原生端点失败/超时 | 检查浏览器进程是否存活 |
| `permission-denied` | 权限档位不足（高风险动作） | 在设置中提高 AI 智能体权限档位 |

动作清单（能力发现）：

```bash
curl -s http://127.0.0.1:<port>/automation -H "Authorization: Bearer <token>"
```

## 5. WebSocket 通道（事件推送）

```text
ws://127.0.0.1:<port>/automation-ws?token=<token>
```

请求 / 响应：

```jsonc
// 客户端 → 服务端
{ "id": "req-1", "action": "getPageText", "params": { "maxChars": 4000 } }
// 服务端 → 客户端
{ "id": "req-1", "ok": true, "result": { "text": "……" } }
```

事件广播（无 `id` 字段）：

```jsonc
{ "event": "download", "payload": { "filename": "a.zip", "state": "completed" }, "ts": 1726000000000 }
```

订阅指定事件（不订阅则接收全部事件）：

```jsonc
{ "id": "s1", "action": "subscribe", "params": { "events": ["download", "aiChunk"] } }
```

可订阅事件：`state`、`findResult`、`windowState`、`download`、`aiChunk`、`aiDone`、`aiError`、`aiTool`、`securityEvent`、`accountsChanged`、`appsChanged`、`extensionsChanged`。

心跳：客户端可发送 `{"action":"ping"}`；服务端每 30 秒发送一次 WebSocket ping 帧，未响应则断开。

## 6. 动作表

### 6.1 导航

| 动作 | 说明 | 必填参数 | 可选参数 |
|---|---|---|---|
| `navigate` | 在当前标签页导航到指定网址（支持网址或搜索词） | `url` | — |
| `newTab` | 新建标签页（可选指定要打开的地址） | — | `url`、`incognito`、`activate` |
| `closeTab` | 关闭指定标签页（缺省关闭当前标签页） | — | `tabId` |
| `activateTab` | 激活指定标签页（tabId 或从 0 开始的 index） | — | `tabId`、`index` |
| `goBack` | 后退到上一页 | — | — |
| `goForward` | 前进到下一页 | — | — |
| `reload` | 重新加载当前页面 | — | — |
| `stop` | 停止加载当前页面 | — | — |
| `goHome` | 打开主页 | — | — |

### 6.2 读取页面

| 动作 | 说明 | 必填参数 | 可选参数 |
|---|---|---|---|
| `getTabs` | 列出所有打开的标签页（含 id / 标题 / 网址 / 是否激活） | — | — |
| `getPageText` | 读取当前页面正文文本 | — | `maxChars`、`tabId` |
| `getPageInfo` | 获取当前页面的标题、网址与加载状态 | — | — |
| `getSelectedText` | 获取用户在页面上选中的文字 | — | — |
| `getDom` | 获取当前页面的 HTML 源码（默认截断 15000 字符）（**高风险**） | — | `maxChars`、`selector` |
| `extractLinks` | 提取页面上的链接（最多 100 条）（**高风险**） | — | — |
| `extractImages` | 提取页面上的图片地址（最多 100 条）（**高风险**） | — | — |

### 6.3 页面交互

| 动作 | 说明 | 必填参数 | 可选参数 |
|---|---|---|---|
| `click` | 点击页面上匹配 CSS 选择器的元素 | `selector` | — |
| `fill` | 在输入框中填写内容（会派发 input/change 事件，兼容 React 受控组件） | `selector`、`value` | — |
| `scroll` | 滚动页面 | `direction` | — |
| `screenshot` | 对当前页面截图，返回 base64 PNG | — | `fullPage`、`format` |
| `evaluate` | 在页面中执行 JavaScript 并返回结果（需要开发者及以上权限档位）（**高风险**） | `code` | — |
| `findInPage` | 页内查找文本并高亮 | `text` | `forward` |

### 6.4 界面控制

| 动作 | 说明 | 必填参数 | 可选参数 |
|---|---|---|---|
| `setOverlay` | 打开/关闭覆盖层（设置、历史、书签、下载、关于） | `name` | — |
| `toggleSidebar` | 打开/关闭 AI 侧边栏 | — | `open` |
| `setSidebarWidth` | 设置 AI 侧边栏宽度（像素，260-560） | `width` | — |
| `setZoom` | 设置页面缩放级别 | `level` | — |
| `setProtectionLevel` | 设置安全浏览档位（增强型 / 标准 / 不防护） | `level` | — |
| `setEnergyMode` | 设置能效档位 | `mode` | — |

### 6.5 状态查询

| 动作 | 说明 | 必填参数 | 可选参数 |
|---|---|---|---|
| `getState` | 获取浏览器完整状态（标签页、设置、侧边栏等） | — | — |
| `getSettings` | 获取浏览器设置（API Key 只返回掩码） | — | — |
| `getSecurityReport` | 获取安全浏览当前档位与拦截统计 | — | — |
| `getDownloads` | 获取下载记录 | — | `limit` |
| `getHistory` | 获取浏览历史 | — | `query`、`limit` |
| `getBookmarks` | 获取书签列表 | — | — |

### 6.6 抓包与维护

| 动作 | 说明 | 必填参数 | 可选参数 |
|---|---|---|---|
| `startCapture` | 开始抓包（记录网络请求）（**高风险**） | — | — |
| `stopCapture` | 停止抓包（**高风险**） | — | — |
| `getCaptured` | 获取抓包到的网络请求列表（**高风险**） | — | `limit` |
| `clearBrowsingData` | 清空浏览数据（缓存与 Cookie，危险操作）（**高风险**） | — | — |
| `closeAllTabs` | 关闭所有标签页（保留一个，危险操作）（**高风险**） | — | — |

## 7. curl 示例

以下示例假设 `<port>` 为发现文件里的端口，`<token>` 为发现文件里的 token。

### 列出所有标签页

```bash
curl -s -X POST http://127.0.0.1:<port>/automation/getTabs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"params":{}}'
```

### 打开一个网址

```bash
curl -s -X POST http://127.0.0.1:<port>/automation/navigate \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"params":{"url":"https://example.com"}}'
```

### 新建标签页（无痕）

```bash
curl -s -X POST http://127.0.0.1:<port>/automation/newTab \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"params":{"url":"https://example.com","incognito":true}}'
```

### 读取当前页面正文（最多 4000 字符）

```bash
curl -s -X POST http://127.0.0.1:<port>/automation/getPageText \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"params":{"maxChars":4000}}'
```

### 读取页面 HTML

```bash
curl -s -X POST http://127.0.0.1:<port>/automation/getDom \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"params":{"maxChars":20000}}'
```

### 点击元素并在输入框填写

```bash
curl -s -X POST http://127.0.0.1:<port>/automation/fill \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"params":{"selector":"#kw","value":"TiBrowser"}}'
```

### 在页面执行 JavaScript

```bash
curl -s -X POST http://127.0.0.1:<port>/automation/evaluate \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"params":{"code":"document.title"}}'
```

### 截图（返回 base64 PNG）

```bash
curl -s -X POST http://127.0.0.1:<port>/automation/screenshot \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"params":{"fullPage":false}}'
```

### 整页截图

```bash
curl -s -X POST http://127.0.0.1:<port>/automation/screenshot \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"params":{"fullPage":true,"format":"png"}}'
```

### 打开设置覆盖层

```bash
curl -s -X POST http://127.0.0.1:<port>/automation/setOverlay \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"params":{"name":"settings"}}'
```

### 设置安全浏览为增强型

```bash
curl -s -X POST http://127.0.0.1:<port>/automation/setProtectionLevel \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"params":{"level":"enhanced"}}'
```

### 开始抓包

```bash
curl -s -X POST http://127.0.0.1:<port>/automation/startCapture \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"params":{}}'
```

### 读取抓包结果

```bash
curl -s -X POST http://127.0.0.1:<port>/automation/getCaptured \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"params":{"limit":50}}'
```

### 一次性串起「打开 → 读正文 → 截图」的 PowerShell 示例

```powershell
$info  = Get-Content "$env:APPDATA\TiBrowser\automation.json" | ConvertFrom-Json
$h     = @{ Authorization = "Bearer $($info.token)"; "Content-Type" = "application/json" }
Invoke-RestMethod -Method Post -Uri "$($info.baseUrl)/navigate"      -Headers $h -Body '{"params":{"url":"https://example.com"}}'
Invoke-RestMethod -Method Post -Uri "$($info.baseUrl)/getPageText"  -Headers $h -Body '{"params":{"maxChars":2000}}'
Invoke-RestMethod -Method Post -Uri "$($info.baseUrl)/screenshot"   -Headers $h -Body '{"params":{}}'
```

## 8. 安全说明

- 只监听 `127.0.0.1`，不对局域网/公网开放；
- 默认关闭；开启后每次请求仍需 Bearer token；
- 高风险动作（`evaluate`、抓包、清空数据等）在原生侧按 AI 权限档位二次校验，档位不足会返回 `permission-denied`；
- 边车不会把 token 写进日志或 `settings.json`；关闭自动化时发现文件不写 token。
