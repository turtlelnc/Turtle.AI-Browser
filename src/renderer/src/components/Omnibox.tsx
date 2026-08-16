import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { BookmarkNode, OmniboxSuggestion, TabState } from '@shared/types'
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

  // 菜单快捷键「聚焦地址栏」
  useEffect(() => {
    if (focusTick > 0) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [focusTick])

  // 标签切换 / 导航时同步显示
  useEffect(() => {
    if (!focused) {
      setValue(tab.isNewTab ? '' : tab.url)
      setSuggestions([])
    }
  }, [tab.id, tab.url, tab.isNewTab])

  const bookmarked = !tab.isNewTab && bookmarks.some((b) => b.url === tab.url)

  async function query(q: string): Promise<void> {
    if (!q.trim()) {
      setSuggestions([])
      return
    }
    setSuggestions(await window.tibrowser.omniboxQuery(q))
  }

  function submit(): void {
    const target = suggestions[highlight]
    const input = target ? target.url : value
    if (input.trim()) window.tibrowser.navigate(input)
    inputRef.current?.blur()
    setSuggestions([])
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      submit()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, suggestions.length - 1))
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

  return (
    <div className="omnibox-wrap">
      <div className="omnibox">
        <span
          className={`secure ${tab.isNewTab ? '' : tab.blocked || !tab.isSecure ? 'unsafe' : 'https'}`}
        >
          {secureIcon}
        </span>
        <input
          ref={inputRef}
          value={value}
          spellCheck={false}
          placeholder="搜索或输入网址"
          onChange={(e) => {
            setValue(e.target.value)
            setHighlight(0)
            void query(e.target.value)
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
          title={bookmarked ? '移除书签' : '添加书签'}
          onClick={() => {
            if (!tab.isNewTab) window.tibrowser.bookmarks.toggle(tab.title, tab.url)
          }}
        >
          {bookmarked ? <StarFilled size={15} /> : <Star size={15} />}
        </span>
      </div>

      {focused && suggestions.length > 0 && (
        <div className="omnibox-suggestions">
          {suggestions.map((s, i) => (
            <div
              key={i}
              className={`suggestion ${i === highlight ? 'highlight' : ''}`}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                window.tibrowser.navigate(s.url)
                inputRef.current?.blur()
                setSuggestions([])
              }}
            >
              {s.type === 'history' ? (
                <Clock size={15} style={{ color: 'var(--fg-faint)' }} />
              ) : (
                <Search size={15} style={{ color: 'var(--fg-faint)' }} />
              )}
              <span className="s-title">{s.title || s.url}</span>
              <span className="s-url">{s.url}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
