/**
 * 设置 · AI 控制台 / 自动化（feature 15）
 *
 * 展示本地自动化接口（HTTP/SSE，仅监听 127.0.0.1），可一键开启 / 关闭，
 * 复制 base URL 与 Bearer token，并给出可执行的 curl 示例。
 */
import { useEffect, useState } from 'react'
import type { AutomationInfo, ServiceStatus } from '@shared/bridge'
import { tib } from '../../bridge'
import { Badge, Callout, CopyButton, ErrorView, Field, Loading, Switch } from '../ui'
import { Check, EyeOff, Info, Plug, Terminal, Warning } from '../icons'

/** 第三方 AI 工具 / CLI 调用本浏览器的最小示例 */
function curlExample(baseUrl: string, token: string): string {
  return `# 1) 查看浏览器状态
curl -s ${baseUrl}/v1/status \\
  -H "Authorization: Bearer ${token}"

# 2) 让浏览器打开一个页面
curl -s -X POST ${baseUrl}/v1/navigate \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://turtleweb.cc.cd"}'

# 3) 让内置 AI 总结当前页面（SSE 流式返回）
curl -N -X POST ${baseUrl}/v1/ai/chat \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"总结当前页面"}]}'`
}

export function AutomationSection(): JSX.Element {
  const [info, setInfo] = useState<AutomationInfo | null>(null)
  const [service, setService] = useState<ServiceStatus | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [showToken, setShowToken] = useState(false)

  async function load(): Promise<void> {
    setError('')
    try {
      const [a, s] = await Promise.all([tib.automationInfo(), tib.serviceStatus()])
      setInfo(a)
      setService(s)
    } catch (err) {
      setError(`读取自动化接口信息失败：${String(err)}`)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function toggle(enabled: boolean): Promise<void> {
    setBusy(true)
    setNotice('')
    try {
      setInfo(await tib.setAutomationEnabled(enabled))
      setNotice(enabled ? '本地自动化接口已开启，仅接受来自本机的请求。' : '本地自动化接口已关闭，所有调用会立即失败。')
    } catch (err) {
      setError(`切换自动化接口失败：${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function copy(text: string): Promise<void> {
    try {
      await tib.copyToClipboard(text)
    } catch {
      setNotice('剪贴板不可用，请手动选中文本复制。')
    }
  }

  if (error && !info) return <ErrorView message={error} onRetry={() => void load()} />
  if (!info) return <Loading text="正在读取自动化接口信息…" />

  const masked = `${info.token.slice(0, 8)}${'•'.repeat(18)}`

  return (
    <section className="ov-section">
      <h2>AI 控制台 / 自动化</h2>
      <p className="sec-desc">
        开启后，本机上的脚本、CLI 或你自己的 AI 工具可以通过 HTTP 接口驱动这个浏览器：
        新建标签、导航、执行页面操作、调用内置 AI。接口只监听 127.0.0.1，并用 Bearer token 鉴权。
      </p>

      <Field
        label="启用本地自动化接口"
        desc={service?.running === false ? '本地 AI 服务（边车）当前未运行，开启后会自动拉起' : '修改立即生效，无需重启浏览器'}
      >
        <Switch on={info.enabled} disabled={busy} onToggle={() => void toggle(!info.enabled)} />
      </Field>

      <div className="stat-grid" style={{ margin: '16px 0' }}>
        <div className="stat">
          <div className="stat-value" style={{ fontSize: 16 }}>
            {info.enabled ? '已开启' : '已关闭'}
          </div>
          <div className="stat-label">自动化接口</div>
        </div>
        <div className="stat">
          <div className="stat-value" style={{ fontSize: 16 }}>
            {service?.running ? '运行中' : '未运行'}
          </div>
          <div className="stat-label">本地 AI 服务{service?.port ? ` · 端口 ${service.port}` : ''}</div>
        </div>
        <div className="stat">
          <div className="stat-value" style={{ fontSize: 16 }}>
            {service?.version ?? '—'}
          </div>
          <div className="stat-label">服务版本</div>
        </div>
      </div>

      {notice ? <Callout tone="accent">{notice}</Callout> : null}
      {error ? <ErrorView message={error} /> : null}

      <Field label="Base URL" desc="所有自动化端点的前缀">
        <span className="code-inline">{info.baseUrl}</span>
        <CopyButton text={info.baseUrl} onCopy={copy} />
      </Field>

      <Field
        label="Bearer Token"
        desc="等价于本接口的密码，任何拿到它的本机程序都能控制浏览器；重启浏览器会轮换"
      >
        <span className="code-inline">{showToken ? info.token : masked}</span>
        <span className="li-action always" title={showToken ? '隐藏' : '显示'} onClick={() => setShowToken((v) => !v)}>
          <EyeOff size={15} />
        </span>
        <CopyButton text={info.token} onCopy={copy} />
      </Field>

      <h2 style={{ marginTop: 24 }}>可用端点</h2>
      {info.endpoints && info.endpoints.length > 0 ? (
        <div className="list">
          {info.endpoints.map((e) => (
            <div key={`${e.method}-${e.path}`} className="list-item">
              <Badge tone="accent">{e.method}</Badge>
              <div className="li-main">
                <div className="li-title" style={{ fontFamily: 'var(--tb-font-mono)', fontSize: 12 }}>
                  {e.path}
                </div>
                <div className="li-sub">{e.desc}</div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">当前服务未上报端点列表</div>
      )}

      <h2 style={{ marginTop: 24 }}>调用示例</h2>
      <div className="code-block">
        <pre>{curlExample(info.baseUrl, showToken ? info.token : '${TOKEN}')}</pre>
        <CopyButton text={curlExample(info.baseUrl, info.token)} onCopy={copy} label="复制示例" />
      </div>

      <div style={{ marginTop: 16 }}>
        <Callout tone="warn" icon={<Warning size={16} />}>
          自动化接口能力等同于「完全控制浏览器」。请勿把端口暴露到公网，也不要把 token 写进共享脚本或提交到代码仓库。
        </Callout>
      </div>
      <div style={{ marginTop: 12 }}>
        <Callout icon={<Info size={16} />}>
          <Check size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
          附带的能力：{service?.capabilities?.join(' / ') ?? '未上报'}。
          <Plug size={14} style={{ verticalAlign: -2, margin: '0 4px' }} />
          SSE 事件名与界面事件一致（`aiChunk` / `aiDone` / `aiError`），可直接在脚本里订阅。
          <Terminal size={14} style={{ verticalAlign: -2, marginLeft: 4 }} />
        </Callout>
      </div>
    </section>
  )
}
