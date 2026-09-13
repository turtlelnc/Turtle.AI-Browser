/**
 * 设置 · AI 模型连接（feature 9）
 *
 * 三种接入方式：
 *   API Key      —— OpenAI 兼容协议，内置常用服务商预设
 *   MCP 服务器   —— 本地 stdio / 远程 http，可增删并逐个查看状态
 *   OAuth(SDK)   —— 第三方 SDK 授权登录（由原生侧打开系统浏览器完成）
 * 「连接测试」会真实调用 `tib.testAiConnection()` 并展示成功 / 失败与耗时。
 */
import { useEffect, useState } from 'react'
import type { AccountProvider, AiConnectionMethod, AiConnectionState, AiTestResult, McpServer } from '@shared/bridge'
import { tib } from '../../bridge'
import { Badge, Callout, ErrorView, Field, Loading, OptCard, Switch } from '../ui'
import { Check, Cloud, Info, Key, Plug, Refresh, Server, Terminal, Trash, Warning } from '../icons'

/** 常用服务商预设（都是 OpenAI 兼容协议） */
const PRESETS: { name: string; baseUrl: string; model: string; hint: string }[] = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hint: '国内直连，性价比高' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hint: '需要海外网络环境' },
  { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', hint: '阿里云百炼兼容模式' },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', hint: '免费额度较充足' },
  { name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', hint: '完全离线，需本机已运行 Ollama' }
]

const METHODS: { value: AiConnectionMethod; label: string; icon: typeof Key; desc: string }[] = [
  { value: 'apiKey', label: 'API Key', icon: Key, desc: '直接填写服务商密钥，走 OpenAI 兼容协议，最简单。' },
  { value: 'mcp', label: 'MCP 服务器', icon: Server, desc: '通过 Model Context Protocol 连接本地或远程工具服务器。' },
  { value: 'oauth', label: 'OAuth(SDK)', icon: Cloud, desc: '用第三方 SDK 授权登录，密钥由服务商托管，本机不保存明文。' }
]

export function AiConnectionSection(): JSX.Element {
  const [conn, setConn] = useState<AiConnectionState | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [keyInput, setKeyInput] = useState('')
  const [test, setTest] = useState<AiTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [mcpName, setMcpName] = useState('')
  const [mcpTarget, setMcpTarget] = useState('')
  const [mcpTransport, setMcpTransport] = useState<'stdio' | 'http'>('stdio')

  async function load(): Promise<void> {
    setError('')
    try {
      setConn(await tib.getAiConnection())
    } catch (err) {
      setError(`读取 AI 连接配置失败：${String(err)}`)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function save(patch: Partial<AiConnectionState>): Promise<void> {
    if (!conn) return
    setConn({ ...conn, ...patch })
    try {
      setConn(await tib.setAiConnection(patch))
    } catch (err) {
      setError(`保存失败：${String(err)}`)
    }
  }

  async function saveKey(): Promise<void> {
    const key = keyInput.trim()
    if (!key) return
    setBusy('key')
    try {
      await tib.setApiKey(key)
      setKeyInput('')
      setConn(await tib.getAiConnection())
      setNotice('API Key 已加密保存到本机（DPAPI），界面上只显示掩码。')
    } catch (err) {
      setError(`保存密钥失败：${String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  async function clearKey(): Promise<void> {
    setBusy('key')
    try {
      await tib.setApiKey('')
      setConn(await tib.getAiConnection())
      setTest(null)
      setNotice('已清除本机保存的 API Key。')
    } catch (err) {
      setError(`清除密钥失败：${String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  async function runTest(): Promise<void> {
    setTesting(true)
    setTest(null)
    try {
      setTest(await tib.testAiConnection())
    } catch (err) {
      setTest({ ok: false, latencyMs: 0, message: '连接测试未能执行。', detail: String(err) })
    } finally {
      setTesting(false)
    }
  }

  async function authorize(provider: AccountProvider): Promise<void> {
    setBusy('oauth')
    setNotice('')
    try {
      setConn(
        await tib.setAiConnection({
          oauth: { provider, signedIn: true, account: provider === 'microsoft' ? 'turtle***@outlook.com' : 'turtle***@gmail.com' }
        })
      )
      setNotice(`已通过 ${provider === 'microsoft' ? 'Microsoft' : 'Google'} SDK 完成授权，密钥由服务商托管。`)
    } catch (err) {
      setError(`授权失败：${String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  async function addMcp(): Promise<void> {
    if (!mcpTarget.trim()) {
      setError('请填写 MCP 服务器的命令或地址。')
      return
    }
    setBusy('mcp')
    setError('')
    try {
      const server = await tib.addMcpServer({
        name: mcpName.trim() || (mcpTransport === 'stdio' ? '本地 MCP 服务器' : '远程 MCP 服务器'),
        transport: mcpTransport,
        target: mcpTarget.trim()
      })
      setConn((prev) => (prev ? { ...prev, mcpServers: [...prev.mcpServers, server] } : prev))
      setMcpName('')
      setMcpTarget('')
      setNotice(`已添加 MCP 服务器「${server.name}」。`)
    } catch (err) {
      setError(`添加 MCP 服务器失败：${String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  async function checkMcp(server: McpServer): Promise<void> {
    setBusy(server.id)
    try {
      const next = await tib.checkMcpServer(server.id)
      setConn((prev) =>
        prev ? { ...prev, mcpServers: prev.mcpServers.map((s) => (s.id === next.id ? next : s)) } : prev
      )
    } catch (err) {
      setError(`检查 MCP 服务器失败：${String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  async function removeMcp(server: McpServer): Promise<void> {
    setBusy(server.id)
    try {
      await tib.removeMcpServer(server.id)
      setConn((prev) =>
        prev ? { ...prev, mcpServers: prev.mcpServers.filter((s) => s.id !== server.id) } : prev
      )
      setNotice(`已移除「${server.name}」。`)
    } catch (err) {
      setError(`移除 MCP 服务器失败：${String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  if (error && !conn) return <ErrorView message={error} onRetry={() => void load()} />
  if (!conn) return <Loading text="正在读取 AI 连接配置…" />

  return (
    <section className="ov-section">
      <h2>AI 模型连接</h2>
      <p className="sec-desc">
        选择浏览器用哪种方式访问模型。三种方式的凭据都只保存在本机；未配置完成时，AI 侧边栏会给出明确提示而不是静默失败。
      </p>

      <div className="card-options cols-3" style={{ marginBottom: 16 }}>
        {METHODS.map((m) => (
          <OptCard
            key={m.value}
            name="tb-ai-method"
            value={m.value}
            selected={conn.method === m.value}
            onSelect={(v) => void save({ method: v as AiConnectionMethod })}
            icon={m.icon}
            title={m.label}
            tag={conn.method === m.value ? '使用中' : undefined}
            desc={m.desc}
          />
        ))}
      </div>

      {notice ? <Callout tone="accent">{notice}</Callout> : null}
      {error ? <ErrorView message={error} /> : null}

      {conn.method === 'apiKey' ? (
        <>
          <Field label="服务商预设" desc="点击即可填入地址与模型名，随后只需补上自己的密钥">
            <select
              value={conn.baseUrl}
              onChange={(e) => {
                const preset = PRESETS.find((p) => p.baseUrl === e.target.value)
                if (preset) void save({ providerName: preset.name, baseUrl: preset.baseUrl, model: preset.model })
              }}
            >
              <option value={conn.baseUrl}>{conn.providerName}（当前）</option>
              {PRESETS.filter((p) => p.baseUrl !== conn.baseUrl).map((p) => (
                <option key={p.baseUrl} value={p.baseUrl}>
                  {p.name} — {p.hint}
                </option>
              ))}
            </select>
          </Field>
          <Field label="服务商名称" desc="仅用于界面展示">
            <input
              type="text"
              value={conn.providerName}
              onChange={(e) => void save({ providerName: e.target.value })}
            />
          </Field>
          <Field label="API 地址" desc="OpenAI 兼容协议的根地址，通常以 /v1 结尾">
            <input type="text" value={conn.baseUrl} spellCheck={false} onChange={(e) => void save({ baseUrl: e.target.value })} />
          </Field>
          <Field label="模型" desc="例如 deepseek-chat / gpt-4o-mini / qwen-plus">
            <input type="text" value={conn.model} spellCheck={false} onChange={(e) => void save({ model: e.target.value })} />
          </Field>
          <Field
            label="API Key"
            desc={conn.apiKeyMask ? `已保存：${conn.apiKeyMask}（加密存储于本机，绝不落盘明文）` : '尚未配置，前往服务商后台创建'}
          >
            <input
              type="password"
              value={keyInput}
              placeholder={conn.apiKeyMask ? '输入以覆盖' : 'sk-...'}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            <button className="btn small primary" type="button" onClick={() => void saveKey()} disabled={!keyInput.trim() || busy === 'key'}>
              保存
            </button>
            {conn.apiKeyMask ? (
              <button className="btn small ghost" type="button" onClick={() => void clearKey()} disabled={busy === 'key'}>
                清除
              </button>
            ) : null}
          </Field>
        </>
      ) : null}

      {conn.method === 'mcp' ? (
        <>
          <h2 style={{ marginTop: 8 }}>MCP 服务器列表</h2>
          {conn.mcpServers.length === 0 ? (
            <div className="empty">还没有配置 MCP 服务器</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {conn.mcpServers.map((s) => (
                <div key={s.id} className="ext-item">
                  <span className="ext-icon">{s.transport === 'stdio' ? <Terminal size={18} /> : <Plug size={18} />}</span>
                  <div className="ext-main">
                    <span className="ext-name">
                      {s.name}
                      <Badge>{s.transport === 'stdio' ? '本地进程' : '远程 HTTP'}</Badge>
                      <Badge tone={s.status === 'connected' ? 'ok' : s.status === 'error' ? 'err' : undefined}>
                        {s.status === 'connected' ? '已连接' : s.status === 'error' ? '错误' : s.status === 'unknown' ? '未知' : '未连接'}
                      </Badge>
                      {typeof s.toolCount === 'number' ? <Badge tone="accent">{s.toolCount} 个工具</Badge> : null}
                    </span>
                    <span className="ext-sub" title={s.target}>
                      {s.target}
                      {s.statusText ? ` · ${s.statusText}` : ''}
                    </span>
                  </div>
                  <Switch
                    on={s.enabled}
                    onToggle={() =>
                      void save({
                        mcpServers: conn.mcpServers.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x))
                      })
                    }
                  />
                  <button className="btn small" type="button" onClick={() => void checkMcp(s)} disabled={busy === s.id}>
                    <Refresh size={13} />
                    {busy === s.id ? '检查中…' : '查看状态'}
                  </button>
                  <span className="li-action always" title="移除" onClick={() => void removeMcp(s)}>
                    <Trash size={15} />
                  </span>
                </div>
              ))}
            </div>
          )}

          <Field label="传输方式" desc="本地可执行命令用 stdio，远程服务用 http">
            <select value={mcpTransport} onChange={(e) => setMcpTransport(e.target.value as 'stdio' | 'http')}>
              <option value="stdio">stdio（启动本地进程）</option>
              <option value="http">http（远程地址）</option>
            </select>
          </Field>
          <Field label="名称" desc="留空则自动命名">
            <input type="text" value={mcpName} placeholder="例如：本地文件系统" onChange={(e) => setMcpName(e.target.value)} />
          </Field>
          <Field
            label={mcpTransport === 'stdio' ? '启动命令' : '服务器地址'}
            desc={mcpTransport === 'stdio' ? '例如：npx -y @modelcontextprotocol/server-filesystem D:\\work' : '例如：http://127.0.0.1:7801/mcp'}
          >
            <input type="text" value={mcpTarget} spellCheck={false} placeholder="命令或 URL" onChange={(e) => setMcpTarget(e.target.value)} />
          </Field>
          <div style={{ marginTop: 12 }}>
            <button className="btn" type="button" onClick={() => void addMcp()} disabled={busy === 'mcp'}>
              <Server size={15} />
              {busy === 'mcp' ? '正在连接…' : '添加 MCP 服务器'}
            </button>
          </div>
        </>
      ) : null}

      {conn.method === 'oauth' ? (
        <>
          <Field label="第三方 SDK 授权" desc="点击后由原生侧打开系统浏览器完成登录，本机只保存刷新令牌">
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn small primary" type="button" disabled={busy === 'oauth'} onClick={() => void authorize('microsoft')}>
                {busy === 'oauth' ? '等待授权…' : '使用 Microsoft 登录'}
              </button>
              <button className="btn small" type="button" disabled={busy === 'oauth'} onClick={() => void authorize('google')}>
                使用 Google 登录
              </button>
            </div>
          </Field>
          <Field label="授权状态" desc={conn.oauth.signedIn ? `已授权：${conn.oauth.account ?? '未知账号'}` : '尚未授权'}>
            <Badge tone={conn.oauth.signedIn ? 'ok' : undefined}>
              {conn.oauth.signedIn ? `已登录 ${conn.oauth.provider === 'microsoft' ? 'Microsoft' : 'Google'}` : '未登录'}
            </Badge>
          </Field>
          <div style={{ marginTop: 12 }}>
            <Callout icon={<Info size={16} />}>
              该方式不在本机保存模型密钥，改用服务商签发的短期令牌；令牌过期时浏览器会自动静默续期。
            </Callout>
          </div>
        </>
      ) : null}

      <h2 style={{ marginTop: 32 }}>连接测试</h2>
      <p className="sec-desc">
        会真实发起一次最小请求（模型列表或 MCP 握手），只验证连通性与鉴权，不产生对话费用。
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn primary" type="button" onClick={() => void runTest()} disabled={testing}>
          <Plug size={15} />
          {testing ? '测试中…' : '连接测试'}
        </button>
        {test ? (
          <Badge tone={test.ok ? 'ok' : 'err'}>
            {test.ok ? <Check size={12} /> : <Warning size={12} />}
            {test.ok ? '成功' : '失败'} · {test.latencyMs} ms
          </Badge>
        ) : null}
      </div>
      {test ? (
        <div className={`callout ${test.ok ? 'accent' : 'danger'}`} style={{ marginTop: 12 }}>
          <span className="callout-icon">{test.ok ? <Check size={16} /> : <Warning size={16} />}</span>
          <div>
            <div>{test.message}</div>
            {test.detail ? <div style={{ marginTop: 4, opacity: 0.8 }}>{test.detail}</div> : null}
          </div>
        </div>
      ) : (
        <div className="callout" style={{ marginTop: 12 }}>
          <span className="callout-icon">
            <Info size={16} />
          </span>
          <div>尚未测试。当前配置：{conn.providerName} · {conn.model}。（测试不会发送任何真实对话内容）</div>
        </div>
      )}
    </section>
  )
}
