import { useEffect, useRef, useState } from 'react'
import type { FindResult } from '@shared/api'
import { Close } from './icons'

export function FindBar({ onClose }: { onClose: () => void }): JSX.Element {
  const [text, setText] = useState('')
  const [result, setResult] = useState<FindResult>({ activeMatchOrdinal: 0, matches: 0, finalUpdate: false })
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    window.tibrowser.find.setOpen(true)
    const off = window.tibrowser.find.onResult(setResult)
    return () => {
      off()
      window.tibrowser.find.stop()
      window.tibrowser.find.setOpen(false)
    }
  }, [])

  useEffect(() => {
    window.tibrowser.find.inPage(text)
  }, [text])

  return (
    <div className="find-bar">
      <input
        ref={inputRef}
        value={text}
        placeholder="在页面中查找"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') window.tibrowser.find.inPage(text)
          if (e.key === 'Escape') onClose()
        }}
      />
      <span className="count">{text ? `${result.activeMatchOrdinal}/${result.matches}` : ''}</span>
      <span className="nav-btn" style={{ width: 26, height: 26 }} onClick={onClose}>
        <Close size={15} />
      </span>
    </div>
  )
}
