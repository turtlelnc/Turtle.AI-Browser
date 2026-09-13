/**
 * 浏览器与本地工具定义（45 个）与四档权限（`off | daily | developer | full`）。
 *
 * 与 v0.1.0 `src/main/ai/tools.ts` 的**根本差异**：工具的 `execute` 不再直接操作
 * Electron 的 BrowserSession，而是通过注入的 `ToolExecutor` 回调原生浏览器；
 * 只有「边车本地就能做」的工具（书签/历史/设置/工作区文件/命令/MCP）走本地实现。
 *
 * 每个工具有一个 `layer` 字段：
 * - `browser`：必须由原生执行（拥有标签页/页面），走 `ToolExecutor.run()`；
 * - `local`  ：边车本地执行（读自己的 JSON 存储、工作区文件、MCP 服务）。
 * 权限档位 `minLevel` 对两类工具一视同仁。
 *
 * 工具名 → 协议动作名的映射只有一处（`executor.ts` 的 `TOOL_TO_ACTION`），
 * 自检会断言本文件里每个 `browser` 层工具都有对应动作。
 */

import type { CliPermissionLevel, SearchEngineId, ThemeMode } from '../shared/types.js'
import { TOOL_TO_ACTION, type ToolExecutor } from './executor.js'
import type { Workspace } from './modes/workspace.js'
import type { McpRegistry } from './mcp.js'

/** 工具可声明的最低档位（off 档位下不暴露任何工具） */
export type ToolLevel = 'daily' | 'developer' | 'full'

/** 工具分层 */
export type ToolLayer = 'browser' | 'local'

/** 本地存储接口（由 store 层注入，便于测试替身） */
export interface LocalToolHost {
  getSettings(): unknown
  updateSetting(key: string, value: unknown): unknown
  listBookmarks(): unknown
  addBookmark(title: string, url: string): unknown
  removeBookmark(id: string): unknown
  listHistory(limit: number): unknown
  clearHistory(): unknown
  listDownloads(limit: number): unknown
  getSecurityReport(): unknown
  getProtectionCapabilities(): unknown
}

/** 工具执行上下文 */
export interface ToolContext {
  /** 浏览器工具的执行通道（HTTP 回调原生 / Mock） */
  executor: ToolExecutor
  /** 边车本地能力 */
  host: LocalToolHost
  /** 工作区（本地开发/办公模式使用；未授权时为 null） */
  workspace: Workspace | null
  /** MCP 服务注册表（mcp_call 工具使用） */
  mcp: McpRegistry | null
  /** 当前请求 id（用于事件上报） */
  requestId?: string
}

export interface ToolDef {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description?: string; enum?: string[] }>
    required?: string[]
  }
  minLevel: ToolLevel
  layer: ToolLayer
  execute: (ctx: ToolContext, args: Record<string, unknown>) => unknown | Promise<unknown>
}

const LEVEL_RANK: Record<CliPermissionLevel, number> = { off: 0, daily: 1, developer: 2, full: 3 }

/** 根据当前权限档位筛选可用工具 */
export function getToolsForLevel(level: CliPermissionLevel): ToolDef[] {
  return TOOLS.filter((t) => LEVEL_RANK[level] >= LEVEL_RANK[t.minLevel])
}

/** 判断某档位能否执行某最低档位的工具 */
export function canRunTool(minLevel: ToolLevel, level: CliPermissionLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[minLevel]
}

/** 按名字取工具定义 */
export function getTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name)
}

/** 工具的 JSON Schema 数组（直接喂给 /chat/completions 的 tools 字段） */
export function toolSchemas(level: CliPermissionLevel): Array<{
  type: 'function'
  function: Record<string, unknown>
}> {
  return getToolsForLevel(level).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
}

/** 需要浏览器执行的工具统一走这里（名字由 executor 映射为协议动作） */
function viaBrowser(name: string) {
  return (ctx: ToolContext, a: Record<string, unknown>): Promise<unknown> =>
    Promise.resolve(ctx.executor.run(name, a))
}

/** 无参数工具的定义糖 */
const NO_PARAMS = { type: 'object' as const, properties: {} }

export const TOOLS: ToolDef[] = [
  // ---------- 日常：网页控制 ----------
  {
    name: 'navigate',
    description: '在当前标签页导航到指定网址（支持网址或搜索词）',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '网址或搜索词' } },
      required: ['url']
    },
    minLevel: 'daily',
    layer: 'browser',
    execute: viaBrowser('navigate')
  },
  {
    name: 'get_page_text',
    description: '读取当前网页的正文文本',
    parameters: {
      type: 'object',
      properties: { maxChars: { type: 'string', description: '最多返回的字符数，默认 8000' } }
    },
    minLevel: 'daily',
    layer: 'browser',
    execute: viaBrowser('get_page_text')
  },
  {
    name: 'get_page_info',
    description: '获取当前页面的标题与网址',
    parameters: NO_PARAMS,
    minLevel: 'daily',
    layer: 'browser',
    execute: viaBrowser('get_page_info')
  },
  {
    name: 'get_tabs',
    description: '列出所有打开的标签页',
    parameters: NO_PARAMS,
    minLevel: 'daily',
    layer: 'browser',
    execute: viaBrowser('get_tabs')
  },
  {
    name: 'open_tab',
    description: '在新标签页打开网址',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '网址' },
        incognito: { type: 'string', description: '是否使用无痕模式（true/false）' }
      },
      required: ['url']
    },
    minLevel: 'daily',
    layer: 'browser',
    execute: viaBrowser('open_tab')
  },
  {
    name: 'close_current_tab',
    description: '关闭当前标签页',
    parameters: NO_PARAMS,
    minLevel: 'daily',
    layer: 'browser',
    execute: viaBrowser('close_current_tab')
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
    layer: 'browser',
    execute: viaBrowser('switch_tab')
  },
  { name: 'go_back', description: '后退到上一页', parameters: NO_PARAMS, minLevel: 'daily', layer: 'browser', execute: viaBrowser('go_back') },
  { name: 'go_forward', description: '前进到下一页', parameters: NO_PARAMS, minLevel: 'daily', layer: 'browser', execute: viaBrowser('go_forward') },
  { name: 'reload_page', description: '刷新当前页面', parameters: NO_PARAMS, minLevel: 'daily', layer: 'browser', execute: viaBrowser('reload_page') },
  { name: 'go_home', description: '打开浏览器主页', parameters: NO_PARAMS, minLevel: 'daily', layer: 'browser', execute: viaBrowser('go_home') },
  {
    name: 'click',
    description: '点击页面上的元素（CSS 选择器）',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS 选择器，如 #submit、.btn' } },
      required: ['selector']
    },
    minLevel: 'daily',
    layer: 'browser',
    execute: viaBrowser('click')
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
    layer: 'browser',
    execute: viaBrowser('fill')
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
    layer: 'browser',
    execute: viaBrowser('scroll')
  },
  {
    name: 'screenshot',
    description: '对当前页面截图，返回 base64 PNG（可用于确认页面状态）',
    parameters: {
      type: 'object',
      properties: {
        fullPage: { type: 'string', description: '是否整页截图（true/false）' },
        format: { type: 'string', enum: ['png', 'jpeg'] }
      }
    },
    minLevel: 'daily',
    layer: 'browser',
    execute: viaBrowser('screenshot')
  },

  // ---------- 日常：书签 / 设置 ----------
  {
    name: 'get_bookmarks',
    description: '列出所有书签',
    parameters: NO_PARAMS,
    minLevel: 'daily',
    layer: 'local',
    execute: (ctx) => ({ bookmarks: ctx.host.listBookmarks() })
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
    layer: 'local',
    execute: (ctx, a) => ctx.host.addBookmark(String(a.title ?? ''), String(a.url ?? ''))
  },
  {
    name: 'get_settings',
    description: '读取浏览器当前设置（不含 API Key，只返回掩码）',
    parameters: NO_PARAMS,
    minLevel: 'daily',
    layer: 'local',
    execute: (ctx) => ({ settings: ctx.host.getSettings() })
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
    layer: 'local',
    execute: (ctx, a) => updateSettingViaHost(ctx, a)
  },
  {
    name: 'open_settings_page',
    description: '打开浏览器的设置页面',
    parameters: NO_PARAMS,
    minLevel: 'daily',
    layer: 'browser',
    execute: (ctx) => ctx.executor.run('open_settings_page', { name: 'settings' })
  },

  // ---------- 日常：工作区（本地办公模式） ----------
  {
    name: 'list_workspace_files',
    description: '列出本地工作区中的文件（需用户已授权工作区目录）',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '相对工作区根目录的子目录，默认为根目录' },
        depth: { type: 'string', description: '递归深度（1-3），默认 1' }
      }
    },
    minLevel: 'daily',
    layer: 'local',
    execute: (ctx, a) => requireWorkspace(ctx).listFiles(String(a.dir ?? '.'), Number(a.depth ?? 1))
  },
  {
    name: 'read_workspace_file',
    description: '读取本地工作区中的文本文件内容（需用户已授权工作区目录）',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区根目录的文件路径' },
        maxBytes: { type: 'string', description: '最多读取的字节数，默认 65536' }
      },
      required: ['path']
    },
    minLevel: 'daily',
    layer: 'local',
    execute: (ctx, a) => requireWorkspace(ctx).readFile(String(a.path ?? ''), Number(a.maxBytes ?? 65536))
  },

  // ---------- 开发：开发者级能力 ----------
  {
    name: 'get_page_source',
    description: '获取当前网页的 HTML 源码（默认截断 15000 字符）',
    parameters: {
      type: 'object',
      properties: {
        maxChars: { type: 'string', description: '最多返回的字符数，默认 15000' },
        selector: { type: 'string', description: '只取某个 CSS 选择器对应的片段' }
      }
    },
    minLevel: 'developer',
    layer: 'browser',
    execute: viaBrowser('get_page_source')
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
    layer: 'browser',
    execute: viaBrowser('execute_js')
  },
  {
    name: 'extract_links',
    description: '提取页面上所有链接',
    parameters: NO_PARAMS,
    minLevel: 'developer',
    layer: 'browser',
    execute: viaBrowser('extract_links')
  },
  {
    name: 'extract_images',
    description: '提取页面上所有图片地址',
    parameters: NO_PARAMS,
    minLevel: 'developer',
    layer: 'browser',
    execute: viaBrowser('extract_images')
  },
  {
    name: 'get_browser_state',
    description: '获取浏览器完整状态（标签页列表、侧边栏、当前覆盖层等）',
    parameters: NO_PARAMS,
    minLevel: 'developer',
    layer: 'browser',
    execute: viaBrowser('get_browser_state')
  },
  {
    name: 'get_history',
    description: '读取浏览历史记录（本地存储，最近 50 条）',
    parameters: NO_PARAMS,
    minLevel: 'developer',
    layer: 'local',
    execute: (ctx) => ({ history: ctx.host.listHistory(50) })
  },
  {
    name: 'get_downloads',
    description: '读取下载记录',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'string', description: '最多返回条数，默认 50' } }
    },
    minLevel: 'developer',
    layer: 'local',
    execute: (ctx, a) => ({ downloads: ctx.host.listDownloads(Number(a.limit ?? 50)) })
  },
  {
    name: 'start_capture',
    description: '开始抓包（记录网络请求）',
    parameters: NO_PARAMS,
    minLevel: 'developer',
    layer: 'browser',
    execute: viaBrowser('start_capture')
  },
  {
    name: 'stop_capture',
    description: '停止抓包',
    parameters: NO_PARAMS,
    minLevel: 'developer',
    layer: 'browser',
    execute: viaBrowser('stop_capture')
  },
  {
    name: 'get_captured',
    description: '获取抓包到的网络请求列表',
    parameters: NO_PARAMS,
    minLevel: 'developer',
    layer: 'browser',
    execute: viaBrowser('get_captured')
  },
  {
    name: 'write_workspace_file',
    description: '在本地工作区写入或修改文件（需工作区授权；演练模式下只返回将要写入的内容而不落盘）',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区根目录的文件路径' },
        content: { type: 'string', description: '完整文件内容' }
      },
      required: ['path', 'content']
    },
    minLevel: 'developer',
    layer: 'local',
    execute: (ctx, a) => requireWorkspace(ctx).writeFile(String(a.path ?? ''), String(a.content ?? ''))
  },
  {
    name: 'run_command',
    description:
      '在本地工作区执行一条白名单内的命令（如 npm test、node script.js），返回 stdout/stderr（演练模式下只返回将执行的命令）',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令，例如 npm test' },
        cwd: { type: 'string', description: '相对工作区根目录的工作目录，默认根目录' }
      },
      required: ['command']
    },
    minLevel: 'developer',
    layer: 'local',
    execute: (ctx, a) => requireWorkspace(ctx).runCommand(String(a.command ?? ''), String(a.cwd ?? '.'))
  },
  {
    name: 'sleep',
    description: '等待若干毫秒（用于等待页面加载完成后再次读取）',
    parameters: {
      type: 'object',
      properties: { ms: { type: 'number', description: '等待毫秒数，上限 10000' } },
      required: ['ms']
    },
    minLevel: 'developer',
    layer: 'local',
    execute: async (_ctx, a) => {
      const ms = Math.max(0, Math.min(10_000, Number(a.ms ?? 0)))
      await new Promise((r) => setTimeout(r, ms))
      return { ok: true, waitedMs: ms }
    }
  },
  {
    name: 'set_protection_level',
    description: '设置安全浏览档位（enhanced 增强型 / standard 标准 / none 不防护）',
    parameters: {
      type: 'object',
      properties: { level: { type: 'string', enum: ['enhanced', 'standard', 'none'] } },
      required: ['level']
    },
    minLevel: 'developer',
    layer: 'local',
    execute: (ctx, a) => ctx.host.updateSetting('protectionLevel', String(a.level ?? ''))
  },
  {
    name: 'set_energy_mode',
    description: '设置能效档位（performance / balanced / saver / instant）',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['performance', 'balanced', 'saver', 'instant'] }
      },
      required: ['mode']
    },
    minLevel: 'developer',
    layer: 'browser',
    execute: viaBrowser('set_energy_mode')
  },
  {
    name: 'mcp_call',
    description: '调用已配置的 MCP 服务器上的工具（server 为服务器名，tool 为工具名）',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP 服务器名' },
        tool: { type: 'string', description: 'MCP 工具名' },
        args: { type: 'string', description: 'JSON 字符串形式的工具参数' }
      },
      required: ['server', 'tool']
    },
    minLevel: 'developer',
    layer: 'local',
    execute: async (ctx, a) => {
      const reg = ctx.mcp
      if (!reg) return { error: 'MCP 功能未启用。' }
      let args: unknown = {}
      const raw = a.args
      if (typeof raw === 'string' && raw.trim()) {
        try {
          args = JSON.parse(raw)
        } catch {
          return { error: 'MCP 参数 args 不是合法 JSON。' }
        }
      } else if (raw && typeof raw === 'object') {
        args = raw
      }
      return reg.callTool(String(a.server ?? ''), String(a.tool ?? ''), args)
    }
  },

  // ---------- 全部：危险操作 ----------
  {
    name: 'clear_history',
    description: '清空浏览历史（危险操作）',
    parameters: NO_PARAMS,
    minLevel: 'full',
    layer: 'local',
    execute: (ctx) => {
      ctx.host.clearHistory()
      return Promise.resolve({ ok: true })
    }
  },
  {
    name: 'clear_browsing_data',
    description: '清空所有浏览数据，含缓存与 Cookie（危险操作）',
    parameters: NO_PARAMS,
    minLevel: 'full',
    layer: 'browser',
    execute: viaBrowser('clear_browsing_data')
  },
  {
    name: 'close_all_tabs',
    description: '关闭所有标签页（保留一个）（危险操作）',
    parameters: NO_PARAMS,
    minLevel: 'full',
    layer: 'browser',
    execute: viaBrowser('close_all_tabs')
  },
  {
    name: 'remove_bookmark',
    description: '删除书签',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '书签 ID' } },
      required: ['id']
    },
    minLevel: 'daily',
    layer: 'local',
    execute: (ctx, a) => ctx.host.removeBookmark(String(a.id ?? ''))
  },
  {
    name: 'remove_history',
    description: '删除单条浏览历史（危险操作）',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '历史记录 ID' } },
      required: ['id']
    },
    minLevel: 'developer',
    layer: 'local',
    execute: (ctx, a) => {
      const host = ctx.host as LocalToolHost & { removeHistory?: (id: string) => unknown }
      if (typeof host.removeHistory !== 'function') {
        return { error: '当前宿主未实现删除单条历史记录。' }
      }
      return host.removeHistory(String(a.id ?? ''))
    }
  },
  {
    name: 'clear_downloads',
    description: '清空下载记录（不影响已下载的文件）',
    parameters: NO_PARAMS,
    minLevel: 'developer',
    layer: 'local',
    execute: (ctx) => {
      const host = ctx.host as LocalToolHost & { clearDownloads?: () => unknown }
      if (typeof host.clearDownloads !== 'function') {
        return { error: '当前宿主未实现清空下载记录。' }
      }
      return host.clearDownloads()
    }
  },
  {
    name: 'reset_settings',
    description: '把浏览器设置恢复为默认值（危险操作；API Key 与工作区授权不受影响）',
    parameters: NO_PARAMS,
    minLevel: 'full',
    layer: 'local',
    execute: (ctx) => {
      const host = ctx.host as LocalToolHost & { resetSettings?: () => unknown }
      if (typeof host.resetSettings !== 'function') {
        return { error: '当前宿主未实现重置设置。' }
      }
      return host.resetSettings()
    }
  }
]

/** 统计：工具总数与各档位可用数量（自检用） */
export function toolStats(): {
  total: number
  byLevel: Record<CliPermissionLevel, number>
  browser: number
  local: number
} {
  const byLevel: Record<CliPermissionLevel, number> = { off: 0, daily: 0, developer: 0, full: 0 }
  for (const level of ['off', 'daily', 'developer', 'full'] as CliPermissionLevel[]) {
    byLevel[level] = getToolsForLevel(level).length
  }
  return {
    total: TOOLS.length,
    byLevel,
    browser: TOOLS.filter((t) => t.layer === 'browser').length,
    local: TOOLS.filter((t) => t.layer === 'local').length
  }
}

function requireWorkspace(ctx: ToolContext): Workspace {
  if (!ctx.workspace?.available) {
    throw new Error('尚未授权本地工作区目录，无法读写本地文件。请在设置中指定工作区根目录后再试。')
  }
  return ctx.workspace
}

/** 需要浏览器执行但缺少协议动作映射的工具名（自检时断言为空数组） */
export function browserToolsWithoutAction(): string[] {
  return TOOLS.filter((t) => t.layer === 'browser' && !TOOL_TO_ACTION[t.name]).map((t) => t.name)
}

/** 设置项写入（走 LocalToolHost，便于单测替换） */
function updateSettingViaHost(ctx: ToolContext, a: Record<string, unknown>): unknown {
  const key = String(a.key ?? '')
  const value = a.value
  const known = [
    'searchEngine',
    'homepage',
    'theme',
    'frostedGlass',
    'bookmarkBarVisible',
    'showHomeButton',
    'safeBrowsing',
    'httpsUpgrade',
    'adBlock',
    'trackerBlock'
  ]
  if (!known.includes(key)) {
    return {
      error: `未知设置项：${key}。可用：${known.join('、')}（安全浏览档位请用 set_protection_level 工具）`
    }
  }
  return ctx.host.updateSetting(key, value)
}

/** 供 host 实现参考：把字符串值转成对应类型（导出便于复用与测试） */
export function coerceSettingValue(
  key: string,
  value: unknown
): SearchEngineId | ThemeMode | boolean | string {
  if (key === 'searchEngine') return String(value) as SearchEngineId
  if (key === 'theme') return String(value) as ThemeMode
  if (
    [
      'frostedGlass',
      'bookmarkBarVisible',
      'showHomeButton',
      'safeBrowsing',
      'httpsUpgrade',
      'adBlock',
      'trackerBlock'
    ].includes(key)
  ) {
    return value === true || value === 'true' || value === 1 || value === '1'
  }
  return String(value ?? '')
}
