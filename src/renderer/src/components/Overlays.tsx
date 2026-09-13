/**
 * 覆盖层：设置 / 历史 / 书签 / 下载 / 关于（+ 网页应用 / 扩展程序两个快捷入口）。
 *
 * 打开覆盖层时原生侧会隐藏网页视图（`tib.setOverlay`），因此这里的样式可以放心使用
 * 半透明与毛玻璃；性能档为「低占用」时令牌层会把模糊降级为纯色。
 * 每个列表都提供：加载中 / 空 / 出错 三种状态（中文）。
 */
import { useEffect, useMemo, useState } from 'react'
import type {
  BookmarkNode,
  BrowserState,
  DownloadItem,
  ExtensionInfo,
  HistoryItem,
  OverlayName,
  WebApp
} from '@shared/bridge'
import { on, tib } from '../bridge'
import { formatBytes, formatTime } from '../format'
import { SettingsPanel } from './settings/SettingsPanel'
import { Badge, EmptyView, ErrorView, Loading } from './ui'
import {
  Bookmark,
  Clock,
  Close,
  Download,
  External,
  Folder,
  Grid,
  Info,
  Puzzle,
  Search,
  Sparkles,
  Trash
} from './icons'
import { TIB_VERSION_LABEL } from '@shared/bridge'

type OverlayKey = NonNullable<OverlayName>

const TITLES: Record<OverlayKey, string> = {
  settings: '设置',
  history: '历史记录',
  bookmarks: '书签管理器',
  downloads: '下载内容',
  about: '关于 TiBrowser',
  apps: '网页应用',
  extensions: '扩展程序',
  aiConsole: 'AI 控制台'
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function Shell({ title, children, wide }: { title: string; children: React.ReactNode; wide?: boolean }): JSX.Element {
  return (
    <div className="overlay">
      <div className="ov-header chrome">
        <span>{title}</span>
        <span className="spacer" />
        <span
          className="nav-btn"
          style={{ width: 30, height: 30 }}
          title="关闭（Esc）"
          onClick={() => void tib.setOverlay(null)}
        >
          <Close size={18} />
        </span>
      </div>
      <div className={`ov-body ${wide ? 'wide' : ''}`}>{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 历史记录
// ---------------------------------------------------------------------------

function HistoryList(): JSX.Element {
  const [items, setItems] = useState<HistoryItem[] | null>(null)
  const [q, setQ] = useState('')
  const [error, setError] = useState('')

  async function load(keyword?: string): Promise<void> {
    setError('')
    try {
      setItems(await tib.getHistory(keyword, 500))
    } catch (err) {
      setError(`读取历史记录失败：${String(err)}`)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function clearAll(): Promise<void> {
    try {
      await tib.clearHistory()
      setItems([])
    } catch (err) {
      setError(`清空历史失败：${String(err)}`)
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await tib.removeHistory(id)
      setItems((prev) => (prev ? prev.filter((i) => i.id !== id) : prev))
    } catch (err) {
      setError(`删除记录失败：${String(err)}`)
    }
  }

  const grouped = useMemo(() => items ?? [], [items])

  return (
    <Shell title={TITLES.history}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        <div className="omnibox" style={{ maxWidth: 360 }}>
          <Search size={15} style={{ color: 'var(--tb-text-3)' }} />
          <input
            value={q}
            placeholder="搜索历史记录"
            onChange={(e) => {
              setQ(e.target.value)
              void load(e.target.value)
            }}
          />
        </div>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn small" onClick={() => void clearAll()} disabled={!items || items.length === 0}>
          <Trash size={14} />
          清空历史
        </button>
      </div>

      {error ? <ErrorView message={error} onRetry={() => void load(q)} /> : null}
      {!items ? (
        <Loading text="正在读取历史记录…" />
      ) : grouped.length === 0 ? (
        <EmptyView text={q ? '没有匹配的历史记录' : '暂无历史记录'} hint="浏览网页后，这里会按时间列出你访问过的页面。" />
      ) : (
        <div className="list">
          {grouped.map((h) => (
            <div key={h.id} className="list-item" onClick={() => void tib.navigate(h.url)}>
              <Clock size={16} style={{ color: 'var(--tb-text-3)' }} />
              <div className="li-main">
                <div className="li-title">{h.title || hostOf(h.url)}</div>
                <div className="li-sub">{h.url}</div>
              </div>
              <span className="se-time">{formatTime(h.visitedAt)}</span>
              <span
                className="li-action"
                title="删除这条记录"
                onClick={(e) => {
                  e.stopPropagation()
                  void remove(h.id)
                }}
              >
                <Close size={14} />
              </span>
            </div>
          ))}
        </div>
      )}
    </Shell>
  )
}

// ---------------------------------------------------------------------------
// 书签
// ---------------------------------------------------------------------------

function BookmarkList(): JSX.Element {
  const [items, setItems] = useState<BookmarkNode[] | null>(null)
  const [q, setQ] = useState('')
  const [error, setError] = useState('')

  async function load(): Promise<void> {
    setError('')
    try {
      setItems(await tib.getBookmarks())
    } catch (err) {
      setError(`读取书签失败：${String(err)}`)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function remove(id: string): Promise<void> {
    try {
      await tib.removeBookmark(id)
      setItems((prev) => (prev ? prev.filter((b) => b.id !== id) : prev))
    } catch (err) {
      setError(`删除书签失败：${String(err)}`)
    }
  }

  const filtered = (items ?? []).filter(
    (b) => !q.trim() || b.title.includes(q) || b.url.toLowerCase().includes(q.toLowerCase())
  )

  return (
    <Shell title={TITLES.bookmarks}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <div className="omnibox" style={{ maxWidth: 360 }}>
          <Search size={15} style={{ color: 'var(--tb-text-3)' }} />
          <input value={q} placeholder="搜索书签" onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {error ? <ErrorView message={error} onRetry={() => void load()} /> : null}
      {!items ? (
        <Loading text="正在读取书签…" />
      ) : filtered.length === 0 ? (
        <EmptyView text={q ? '没有匹配的书签' : '暂无书签'} hint="点击地址栏右侧的星标即可把当前页面加入书签。" />
      ) : (
        <div className="list">
          {filtered.map((b) => (
            <div key={b.id} className="list-item" onClick={() => void tib.navigate(b.url)}>
              <Bookmark size={16} style={{ color: 'var(--tb-accent)' }} />
              <div className="li-main">
                <div className="li-title">{b.title || hostOf(b.url)}</div>
                <div className="li-sub">
                  {b.url}
                  {b.folder ? ` · ${b.folder}` : ''}
                </div>
              </div>
              <span className="se-time">{formatTime(b.createdAt)}</span>
              <span
                className="li-action"
                title="删除书签"
                onClick={(e) => {
                  e.stopPropagation()
                  void remove(b.id)
                }}
              >
                <Close size={14} />
              </span>
            </div>
          ))}
        </div>
      )}
    </Shell>
  )
}

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------

function DownloadList(): JSX.Element {
  const [items, setItems] = useState<DownloadItem[] | null>(null)
  const [error, setError] = useState('')

  async function load(): Promise<void> {
    setError('')
    try {
      setItems(await tib.getDownloads())
    } catch (err) {
      setError(`读取下载记录失败：${String(err)}`)
    }
  }

  useEffect(() => {
    void load()
    return on('download', (item) => {
      setItems((prev) => {
        if (!prev) return [item]
        const i = prev.findIndex((x) => x.id === item.id)
        if (i < 0) return [item, ...prev]
        const next = [...prev]
        next[i] = item
        return next
      })
    })
  }, [])

  function label(it: DownloadItem): string {
    if (it.state === 'completed') return `已完成 · ${formatBytes(it.totalBytes)}`
    if (it.state === 'interrupted') return '已中断'
    if (it.state === 'cancelled') return '已取消'
    const pct = it.totalBytes > 0 ? Math.round((it.receivedBytes / it.totalBytes) * 100) : 0
    return `下载中 ${pct}% · ${formatBytes(it.receivedBytes)} / ${formatBytes(it.totalBytes)}`
  }

  return (
    <Shell title={TITLES.downloads}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className="btn small" onClick={() => void tib.openDownloadFolder()}>
          <Folder size={14} />
          打开下载文件夹
        </button>
      </div>

      {error ? <ErrorView message={error} onRetry={() => void load()} /> : null}
      {!items ? (
        <Loading text="正在读取下载记录…" />
      ) : items.length === 0 ? (
        <EmptyView text="暂无下载内容" hint="从网页下载的文件会出现在这里，可疑安装包会先弹出安全警告。" />
      ) : (
        <div className="list">
          {items.map((it) => (
            <div key={it.id} className="list-item">
              <Download size={16} style={{ color: 'var(--tb-text-3)' }} />
              <div className="li-main">
                <div className="li-title">
                  {it.filename}
                  {it.suspicious ? <Badge tone="warn">可疑来源</Badge> : null}
                </div>
                <div className="li-sub">
                  {label(it)}
                  {it.suspiciousReason ? ` · ${it.suspiciousReason}` : ''}
                </div>
              </div>
              {it.state === 'completed' ? (
                <span className="li-action always" title="打开文件" onClick={() => void tib.openDownload(it.id)}>
                  <External size={15} />
                </span>
              ) : null}
              <span className="li-action always" title="在文件夹中显示" onClick={() => void tib.openDownloadFolder()}>
                <Folder size={15} />
              </span>
            </div>
          ))}
        </div>
      )}
    </Shell>
  )
}

// ---------------------------------------------------------------------------
// 关于（内嵌完整设置页，含版本信息）
// ---------------------------------------------------------------------------

function AboutPanel(): JSX.Element {
  return (
    <Shell title={TITLES.about} wide>
      <div style={{ textAlign: 'center', padding: '8px 0 24px' }}>
        <div
          style={{
            display: 'inline-flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 10,
            padding: '28px 40px',
            borderRadius: 'var(--tb-card-radius-lg)',
            background: 'var(--tb-surface)',
            boxShadow: 'var(--tb-elev-1)'
          }}
        >
          <span
            style={{
              display: 'grid',
              placeItems: 'center',
              width: 56,
              height: 56,
              borderRadius: 'var(--tb-newtab-radius)',
              background: 'linear-gradient(135deg, var(--tb-newtab-a), var(--tb-newtab-b))',
              color: '#fff'
            }}
          >
            <Sparkles size={28} />
          </span>
          <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.4px' }}>TiBrowser</div>
          <div style={{ color: 'var(--tb-text-2)', fontSize: 13 }}>{TIB_VERSION_LABEL}</div>
        </div>
      </div>
      <SettingsPanel mode="stacked" />
    </Shell>
  )
}

// ---------------------------------------------------------------------------
// 网页应用 / 扩展程序（从设置里拆出来的独立视图）
// ---------------------------------------------------------------------------

function AppsPanel(): JSX.Element {
  const [apps, setApps] = useState<WebApp[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    tib
      .getInstalledApps()
      .then(setApps)
      .catch((err: unknown) => setError(`读取网页应用失败：${String(err)}`))
    return on('appsChanged', setApps)
  }, [])

  return (
    <Shell title={TITLES.apps}>
      <p className="sec-desc">网页应用会以独立窗口打开，可固定到任务栏，也可在此卸载。</p>
      <div style={{ marginBottom: 16 }}>
        <button className="btn small" onClick={() => void tib.setOverlay('settings')}>
          <Grid size={14} />
          前往设置创建新应用
        </button>
      </div>
      {error ? <ErrorView message={error} /> : null}
      {!apps ? (
        <Loading text="正在读取网页应用…" />
      ) : apps.length === 0 ? (
        <EmptyView text="还没有安装任何网页应用" hint="在「设置 → 网页应用」中可以从当前标签页一键创建。" />
      ) : (
        <div className="app-grid">
          {apps.map((a) => (
            <div key={a.id} className="app-tile">
              <span className="app-icon">{a.icon ? <img src={a.icon} alt="" /> : a.name.slice(0, 1).toUpperCase()}</span>
              <span className="app-name">{a.name}</span>
              <span className="app-host">{hostOf(a.url)}</span>
              <span className="app-actions">
                <button className="btn small primary" onClick={() => void tib.launchWebApp(a.id)}>
                  启动
                </button>
                <button className="btn small ghost" onClick={() => void tib.uninstallWebApp(a.id)}>
                  <Trash size={13} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </Shell>
  )
}

function ExtensionsPanel(): JSX.Element {
  const [list, setList] = useState<ExtensionInfo[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    tib
      .getExtensions()
      .then(setList)
      .catch((err: unknown) => setError(`读取扩展失败：${String(err)}`))
    return on('extensionsChanged', setList)
  }, [])

  return (
    <Shell title={TITLES.extensions}>
      <p className="sec-desc">在这里快速启用 / 禁用扩展；开发者模式与本地加载请前往设置。</p>
      <div style={{ marginBottom: 16 }}>
        <button className="btn small" onClick={() => void tib.setOverlay('settings')}>
          <Puzzle size={14} />
          打开扩展设置
        </button>
      </div>
      {error ? <ErrorView message={error} /> : null}
      {!list ? (
        <Loading text="正在读取扩展程序…" />
      ) : list.length === 0 ? (
        <EmptyView text="尚未安装任何扩展程序" />
      ) : (
        <div className="list">
          {list.map((ext) => (
            <div key={ext.id} className="list-item">
              <Puzzle size={16} style={{ color: 'var(--tb-accent)' }} />
              <div className="li-main">
                <div className="li-title">{ext.name}</div>
                <div className="li-sub">
                  v{ext.version} · {ext.enabled ? '已启用' : '已禁用'}
                </div>
              </div>
              <button
                className="btn small"
                onClick={() => void tib.setExtensionEnabled(ext.id, !ext.enabled)}
              >
                {ext.enabled ? '禁用' : '启用'}
              </button>
            </div>
          ))}
        </div>
      )}
    </Shell>
  )
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function Overlays({ overlay }: { overlay: OverlayKey }): JSX.Element {
  // Esc 关闭覆盖层（原生侧菜单也会发同样的命令）
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') void tib.setOverlay(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (overlay === 'settings') {
    return (
      <Shell title={TITLES.settings} wide>
        <SettingsPanel mode="overlay" />
      </Shell>
    )
  }
  if (overlay === 'history') return <HistoryList />
  if (overlay === 'bookmarks') return <BookmarkList />
  if (overlay === 'downloads') return <DownloadList />
  if (overlay === 'about') return <AboutPanel />
  if (overlay === 'apps') return <AppsPanel />
  if (overlay === 'extensions') return <ExtensionsPanel />
  if (overlay === 'aiConsole') {
    return (
      <Shell title={TITLES.aiConsole}>
        <div className="callout">
          <span className="callout-icon">
            <Info size={16} />
          </span>
          <div>自动化接口的开关、Base URL、Token 与 curl 示例都已并入设置面板。</div>
        </div>
        <div style={{ marginTop: 12 }}>
          <button className="btn small" onClick={() => void tib.setOverlay('settings')}>
            前往设置
          </button>
        </div>
      </Shell>
    )
  }
  return <Shell title="TiBrowser">{null}</Shell>
}

/** 供外部（如状态栏）判断某个覆盖层是否需要隐藏网页视图 */
export function isFullscreenOverlay(name: BrowserState['overlay']): boolean {
  return name !== null
}
