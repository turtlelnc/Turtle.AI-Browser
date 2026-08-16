import { useState } from 'react'
import type { BrowserState } from '@shared/types'
import { Close, Globe, Minus, Plus, Restore, Square } from './icons'

interface Props {
  state: BrowserState
  isMaximized: boolean
}

export function TitleBar({ state, isMaximized }: Props): JSX.Element {
  const [dragId, setDragId] = useState<string | null>(null)

  return (
    <div className="titlebar chrome">
      <div className="tabs">
        {state.tabs.map((tab) => {
          const index = state.tabs.findIndex((t) => t.id === tab.id)
          return (
            <div
              key={tab.id}
              className={`tab ${tab.id === state.activeTabId ? 'active' : ''} ${
                dragId === tab.id ? 'dragging' : ''
              }`}
              title={tab.url || tab.title}
              draggable
              onClick={() => window.tibrowser.activateTab(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) window.tibrowser.closeTab(tab.id)
              }}
              onDragStart={(e) => {
                setDragId(tab.id)
                e.dataTransfer.effectAllowed = 'move'
                try {
                  e.dataTransfer.setData('text/plain', tab.id)
                } catch {
                  /* 某些环境 setData 受保护，忽略 */
                }
              }}
              onDragOver={(e) => {
                if (dragId && dragId !== tab.id) {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                }
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragId && dragId !== tab.id) {
                  window.tibrowser.moveTab(dragId, index)
                }
                setDragId(null)
              }}
              onDragEnd={() => setDragId(null)}
            >
              {tab.favicon ? (
                <img className="tab-favicon" src={tab.favicon} alt="" />
              ) : (
                <Globe className="tab-favicon" size={15} style={{ color: 'var(--fg-faint)' }} />
              )}
              <span className="tab-title">{tab.isNewTab ? '新标签页' : tab.title}</span>
              <span
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  window.tibrowser.closeTab(tab.id)
                }}
              >
                <Close size={13} />
              </span>
            </div>
          )
        })}
        <span className="new-tab-btn" onClick={() => window.tibrowser.newTab()} title="新建标签页">
          <Plus size={15} />
        </span>
      </div>

      <div className="window-controls">
        <span className="win-btn" onClick={() => window.tibrowser.minimize()}>
          <Minus size={16} />
        </span>
        <span className="win-btn" onClick={() => window.tibrowser.maximize()}>
          {isMaximized ? <Restore size={13} /> : <Square size={13} />}
        </span>
        <span className="win-btn close" onClick={() => window.tibrowser.closeWindow()}>
          <Close size={16} />
        </span>
      </div>
    </div>
  )
}
