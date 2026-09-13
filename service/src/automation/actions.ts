/**
 * 本地自动化 API 的动作表（供外部 AI 工具 / CLI / harness 调用）。
 *
 * 动作名与 `docs/ARCHITECTURE.md` §3.1 的 `tib.*` 命令一一对应，
 * 也是 `PROTOCOL_ACTIONS`（见 `../ai/executor.ts`）里定义的**同一套协议动作名**；
 * 边车**只做鉴权 + 转发**，真正的执行在原生浏览器进程。
 *
 * 每个动作额外给出 `tool`（AI 智能体使用的工具名），用于把外部调用也塞进同一执行通道。
 */

import { ACTION_TO_TOOL } from '../ai/executor.js'

/** 动作分组（文档按组展示） */
export type ActionGroup = 'navigate' | 'read' | 'interact' | 'ui' | 'state' | 'utility'

export interface ActionDef {
  /** 对外动作名（`POST /automation/<action>`） */
  name: string
  group: ActionGroup
  /** 对应的 AI 智能体工具名 */
  tool: string
  /** 中文说明 */
  summary: string
  /** 参数说明：参数名 → 中文说明（含类型与是否必填） */
  params: Record<string, string>
  /** 必填参数 */
  required: string[]
  /** 是否需要 developer 及以上权限（原生侧会二次校验） */
  risky?: boolean
}

/** 全部可用动作（顺序即文档顺序） */
export const AUTOMATION_ACTIONS: ActionDef[] = [
  // ---------- 导航 ----------
  {
    name: 'navigate',
    group: 'navigate',
    tool: 'navigate',
    summary: '在当前标签页导航到指定网址（支持网址或搜索词）',
    params: { url: 'string（必填）网址或搜索词' },
    required: ['url']
  },
  {
    name: 'newTab',
    group: 'navigate',
    tool: 'open_tab',
    summary: '新建标签页（可选指定要打开的地址）',
    params: {
      url: 'string（可选）要打开的地址，缺省为新标签页',
      incognito: 'boolean（可选）是否使用无痕模式',
      activate: 'boolean（可选，默认 true）是否立即激活'
    },
    required: []
  },
  {
    name: 'closeTab',
    group: 'navigate',
    tool: 'close_current_tab',
    summary: '关闭指定标签页（缺省关闭当前标签页）',
    params: { tabId: 'string（可选）标签页 ID' },
    required: []
  },
  {
    name: 'activateTab',
    group: 'navigate',
    tool: 'switch_tab',
    summary: '激活指定标签页（tabId 或从 0 开始的 index）',
    params: { tabId: 'string（二选一）标签页 ID', index: 'number（二选一）标签页序号，从 0 开始' },
    required: []
  },
  { name: 'goBack', group: 'navigate', tool: 'go_back', summary: '后退到上一页', params: {}, required: [] },
  { name: 'goForward', group: 'navigate', tool: 'go_forward', summary: '前进到下一页', params: {}, required: [] },
  { name: 'reload', group: 'navigate', tool: 'reload_page', summary: '重新加载当前页面', params: {}, required: [] },
  { name: 'stop', group: 'navigate', tool: 'stop_loading', summary: '停止加载当前页面', params: {}, required: [] },
  { name: 'goHome', group: 'navigate', tool: 'go_home', summary: '打开主页', params: {}, required: [] },

  // ---------- 读取 ----------
  {
    name: 'getTabs',
    group: 'read',
    tool: 'get_tabs',
    summary: '列出所有打开的标签页（含 id / 标题 / 网址 / 是否激活）',
    params: {},
    required: []
  },
  {
    name: 'getPageText',
    group: 'read',
    tool: 'get_page_text',
    summary: '读取当前页面正文文本',
    params: {
      maxChars: 'number（可选，默认 8000）最多返回的字符数',
      tabId: 'string（可选）指定标签页'
    },
    required: []
  },
  {
    name: 'getPageInfo',
    group: 'read',
    tool: 'get_page_info',
    summary: '获取当前页面的标题、网址与加载状态',
    params: {},
    required: []
  },
  {
    name: 'getSelectedText',
    group: 'read',
    tool: 'get_selected_text',
    summary: '获取用户在页面上选中的文字',
    params: {},
    required: []
  },
  {
    name: 'getDom',
    group: 'read',
    tool: 'get_page_source',
    summary: '获取当前页面的 HTML 源码（默认截断 15000 字符）',
    params: {
      maxChars: 'number（可选，默认 15000）最多返回的字符数',
      selector: 'string（可选）只取某个 CSS 选择器对应的片段'
    },
    required: [],
    risky: true
  },
  {
    name: 'extractLinks',
    group: 'read',
    tool: 'extract_links',
    summary: '提取页面上的链接（最多 100 条）',
    params: {},
    required: [],
    risky: true
  },
  {
    name: 'extractImages',
    group: 'read',
    tool: 'extract_images',
    summary: '提取页面上的图片地址（最多 100 条）',
    params: {},
    required: [],
    risky: true
  },

  // ---------- 交互 ----------
  {
    name: 'click',
    group: 'interact',
    tool: 'click',
    summary: '点击页面上匹配 CSS 选择器的元素',
    params: { selector: 'string（必填）CSS 选择器，如 #submit、.btn' },
    required: ['selector']
  },
  {
    name: 'fill',
    group: 'interact',
    tool: 'fill',
    summary: '在输入框中填写内容（会派发 input/change 事件，兼容 React 受控组件）',
    params: {
      selector: 'string（必填）输入框 CSS 选择器',
      value: 'string（必填）要填写的内容'
    },
    required: ['selector', 'value']
  },
  {
    name: 'scroll',
    group: 'interact',
    tool: 'scroll',
    summary: '滚动页面',
    params: { direction: 'string（必填）down | up | top | bottom' },
    required: ['direction']
  },
  {
    name: 'screenshot',
    group: 'interact',
    tool: 'screenshot',
    summary: '对当前页面截图，返回 base64 PNG',
    params: {
      fullPage: 'boolean（可选，默认 false）是否整页截图',
      format: 'string（可选，默认 png）png | jpeg'
    },
    required: []
  },
  {
    name: 'evaluate',
    group: 'interact',
    tool: 'execute_js',
    summary: '在页面中执行 JavaScript 并返回结果（需要开发者及以上权限档位）',
    params: { code: 'string（必填）要执行的 JS 代码' },
    required: ['code'],
    risky: true
  },
  {
    name: 'findInPage',
    group: 'interact',
    tool: 'find_in_page',
    summary: '页内查找文本并高亮',
    params: {
      text: 'string（必填）要查找的文本',
      forward: 'boolean（可选，默认 true）查找方向'
    },
    required: ['text']
  },

  // ---------- 界面 ----------
  {
    name: 'setOverlay',
    group: 'ui',
    tool: 'open_settings_page',
    summary: '打开/关闭覆盖层（设置、历史、书签、下载、关于）',
    params: { name: "string（必填）settings | history | bookmarks | downloads | about | ''（关闭）" },
    required: ['name']
  },
  {
    name: 'toggleSidebar',
    group: 'ui',
    tool: 'toggle_sidebar',
    summary: '打开/关闭 AI 侧边栏',
    params: { open: 'boolean（可选）不传则切换' },
    required: []
  },
  {
    name: 'setSidebarWidth',
    group: 'ui',
    tool: 'set_sidebar_width',
    summary: '设置 AI 侧边栏宽度（像素，260-560）',
    params: { width: 'number（必填）宽度' },
    required: ['width']
  },
  {
    name: 'setZoom',
    group: 'ui',
    tool: 'set_zoom',
    summary: '设置页面缩放级别',
    params: { level: 'number（必填）Chromium 缩放级别，0 表示 100%' },
    required: ['level']
  },
  {
    name: 'setProtectionLevel',
    group: 'ui',
    tool: 'set_protection_level',
    summary: '设置安全浏览档位（增强型 / 标准 / 不防护）',
    params: { level: 'string（必填）enhanced | standard | none' },
    required: ['level']
  },
  {
    name: 'setEnergyMode',
    group: 'ui',
    tool: 'set_energy_mode',
    summary: '设置能效档位',
    params: { mode: 'string（必填）performance | balanced | saver | instant' },
    required: ['mode']
  },

  // ---------- 状态 ----------
  {
    name: 'getState',
    group: 'state',
    tool: 'get_browser_state',
    summary: '获取浏览器完整状态（标签页、设置、侧边栏等）',
    params: {},
    required: []
  },
  {
    name: 'getSettings',
    group: 'state',
    tool: 'get_settings',
    summary: '获取浏览器设置（API Key 只返回掩码）',
    params: {},
    required: []
  },
  {
    name: 'getSecurityReport',
    group: 'state',
    tool: 'get_security_report',
    summary: '获取安全浏览当前档位与拦截统计',
    params: {},
    required: []
  },
  {
    name: 'getDownloads',
    group: 'state',
    tool: 'get_downloads',
    summary: '获取下载记录',
    params: { limit: 'number（可选，默认 100）' },
    required: []
  },
  {
    name: 'getHistory',
    group: 'state',
    tool: 'get_history',
    summary: '获取浏览历史',
    params: { query: 'string（可选）关键词过滤', limit: 'number（可选，默认 100）' },
    required: []
  },
  {
    name: 'getBookmarks',
    group: 'state',
    tool: 'get_bookmarks',
    summary: '获取书签列表',
    params: {},
    required: []
  },

  // ---------- 抓包与维护 ----------
  {
    name: 'startCapture',
    group: 'utility',
    tool: 'start_capture',
    summary: '开始抓包（记录网络请求）',
    params: {},
    required: [],
    risky: true
  },
  {
    name: 'stopCapture',
    group: 'utility',
    tool: 'stop_capture',
    summary: '停止抓包',
    params: {},
    required: [],
    risky: true
  },
  {
    name: 'getCaptured',
    group: 'utility',
    tool: 'get_captured',
    summary: '获取抓包到的网络请求列表',
    params: { limit: 'number（可选，默认 200）' },
    required: [],
    risky: true
  },
  {
    name: 'clearBrowsingData',
    group: 'utility',
    tool: 'clear_browsing_data',
    summary: '清空浏览数据（缓存与 Cookie，危险操作）',
    params: {},
    required: [],
    risky: true
  },
  {
    name: 'closeAllTabs',
    group: 'utility',
    tool: 'close_all_tabs',
    summary: '关闭所有标签页（保留一个，危险操作）',
    params: {},
    required: [],
    risky: true
  }
]

/** 动作名 → 定义 */
export const ACTION_MAP: Map<string, ActionDef> = new Map(AUTOMATION_ACTIONS.map((a) => [a.name, a]))

/** 按分组列出动作（文档生成用） */
export function actionsByGroup(): Array<{ group: ActionGroup; label: string; actions: ActionDef[] }> {
  const labels: Record<ActionGroup, string> = {
    navigate: '导航',
    read: '读取页面',
    interact: '页面交互',
    ui: '界面控制',
    state: '状态查询',
    utility: '抓包与维护'
  }
  const groups: ActionGroup[] = ['navigate', 'read', 'interact', 'ui', 'state', 'utility']
  return groups
    .map((group) => ({
      group,
      label: labels[group],
      actions: AUTOMATION_ACTIONS.filter((a) => a.group === group)
    }))
    .filter((g) => g.actions.length > 0)
}

/**
 * 自检用：确认动作表里声明的 `tool` 与 `ACTION_TO_TOOL` 双向一致。
 * 返回不一致的条目（空数组表示完全一致）。
 */
export function actionToolMismatches(): string[] {
  const bad: string[] = []
  for (const a of AUTOMATION_ACTIONS) {
    const expected = ACTION_TO_TOOL[a.name] ?? a.name
    if (expected !== a.tool) {
      bad.push(`${a.name}: 动作表写的是 ${a.tool}，映射表推导为 ${expected}`)
    }
  }
  return bad
}
