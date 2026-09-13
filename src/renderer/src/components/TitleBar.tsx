/**
 * 标题栏：标签栏 + 窗口控制按钮。
 *
 * v1.0.0-rc1 变化：
 *  - 全部命令改走 `tib`（ARCHITECTURE.md §3.1）；
 *  - 无痕标签显示「无痕」标记（feature 4 的可见指示器）；
 *  - 标签形状由皮肤令牌决定（胶囊 / 圆角矩形 / 梯形感），此处不写死圆角。
 */
import { useState } from 'react'
import type { BrowserState } from '@shared/bridge'
import { tib } from '../bridge'
import { Close, Globe, Incognito, Minus, Plus, Restore, Square } from './icons'

interface Props {
  state: BrowserState
  isMaximized: boolean
}

export function TitleBar({ state, isMaximized }: Props): JSX.Element {
  const [dragId, setDragId] = useState<string | null>(null)
  const incognitoTabs = state.tabs.filter((t) => t.incognito).length

  return (
    <div className="titlebar chrome">
      <div className="tabs">
        {incognitoTabs > 0 ? (
          <span className="badge accent" title="当前窗口包含无痕标签：不写入磁盘，指纹已改写">
            <Incognito size={12} />
            无痕 {incognitoTabs}
          </span>
        ) : null}

        {state.tabs.map((tab) => {
          const index = state.tabs.findIndex((t) => t.id === tab.id)
          return (
            <div
              key={tab.id}
              className={[
                'tab',
                tab.id === state.activeTabId ? 'active' : '',
                dragId === tab.id ? 'dragging' : '',
                tab.incognito ? 'incognito' : ''
              ].join(' ')}
              title={tab.url || tab.title}
              draggable
              onClick={() => void tib.activateTab(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) void tib.closeTab(tab.id)
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
                if (dragId && dragId !== tab.id) void tib.moveTab(dragId, index)
                setDragId(null)
              }}
              onDragEnd={() => setDragId(null)}
            >
              {tab.favicon ? (
                <img className="tab-favicon" src={tab.favicon} alt="" />
              ) : (
                <Globe className="tab-favicon" size={15} style={{ color: 'var(--tb-text-3)' }} />
              )}
              <span className="tab-title">{tab.isNewTab ? '新标签页' : tab.title || tab.url}</span>
              <span
                className="tab-close"
                title="关闭标签页"
                onClick={(e) => {
                  e.stopPropagation()
                  void tib.closeTab(tab.id)
                }}
              >
                <Close size={13} />
              </span>
            </div>
          )
        })}
        <span className="new-tab-btn" onClick={() => void tib.newTab()} title="新建标签页（Ctrl+T）">
          <Plus size={15} />
        </span>
      </div>

      <div className="window-controls">
        <span className="win-btn" title="最小化" onClick={() => void tib.windowAction('minimize')}>
          <Minus size={16} />
        </span>
        <span
          className="win-btn"
          title={isMaximized ? '还原' : '最大化'}
          onClick={() => void tib.windowAction(isMaximized ? 'restore' : 'maximize')}
        >
          {isMaximized ? <Restore size={13} /> : <Square size={13} />}
        </span>
        <span className="win-btn close" title="关闭窗口" onClick={() => void tib.windowAction('close')}>
          <Close size={16} />
        </span>
      </div>
    </div>
  )
}
