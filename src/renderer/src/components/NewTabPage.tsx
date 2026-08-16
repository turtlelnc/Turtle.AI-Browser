import { useState } from 'react'
import type { BookmarkNode, Settings } from '@shared/types'
import { Search, Sparkles } from './icons'

interface Props {
  settings?: Settings
  bookmarks: BookmarkNode[]
}

const DEFAULT_SHORTCUTS = [
  { label: 'Bing', url: 'https://www.bing.com', letter: 'B' },
  { label: '百度', url: 'https://www.baidu.com', letter: '百' },
  { label: 'GitHub', url: 'https://github.com', letter: 'G' },
  { label: '知乎', url: 'https://www.zhihu.com', letter: '知' },
  { label: '哔哩哔哩', url: 'https://www.bilibili.com', letter: 'B' },
  { label: 'YouTube', url: 'https://www.youtube.com', letter: 'Y' },
  { label: '维基百科', url: 'https://www.wikipedia.org', letter: 'W' },
  { label: '微博', url: 'https://weibo.com', letter: '微' }
]

export function NewTabPage({ bookmarks }: Props): JSX.Element {
  const [q, setQ] = useState('')
  const shortcuts =
    bookmarks.length >= 8
      ? bookmarks.map((b) => ({ label: b.title, url: b.url, letter: b.title.slice(0, 1) || '★' }))
      : DEFAULT_SHORTCUTS

  function submit(): void {
    if (q.trim()) window.tibrowser.navigate(q)
  }

  return (
    <div className="newtab">
      <div className="brand">
        <div className="logo">
          <Sparkles size={32} />
        </div>
        <div>TIbrowser</div>
      </div>

      <div className="search-box">
        <Search size={20} style={{ color: 'var(--fg-faint)' }} />
        <input
          autoFocus
          value={q}
          placeholder="搜索或输入网址"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>

      <div className="shortcuts">
        {shortcuts.map((s) => (
          <div key={s.url} className="shortcut" onClick={() => window.tibrowser.navigate(s.url)}>
            <div className="s-icon">{s.letter}</div>
            <div className="s-label">{s.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
