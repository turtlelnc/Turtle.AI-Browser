import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { UI } from '@shared/constants'
import type { BookmarkNode, BrowserState } from '@shared/types'
import { TitleBar } from './components/TitleBar'
import { Toolbar } from './components/Toolbar'
import { BookmarkBar } from './components/BookmarkBar'
import { NewTabPage } from './components/NewTabPage'
import { BlockedPage } from './components/BlockedPage'
import { AiSidebar } from './components/AiSidebar'
import { FindBar } from './components/FindBar'
import { Overlays } from './components/Overlays'

export default function App(): JSX.Element {
  const [state, setState] = useState<BrowserState | null>(null)
  const [bookmarks, setBookmarks] = useState<BookmarkNode[]>([])
  const [isMaximized, setIsMaximized] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [focusTick, setFocusTick] = useState(0)

  useEffect(() => {
    let alive = true
    window.tibrowser.getState().then((s) => alive && setState(s))
    window.tibrowser.bookmarks.list().then((b) => alive && setBookmarks(b))
    const offs = [
      window.tibrowser.onState((s) => setState(s)),
      window.tibrowser.onWindowState((s) => setIsMaximized(s.isMaximized)),
      window.tibrowser.bookmarks.onChange((list) => setBookmarks(list)),
      window.tibrowser.onUiCommand((cmd) => {
        if (cmd === 'open-find') setFindOpen(true)
        else if (cmd === 'focus-omnibox') setFocusTick((t) => t + 1)
      })
    ]
    return () => {
      alive = false
      offs.forEach((off) => off())
    }
  }, [])

  const settings = state?.settings
  const theme = useMemo(() => {
    const t = settings?.appearance.theme ?? 'system'
    if (t !== 'system') return t
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }, [settings?.appearance.theme])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const activeTab = state?.tabs.find((t) => t.id === state?.activeTabId)
  const bookmarkVisible = settings?.appearance.bookmarkBarVisible ?? false
  const chromeH =
    UI.tabStripHeight + UI.toolbarHeight + (bookmarkVisible ? UI.bookmarkBarHeight : 0)
  const contentRight = state?.sidebarOpen ? (state.sidebarWidth ?? UI.sidebarWidth) : 0
  const contentTop = chromeH + (findOpen ? UI.findBarHeight : 0)

  const cssVars = {
    '--tab-h': `${UI.tabStripHeight}px`,
    '--toolbar-h': `${UI.toolbarHeight}px`,
    '--bookmark-h': `${UI.bookmarkBarHeight}px`,
    '--chrome-h': `${chromeH}px`,
    '--find-h': `${UI.findBarHeight}px`,
    '--content-top': `${contentTop}px`,
    '--sidebar-w': `${state?.sidebarWidth ?? UI.sidebarWidth}px`,
    '--content-right': `${contentRight}px`
  } as CSSProperties

  if (!state) {
    return <div className="app" data-theme={theme} style={cssVars} />
  }

  return (
    <div
      className={[
        'app',
        settings?.appearance.frostedGlass ? 'frosted' : '',
        state.isIncognito ? 'incognito' : ''
      ].join(' ')}
      data-theme={theme}
      style={cssVars}
    >
      <TitleBar state={state} isMaximized={isMaximized} />
      <Toolbar state={state} focusTick={focusTick} bookmarks={bookmarks} />
      {bookmarkVisible && <BookmarkBar bookmarks={bookmarks} />}

      <div className="content-area">
        {activeTab?.isNewTab && <NewTabPage settings={settings} bookmarks={bookmarks} />}
        {activeTab?.blocked && <BlockedPage tab={activeTab} />}
      </div>

      {state.sidebarOpen && <AiSidebar />}
      {findOpen && <FindBar onClose={() => setFindOpen(false)} />}
      {state.overlay && <Overlays overlay={state.overlay} />}
    </div>
  )
}
