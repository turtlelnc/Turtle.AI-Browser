/**
 * 地址栏（omnibox）：安全状态图标 + 输入 + 书签星标 + 联想下拉。
 * 联想来自 `tib.omniboxSuggest()`（原生侧聚合历史 / 书签 / 搜索引擎）。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { BookmarkNode, OmniboxSuggestion, TabState } from '@shared/bridge'
import { tib } from '../bridge'
import { Clock, Lock, Search, ShieldWarn, Star, StarFilled } from './icons'

interface Props {
  tab: TabState
  bookmarks: BookmarkNode[]
  focusTick: number
}

export function Omnibox({ tab, bookmarks, focusTick }: Props): JSX.Element {
  const [value, setValue] = useState('')
  const [focused, setFocused] = useState(false)
  const [suggestions, setSuggestions] = useState<OmniboxSuggestion[]>([])
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  /** 联想请求序号：只有最后一次请求的结果会被采纳，避免快速输入时结果乱序 */
  const querySeq = useRef(0)

  // 菜单 / 快捷键「聚焦地址栏」
  useEffect(() => {
    if (focusTick > 0) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [focusTick])

  // 标签切换 / 导航时同步显示内容
  useEffect(() => {
    if (!focused) {
      setValue(tab.isNewTab ? '' : tab.url)
      setSuggestions([])
    }
  }, [tab.id, tab.url, tab.isNewTab, focused])

  const bookmarked = !tab.isNewTab && bookmarks.some((b) => b.url === tab.url)

  async function query(q: string): Promise<void> {
    if (!q.trim()) {
      setSuggestions([])
      return
    }
    const seq = ++querySeq.current
    try {
      const list = await tib.omniboxSuggest(q)
      // 用户可能已经继续输入，只采纳最后一次请求的结果
      if (seq === querySeq.current) setSuggestions(list)
    } catch {
      if (seq === querySeq.current) setSuggestions([])
    }
  }

  function submit(): void {
    const target = suggestions[highlight]
    const input = target ? target.url : value
    if (input.trim()) void tib.navigate(input)
    inputRef.current?.blur()
    setSuggestions([])
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      submit()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, Math.max(0, suggestions.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Escape') {
      setSuggestions([])
      inputRef.current?.select()
    }
  }

  const secureIcon = tab.isNewTab ? (
    <Search size={15} />
  ) : tab.blocked ? (
    <ShieldWarn size={15} />
  ) : tab.isSecure ? (
    <Lock size={15} />
  ) : (
    <ShieldWarn size={15} />
  )

  const secureTitle = tab.isNewTab
    ? '搜索或输入网址'
    : tab.blocked
      ? '此页已被安全浏览拦截'
      : tab.isSecure
        ? '连接安全（HTTPS）'
        : '连接不安全（HTTP）'

  return (
    <div className="omnibox-wrap">
      <div className="omnibox">
        <span
          className={`secure ${tab.isNewTab ? '' : tab.blocked || !tab.isSecure ? 'unsafe' : 'https'}`}
          title={secureTitle}
        >
          {secureIcon}
        </span>
        <input
          ref={inputRef}
          value={value}
          spellCheck={false}
          placeholder="搜索或输入网址"
          aria-label="地址栏"
          onChange={(e) => {
            const next = e.target.value
            setValue(next)
            setHighlight(0)
            void query(next)
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            setValue(tab.isNewTab ? '' : tab.url)
            setTimeout(() => setSuggestions([]), 150)
          }}
          onKeyDown={onKey}
        />
        <span
          className={`star-btn ${bookmarked ? 'on' : ''}`}
          title={bookmarked ? '移除此书签' : '添加书签'}
          onClick={() => {
            if (!tab.isNewTab) void tib.toggleBookmark(tab.title, tab.url)
          }}
        >
          {bookmarked ? <StarFilled size={15} /> : <Star size={15} />}
        </span>
      </div>

      {focused && suggestions.length > 0 ? (
        <div className="omnibox-suggestions">
          {suggestions.map((s, i) => (
            <div
              key={`${s.url}-${i}`}
              className={`suggestion ${i === highlight ? 'highlight' : ''}`}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                void tib.navigate(s.url)
                inputRef.current?.blur()
                setSuggestions([])
              }}
            >
              {s.type === 'history' ? (
                <Clock size={15} style={{ color: 'var(--tb-text-3)' }} />
              ) : (
                <Search size={15} style={{ color: 'var(--tb-text-3)' }} />
              )}
              <span className="s-title">{s.title || s.text || s.url}</span>
              <span className="s-url">{s.url}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
