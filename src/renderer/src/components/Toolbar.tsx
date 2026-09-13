/**
 * 工具栏：导航按钮 + 地址栏 + AI 侧边栏 / 菜单。
 * 图标尺寸与按钮大小来自皮肤令牌（``--tb-icon-nav`` / ``--tb-nav-btn-size``）。
 */
import type { BookmarkNode, BrowserState } from '@shared/bridge'
import { tib } from '../bridge'
import { Omnibox } from './Omnibox'
import { ArrowLeft, ArrowRight, Dots, Home, PanelRight, Reload, Stop } from './icons'

interface Props {
  state: BrowserState
  focusTick: number
  bookmarks: BookmarkNode[]
}

export function Toolbar({ state, focusTick, bookmarks }: Props): JSX.Element {
  const active = state.tabs.find((t) => t.id === state.activeTabId)
  const showHome = state.settings.showHomeButton

  return (
    <div className="toolbar chrome">
      <button
        className="nav-btn"
        disabled={!state.canGoBack}
        title="后退"
        onClick={() => void tib.goBack()}
      >
        <ArrowLeft size={18} />
      </button>
      <button
        className="nav-btn"
        disabled={!state.canGoForward}
        title="前进"
        onClick={() => void tib.goForward()}
      >
        <ArrowRight size={18} />
      </button>
      <button
        className="nav-btn"
        title={state.isLoading ? '停止加载' : '重新加载'}
        onClick={() => void (state.isLoading ? tib.stop() : tib.reload())}
      >
        {state.isLoading ? <Stop size={17} /> : <Reload size={17} />}
      </button>
      {showHome ? (
        <button className="nav-btn" title="主页" onClick={() => void tib.goHome()}>
          <Home size={17} />
        </button>
      ) : null}

      {active ? <Omnibox tab={active} bookmarks={bookmarks} focusTick={focusTick} /> : <span style={{ flex: 1 }} />}

      <button
        className={`nav-btn ${state.sidebarOpen ? 'on' : ''}`}
        title="AI 助手"
        onClick={() => void tib.toggleSidebar()}
      >
        <PanelRight size={18} />
      </button>
      <button className="nav-btn" title="菜单" onClick={() => void tib.popupMenu()}>
        <Dots size={18} />
      </button>
    </div>
  )
}
