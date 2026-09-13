/**
 * 设置面板（v1.0.0-rc1）
 *
 * 十个分区：
 *   常规 / 外观 / 能效模式 / 安全浏览 / 无痕模式 / 账户与同步 /
 *   网页应用 / 扩展程序 / AI 模型连接 / AI 模式 / AI 控制台 / 关于
 *
 * 状态归属：外观类（皮肤 / 主题 / 性能档）与常规项保存在本组件，
 * 由底部「保存设置」统一提交；其余分区各自即时落盘（切换即刻生效），
 * 因为它们都对应原生侧的独立命令（setProtectionLevel / setEnergyMode / …）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { BrowserSkin, ThemeMode2, TibSettings } from '@shared/bridge'
import { tib } from '../../bridge'
import { applyPerf, applySkin, applyTheme, resolveTheme, watchSystemTheme } from '../../theme'
import { Loading } from '../ui'
import {
  Bolt,
  Gear,
  Grid,
  Incognito,
  Info,
  Key,
  Leaf,
  Palette,
  Puzzle,
  Server,
  Shield,
  Terminal,
  User
} from '../icons'
import { GeneralSection } from './GeneralSection'
import { AppearanceSection } from './AppearanceSection'
import { EnergySection } from './EnergySection'
import { SecuritySection } from './SecuritySection'
import { IncognitoSection } from './IncognitoSection'
import { AccountsSection } from './AccountsSection'
import { WebAppsSection } from './WebAppsSection'
import { ExtensionsSection } from './ExtensionsSection'
import { AiConnectionSection } from './AiConnectionSection'
import { AiModeSection } from './AiModeSection'
import { AutomationSection } from './AutomationSection'
import { AboutSection } from './AboutSection'

type SectionId =
  | 'general'
  | 'appearance'
  | 'energy'
  | 'security'
  | 'incognito'
  | 'accounts'
  | 'apps'
  | 'extensions'
  | 'aiConnection'
  | 'aiMode'
  | 'automation'
  | 'about'

const NAV: { id: SectionId; label: string; hint: string; icon: typeof Gear }[] = [
  { id: 'general', label: '常规', hint: '搜索与启动', icon: Gear },
  { id: 'appearance', label: '外观', hint: '皮肤 / 主题', icon: Palette },
  { id: 'energy', label: '能效模式', hint: '四档', icon: Leaf },
  { id: 'security', label: '安全浏览', hint: '三档防护', icon: Shield },
  { id: 'incognito', label: '无痕模式', hint: '指纹改写', icon: Incognito },
  { id: 'accounts', label: '账户与同步', hint: '登录 / 迁移', icon: User },
  { id: 'apps', label: '网页应用', hint: '独立窗口', icon: Grid },
  { id: 'extensions', label: '扩展程序', hint: '启用 / 加载', icon: Puzzle },
  { id: 'aiConnection', label: 'AI 模型连接', hint: 'Key / MCP', icon: Key },
  { id: 'aiMode', label: 'AI 模式', hint: '浏览 / 办公 / 开发', icon: Terminal },
  { id: 'automation', label: 'AI 控制台', hint: '自动化接口', icon: Server },
  { id: 'about', label: '关于', hint: '版本信息', icon: Info }
]

const HERO: Record<SectionId, { title: string; desc: string }> = {
  general: { title: '常规', desc: '搜索引擎、主页与启动行为。' },
  appearance: { title: '外观', desc: '皮肤、主题与性能档，切换即时生效、无需重启。' },
  energy: { title: '能效模式', desc: '在内存、启动速度与兼容性之间取舍。' },
  security: { title: '安全浏览', desc: '决定浏览器如何判断网站与下载是否危险。' },
  incognito: { title: '无痕模式 2.0', desc: '独立上下文 + 指纹改写，关闭即清除。' },
  accounts: { title: '账户与同步', desc: '登录、同步开关与本机迁移。' },
  apps: { title: '网页应用', desc: '把常用网站变成独立窗口应用。' },
  extensions: { title: '扩展程序', desc: '启用、禁用与本地加载。' },
  aiConnection: { title: 'AI 模型连接', desc: 'API Key / MCP 服务器 / OAuth 三种接入方式。' },
  aiMode: { title: 'AI 模式', desc: '明确 AI 能看到什么、能改什么。' },
  automation: { title: 'AI 控制台 / 自动化', desc: '把浏览器暴露给本机脚本与你自己的 AI 工具。' },
  about: { title: '关于', desc: '版本、内核、许可证与官网。' }
}

/** 本地化的默认设置（在 getSettings 返回前先用它渲染，避免白屏） */
const FALLBACK: TibSettings = {
  searchEngine: 'bing',
  homepage: 'https://www.bing.com',
  theme: 'system',
  skin: 'tibrowser',
  perf: 'high',
  bookmarkBarVisible: true,
  showHomeButton: true,
  restoreSession: true,
  cliPermission: 'daily',
  aiEnabled: true,
  serviceAutoStart: true
}

interface Props {
  /** overlay：带左侧导航的完整设置页；stacked：直接顺序铺开（「关于」页里复用） */
  mode?: 'overlay' | 'stacked'
}

export function SettingsPanel({ mode = 'overlay' }: Props): JSX.Element {
  const [form, setForm] = useState<TibSettings | null>(null)
  const [active, setActive] = useState<SectionId>('appearance')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState('')
  const systemThemeRef = useRef<ThemeMode2>('system')

  // 首次加载设置
  useEffect(() => {
    let alive = true
    tib
      .getSettings()
      .then((s) => alive && setForm(s))
      .catch((err: unknown) => {
        if (!alive) return
        setError(`读取设置失败，已使用默认值：${String(err)}`)
        setForm(FALLBACK)
      })
    return () => {
      alive = false
    }
  }, [])

  // 外观三件套：皮肤 / 主题 / 性能档，任何变化都立即作用到 <html>
  useEffect(() => {
    if (!form) return
    applySkin(form.skin)
    applyTheme(resolveTheme(form.theme))
    applyPerf(form.perf)
  }, [form?.skin, form?.theme, form?.perf])

  // 跟随系统主题时的实时联动
  useEffect(() => {
    systemThemeRef.current = form?.theme ?? 'system'
    return watchSystemTheme((t) => {
      if (systemThemeRef.current === 'system') applyTheme(t)
    })
  }, [form?.theme])

  const patch = useMemo(
    () => (p: Partial<TibSettings>) => {
      setForm((prev) => ({ ...(prev ?? FALLBACK), ...p }))
      setSaveState('idle')
    },
    []
  )

  async function save(): Promise<void> {
    if (!form) return
    setSaveState('saving')
    setError('')
    try {
      await tib.setSettings({
        searchEngine: form.searchEngine,
        homepage: form.homepage,
        theme: form.theme,
        perf: form.perf,
        bookmarkBarVisible: form.bookmarkBarVisible,
        showHomeButton: form.showHomeButton,
        restoreSession: form.restoreSession,
        serviceAutoStart: form.serviceAutoStart
      })
      await tib.setSkin(form.skin as BrowserSkin)
      setSaveState('saved')
      setTimeout(() => setSaveState('idle'), 1800)
    } catch (err) {
      setError(`保存设置失败：${String(err)}`)
      setSaveState('error')
    }
  }

  if (!form) return <Loading text="正在读取设置…" />

  const hero = HERO[active]

  return (
    <div className={mode === 'overlay' ? 'settings-layout' : ''}>
      {mode === 'overlay' ? (
        <nav className="settings-nav" aria-label="设置分区">
          {NAV.map((n) => {
            const IconCmp = n.icon
            return (
              <span
                key={n.id}
                className={`settings-nav-item ${active === n.id ? 'active' : ''}`}
                role="tab"
                aria-selected={active === n.id}
                tabIndex={0}
                onClick={() => setActive(n.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setActive(n.id)
                  }
                }}
              >
                <IconCmp size={15} />
                {n.label}
                <span className="nav-hint">{n.hint}</span>
              </span>
            )
          })}
        </nav>
      ) : null}

      <div className="settings-content">
        {mode === 'overlay' ? (
          <div className="settings-hero">
            <span className="hero-icon">
              <Bolt size={20} />
            </span>
            <div className="hero-text">
              <h1>{hero.title}</h1>
              <p>{hero.desc}</p>
            </div>
          </div>
        ) : null}

        {mode === 'stacked' ? (
          <>
            <GeneralSection form={form} patch={patch} />
            <AppearanceSection form={form} patch={patch} />
            <EnergySection />
            <SecuritySection />
            <IncognitoSection />
            <AccountsSection />
            <WebAppsSection />
            <ExtensionsSection />
            <AiConnectionSection />
            <AiModeSection />
            <AutomationSection />
            <AboutSection />
          </>
        ) : (
          <>
            {active === 'general' ? <GeneralSection form={form} patch={patch} /> : null}
            {active === 'appearance' ? <AppearanceSection form={form} patch={patch} /> : null}
            {active === 'energy' ? <EnergySection /> : null}
            {active === 'security' ? <SecuritySection /> : null}
            {active === 'incognito' ? <IncognitoSection /> : null}
            {active === 'accounts' ? <AccountsSection /> : null}
            {active === 'apps' ? <WebAppsSection /> : null}
            {active === 'extensions' ? <ExtensionsSection /> : null}
            {active === 'aiConnection' ? <AiConnectionSection /> : null}
            {active === 'aiMode' ? <AiModeSection /> : null}
            {active === 'automation' ? <AutomationSection /> : null}
            {active === 'about' ? <AboutSection /> : null}
          </>
        )}

        {mode === 'stacked' || active === 'general' || active === 'appearance' ? (
          <div className="settings-foot">
            <button className="btn primary" type="button" onClick={() => void save()} disabled={saveState === 'saving'}>
              {saveState === 'saving' ? '正在保存…' : '保存设置'}
            </button>
            {saveState === 'saved' ? <span className="save-state">已保存 ✓（皮肤与主题已生效）</span> : null}
            {saveState === 'error' ? <span className="save-state err">{error}</span> : null}
            {saveState === 'idle' && error ? <span className="save-state err">{error}</span> : null}
            <span style={{ color: 'var(--tb-text-2)' }}>
              本页中的安全档位、能效模式、扩展开关等在点击时即刻生效，无需再保存。
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
