/**
 * 文档生成器：写出 `docs/SERVICE-API.md` 与 `docs/AUTOMATION.md`。
 *
 * 用法（在 `service/` 目录下）：
 * ```bash
 * npm run docs
 * ```
 *
 * 之所以用「真实注册一遍 RPC 方法再枚举」的方式，而不是手写方法表：
 * 保证文档与代码永不漂移——新增/改名方法后重跑即可。
 */

import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_BUILD, APP_VERSION } from '../shared/constants.js'
import { RpcServer } from '../rpc/server.js'
import { registerAllMethods } from '../rpc/methods.js'
import { writeTextAtomic } from '../store/json-store.js'
import { writeAutomationDoc } from '../automation/docs.js'
import { AUTOMATION_ACTIONS } from '../automation/actions.js'
import { TOOLS, toolStats, getToolsForLevel } from '../ai/tools.js'
import { PROTECTION_PROFILES } from '../security/protection.js'
import { TRUSTED_PUBLISHERS } from '../security/trusted.js'
import { OFFICE_CAPABILITIES } from '../ai/modes/office.js'
import { DEV_CAPABILITIES } from '../ai/modes/dev.js'
import { PROVIDERS } from '../ai/providers.js'
import { AccountService } from '../sync/accounts.js'
import { McpRegistry } from '../ai/mcp.js'

const here = dirname(fileURLToPath(import.meta.url))
/** 仓库根目录：dist/tools → dist → service → 仓库根 */
const repoRoot = resolve(here, '..', '..', '..')

/** 收集 RPC 方法清单（不启动服务器、不监听端口） */
function collectMethods(): Array<{ name: string; summary: string }> {
  const rpc = new RpcServer({ token: 'docs-only' })
  const accounts = new AccountService({
    // 文档生成不读取真实设置，返回一个最小可用的桩对象
    getSettings: () =>
      ({
        searchEngine: 'bing',
        homepage: '',
        ai: { enabled: false, providerName: '', baseUrl: '', apiKey: '', model: '', systemPrompt: '', cliPermission: 'daily' },
        security: { safeBrowsing: true, httpsUpgrade: true, adBlock: true, trackerBlock: true, blockSuspiciousDownloads: true },
        appearance: { frostedGlass: true, theme: 'system', bookmarkBarVisible: true, showHomeButton: true },
        protectionLevel: 'standard',
        automation: { enabled: false },
        workspace: { root: '', allowCommands: [], dryRun: true },
        reputationEndpoint: ''
      }) as never,
    userDataDir: () => process.cwd()
  })
  registerAllMethods(rpc, {
    log: () => {
      /* 静默 */
    },
    accounts,
    mcp: new McpRegistry(() => join(process.cwd(), 'docs-only-mcp.json')),
    executor: { run: async () => null, action: async () => null, available: false } as never,
    secretBackend: () => ({ mode: 'weak', insecure: true, note: '文档生成' }),
    reloadBridge: () => ({ baseUrl: '', token: '' }),
    emit: () => {
      /* 静默 */
    }
  })
  return rpc.methods().map((m) => ({ name: m.name, summary: m.summary }))
}

/** 方法名前缀分组的中文标题 */
const GROUP_LABELS: Array<{ prefix: string; title: string }> = [
  { prefix: 'service.', title: '服务自身' },
  { prefix: 'store.', title: '设置与密钥' },
  { prefix: 'bookmarks.', title: '书签' },
  { prefix: 'history.', title: '浏览历史' },
  { prefix: 'downloads.', title: '下载记录' },
  { prefix: 'ai.mcp.', title: 'AI · MCP 客户端' },
  { prefix: 'ai.oauth.', title: 'AI · OAuth 2.0 (PKCE)' },
  { prefix: 'ai.modes.', title: 'AI · 本地办公 / 本地开发模式' },
  { prefix: 'ai.tools', title: 'AI · 工具清单' },
  { prefix: 'ai.', title: 'AI · 对话与智能体' },
  { prefix: 'security.', title: '安全浏览' },
  { prefix: 'automation.', title: '本地自动化 API' },
  { prefix: 'accounts.', title: '账户与同步' },
  { prefix: 'profile.', title: '配置迁移（.tbuser）' },
  { prefix: 'workspace.', title: '本地工作区' }
]

function groupOf(name: string): string {
  // 更长的前缀优先（ai.mcp. 优先于 ai.）
  const sorted = [...GROUP_LABELS].sort((a, b) => b.prefix.length - a.prefix.length)
  return sorted.find((g) => name.startsWith(g.prefix))?.title ?? '其他'
}

function renderServiceApiDoc(methods: Array<{ name: string; summary: string }>): string {
  const stats = toolStats()
  const lines: string[] = []
  lines.push('# TiBrowser 边车服务 API（tib-service）')
  lines.push('')
  lines.push(
    `> 适用版本：${APP_VERSION} (build ${APP_BUILD})　｜　本文档由 \`service/src/tools/gen-docs.ts\` 自动生成，请勿手工编辑。`
  )
  lines.push('')
  lines.push('本文件描述 Node 边车（`tib-service`）对原生浏览器暴露的**本地 RPC 接口**，契约见 `docs/ARCHITECTURE.md` 第 4 节。')
  lines.push('')
  lines.push('## 1. 传输与握手')
  lines.push('')
  lines.push('| 项目 | 说明 |')
  lines.push('|---|---|')
  lines.push('| 监听地址 | `127.0.0.1`（仅回环，绝不监听 0.0.0.0） |')
  lines.push('| 端口 | 默认 `0`（系统分配）；可用 `--port <n>` 指定 |')
  lines.push('| 鉴权 | 每个请求都必须带 `Authorization: Bearer <token>`（32 字节随机 token） |')
  lines.push('| 握手文件 | 启动后写入 `<userData>/service.json`：`{port, token, pid, version, build, updatedAt}` |')
  lines.push('| 就绪信号 | stdout **只输出一行** JSON：`{"ready":true,"port":<n>,"version":"…","build":…,"capabilities":[…]}` |')
  lines.push('| 日志 | 全部写 stderr，保证 stdout 干净 |')
  lines.push('')
  lines.push('### 1.1 端点一览')
  lines.push('')
  lines.push('| 端点 | 方法 | 鉴权 | 说明 |')
  lines.push('|---|---|---|---|')
  lines.push('| `/rpc/<method>` | POST | 需要 | 调用下面表格中的任意方法，请求体 `{"params":{…}}` |')
  lines.push('| `/events?token=<t>` | GET | 需要（query 传 token） | SSE 事件流，事件名见 1.3 |')
  lines.push('| `/health` | GET | **不需要** | `{ok, version, build, capabilities[]}`，不含敏感信息 |')
  lines.push('| `/automation/<action>` | POST | 需要 | 本地自动化 API，见 [`AUTOMATION.md`](./AUTOMATION.md) |')
  lines.push('| `/automation-ws?token=<t>` | WS | 需要（query 传 token） | 自动化 WebSocket 通道（事件推送 + 动作调用） |')
  lines.push('')
  lines.push('### 1.2 响应格式')
  lines.push('')
  lines.push('成功：')
  lines.push('')
  lines.push('```json')
  lines.push('{ "ok": true, "result": { } }')
  lines.push('```')
  lines.push('')
  lines.push('失败（`message` 一律中文，`code` 为机器可读常量）：')
  lines.push('')
  lines.push('```json')
  lines.push('{ "ok": false, "error": { "code": "unknown-method", "message": "未知的 RPC 方法：xxx" } }')
  lines.push('```')
  lines.push('')
  lines.push('| HTTP | code | 含义 |')
  lines.push('|---|---|---|')
  lines.push('| 400 | `bad-json` / `bad-param` | 请求体不是合法 JSON / 参数不合法 |')
  lines.push('| 401 | `unauthorized` | 缺少或错误的 Bearer token |')
  lines.push('| 404 | `unknown-method` / `not-found` | 方法不存在 / 端点不存在 |')
  lines.push('| 500 | `handler-failed` / `internal` | 方法执行异常（细节见 stderr 日志） |')
  lines.push('')
  lines.push('### 1.3 SSE 事件（与 ARCHITECTURE.md §3.2 对齐）')
  lines.push('')
  lines.push('| 事件 | 载荷 |')
  lines.push('|---|---|')
  lines.push('| `aiChunk` | `{requestId, delta}` |')
  lines.push('| `aiDone` | `{requestId, content}` |')
  lines.push('| `aiError` | `{requestId, message}` |')
  lines.push('| `aiTool` | `{requestId, name, detail, phase}` |')
  lines.push('| `securityEvent` | `{url, verdict, action}` |')
  lines.push('| `accountsChanged` | `{accounts, syncState}` |')
  lines.push('| `appsChanged` | `WebApp[]` |')
  lines.push('| `extensionsChanged` | `ExtensionInfo[]` |')
  lines.push('')
  lines.push('连接建立后会先收到一帧 `event: ready`（含 subscriberId）。服务端每 **15 秒**发送一次心跳注释（`: heartbeat <ts>`），客户端断开时自动清理。')
  lines.push('')
  lines.push('```bash')
  lines.push('curl -N "http://127.0.0.1:<port>/events?token=<token>"')
  lines.push('```')
  lines.push('')
  lines.push('## 2. 方法清单')
  lines.push('')
  lines.push(`共 **${methods.length}** 个方法。`)
  lines.push('')
  const groups = [...new Set(methods.map((m) => groupOf(m.name)))]
  for (const g of groups) {
    lines.push(`### 2.${groups.indexOf(g) + 1} ${g}`)
    lines.push('')
    lines.push('| 方法 | 说明 |')
    lines.push('|---|---|')
    for (const m of methods.filter((x) => groupOf(x.name) === g)) {
      lines.push(`| \`${m.name}\` | ${m.summary} |`)
    }
    lines.push('')
  }
  lines.push('详细的参数与返回结构见各方法的实现（`service/src/rpc/methods.ts`）；')
  lines.push('每条方法的中文说明即上表，参数名与返回值字段与实现同源。')
  lines.push('')
  lines.push('## 3. 安全与密钥')
  lines.push('')
  lines.push('- API Key 与 OAuth 令牌写入 `<userData>/secrets.json`，Windows 上使用 **DPAPI** 加密（`ConvertTo-SecureString`/`ConvertFrom-SecureString`），密文与当前 Windows 用户账户绑定；')
  lines.push('- 非 Windows 或 PowerShell 不可用时退化为 `weak:` base64 弱混淆，并在文件中写入 `"insecure": true`，同时在日志与 `store.secretBackend` 中明确告知——**不谎称已加密**；')
  lines.push('- `store.getSettings` 返回的 API Key 恒为掩码 `••••••••`；')
  lines.push('- 所有 JSON 写入均为「临时文件 + fsync + rename」原子写（v0.1.0 曾出现半截文件导致数据丢失的回归）。')
  lines.push('')
  lines.push('## 4. AI 能力')
  lines.push('')
  lines.push('### 4.1 服务商预设')
  lines.push('')
  lines.push('| id | 名称 | 默认地址 | 默认模型 | 支持 tools | OAuth |')
  lines.push('|---|---|---|---|---|---|')
  for (const p of PROVIDERS) {
    lines.push(
      `| \`${p.id}\` | ${p.name} | \`${p.baseUrl}\` | \`${p.defaultModel}\` | ${p.supportsTools ? '是' : '否'} | ${p.oauth ? '需自备 client_id' : '不支持'} |`
    )
  }
  lines.push('')
  lines.push('### 4.2 智能体工具与权限档位')
  lines.push('')
  lines.push(`共 **${stats.total}** 个工具（浏览器层 ${stats.browser} 个，边车本地层 ${stats.local} 个）：`)
  lines.push('')
  lines.push('| 档位 | 可用工具数 | 中文名 |')
  lines.push('|---|---|---|')
  lines.push(`| \`off\` | 0 | 关闭（不暴露任何工具） |`)
  lines.push(`| \`daily\` | ${getToolsForLevel('daily').length} | 日常 |`)
  lines.push(`| \`developer\` | ${getToolsForLevel('developer').length} | 开发 |`)
  lines.push(`| \`full\` | ${getToolsForLevel('full').length} | 全部 |`)
  lines.push('')
  lines.push('| 工具 | 最低档位 | 层 | 说明 |')
  lines.push('|---|---|---|---|')
  for (const t of TOOLS) {
    lines.push(`| \`${t.name}\` | ${t.minLevel} | ${t.layer === 'browser' ? '浏览器（回调原生）' : '边车本地'} | ${t.description} |`)
  }
  lines.push('')
  lines.push('> **执行位置**：标记为「浏览器」的工具由边车把动作（`PROTOCOL_ACTIONS`）POST 回原生自动化端点执行；')
  lines.push('> 原生端点地址由 `<userData>/native-bridge.json` 配置（`automation.bridge`）。未配置时工具返回明确的中文错误，不会伪造成功。')
  lines.push('')
  lines.push('### 4.3 本地办公模式能力')
  lines.push('')
  lines.push('| id | 能力 | 需要工作区 | 说明 |')
  lines.push('|---|---|---|---|')
  for (const c of OFFICE_CAPABILITIES) {
    lines.push(`| \`${c.id}\` | ${c.name} | ${c.requiresWorkspace ? '是' : '否'} | ${c.description} |`)
  }
  lines.push('')
  lines.push('### 4.4 本地开发模式能力')
  lines.push('')
  lines.push('| id | 能力 | 需要工作区 | 说明 |')
  lines.push('|---|---|---|---|')
  for (const c of DEV_CAPABILITIES) {
    lines.push(`| \`${c.id}\` | ${c.name} | ${c.requiresWorkspace ? '是' : '否'} | ${c.description} |`)
  }
  lines.push('')
  lines.push('## 5. 自动化接口')
  lines.push('')
  lines.push(
    `共 **${AUTOMATION_ACTIONS.length}** 个动作，详见 [AUTOMATION.md](./AUTOMATION.md)。**默认关闭**（\`automation.enabled=false\`），开启后写入 \`<userData>/automation.json\` 供用户自己的工具发现。`
  )
  lines.push('')
  lines.push('## 6. 安全浏览三档（诚实能力矩阵）')
  lines.push('')
  for (const key of ['enhanced', 'standard', 'none'] as const) {
    const p = PROTECTION_PROFILES[key]
    lines.push(`### ${p.label}（\`${p.level}\`）`)
    lines.push('')
    lines.push(p.summary)
    lines.push('')
    lines.push('| 能力 | 是否本地可用 | 说明 |')
    lines.push('|---|---|---|')
    for (const c of p.capabilities) {
      const mark = c.availability === 'local' ? '✅ 本地实现' : c.availability === 'requires-config' ? '⚙️ 需用户配置' : '☁️ 仅云端（本地不可用）'
      lines.push(`| ${c.name} | ${mark} | ${c.description}${c.limitation ? `　**限制**：${c.limitation}` : ''} |`)
    }
    lines.push('')
  }
  lines.push('### turtlelnc 白名单（特性 6）')
  lines.push('')
  lines.push('以下内容在**任何档位**下都不拦截、不警告、不计入威胁统计：')
  lines.push('')
  lines.push(`- GitHub 组织：${(TRUSTED_PUBLISHERS.githubOrgs as readonly string[]).map((o) => `\`github.com/${o}/*\``).join('、')}`)
  lines.push(`- 根域及其子域：${(TRUSTED_PUBLISHERS.rootDomains as readonly string[]).map((d) => `\`*.${d}\``).join('、')}`)
  lines.push(`- 精确主机：${(TRUSTED_PUBLISHERS.exactHosts as readonly string[]).map((h) => `\`${h}\``).join('、')}`)
  lines.push(`- 已验签发布者：${(TRUSTED_PUBLISHERS.signerNames as readonly string[]).map((s) => `\`${s}\``).join('、')}`)
  lines.push('')
  lines.push('规则常量集中在 `service/src/security/trusted.ts`，native 侧（`native/src/security.cpp`）按同一清单同步实现。')
  lines.push('')
  lines.push('### 危险下载闸门（特性 6 新行为）')
  lines.push('')
  lines.push('`security.downloadVerdict` 返回三态结论：')
  lines.push('')
  lines.push('| action | 触发条件 | 行为 |')
  lines.push('|---|---|---|')
  lines.push('| `allow` | 未发现本地可见风险；或 turtlelnc 官方内容 | 直接放行 |')
  lines.push('| `warn` | 安装包 / 未知可执行 / 加壳高熵 / 宏文档 / 双扩展名 / 可疑来源 | **警告但可以保留**（不自动删除） |')
  lines.push('| `block` | 命中黑名单域名下载、EICAR 等本地高置信度恶意特征 | 阻断 |')
  lines.push('')
  lines.push('## 7. 配置与文件位置')
  lines.push('')
  lines.push('用户数据目录（对齐 Electron 的 userData 路径）：Windows = `%APPDATA%/TiBrowser`。')
  lines.push('')
  lines.push('| 文件 | 内容 | 是否加密 |')
  lines.push('|---|---|---|')
  lines.push('| `settings.json` | 设置（含 protectionLevel / automation / workspace / syncFolder） | 否（不含密钥） |')
  lines.push('| `secrets.json` | API Key 与 OAuth 令牌 | **DPAPI**（否则 weak + insecure:true） |')
  lines.push('| `bookmarks.json` / `history.json` / `downloads.json` | 本地数据 | 否 |')
  lines.push('| `mcp.json` | MCP 服务器配置 | 否 |')
  lines.push('| `accounts.json` / `sync-manifest.json` | 账户记录与同步清单 | 否 |')
  lines.push('| `service.json` | 握手文件（port/token/pid） | 否（ACL 收紧） |')
  lines.push('| `automation.json` | 自动化发现文件（含 token，**仅开启时**） | 否 |')
  lines.push('| `native-bridge.json` | 原生自动化端点地址与 token | 否 |')
  lines.push('')
  lines.push('## 8. 启动参数')
  lines.push('')
  lines.push('```text')
  lines.push('node dist/index.js [--port <n>] [--token-file <path>] [--token <t>] [--energy-mode <m>]')
  lines.push('                    [--user-data <dir>] [--blocklists <dir>] [--headless] [--help]')
  lines.push('```')
  lines.push('')
  lines.push('| 参数 | 说明 |')
  lines.push('|---|---|')
  lines.push('| `--port <n>` | 监听端口，默认 0（系统分配） |')
  lines.push('| `--token-file <path>` | 从握手文件读取 token（默认约定为 `<userData>/service.json`） |')
  lines.push('| `--token <t>` | 直接指定 token（自检/调试用） |')
  lines.push('| `--energy-mode <m>` | 能效档位（performance/balanced/saver/instant） |')
  lines.push('| `--user-data <dir>` | 覆盖用户数据目录 |')
  lines.push('| `--blocklists <dir>` | 运行时黑名单目录 |')
  lines.push('| `--headless` | 不自动拉起 MCP 服务器、不写自动化发现文件 |')
  lines.push('')
  lines.push('## 9. 自检')
  lines.push('')
  lines.push('```bash')
  lines.push('cd service')
  lines.push('npm install')
  lines.push('npm run build')
  lines.push('npm run self-test   # 打印 SELFTEST OK 表示通过')
  lines.push('```')
  lines.push('')
  lines.push('自检**不联网、不需要浏览器**：在临时目录里启动真实 RPC 服务器，用本地假 OpenAI 服务端与假 MCP 服务器验证智能体循环与 MCP stdio 往返。')
  lines.push('')
  return lines.join('\n')
}

function main(): void {
  const docsDir = join(repoRoot, 'docs')
  mkdirSync(docsDir, { recursive: true })

  const methods = collectMethods()
  const apiPath = join(docsDir, 'SERVICE-API.md')
  writeTextAtomic(apiPath, renderServiceApiDoc(methods))
  process.stdout.write(`已生成 ${apiPath}（${methods.length} 个 RPC 方法）\n`)

  const autoPath = join(docsDir, 'AUTOMATION.md')
  const auto = writeAutomationDoc({
    userDataDir: process.platform === 'win32' ? '%APPDATA%\\TiBrowser' : '~/.config/TiBrowser',
    outputPath: autoPath
  })
  process.stdout.write(`已生成 ${auto.path}（${auto.bytes} 字节，${AUTOMATION_ACTIONS.length} 个动作）\n`)
}

main()
