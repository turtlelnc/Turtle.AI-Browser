/**
 * AI 子系统的常量。
 */

/** 调用浏览器自动化接口的默认超时（毫秒） */
export const DEFAULT_BROWSER_TIMEOUT_MS = 30_000

/** 调用浏览器自动化接口的默认超时（毫秒），用于脚本/长任务 */
export const LONG_BROWSER_TIMEOUT_MS = 120_000

/** 模型请求的默认超时（毫秒）——统一由 AbortController 控制 */
export const DEFAULT_MODEL_TIMEOUT_MS = 120_000

/** 会话滚动窗口：最多保留的历史消息条数 */
export const MAX_HISTORY_MESSAGES = 40

/** 工具结果回填模型时的最大字符数（超出截断并标注） */
export const MAX_TOOL_RESULT_CHARS = 6000

/** 页面正文默认返回字符数 */
export const DEFAULT_PAGE_TEXT_CHARS = 8000

/** 页面 HTML 默认返回字符数 */
export const DEFAULT_PAGE_DOM_CHARS = 15_000
