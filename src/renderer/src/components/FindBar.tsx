/**
 * 页内查找栏（Ctrl+F）。
 * 展开 / 收起会改变内容区布局，因此必须通知原生侧（`tib.setFindOpen`）。
 */
import { useEffect, useRef, useState } from 'react'
import type { FindResult } from '@shared/bridge'
import { on, tib } from '../bridge'
import { Close } from './icons'

export function FindBar({ onClose }: { onClose: () => void }): JSX.Element {
  const [text, setText] = useState('')
  const [result, setResult] = useState<FindResult>({ activeMatchOrdinal: 0, matches: 0, finalUpdate: false })
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    void tib.setFindOpen(true)
    const off = on('findResult', setResult)
    return () => {
      off()
      void tib.findStop()
      void tib.setFindOpen(false)
    }
  }, [])

  useEffect(() => {
    void tib.findInPage(text)
  }, [text])

  return (
    <div className="find-bar">
      <input
        ref={inputRef}
        value={text}
        placeholder="在页面中查找"
        aria-label="在页面中查找"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void tib.findInPage(text)
          if (e.key === 'Escape') onClose()
        }}
      />
      <span className="count">{text ? `${result.activeMatchOrdinal}/${result.matches}` : ''}</span>
      <span className="nav-btn" style={{ width: 26, height: 26 }} title="关闭（Esc）" onClick={onClose}>
        <Close size={15} />
      </span>
    </div>
  )
}
