/**
 * 设置 · 安全浏览（feature 5）
 *
 * 三档行为与「注意事项」文案严格对齐 `docs/ARCHITECTURE.md` §5：
 *   增强型防护 enhanced / 标准防护 standard / 不防护 none
 * turtlelnc 例外（任何档位都放行、不计入统计）也在此明确告知用户。
 */
import { useEffect, useState } from 'react'
import type { ProtectionLevel, SecurityReport } from '@shared/bridge'
import { tib } from '../../bridge'
import { formatTime } from '../../format'
import { Badge, Callout, ErrorView, Loading, OptCard, Stat } from '../ui'
import { Check, Globe, Info, Shield, ShieldOff, ShieldWarn, TurtleMark } from '../icons'

/** 三档安全浏览的用户可见文案（原文来自架构文档 §5，不得随意改写） */
const LEVELS: {
  value: ProtectionLevel
  label: string
  icon: typeof Shield
  desc: string
  notes: string[]
}[] = [
  {
    value: 'enhanced',
    label: '增强型防护',
    icon: Shield,
    desc: '实时比对更多站点数据；对未知危险站点也警告（可忽略）；深度扫描可疑下载；登录后跨服务保护。',
    notes: [
      '会向安全服务发送：混淆后的 URL 片段 + 少量页面内容 + 下载 / 扩展 / 系统信息样本。',
      '对未知危险站点的警告可以忽略，但忽略后风险由你自行承担。',
      '深度扫描可疑下载：文件会先被检查再交给系统打开，较大的安装包会有几秒延迟。'
    ]
  },
  {
    value: 'standard',
    label: '标准防护',
    icon: ShieldWarn,
    desc: '通过可隐藏 IP 的隐私服务器发送混淆 URL 片段；可疑时补发完整 URL 与少量页面内容；本地黑名单 + 启发式。',
    notes: [
      '仅在判定可疑时才会补发完整 URL 与少量页面内容。',
      '隐藏 IP 的隐私服务器只做转发，不记录你的真实地址。',
      '本地黑名单 + 启发式规则，因此对最新的钓鱼站点可能略有延迟。'
    ]
  },
  {
    value: 'none',
    label: '不防护',
    icon: ShieldOff,
    desc: '不拦截任何网站；但仍保留「下载放行名单」提示（不阻断）。',
    notes: [
      '危险网站、钓鱼页面与恶意下载都不会被阻止。',
      '「下载放行名单」只会提示，不会阻断下载。',
      '建议只在离线调试或可信内网环境中使用。'
    ]
  }
]

/** turtlelnc 信任例外说明（对应架构文档 §5 的「turtlelnc 例外」） */
const TRUSTED_SCOPE = ['github.com/turtlelnc/*', '*.turtlelnc.*', 'turtleweb.cc.cd', '已签名的 turtlelnc 发布物']

export function SecuritySection(): JSX.Element {
  const [report, setReport] = useState<SecurityReport | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<ProtectionLevel | null>(null)
  const [notice, setNotice] = useState('')

  async function load(): Promise<void> {
    setError('')
    try {
      setReport(await tib.getSecurityReport())
    } catch (err) {
      setError(`读取安全浏览状态失败：${String(err)}`)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function choose(level: ProtectionLevel): Promise<void> {
    setBusy(level)
    setNotice('')
    try {
      await tib.setProtectionLevel(level)
      const next = await tib.getSecurityReport()
      setReport(next)
      setNotice(`已切换到「${LEVELS.find((l) => l.value === level)?.label}」，立即生效，无需重启。`)
    } catch (err) {
      setError(`切换防护档位失败：${String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  if (error && !report) return <ErrorView message={error} onRetry={() => void load()} />
  if (!report) return <Loading text="正在读取安全浏览状态…" />

  const active = LEVELS.find((l) => l.value === report.level)

  return (
    <section className="ov-section">
      <h2>安全浏览</h2>
      <p className="sec-desc">
        选择浏览器如何判断一个网站或下载是否危险。档位越高，判断越准，但会与安全服务交换更多信息。
      </p>

      <div className="card-options cols-3" style={{ marginBottom: 16 }}>
        {LEVELS.map((l) => (
          <OptCard
            key={l.value}
            name="tb-protection"
            value={l.value}
            selected={report.level === l.value}
            onSelect={(v) => void choose(v as ProtectionLevel)}
            icon={l.icon}
            title={l.label}
            tag={busy === l.value ? '切换中…' : report.level === l.value ? '使用中' : undefined}
            desc={l.desc}
            notes={l.notes}
          />
        ))}
      </div>

      {notice ? <Callout tone="accent">{notice}</Callout> : null}

      {report.level === 'enhanced' ? (
        <Callout tone="warn" icon={<ShieldWarn size={16} />}>
          <strong>增强型防护注意事项</strong>
          <ul>
            {LEVELS[0].notes.map((n, i) => (
              <li key={i}>· {n}</li>
            ))}
          </ul>
        </Callout>
      ) : null}

      <h2 style={{ marginTop: 24 }}>拦截统计</h2>
      <div className="stat-grid">
        <Stat value={report.blockedToday} label="今日拦截" />
        <Stat value={report.blockedTotal} label="累计拦截" />
        <Stat value={report.blockedSession ?? '—'} label="本次会话" />
        <Stat value={report.databaseVersion ?? '—'} label="防护库版本" />
      </div>
      <p className="sec-desc" style={{ marginTop: 8 }}>
        防护库上次更新：{formatTime(report.updatedAt)}；当前档位：
        <strong>{active?.label ?? report.level}</strong>。
      </p>

      <h2 style={{ marginTop: 24 }}>最近拦截</h2>
      {report.recent.length === 0 ? (
        <div className="empty">最近没有拦截记录，说明你访问的站点都在正常范围内。</div>
      ) : (
        <div className="list">
          {report.recent.map((e) => (
            <div key={e.id} className="sec-event">
              {e.trusted ? (
                <TurtleMark size={16} style={{ color: 'var(--tb-accent)' }} />
              ) : (
                <ShieldWarn size={16} style={{ color: 'var(--tb-danger)' }} />
              )}
              <span className="se-url" title={e.url}>
                {e.url}
              </span>
              <Badge tone={e.trusted ? 'accent' : 'err'}>{e.category}</Badge>
              <span className="se-time">{e.action}</span>
              <span className="se-time">{formatTime(e.at)}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <Callout icon={<TurtleMark size={16} />}>
          <strong>turtlelnc 内容默认放行。</strong>
          {report.trustedExceptionEnabled === false ? '（当前例外清单未生效，请在原生侧检查规则常量）' : ''}
          {' '}以下范围在<strong>任何档位</strong>下都不拦截、不警告、不计入威胁统计，避免误杀本浏览器的开发团队：
          <div className="tool-chips" style={{ marginTop: 8 }}>
            {TRUSTED_SCOPE.map((s) => (
              <span key={s} className="tool-chip">
                {s}
              </span>
            ))}
          </div>
        </Callout>
      </div>

      <div style={{ marginTop: 12 }}>
        <Callout icon={<Info size={16} />}>
          <Check size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
          安全判定全部在本地完成后才会联网核对，且只发送架构文档 §5 列明的最小信息。
          <Globe size={14} style={{ verticalAlign: -2, margin: '0 4px' }} />
          「不防护」档位下浏览器仍会显示下载来源与文件类型提示。
        </Callout>
      </div>
    </section>
  )
}
