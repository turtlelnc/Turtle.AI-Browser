/**
 * 服务端常量副本（只读镜像）。
 *
 * ⚠️ 同步约定：本文件是 `src/shared/constants.ts` 的**只读镜像**，理由见
 * `./types.ts` 顶部说明。契约唯一事实来源仍为仓库根的 `src/shared/constants.ts`。
 */

import type { CliPermissionLevel, Settings, SearchEngineId } from './types.js'

/** 产品信息（ARCHITECTURE.md §6 规定：APP_VERSION/APP_BUILD 为唯一版本来源） */
export const APP_NAME = 'TiBrowser'
export const APP_VERSION = '1.0.0-rc1'
export const APP_BUILD = 260913
/** 展示格式：v1.0.0-rc1 (build 260913) */
export const APP_VERSION_LABEL = `v${APP_VERSION} (build ${APP_BUILD})`

/** 内部伪协议 / 页面标识 */
export const NEW_TAB_URL = 'tibrowser://newtab'

/** 搜索引擎模板 */
export const SEARCH_ENGINES: Record<SearchEngineId, { name: string; template: string }> = {
  bing: { name: 'Bing', template: 'https://www.bing.com/search?q=' },
  baidu: { name: '百度', template: 'https://www.baidu.com/s?wd=' },
  google: { name: 'Google', template: 'https://www.google.com/search?q=' },
  duckduckgo: { name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=' }
}

/** 默认设置 */
export const DEFAULT_SETTINGS: Settings = {
  searchEngine: 'bing',
  homepage: 'https://www.bing.com',
  ai: {
    enabled: true,
    providerName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    systemPrompt: '你是 TiBrowser 内置的 AI 助手，请用简洁、准确的中文回答用户的问题。',
    cliPermission: 'daily'
  },
  security: {
    safeBrowsing: true,
    httpsUpgrade: true,
    adBlock: true,
    trackerBlock: true,
    blockSuspiciousDownloads: true
  },
  appearance: {
    frostedGlass: true,
    theme: 'system',
    bookmarkBarVisible: true,
    showHomeButton: true
  }
}

/** AI 智能体权限档位（UI 展示用） */
export const CLI_PERMISSION_LEVELS: { value: CliPermissionLevel; label: string; hint: string }[] = [
  { value: 'off', label: '关闭', hint: '仅基础对话，AI 不能控制浏览器' },
  { value: 'daily', label: '日常', hint: '可控制网页、帮你设置等安全操作' },
  { value: 'developer', label: '开发', hint: '额外增加抓包、执行 JS、读源码等开发功能' },
  { value: 'full', label: '全部', hint: '完全控制浏览器，含清空数据等危险操作，请谨慎开启' }
]

/** 事件名（原生 → UI 的 SSE 事件，见 ARCHITECTURE.md §3.2） */
export const SERVICE_EVENTS = [
  'aiChunk',
  'aiDone',
  'aiError',
  'aiTool',
  'securityEvent',
  'accountsChanged',
  'appsChanged',
  'extensionsChanged'
] as const

export type ServiceEventName = (typeof SERVICE_EVENTS)[number]
