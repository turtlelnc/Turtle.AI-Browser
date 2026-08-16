import { useEffect, useState } from 'react'
import { APP_NAME, APP_VERSION } from '@shared/constants'
import type { BookmarkNode, DownloadItem, HistoryItem, OverlayName } from '@shared/types'
import { SettingsPanel } from './SettingsPanel'
import { Bookmark, Clock, Close, Download, External, Folder, Sparkles, Trash } from './icons'

function shell(title: string): JSX.Element {
  return (
    <div className="ov-header">
      <span>{title}</span>
      <span className="spacer" />
      <span className="nav-btn" style={{ width: 30, height: 30 }} onClick={() => window.tibrowser.openOverlay(null)}>
        <Close size={18} />
      </span>
    </div>
  )
}

function HistoryList(): JSX.Element {
  const [items, setItems] = useState<HistoryItem[]>([])
  useEffect(() => {
    window.tibrowser.history.list().then(setItems)
  }, [])
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <button
          className="btn"
          onClick={async () => {
            await window.tibrowser.history.clear()
            setItems([])
          }}
        >
          <Trash size={15} /> 清空历史
        </button>
      </div>
      {items.length === 0 && <div className="empty">暂无历史记录</div>}
      <div className="list">
        {items.map((h) => (
          <div key={h.id} className="list-item" onClick={() => window.tibrowser.navigate(h.url)}>
            <Clock size={16} style={{ color: 'var(--fg-faint)' }} />
            <div className="li-main">
              <div className="li-title">{h.title}</div>
              <div className="li-sub">{h.url}</div>
            </div>
            <span
              className="li-action"
              onClick={async (e) => {
                e.stopPropagation()
                await window.tibrowser.history.remove(h.id)
                setItems(items.filter((i) => i.id !== h.id))
              }}
            >
              <Close size={14} />
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function BookmarkList(): JSX.Element {
  const [items, setItems] = useState<BookmarkNode[]>([])
  useEffect(() => {
    window.tibrowser.bookmarks.list().then(setItems)
    const off = window.tibrowser.bookmarks.onChange(setItems)
    return off
  }, [])
  return (
    <div>
      {items.length === 0 && <div className="empty">暂无书签</div>}
      <div className="list">
        {items.map((b) => (
          <div key={b.id} className="list-item" onClick={() => window.tibrowser.navigate(b.url)}>
            <Bookmark size={16} style={{ color: 'var(--accent)' }} />
            <div className="li-main">
              <div className="li-title">{b.title}</div>
              <div className="li-sub">{b.url}</div>
            </div>
            <span
              className="li-action"
              onClick={async (e) => {
                e.stopPropagation()
                await window.tibrowser.bookmarks.remove(b.id)
              }}
            >
              <Close size={14} />
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function DownloadList(): JSX.Element {
  const [items, setItems] = useState<DownloadItem[]>([])
  useEffect(() => {
    window.tibrowser.downloads.list().then(setItems)
    const off = window.tibrowser.downloads.onProgress((item) => {
      setItems((prev) => {
        const i = prev.findIndex((x) => x.id === item.id)
        if (i < 0) return [item, ...prev]
        const next = [...prev]
        next[i] = item
        return next
      })
    })
    return off
  }, [])

  function label(it: DownloadItem): string {
    if (it.state === 'completed') return '已完成'
    if (it.state === 'interrupted') return '已中断'
    if (it.state === 'cancelled') return '已取消'
    const pct = it.totalBytes > 0 ? Math.round((it.receivedBytes / it.totalBytes) * 100) : 0
    return `下载中 ${pct}%`
  }

  return (
    <div>
      {items.length === 0 && <div className="empty">暂无下载内容</div>}
      <div className="list">
        {items.map((it) => (
          <div key={it.id} className="list-item">
            <Download size={16} style={{ color: 'var(--fg-faint)' }} />
            <div className="li-main">
              <div className="li-title">{it.filename}</div>
              <div className="li-sub">{label(it)}</div>
            </div>
            {it.state === 'completed' && (
              <span className="li-action" onClick={() => window.tibrowser.downloads.open(it.id)} title="打开">
                <External size={15} />
              </span>
            )}
            <span className="li-action" onClick={() => window.tibrowser.downloads.openFolder(it.id)} title="在文件夹中显示">
              <Folder size={15} />
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function About(): JSX.Element {
  return (
    <div style={{ textAlign: 'center', padding: '40px 0' }}>
      <div
        className="newtab"
        style={{ borderRadius: 16, padding: '40px', background: 'var(--surface-2)', height: 'auto' }}
      >
        <div className="brand" style={{ fontSize: 26 }}>
          <div className="logo">
            <Sparkles size={32} />
          </div>
          <div>{APP_NAME}</div>
          <div style={{ fontSize: 14, color: 'var(--fg-muted)', fontWeight: 400 }}>版本 {APP_VERSION}</div>
        </div>
        <p style={{ color: 'var(--fg-muted)', lineHeight: 1.8, marginTop: 16, maxWidth: 460 }}>
          基于 Chromium 内核的 AI 安全浏览器。
          <br />
          拥有 Chrome 的主要功能，内置 AI 助手与本地安全服务。
        </p>
      </div>
    </div>
  )
}

const TITLES: Record<NonNullable<OverlayName>, string> = {
  settings: '设置',
  history: '历史记录',
  bookmarks: '书签管理器',
  downloads: '下载内容',
  about: '关于'
}

export function Overlays({ overlay }: { overlay: NonNullable<OverlayName> }): JSX.Element {
  return (
    <div className="overlay">
      {shell(TITLES[overlay])}
      <div className="ov-body">
        {overlay === 'settings' && <SettingsPanel />}
        {overlay === 'history' && <HistoryList />}
        {overlay === 'bookmarks' && <BookmarkList />}
        {overlay === 'downloads' && <DownloadList />}
        {overlay === 'about' && <About />}
      </div>
    </div>
  )
}
