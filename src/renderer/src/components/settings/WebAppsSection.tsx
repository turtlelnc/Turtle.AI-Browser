/**
 * 设置 · 网页应用（feature 7）
 *
 * 「从此标签页创建应用」会把当前标签页升级为独立窗口应用；
 * 已安装应用可启动（在独立窗口打开）或卸载。
 */
import { useEffect, useState } from 'react'
import type { BrowserState, WebApp } from '@shared/bridge'
import { tib } from '../../bridge'
import { Badge, Callout, ErrorView, Field, Loading } from '../ui'
import { External, Grid, Info, Plus, Trash } from '../icons'

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function WebAppsSection(): JSX.Element {
  const [apps, setApps] = useState<WebApp[] | null>(null)
  const [state, setState] = useState<BrowserState | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)

  async function load(): Promise<void> {
    setError('')
    try {
      const [list, st] = await Promise.all([tib.getInstalledApps(), tib.getState()])
      setApps(list)
      setState(st)
    } catch (err) {
      setError(`读取网页应用失败：${String(err)}`)
    }
  }

  useEffect(() => {
    void load()
    return tib.on('appsChanged', setApps)
  }, [])

  const activeTab = state?.tabs.find((t) => t.id === state.activeTabId)
  const creatable = Boolean(activeTab && !activeTab.isNewTab && activeTab.url)

  /** 用当前标签页的信息预填创建表单 */
  function prefillFromActiveTab(): void {
    if (!activeTab) return
    setUrl(activeTab.url)
    setName(activeTab.title && activeTab.title !== activeTab.url ? activeTab.title : hostOf(activeTab.url))
    setNotice('已从当前标签页填入名称与网址，可自行修改后创建。')
  }

  async function create(): Promise<void> {
    if (!url.trim()) {
      setError('请填写要创建为应用的网址。')
      return
    }
    setBusy(true)
    setError('')
    try {
      const app = await tib.installWebApp(url.trim(), name.trim() || hostOf(url.trim()))
      setApps((prev) => (prev ? [...prev, app] : [app]))
      setName('')
      setUrl('')
      setNotice(`已创建网页应用「${app.name}」，可在上方「已安装应用」中启动。`)
    } catch (err) {
      setError(`创建失败：${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function uninstall(id: string, appName: string): Promise<void> {
    try {
      await tib.uninstallWebApp(id)
      setApps((prev) => (prev ? prev.filter((a) => a.id !== id) : prev))
      setNotice(`已卸载「${appName}」。`)
    } catch (err) {
      setError(`卸载失败：${String(err)}`)
    }
  }

  if (error && !apps) return <ErrorView message={error} onRetry={() => void load()} />
  if (!apps) return <Loading text="正在读取已安装的网页应用…" />

  return (
    <section className="ov-section">
      <h2>已安装应用</h2>
      <p className="sec-desc">
        网页应用会以独立窗口打开，拥有自己的任务栏图标与快捷方式，不再显示地址栏——用起来和本机程序一样。
      </p>

      {apps.length === 0 ? (
        <div className="empty">
          还没有安装任何网页应用
          <div style={{ fontSize: 12, marginTop: 4 }}>在任意网站点击「从此标签页创建应用」即可安装。</div>
        </div>
      ) : (
        <div className="app-grid">
          {apps.map((a) => (
            <div key={a.id} className="app-tile">
              <span className="app-icon">
                {a.icon ? <img src={a.icon} alt="" /> : a.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="app-name" title={a.name}>
                {a.name}
              </span>
              <span className="app-host" title={a.url}>
                {hostOf(a.url)}
              </span>
              <span className="app-actions">
                <button className="btn small primary" type="button" onClick={() => void tib.launchWebApp(a.id)}>
                  <External size={13} />
                  启动
                </button>
                <button className="btn small ghost" type="button" onClick={() => void uninstall(a.id, a.name)}>
                  <Trash size={13} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ marginTop: 32 }}>从此标签页创建应用</h2>
      <p className="sec-desc">
        名称与图标会自动从当前页面获取；图标可以稍后由原生侧抓取站点 favicon（本版本使用首字母占位）。
      </p>
      {notice ? <Callout tone="accent">{notice}</Callout> : null}
      {error ? <ErrorView message={error} /> : null}

      <Field label="应用名称" desc="显示在独立窗口标题与任务栏上">
        <input type="text" value={name} placeholder="例如：TiBrowser 官网" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="网址" desc="应用的起始地址，必须包含协议（https://）">
        <input
          type="text"
          value={url}
          spellCheck={false}
          placeholder="https://"
          onChange={(e) => setUrl(e.target.value)}
        />
      </Field>

      <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
        <button className="btn primary" type="button" onClick={() => void create()} disabled={busy}>
          <Plus size={15} />
          {busy ? '正在创建…' : '创建应用'}
        </button>
        <button className="btn" type="button" onClick={prefillFromActiveTab} disabled={!creatable}>
          <Grid size={15} />
          从当前标签页填入
        </button>
        {creatable ? <Badge tone="accent">当前：{hostOf(activeTab?.url ?? '')}</Badge> : <Badge>当前标签页不可用</Badge>}
      </div>

      <div style={{ marginTop: 16 }}>
        <Callout icon={<Info size={16} />}>
          卸载只会移除应用快捷方式与独立窗口，不会删除浏览数据（Cookie、缓存仍保留在浏览器配置里）。
        </Callout>
      </div>
    </section>
  )
}
