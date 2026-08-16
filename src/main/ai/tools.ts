import type { CliPermissionLevel, SearchEngineId, ThemeMode } from '@shared/types'
import type { BrowserSession } from '../browser-session'
import { bookmarks, history, store } from '../store'
import { getCaptured, startCapture, stopCapture } from '../network-capture'

export interface ToolContext {
  session: BrowserSession
}

type ToolLevel = 'daily' | 'developer' | 'full'

export interface ToolDef {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description?: string; enum?: string[] }>
    required?: string[]
  }
  minLevel: ToolLevel
  run: (ctx: ToolContext, args: Record<string, unknown>) => unknown | Promise<unknown>
}

const LEVEL_RANK: Record<CliPermissionLevel, number> = { off: 0, daily: 1, developer: 2, full: 3 }

/** 根据当前权限档位筛选可用工具 */
export function getToolsForLevel(level: CliPermissionLevel): ToolDef[] {
  return TOOLS.filter((t) => LEVEL_RANK[level] >= LEVEL_RANK[t.minLevel])
}

export function canRunTool(minLevel: ToolLevel, level: CliPermissionLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[minLevel]
}

const sel = (s: unknown): string => JSON.stringify(String(s))

const TOOLS: ToolDef[] = [
  // ---------- 日常：网页控制与安全设置 ----------
  {
    name: 'navigate',
    description: '在当前标签页导航到指定网址（支持网址或搜索词）',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '网址或搜索词' } },
      required: ['url']
    },
    minLevel: 'daily',
    run: (ctx, a) => {
      ctx.session.navigate(String(a.url))
      return { ok: true, url: String(a.url) }
    }
  },
  {
    name: 'get_page_text',
    description: '读取当前网页的正文文本',
    parameters: { type: 'object', properties: {} },
    minLevel: 'daily',
    run: async (ctx) => ({ text: await ctx.session.extractPageText(8000) })
  },
  {
    name: 'get_page_info',
    description: '获取当前页面的标题与网址',
    parameters: { type: 'object', properties: {} },
    minLevel: 'daily',
    run: (ctx) => ({ title: ctx.session.getActiveTabTitle(), url: ctx.session.getActiveTabUrl() })
  },
  {
    name: 'get_selected_text',
    description: '获取用户在页面上选中的文字',
    parameters: { type: 'object', properties: {} },
    minLevel: 'daily',
    run: async (ctx) => ({ selectedText: await ctx.session.getSelectedText() })
  },
  {
    name: 'get_tabs',
    description: '列出所有打开的标签页',
    parameters: { type: 'object', properties: {} },
    minLevel: 'daily',
    run: (ctx) => ({
      tabs: ctx.session
        .getState()
        .tabs.map((t, i) => ({ index: i, id: t.id, title: t.title, url: t.url }))
    })
  },
  {
    name: 'open_tab',
    description: '在新标签页打开网址',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '网址' } },
      required: ['url']
    },
    minLevel: 'daily',
    run: (ctx, a) => {
      ctx.session.createTab(String(a.url))
      return { ok: true }
    }
  },
  {
    name: 'close_current_tab',
    description: '关闭当前标签页',
    parameters: { type: 'object', properties: {} },
    minLevel: 'daily',
    run: (ctx) => {
      ctx.session.closeActiveTab()
      return { ok: true }
    }
  },
  {
    name: 'switch_tab',
    description: '切换到指定标签页（index 从 0 开始）',
    parameters: {
      type: 'object',
      properties: { index: { type: 'number', description: '标签页序号' } },
      required: ['index']
    },
    minLevel: 'daily',
    run: (ctx, a) => {
      const tabs = ctx.session.getState().tabs
      const t = tabs[Number(a.index)]
      if (!t) return { error: '标签页序号超出范围' }
      ctx.session.activateTab(t.id)
      return { ok: true, tab: t.title }
    }
  },
  {
    name: 'go_back',
    description: '后退到上一页',
    parameters: { type: 'object', properties: {} },
    minLevel: 'daily',
    run: (ctx) => {
      ctx.session.goBack()
      return { ok: true }
    }
  },
  {
    name: 'go_forward',
    description: '前进到下一页',
    parameters: { type: 'object', properties: {} },
    minLevel: 'daily',
    run: (ctx) => {
      ctx.session.goForward()
      return { ok: true }
    }
  },
  {
    name: 'reload_page',
    description: '刷新当前页面',
    parameters: { type: 'object', properties: {} },
    minLevel: 'daily',
    run: (ctx) => {
      ctx.session.reload()
      return { ok: true }
    }
  },
  {
    name: 'click',
    description: '点击页面上的元素（CSS 选择器）',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS 选择器，如 #submit、.btn' } },
      required: ['selector']
    },
    minLevel: 'daily',
    run: (ctx, a) =>
      ctx.session.runInPage(
        `(function(){const el=document.querySelector(${sel(a.selector)});if(!el)return {error:'未找到元素'};el.scrollIntoView({block:'center'});el.click();return {ok:true,text:(el.innerText||el.value||'').toString().slice(0,80)}})()`
      )
  },
  {
    name: 'fill',
    description: '在页面输入框中填写内容（CSS 选择器）',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '输入框的 CSS 选择器' },
        value: { type: 'string', description: '要填写的内容' }
      },
      required: ['selector', 'value']
    },
    minLevel: 'daily',
    run: (ctx, a) =>
      ctx.session.runInPage(
        `(function(){const el=document.querySelector(${sel(a.selector)});if(!el)return {error:'未找到输入框'};el.focus();const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')&&Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;const t=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')&&Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;if(el instanceof HTMLInputElement&&setter)setter.call(el,${sel(a.value)});else if(el instanceof HTMLTextAreaElement&&t)t.call(el,${sel(a.value)});else el.value=${sel(a.value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true}})()`
      )
  },
  {
    name: 'scroll',
    description: '滚动页面（down/up/top/bottom）',
    parameters: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'] } },
      required: ['direction']
    },
    minLevel: 'daily',
    run: (ctx, a) =>
      ctx.session.runInPage(
        `(function(){const d=${sel(a.direction)};if(d==='down')window.scrollBy({top:600,behavior:'smooth'});else if(d==='up')window.scrollBy({top:-600,behavior:'smooth'});else if(d==='top')window.scrollTo({top:0,behavior:'smooth'});else if(d==='bottom')window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'});return {ok:true}})()`
      )
  },
  {
    name: 'get_bookmarks',
    description: '列出所有书签',
    parameters: { type: 'object', properties: {} },
    minLevel: 'daily',
    run: () => ({ bookmarks: bookmarks.list() })
  },
  {
    name: 'add_bookmark',
    description: '添加书签',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '书签标题' },
        url: { type: 'string', description: '网址' }
      },
      required: ['title', 'url']
    },
    minLevel: 'daily',
    run: (_c, a) => {
      bookmarks.add(String(a.title), String(a.url))
      return { ok: true }
    }
  },
  {
    name: 'get_settings',
    description: '读取浏览器当前设置（不含 API Key）',
    parameters: { type: 'object', properties: {} },
    minLevel: 'daily',
    run: () => ({ settings: store.getSettings() })
  },
  {
    name: 'update_setting',
    description:
      '修改浏览器设置。key 可选：searchEngine(bing/baidu/google/duckduckgo)、homepage、theme(system/light/dark)、frostedGlass、bookmarkBarVisible、showHomeButton、safeBrowsing、httpsUpgrade、adBlock、trackerBlock',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '设置项名称' },
        value: { type: 'string', description: '新值' }
      },
      required: ['key', 'value']
    },
    minLevel: 'daily',
    run: (_c, a) => updateSetting(a)
  },
  {
    name: 'open_settings_page',
    description: '打开浏览器的设置页面',
    parameters: { type: 'object', properties: {} },
    minLevel: 'daily',
    run: (ctx) => {
      ctx.session.openOverlay('settings')
      return { ok: true }
    }
  },

  // ---------- 开发：较安全的开发相关功能 ----------
  {
    name: 'get_page_source',
    description: '获取当前网页的 HTML 源码（截断）',
    parameters: { type: 'object', properties: {} },
    minLevel: 'developer',
    run: (ctx) =>
      ctx.session.runInPage(`document.documentElement.outerHTML.slice(0,15000)`)
  },
  {
    name: 'execute_js',
    description: '在当前页面执行一段 JavaScript 代码并返回结果',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: '要执行的 JS 代码' } },
      required: ['code']
    },
    minLevel: 'developer',
    run: (ctx, a) => ctx.session.runInPage(String(a.code))
  },
  {
    name: 'extract_links',
    description: '提取页面上所有链接',
    parameters: { type: 'object', properties: {} },
    minLevel: 'developer',
    run: (ctx) =>
      ctx.session.runInPage(
        `Array.from(document.querySelectorAll('a[href]')).slice(0,100).map(a=>({text:(a.innerText||'').trim().slice(0,100),href:a.href}))`
      )
  },
  {
    name: 'extract_images',
    description: '提取页面上所有图片地址',
    parameters: { type: 'object', properties: {} },
    minLevel: 'developer',
    run: (ctx) =>
      ctx.session.runInPage(
        `Array.from(document.querySelectorAll('img[src]')).slice(0,100).map(i=>i.src)`
      )
  },
  {
    name: 'get_history',
    description: '读取浏览历史记录',
    parameters: { type: 'object', properties: {} },
    minLevel: 'developer',
    run: () => ({ history: history.list(50) })
  },
  {
    name: 'start_capture',
    description: '开始抓包（记录网络请求）',
    parameters: { type: 'object', properties: {} },
    minLevel: 'developer',
    run: () => {
      startCapture()
      return { ok: true }
    }
  },
  {
    name: 'stop_capture',
    description: '停止抓包',
    parameters: { type: 'object', properties: {} },
    minLevel: 'developer',
    run: () => {
      stopCapture()
      return { ok: true }
    }
  },
  {
    name: 'get_captured',
    description: '获取抓包到的网络请求列表',
    parameters: { type: 'object', properties: {} },
    minLevel: 'developer',
    run: () => ({ requests: getCaptured().slice(-200) })
  },

  // ---------- 全部：谨慎开启 ----------
  {
    name: 'clear_history',
    description: '清空浏览历史（危险操作）',
    parameters: { type: 'object', properties: {} },
    minLevel: 'full',
    run: () => {
      history.clear()
      return { ok: true }
    }
  },
  {
    name: 'clear_browsing_data',
    description: '清空所有浏览数据，含缓存与 Cookie（危险操作）',
    parameters: { type: 'object', properties: {} },
    minLevel: 'full',
    run: async (ctx) => {
      await ctx.session.session.clearStorageData()
      await ctx.session.session.clearCache()
      history.clear()
      return { ok: true }
    }
  },
  {
    name: 'close_all_tabs',
    description: '关闭所有标签页（保留一个）（危险操作）',
    parameters: { type: 'object', properties: {} },
    minLevel: 'full',
    run: (ctx) => {
      const ids = ctx.session.getState().tabs.map((t) => t.id)
      for (const id of ids.slice(1)) ctx.session.closeTab(id)
      return { ok: true }
    }
  },
  {
    name: 'remove_bookmark',
    description: '删除书签（危险操作）',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '书签 ID' } },
      required: ['id']
    },
    minLevel: 'full',
    run: (_c, a) => {
      bookmarks.remove(String(a.id))
      return { ok: true }
    }
  }
]

function updateSetting(a: Record<string, unknown>): unknown {
  const key = String(a.key ?? '')
  const value = a.value
  const setters: Record<string, (v: unknown) => unknown> = {
    searchEngine: (v) => store.setSettings({ searchEngine: v as SearchEngineId }),
    homepage: (v) => store.setSettings({ homepage: String(v) }),
    theme: (v) =>
      store.setSettings({ appearance: { ...store.getAppearance(), theme: v as ThemeMode } }),
    frostedGlass: (v) =>
      store.setSettings({ appearance: { ...store.getAppearance(), frostedGlass: Boolean(v) } }),
    bookmarkBarVisible: (v) =>
      store.setSettings({
        appearance: { ...store.getAppearance(), bookmarkBarVisible: Boolean(v) }
      }),
    showHomeButton: (v) =>
      store.setSettings({ appearance: { ...store.getAppearance(), showHomeButton: Boolean(v) } }),
    safeBrowsing: (v) =>
      store.setSettings({ security: { ...store.getSecurity(), safeBrowsing: Boolean(v) } }),
    httpsUpgrade: (v) =>
      store.setSettings({ security: { ...store.getSecurity(), httpsUpgrade: Boolean(v) } }),
    adBlock: (v) => store.setSettings({ security: { ...store.getSecurity(), adBlock: Boolean(v) } }),
    trackerBlock: (v) =>
      store.setSettings({ security: { ...store.getSecurity(), trackerBlock: Boolean(v) } })
  }
  const setter = setters[key]
  if (!setter) {
    return { error: `未知设置项：${key}。可用：${Object.keys(setters).join('、')}` }
  }
  setter(value)
  return { ok: true, key }
}
