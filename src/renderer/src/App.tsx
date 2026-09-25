/**
 * TiBrowser 外壳 UI 根组件（v1.0.1-rc2）
 *
 * 职责：
 *  1. 从 `tib.getState()` 拉取全量状态，并订阅 `state` / `windowState` 等事件；
 *  2. 把皮肤、主题、性能档写到 `<html>`（`data-skin` / `data-theme` / `data-perf`）；
 *  3. 计算外壳高度与内容区偏移量，交给原生侧定位网页视图（CSS 变量 --chrome-h 等）；
 *  4. 承载覆盖层、侧边栏、查找栏与全局对话框。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { BookmarkNode, BrowserState, DownloadPrompt, TibSettings } from '@shared/bridge'
import { on, tib } from './bridge'
import { DEFAULT_SIDEBAR_WIDTH } from './skins/tokens'
import { applyPerf, applySkin, applyTheme, resolveTheme, watchSystemTheme } from './theme'
import { TitleBar } from './components/TitleBar'
import { Toolbar } from './components/Toolbar'
import { BookmarkBar } from './components/BookmarkBar'
import { NewTabPage } from './components/NewTabPage'
import { BlockedPage } from './components/BlockedPage'
import { AiSidebar } from './components/AiSidebar'
import { FindBar } from './components/FindBar'
import { Overlays } from './components/Overlays'
import { DownloadWarningDialog } from './components/DownloadWarningDialog'

/** 读取 CSS 变量里的像素值（外壳高度以皮肤令牌为准，避免 JS/CSS 两套数字） */
function cssPx(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name)
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? n : fallback
}

export default function App(): JSX.Element {
  const [state, setState] = useState<BrowserState | null>(null)
  const [bookmarks, setBookmarks] = useState<BookmarkNode[]>([])
  const [findOpen, setFindOpen] = useState(false)
  const [focusTick, setFocusTick] = useState(0)
  const [prompt, setPrompt] = useState<DownloadPrompt | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH)
  const [layoutTick, setLayoutTick] = useState(0)
  const resizingRef = useRef(false)

  // ---- 初始状态 + 事件订阅 ----
  useEffect(() => {
    let alive = true
    tib
      .getState()
      .then((s) => {
        if (alive) setState(s)
      })
      .catch((err: unknown) => console.warn('[TiBrowser] 读取浏览器状态失败：', err))
    tib
      .getBookmarks()
      .then((b) => {
        if (alive) setBookmarks(b)
      })
      .catch(() => undefined)

    const offs = [
      on('state', setState),
      on('windowState', (s) => setState((prev) => (prev ? { ...prev, isMaximized: s.isMaximized } : prev))),
      on('downloadWarning', (p) => setPrompt(p)),
      on('settingsChanged', (settings) => setState((prev) => (prev ? { ...prev, settings } : prev)))
    ]
    return () => {
      alive = false
      offs.forEach((off) => off())
    }
  }, [])

  // 书签列表没有独立事件，因此采用「打开覆盖层时重新拉取」的策略，
  // 由 Overlays 自行负责；这里只在窗口状态首次到达时拉一次（已在上面的 effect 中完成）。

  const settings: TibSettings | undefined = state?.settings

  // ---- 外观三件套 ----
  useEffect(() => {
    if (!settings) return
    applySkin(settings.skin)
    applyTheme(resolveTheme(settings.theme))
    applyPerf(settings.perf)
  }, [settings?.skin, settings?.theme, settings?.perf])

  useEffect(() => {
    return watchSystemTheme((t) => {
      if ((settings?.theme ?? 'system') === 'system') applyTheme(t)
    })
  }, [settings?.theme])

  // 皮肤变化会改变标签栏 / 工具栏高度，需要重新量一次
  useEffect(() => {
    setLayoutTick((t) => t + 1)
  }, [settings?.skin])

  useEffect(() => {
    if (state?.sidebarWidth) setSidebarWidth(state.sidebarWidth)
  }, [state?.sidebarWidth])

  const activeTab = state?.tabs.find((t) => t.id === state?.activeTabId)
  const bookmarkVisible = settings?.bookmarkBarVisible ?? false
  const sidebarOpen = Boolean(state?.sidebarOpen)

  // ---- 布局尺寸：外壳高度与内容区偏移 ----
  const layout = useMemo(() => {
    const tabH = cssPx('--tb-tab-outer-h', 40)
    const toolbarH = cssPx('--tb-toolbar-h', 46)
    const bookmarkH = cssPx('--tb-bookmark-h', 32)
    const findH = cssPx('--tb-find-h', 42)
    void layoutTick // 皮肤切换后强制重算
    const chromeH = tabH + toolbarH + (bookmarkVisible ? bookmarkH : 0)
    const contentTop = chromeH + (findOpen ? findH : 0)
    return { tabH, toolbarH, bookmarkH, chromeH, contentTop, findH }
  }, [bookmarkVisible, findOpen, layoutTick, settings?.skin])

  const cssVars = {
    '--chrome-h': `${layout.chromeH}px`,
    '--content-top': `${layout.contentTop}px`,
    '--sidebar-w': `${sidebarWidth}px`,
    '--content-right': sidebarOpen ? `${sidebarWidth}px` : '0px'
  } as CSSProperties

  // ---- 快捷键（外壳自身的可访问性兜底；原生侧菜单走同样的命令） ----
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!(e.ctrlKey || e.metaKey)) return
      const key = e.key.toLowerCase()
      if (key === 'f') {
        e.preventDefault()
        setFindOpen(true)
      } else if (key === 'l') {
        e.preventDefault()
        setFocusTick((t) => t + 1)
      } else if (key === 't') {
        e.preventDefault()
        void tib.newTab()
      } else if (key === 'w') {
        e.preventDefault()
        if (state?.activeTabId) void tib.closeTab(state.activeTabId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state?.activeTabId])

  // ---- 侧边栏拖拽调宽 ----
  function startResize(e: ReactPointerEvent<HTMLDivElement>): void {
    e.preventDefault()
    resizingRef.current = true
    const startX = e.clientX
    const startW = sidebarWidth
    let latest = startW

    const move = (ev: PointerEvent): void => {
      if (!resizingRef.current) return
      latest = Math.max(260, Math.min(680, startW - (ev.clientX - startX)))
      setSidebarWidth(latest)
    }
    const up = (): void => {
      resizingRef.current = false
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      // 结束时才通知原生侧，避免拖拽过程中高频 IPC
      void tib.setSidebarWidth(latest)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // 页面内容为空或尚未拿到状态时，先渲染一个透明骨架，避免遮挡原生网页视图
  const theme = settings ? resolveTheme(settings.theme) : 'light'

  return (
    <div
      className={['app', settings?.perf === 'low' ? '' : 'frosted', state?.isIncognito ? 'incognito' : ''].join(' ')}
      data-theme={theme}
      style={cssVars}
    >
      {state ? (
        <>
          <TitleBar state={state} isMaximized={state.isMaximized} />
          <Toolbar state={state} focusTick={focusTick} bookmarks={bookmarks} />
          {bookmarkVisible ? <BookmarkBar bookmarks={bookmarks} /> : null}

          <div className="content-area">
            {activeTab?.isNewTab ? <NewTabPage settings={settings} bookmarks={bookmarks} state={state} /> : null}
            {activeTab?.blocked ? <BlockedPage tab={activeTab} /> : null}
          </div>

          {sidebarOpen ? (
            <>
              <div className="sidebar-resizer" style={{ right: sidebarWidth - 3 }} onPointerDown={startResize} />
              <AiSidebar />
            </>
          ) : null}

          {findOpen ? <FindBar onClose={() => setFindOpen(false)} /> : null}
          {state.overlay ? <Overlays overlay={state.overlay} /> : null}
        </>
      ) : null}

      {prompt ? <DownloadWarningDialog prompt={prompt} onResolved={() => setPrompt(null)} /> : null}
    </div>
  )
}
