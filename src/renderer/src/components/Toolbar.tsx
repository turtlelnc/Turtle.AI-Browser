import type { BookmarkNode, BrowserState } from '@shared/types'
import { Omnibox } from './Omnibox'
import { ArrowLeft, ArrowRight, Dots, Home, PanelRight, Reload, Stop } from './icons'

interface Props {
  state: BrowserState
  focusTick: number
  bookmarks: BookmarkNode[]
}

export function Toolbar({ state, focusTick, bookmarks }: Props): JSX.Element {
  const active = state.tabs.find((t) => t.id === state.activeTabId)
  const showHome = state.settings.appearance.showHomeButton

  return (
    <div className="toolbar chrome">
      <button
        className="nav-btn"
        disabled={!state.canGoBack}
        title="后退"
        onClick={() => window.tibrowser.goBack()}
      >
        <ArrowLeft size={18} />
      </button>
      <button
        className="nav-btn"
        disabled={!state.canGoForward}
        title="前进"
        onClick={() => window.tibrowser.goForward()}
      >
        <ArrowRight size={18} />
      </button>
      <button
        className="nav-btn"
        title={state.isLoading ? '停止' : '重新加载'}
        onClick={() => (state.isLoading ? window.tibrowser.stop() : window.tibrowser.reload())}
      >
        {state.isLoading ? <Stop size={17} /> : <Reload size={17} />}
      </button>
      {showHome && (
        <button className="nav-btn" title="主页" onClick={() => window.tibrowser.goHome()}>
          <Home size={17} />
        </button>
      )}

      {active && <Omnibox tab={active} bookmarks={bookmarks} focusTick={focusTick} />}

      <button
        className="nav-btn"
        title="AI 助手"
        style={{ color: state.sidebarOpen ? 'var(--accent)' : undefined }}
        onClick={() => window.tibrowser.toggleSidebar()}
      >
        <PanelRight size={18} />
      </button>
      <button className="nav-btn" title="菜单" onClick={() => window.tibrowser.popupMenu()}>
        <Dots size={18} />
      </button>
    </div>
  )
}
