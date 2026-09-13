/**
 * 新标签页：品牌区 + 搜索框 + 快捷方式宫格。
 * 无痕会话下会额外显示一条提示，说明本窗口的数据不会被保存。
 */
import type { BookmarkNode, BrowserState, TibSettings } from '@shared/bridge'
import { tib } from '../bridge'
import { Incognito, Search, Sparkles } from './icons'

interface Props {
  settings?: TibSettings
  bookmarks: BookmarkNode[]
  state: BrowserState
}

const DEFAULT_SHORTCUTS = [
  { label: 'Bing', url: 'https://www.bing.com', letter: 'B' },
  { label: '百度', url: 'https://www.baidu.com', letter: '百' },
  { label: 'GitHub', url: 'https://github.com', letter: 'G' },
  { label: '知乎', url: 'https://www.zhihu.com', letter: '知' },
  { label: '哔哩哔哩', url: 'https://www.bilibili.com', letter: '哔' },
  { label: 'YouTube', url: 'https://www.youtube.com', letter: 'Y' },
  { label: '维基百科', url: 'https://www.wikipedia.org', letter: 'W' },
  { label: '微博', url: 'https://weibo.com', letter: '微' }
]

export function NewTabPage({ bookmarks, state }: Props): JSX.Element {
  const shortcuts =
    bookmarks.length >= 4
      ? bookmarks.slice(0, 8).map((b) => ({
          label: b.title || b.url,
          url: b.url,
          letter: (b.title || b.url).slice(0, 1).toUpperCase() || '★'
        }))
      : DEFAULT_SHORTCUTS

  const incognito = state.tabs.find((t) => t.id === state.activeTabId)?.incognito ?? state.isIncognito

  return (
    <div className="newtab">
      <div className="brand">
        <div className="logo">
          <Sparkles size={32} />
        </div>
        <div>TiBrowser</div>
      </div>

      {incognito ? (
        <div className="ntp-incognito">
          <Incognito size={14} />
          你正在使用无痕窗口：本次浏览不会写入历史，关闭全部无痕标签后 Cookie 与缓存会被清除。
        </div>
      ) : null}

      <form
        className="search-box"
        onSubmit={(e) => {
          e.preventDefault()
          const input = new FormData(e.currentTarget).get('q')
          if (typeof input === 'string' && input.trim()) void tib.navigate(input)
        }}
      >
        <Search size={20} style={{ color: 'var(--tb-text-3)' }} />
        <input name="q" autoFocus placeholder="搜索或输入网址" aria-label="搜索或输入网址" />
      </form>

      <div className="shortcuts">
        {shortcuts.map((s) => (
          <div
            key={s.url}
            className="shortcut"
            title={s.url}
            onClick={() => void tib.navigate(s.url)}
            onAuxClick={(e) => {
              if (e.button === 1) void tib.newTab(s.url)
            }}
          >
            <div className="s-icon">{s.letter}</div>
            <div className="s-label">{s.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
