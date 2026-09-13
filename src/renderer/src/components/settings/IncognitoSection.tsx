/**
 * 设置 · 无痕模式 2.0（feature 4）
 *
 * 指纹改写编辑器：每个字段都能单独「跟随系统」或指定固定值，
 * 并给出该字段的中文解释与当前系统真实取值（方便对比）。
 * 「一键随机化」一次性生成一整套自洽的伪指纹。
 */
import { useEffect, useMemo, useState } from 'react'
import type { FingerprintProfile } from '@shared/bridge'
import { tib } from '../../bridge'
import { formatTime } from '../../format'
import { Badge, Callout, ErrorView, Field, Loading, Switch } from '../ui'
import { EyeOff, Fingerprint, Incognito, Info, Reload } from '../icons'

type Mode = 'system' | 'value'

/** 读取本机真实指纹（仅用于在界面上做对照展示，不会发送到任何地方） */
function systemFacts(): Record<string, string> {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '未知'
  return {
    userAgent: nav.userAgent,
    platform: nav.userAgentData?.platform ?? nav.platform ?? '未知',
    timezone: tz,
    language: nav.language || '未知',
    screen: `${window.screen.width} × ${window.screen.height}`,
    hardwareConcurrency: String(nav.hardwareConcurrency ?? '未知')
  }
}

const PLATFORMS = ['Win32', 'MacIntel', 'Linux x86_64']
const TIMEZONES = ['Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles']
const LANGUAGES = ['zh-CN,zh;q=0.9', 'zh-TW,zh;q=0.8', 'en-US,en;q=0.9', 'ja-JP,ja;q=0.9', 'de-DE,de;q=0.9']
const SCREENS = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 3840, height: 2160 }
]

/** 单个指纹字段：模式切换 + 取值控件 + 中文解释 */
function FpItem({
  label,
  hint,
  mode,
  onMode,
  children,
  systemValue
}: {
  label: string
  hint: string
  mode: Mode
  onMode: (m: Mode) => void
  children: (disabled: boolean) => JSX.Element
  systemValue?: string
}): JSX.Element {
  return (
    <div className="fp-item">
      <div className="fp-label">
        <span>{label}</span>
        <Badge tone={mode === 'system' ? undefined : 'accent'}>
          {mode === 'system' ? '跟随系统' : '自定义'}
        </Badge>
        <span style={{ marginLeft: 'auto' }}>
          <Switch on={mode === 'value'} onToggle={() => onMode(mode === 'system' ? 'value' : 'system')} />
        </span>
      </div>
      <div className="fp-control">{children(mode === 'system')}</div>
      <div className="fp-hint">
        {hint}
        {systemValue ? (
          <>
            <br />
            本机真实值：<span className="code-inline">{systemValue}</span>
          </>
        ) : null}
      </div>
    </div>
  )
}

export function IncognitoSection(): JSX.Element {
  const [fp, setFp] = useState<FingerprintProfile | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const facts = useMemo(systemFacts, [])

  async function load(): Promise<void> {
    setError('')
    try {
      setFp(await tib.getFingerprintProfile())
    } catch (err) {
      setError(`读取指纹配置失败：${String(err)}`)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  /** 单个字段改动：立即写回并保持本地状态一致 */
  async function update(patch: Partial<FingerprintProfile>): Promise<void> {
    if (!fp) return
    const optimistic = { ...fp, ...patch }
    setFp(optimistic)
    try {
      setFp(await tib.setFingerprintProfile(patch))
    } catch (err) {
      setError(`保存指纹字段失败：${String(err)}`)
    }
  }

  async function randomize(): Promise<void> {
    setBusy(true)
    setNotice('')
    try {
      setFp(await tib.randomizeFingerprint())
      setNotice('已生成一整套自洽的伪指纹（UA / 平台 / 时区 / 语言 / 分辨率 / 核心数互相匹配），仅对无痕窗口生效。')
    } catch (err) {
      setError(`随机化失败：${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  if (error && !fp) return <ErrorView message={error} onRetry={() => void load()} />
  if (!fp) return <Loading text="正在读取指纹配置…" />

  const screenValue = typeof fp.screen === 'string' ? '' : `${fp.screen.width}x${fp.screen.height}`

  return (
    <section className="ov-section">
      <h2>无痕模式 2.0</h2>
      <p className="sec-desc">
        无痕窗口使用独立的浏览上下文（不写入磁盘），并按下面的配置改写浏览器指纹，
        让网站难以把你和普通窗口关联起来。所有字段默认「跟随系统」，只有主动修改过的字段才会被改写。
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn primary" type="button" onClick={() => void randomize()} disabled={busy}>
          <Reload size={15} />
          {busy ? '正在生成…' : '一键随机化'}
        </button>
        <span style={{ fontSize: 12, color: 'var(--tb-text-3)' }}>
          上次随机化：{formatTime(fp.randomizedAt)}（随机化会同时打开 Canvas / WebGL 噪声）
        </span>
      </div>

      {notice ? <Callout tone="accent">{notice}</Callout> : null}

      <div className="fp-grid">
        <FpItem
          label="User-Agent"
          hint="浏览器向网站自报的身份字符串。改写后应与「平台」保持一致，否则反而更显眼。"
          mode={fp.userAgent === 'system' ? 'system' : 'value'}
          onMode={(m) => void update({ userAgent: m === 'system' ? 'system' : facts.userAgent })}
          systemValue={facts.userAgent}
        >
          {(disabled) => (
            <input
              type="text"
              disabled={disabled}
              value={fp.userAgent === 'system' ? '' : fp.userAgent}
              placeholder="跟随系统（不改写）"
              onChange={(e) => void update({ userAgent: e.target.value })}
            />
          )}
        </FpItem>

        <FpItem
          label="平台"
          hint="navigator.platform 的取值，常用于区分 Windows / macOS / Linux。"
          mode={fp.platform === 'system' ? 'system' : 'value'}
          onMode={(m) => void update({ platform: m === 'system' ? 'system' : facts.platform })}
          systemValue={facts.platform}
        >
          {(disabled) => (
            <select
              disabled={disabled}
              value={fp.platform === 'system' ? '' : fp.platform}
              onChange={(e) => void update({ platform: e.target.value })}
            >
              <option value="">跟随系统</option>
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          )}
        </FpItem>

        <FpItem
          label="时区"
          hint="网站可用时区推断你所在的国家 / 地区，改写后与语言不一致会显得可疑。"
          mode={fp.timezone === 'system' ? 'system' : 'value'}
          onMode={(m) => void update({ timezone: m === 'system' ? 'system' : facts.timezone })}
          systemValue={facts.timezone}
        >
          {(disabled) => (
            <select
              disabled={disabled}
              value={fp.timezone === 'system' ? '' : fp.timezone}
              onChange={(e) => void update({ timezone: e.target.value })}
            >
              <option value="">跟随系统</option>
              {TIMEZONES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
        </FpItem>

        <FpItem
          label="语言"
          hint="Accept-Language 与 navigator.language，决定网站用哪种语言展示。"
          mode={fp.language === 'system' ? 'system' : 'value'}
          onMode={(m) => void update({ language: m === 'system' ? 'system' : facts.language })}
          systemValue={facts.language}
        >
          {(disabled) => (
            <select
              disabled={disabled}
              value={fp.language === 'system' ? '' : fp.language}
              onChange={(e) => void update({ language: e.target.value })}
            >
              <option value="">跟随系统</option>
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          )}
        </FpItem>

        <FpItem
          label="屏幕分辨率"
          hint="window.screen 的宽高。分辨率与 UA 声明的设备类型明显不符时会成为特征。"
          mode={fp.screen === 'system' ? 'system' : 'value'}
          onMode={(m) =>
            void update({ screen: m === 'system' ? 'system' : { width: window.screen.width, height: window.screen.height } })
          }
          systemValue={facts.screen}
        >
          {(disabled) => (
            <select
              disabled={disabled}
              value={screenValue}
              onChange={(e) => {
                const [w, h] = e.target.value.split('x').map(Number)
                void update({ screen: { width: w, height: h } })
              }}
            >
              <option value="">跟随系统</option>
              {SCREENS.map((s) => (
                <option key={`${s.width}x${s.height}`} value={`${s.width}x${s.height}`}>
                  {s.width} × {s.height}
                </option>
              ))}
            </select>
          )}
        </FpItem>

        <FpItem
          label="硬件并发数"
          hint="navigator.hardwareConcurrency，即 CPU 逻辑核心数，常被用于设备指纹。"
          mode={fp.hardwareConcurrency === 'system' ? 'system' : 'value'}
          onMode={(m) =>
            void update({ hardwareConcurrency: m === 'system' ? 'system' : (navigator.hardwareConcurrency ?? 8) })
          }
          systemValue={facts.hardwareConcurrency}
        >
          {(disabled) => (
            <select
              disabled={disabled}
              value={fp.hardwareConcurrency === 'system' ? '' : String(fp.hardwareConcurrency)}
              onChange={(e) => void update({ hardwareConcurrency: Number(e.target.value) })}
            >
              <option value="">跟随系统</option>
              {[2, 4, 6, 8, 12, 16, 24, 32].map((n) => (
                <option key={n} value={n}>
                  {n} 核
                </option>
              ))}
            </select>
          )}
        </FpItem>
      </div>

      <Field label="Canvas 噪声" desc="在读取 Canvas 像素时注入极小扰动，抵御 Canvas 指纹（几乎不影响画面）">
        <Switch on={fp.canvasNoise} onToggle={() => void update({ canvasNoise: !fp.canvasNoise })} />
      </Field>

      <Field label="WebGL 噪声" desc="扰动 WebGL 渲染参数与显卡型号字符串，抵御 WebGL 指纹">
        <Switch on={fp.webglNoise} onToggle={() => void update({ webglNoise: !fp.webglNoise })} />
      </Field>

      <Field label="Do-Not-Track" desc="发送 DNT: 1 请求头，表达「不要追踪我」的意愿（遵守与否取决于网站）">
        <Switch on={fp.doNotTrack} onToggle={() => void update({ doNotTrack: !fp.doNotTrack })} />
      </Field>

      <Field label="禁用 WebRTC" desc="阻止 WebRTC 泄露真实内网 IP；开启后网页版音视频通话可能不可用">
        <Switch
          on={Boolean(fp.disableWebRtc)}
          onToggle={() => void update({ disableWebRtc: !fp.disableWebRtc })}
        />
      </Field>

      <Field label="阻止第三方 Cookie" desc="无痕窗口内默认阻止跨站 Cookie，减少跨站追踪">
        <Switch
          on={Boolean(fp.blockThirdPartyCookies)}
          onToggle={() => void update({ blockThirdPartyCookies: !fp.blockThirdPartyCookies })}
        />
      </Field>

      <div style={{ marginTop: 16 }}>
        <Callout icon={<Incognito size={16} />}>
          无痕窗口会在<strong>标签栏</strong>显示「无痕」标记，并用紫色强调色与普通窗口区分；
          关闭全部无痕窗口后，Cookie、缓存与本次会话记录会被立即清除。
        </Callout>
      </div>
      <div style={{ marginTop: 12 }}>
        <Callout icon={<EyeOff size={16} />}>
          指纹改写只能降低被识别的概率，无法做到匿名：登录账号、浏览器扩展、网络出口 IP 仍可能识别你。
          <Fingerprint size={14} style={{ verticalAlign: -2, margin: '0 4px' }} />
          配置仅作用于无痕窗口，普通窗口始终保持真实指纹。
        </Callout>
      </div>
    </section>
  )
}
