/**
 * 生成 `docs/AUTOMATION.md`（特性 15 的对外文档）。
 *
 * 文档内容全部由动作表（`./actions.ts`）与发现文件结构推导，
 * 保证「代码改了文档不会漂移」。
 */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { APP_BUILD, APP_VERSION } from '../shared/constants.js'
import { writeTextAtomic } from '../store/json-store.js'
import { actionsByGroup } from './actions.js'
import { AUTOMATION_DISCOVERY_FILE } from './discovery.js'

export interface DocGenOptions {
  /** 发现文件所在目录（用户数据目录），文档中会以变量形式引用 */
  userDataDir: string
  /** 文档输出路径（默认 <repo>/docs/AUTOMATION.md） */
  outputPath: string
}

/** 生成 Markdown 文本 */
export function renderAutomationDoc(opts: { userDataDir: string }): string {
  const groups = actionsByGroup()
  const lines: string[] = []

  lines.push('# TiBrowser 本地自动化 API')
  lines.push('')
  lines.push(
    `> 适用版本：${APP_VERSION} (build ${APP_BUILD})　｜　边车服务：\`tib-service\`　｜　本文档由 \`service/src/automation/docs.ts\` 自动生成，请勿手工编辑。`
  )
  lines.push('')
  lines.push(
    'TiBrowser 提供一个**仅监听本机回环地址**的自动化接口，让你自己的 AI 工具 / CLI / 脚本 / harness 直接驱动浏览器：' +
      '打开页面、读取正文、点击与填写、执行脚本、截图、抓包……'
  )
  lines.push('')
  lines.push('## 1. 默认状态与开启方式')
  lines.push('')
  lines.push(
    '- **默认关闭**。关闭时接口不返回任何动作结果，只返回中文错误 `automation-disabled`，且发现文件中**不会写入 token**。'
  )
  lines.push('- 开启方式：设置 `automation.enabled = true`（通过设置界面或 RPC `store.setSettings`）。')
  lines.push(
    '- 自动化动作最终由原生浏览器执行，因此还需要原生侧暴露自动化端点；边车通过 `native-bridge.json` 记录的地址转发（见第 4 节）。'
  )
  lines.push('')
  lines.push('## 2. 发现文件')
  lines.push('')
  lines.push(`边车启动后会在用户数据目录写入 \`${AUTOMATION_DISCOVERY_FILE}\`：`)
  lines.push('')
  lines.push('```text')
  lines.push(`${opts.userDataDir}\\${AUTOMATION_DISCOVERY_FILE}`)
  lines.push('```')
  lines.push('')
  lines.push('```json')
  lines.push('{')
  lines.push('  "enabled": true,')
  lines.push('  "baseUrl": "http://127.0.0.1:51234/automation",')
  lines.push('  "wsUrl": "ws://127.0.0.1:51234/automation-ws",')
  lines.push('  "token": "（开启自动化时才写入的 64 位十六进制随机串）",')
  lines.push(`  "version": "${APP_VERSION}",`)
  lines.push(`  "build": ${APP_BUILD},`)
  lines.push('  "docs": "docs/AUTOMATION.md"')
  lines.push('}')
  lines.push('```')
  lines.push('')
  lines.push('也可以直接查询健康检查端点获取端口与能力清单（无需 token，不含敏感信息）：')
  lines.push('')
  lines.push('```bash')
  lines.push('curl -s http://127.0.0.1:<port>/health')
  lines.push('# {"ok":true,"version":"1.0.0-rc1","build":260913,"capabilities":[...]}')
  lines.push('```')
  lines.push('')
  lines.push('## 3. 鉴权')
  lines.push('')
  lines.push('所有 `/automation/*` 请求都必须带 Bearer token（与边车 RPC 同一个 token）：')
  lines.push('')
  lines.push('```bash')
  lines.push('curl -s -X POST http://127.0.0.1:<port>/automation/getTabs \\')
  lines.push('  -H "Authorization: Bearer <token>" \\')
  lines.push('  -H "Content-Type: application/json" \\')
  lines.push('  -d \'{"params":{}}\'')
  lines.push('```')
  lines.push('')
  lines.push('错误的 token 会得到 `401`：')
  lines.push('')
  lines.push('```json')
  lines.push('{ "ok": false, "error": { "code": "unauthorized", "message": "鉴权失败：缺少或错误的 Bearer token。……" } }')
  lines.push('```')
  lines.push('')
  lines.push('> 安全提示：token 等价于浏览器控制权。不要把它写进会被同步/提交的文件，也不要暴露到非本机网络。')
  lines.push('')
  lines.push('## 4. 请求与响应格式')
  lines.push('')
  lines.push('```http')
  lines.push('POST /automation/<action>')
  lines.push('Content-Type: application/json')
  lines.push('Authorization: Bearer <token>')
  lines.push('')
  lines.push('{ "params": { ... } }')
  lines.push('```')
  lines.push('')
  lines.push('成功：')
  lines.push('')
  lines.push('```json')
  lines.push('{ "ok": true, "result": { ... }, "action": "getTabs" }')
  lines.push('```')
  lines.push('')
  lines.push('失败：')
  lines.push('')
  lines.push('```json')
  lines.push('{ "ok": false, "action": "navigate", "error": { "code": "missing-param", "message": "动作「navigate」缺少必填参数：url。" } }')
  lines.push('```')
  lines.push('')
  lines.push('常见错误码：')
  lines.push('')
  lines.push('| code | 中文含义 | 处理方式 |')
  lines.push('|---|---|---|')
  lines.push('| `unauthorized` | token 缺失或错误 | 检查发现文件中的 token |')
  lines.push('| `automation-disabled` | 自动化接口未开启 | 设置 `automation.enabled = true` |')
  lines.push('| `unknown-action` | 动作名不存在 | 对照第 6 节动作表 |')
  lines.push('| `missing-param` | 缺少必填参数 | 按动作表的 required 补齐 |')
  lines.push('| `native-endpoint-missing` | 未连接到原生浏览器自动化端点 | 确认浏览器已启动并写入了桥接配置 |')
  lines.push('| `network-error` | 调用原生端点失败/超时 | 检查浏览器进程是否存活 |')
  lines.push('| `permission-denied` | 权限档位不足（高风险动作） | 在设置中提高 AI 智能体权限档位 |')
  lines.push('')
  lines.push('动作清单（能力发现）：')
  lines.push('')
  lines.push('```bash')
  lines.push('curl -s http://127.0.0.1:<port>/automation -H "Authorization: Bearer <token>"')
  lines.push('```')
  lines.push('')
  lines.push('## 5. WebSocket 通道（事件推送）')
  lines.push('')
  lines.push('```text')
  lines.push('ws://127.0.0.1:<port>/automation-ws?token=<token>')
  lines.push('```')
  lines.push('')
  lines.push('请求 / 响应：')
  lines.push('')
  lines.push('```jsonc')
  lines.push('// 客户端 → 服务端')
  lines.push('{ "id": "req-1", "action": "getPageText", "params": { "maxChars": 4000 } }')
  lines.push('// 服务端 → 客户端')
  lines.push('{ "id": "req-1", "ok": true, "result": { "text": "……" } }')
  lines.push('```')
  lines.push('')
  lines.push('事件广播（无 `id` 字段）：')
  lines.push('')
  lines.push('```jsonc')
  lines.push('{ "event": "download", "payload": { "filename": "a.zip", "state": "completed" }, "ts": 1726000000000 }')
  lines.push('```')
  lines.push('')
  lines.push('订阅指定事件（不订阅则接收全部事件）：')
  lines.push('')
  lines.push('```jsonc')
  lines.push('{ "id": "s1", "action": "subscribe", "params": { "events": ["download", "aiChunk"] } }')
  lines.push('```')
  lines.push('')
  lines.push('可订阅事件：`state`、`findResult`、`windowState`、`download`、`aiChunk`、`aiDone`、`aiError`、`aiTool`、`securityEvent`、`accountsChanged`、`appsChanged`、`extensionsChanged`。')
  lines.push('')
  lines.push('心跳：客户端可发送 `{"action":"ping"}`；服务端每 30 秒发送一次 WebSocket ping 帧，未响应则断开。')
  lines.push('')
  lines.push('## 6. 动作表')
  lines.push('')

  for (const g of groups) {
    lines.push(`### 6.${groups.indexOf(g) + 1} ${g.label}`)
    lines.push('')
    lines.push('| 动作 | 说明 | 必填参数 | 可选参数 |')
    lines.push('|---|---|---|---|')
    for (const a of g.actions) {
      const required = a.required.length ? a.required.map((r) => `\`${r}\``).join('、') : '—'
      const optional = Object.keys(a.params)
        .filter((p) => !a.required.includes(p))
        .map((p) => `\`${p}\``)
        .join('、')
      lines.push(`| \`${a.name}\` | ${a.summary}${a.risky ? '（**高风险**）' : ''} | ${required} | ${optional || '—'} |`)
    }
    lines.push('')
  }

  lines.push('## 7. curl 示例')
  lines.push('')
  lines.push('以下示例假设 `<port>` 为发现文件里的端口，`<token>` 为发现文件里的 token。')
  lines.push('')

  const examples: Array<{ title: string; action: string; body: string }> = [
    { title: '列出所有标签页', action: 'getTabs', body: '{"params":{}}' },
    { title: '打开一个网址', action: 'navigate', body: '{"params":{"url":"https://example.com"}}' },
    {
      title: '新建标签页（无痕）',
      action: 'newTab',
      body: '{"params":{"url":"https://example.com","incognito":true}}'
    },
    { title: '读取当前页面正文（最多 4000 字符）', action: 'getPageText', body: '{"params":{"maxChars":4000}}' },
    { title: '读取页面 HTML', action: 'getDom', body: '{"params":{"maxChars":20000}}' },
    {
      title: '点击元素并在输入框填写',
      action: 'fill',
      body: '{"params":{"selector":"#kw","value":"TiBrowser"}}'
    },
    { title: '在页面执行 JavaScript', action: 'evaluate', body: '{"params":{"code":"document.title"}}' },
    { title: '截图（返回 base64 PNG）', action: 'screenshot', body: '{"params":{"fullPage":false}}' },
    { title: '整页截图', action: 'screenshot', body: '{"params":{"fullPage":true,"format":"png"}}' },
    { title: '打开设置覆盖层', action: 'setOverlay', body: '{"params":{"name":"settings"}}' },
    { title: '设置安全浏览为增强型', action: 'setProtectionLevel', body: '{"params":{"level":"enhanced"}}' },
    { title: '开始抓包', action: 'startCapture', body: '{"params":{}}' },
    { title: '读取抓包结果', action: 'getCaptured', body: '{"params":{"limit":50}}' }
  ]

  for (const ex of examples) {
    lines.push(`### ${ex.title}`)
    lines.push('')
    lines.push('```bash')
    lines.push(`curl -s -X POST http://127.0.0.1:<port>/automation/${ex.action} \\`)
    lines.push('  -H "Authorization: Bearer <token>" \\')
    lines.push('  -H "Content-Type: application/json" \\')
    lines.push(`  -d '${ex.body}'`)
    lines.push('```')
    lines.push('')
  }

  lines.push('### 一次性串起「打开 → 读正文 → 截图」的 PowerShell 示例')
  lines.push('')
  lines.push('```powershell')
  lines.push('$info  = Get-Content "$env:APPDATA\\TiBrowser\\automation.json" | ConvertFrom-Json')
  lines.push('$h     = @{ Authorization = "Bearer $($info.token)"; "Content-Type" = "application/json" }')
  lines.push('Invoke-RestMethod -Method Post -Uri "$($info.baseUrl)/navigate"      -Headers $h -Body \'{"params":{"url":"https://example.com"}}\'')
  lines.push('Invoke-RestMethod -Method Post -Uri "$($info.baseUrl)/getPageText"  -Headers $h -Body \'{"params":{"maxChars":2000}}\'')
  lines.push('Invoke-RestMethod -Method Post -Uri "$($info.baseUrl)/screenshot"   -Headers $h -Body \'{"params":{}}\'')
  lines.push('```')
  lines.push('')
  lines.push('## 8. 安全说明')
  lines.push('')
  lines.push('- 只监听 `127.0.0.1`，不对局域网/公网开放；')
  lines.push('- 默认关闭；开启后每次请求仍需 Bearer token；')
  lines.push('- 高风险动作（`evaluate`、抓包、清空数据等）在原生侧按 AI 权限档位二次校验，档位不足会返回 `permission-denied`；')
  lines.push('- 边车不会把 token 写进日志或 `settings.json`；关闭自动化时发现文件不写 token。')
  lines.push('')
  return lines.join('\n')
}

/** 写出文档文件 */
export function writeAutomationDoc(opts: DocGenOptions): { path: string; bytes: number } {
  const text = renderAutomationDoc({ userDataDir: opts.userDataDir })
  const out = resolve(opts.outputPath)
  mkdirSync(dirname(out), { recursive: true })
  // 用原子写落盘纯文本（不能走 JSON 序列化，否则 Markdown 会被引号包裹）
  writeTextAtomic(out, text)
  return { path: out, bytes: Buffer.byteLength(text, 'utf-8') }
}
