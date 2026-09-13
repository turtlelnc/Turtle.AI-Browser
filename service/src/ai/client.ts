/**
 * OpenAI 兼容协议客户端（ESM 版，移植自 `src/main/ai/client.ts`）。
 *
 * 一套协议兼容 DeepSeek / OpenAI / Moonshot / 智谱 / 通义千问 等：
 * - `chatCompletion`：非流式，用于智能体工具调用循环（需要拿到 tool_calls）；
 * - `chatStream`：流式 SSE，用于聊天窗口逐字输出；
 * - 两者都支持 `signal` 取消与中文错误信息。
 */

import type { AgentMessage, AiMessage, AiProviderConfig } from '../shared/types.js'

export interface StreamHandlers {
  onChunk: (delta: string) => void
  onDone: (full: string) => void
  onError: (message: string) => void
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface CompletionResult {
  content: string
  toolCalls: ToolCall[]
  /** 结束原因（stop / tool_calls / length / content_filter） */
  finishReason: string
  /** token 用量（部分服务返回） */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

/** 工具 schema（OpenAI function calling 格式） */
export interface ToolSchema {
  type: 'function'
  function: Record<string, unknown>
}

/** 拼出 /chat/completions 完整地址（兼容用户直接填完整路径） */
export function completionsEndpoint(baseUrl: string): string {
  const base = (baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('API 地址为空，请先在设置中填写服务商地址。')
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
}

function authHeaders(config: AiProviderConfig): Record<string, string> {
  const key = config.apiKey?.trim()
  return {
    'Content-Type': 'application/json',
    ...(key ? { Authorization: `Bearer ${key}` } : {})
  }
}

async function readErrorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text()
    if (!text) return ''
    try {
      const json = JSON.parse(text) as { error?: { message?: string }; message?: string }
      const m = json.error?.message ?? json.message
      if (m) return m.slice(0, 240)
    } catch {
      /* 非 JSON，按原文截断 */
    }
    return text.slice(0, 240)
  } catch {
    return ''
  }
}

export interface CompletionOptions {
  tools?: ToolSchema[]
  temperature?: number
  signal?: AbortSignal
  /** 覆盖模型（例如办公/开发模式使用不同模型） */
  model?: string
  /** 额外请求体字段（如 response_format） */
  extraBody?: Record<string, unknown>
  fetchImpl?: typeof fetch
}

/** 非流式对话补全（供智能体工具调用循环使用） */
export async function chatCompletion(
  config: AiProviderConfig,
  messages: AgentMessage[],
  toolsOrOptions?: ToolSchema[] | CompletionOptions
): Promise<CompletionResult> {
  const options: CompletionOptions = Array.isArray(toolsOrOptions)
    ? { tools: toolsOrOptions }
    : (toolsOrOptions ?? {})
  const endpoint = completionsEndpoint(config.baseUrl)
  const fetchImpl = options.fetchImpl ?? fetch
  const tools = options.tools

  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({
      model: options.model ?? config.model,
      messages,
      ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
      temperature: options.temperature ?? 0.3,
      ...(options.extraBody ?? {})
    }),
    ...(options.signal ? { signal: options.signal } : {})
  })

  if (!res.ok) {
    const detail = await readErrorDetail(res)
    throw new Error(`请求失败 (HTTP ${res.status})${detail ? '：' + detail : ''}`)
  }
  const json = (await res.json()) as unknown as {
    choices?: Array<{
      message?: {
        content?: string | null
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
      }
      finish_reason?: string
    }>
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  }
  const choice = json.choices?.[0]
  const msg = choice?.message ?? {}
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc, i) => ({
    id: tc.id ?? `call_${i}`,
    type: 'function' as const,
    function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '{}' }
  }))
  return {
    content: msg.content ?? '',
    toolCalls,
    finishReason: choice?.finish_reason ?? (toolCalls.length ? 'tool_calls' : 'stop'),
    ...(json.usage
      ? {
          usage: {
            promptTokens: json.usage.prompt_tokens ?? 0,
            completionTokens: json.usage.completion_tokens ?? 0,
            totalTokens: json.usage.total_tokens ?? 0
          }
        }
      : {})
  }
}

export interface ChatStreamOptions {
  signal?: AbortSignal
  temperature?: number
  model?: string
  fetchImpl?: typeof fetch
}

/**
 * 流式对话补全。返回 AbortController，调用方 abort() 即可中断。
 * 与 v0.1.0 的差异：可注入 signal（由调用方统一管理取消）与 fetchImpl（自检用）。
 */
export function chatStream(
  config: AiProviderConfig,
  messages: AiMessage[] | AgentMessage[],
  handlers: StreamHandlers,
  options: ChatStreamOptions = {}
): AbortController {
  const controller = new AbortController()
  const signal = options.signal ?? controller.signal
  const fetchImpl = options.fetchImpl ?? fetch

  void (async () => {
    try {
      const endpoint = completionsEndpoint(config.baseUrl)
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: authHeaders(config),
        body: JSON.stringify({
          model: options.model ?? config.model,
          messages,
          stream: true,
          temperature: options.temperature ?? 0.7
        }),
        signal
      })

      if (!res.ok) {
        const detail = await readErrorDetail(res)
        throw new Error(`请求失败 (HTTP ${res.status})${detail ? '：' + detail : ''}`)
      }
      if (!res.body) throw new Error('响应无数据流（服务端未返回 stream）')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let full = ''

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          const data = t.slice(5).trim()
          if (!data || data === '[DONE]') continue
          try {
            const json = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>
            }
            const delta =
              json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content ?? ''
            if (delta) {
              full += delta
              handlers.onChunk(delta)
            }
          } catch {
            /* 忽略无法解析的行 */
          }
        }
      }
      handlers.onDone(full)
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      handlers.onError((err as Error)?.message || '未知错误')
    }
  })()

  return controller
}

/** 校验配置是否足以发起请求；返回 null 表示可用 */
export function validateAiConfig(config: AiProviderConfig): string | null {
  if (!config.apiKey?.trim()) return '尚未设置 API Key，请在设置中填写。'
  if (!config.baseUrl?.trim()) return 'API 地址为空。'
  if (!config.model?.trim()) return '模型名为空。'
  return null
}

/** 非流式单轮问答（办公/开发模式的内部步骤用） */
export async function simpleAsk(
  config: AiProviderConfig,
  systemPrompt: string,
  userPrompt: string,
  options: CompletionOptions = {}
): Promise<string> {
  const result = await chatCompletion(
    config,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    { temperature: 0.2, ...options }
  )
  return result.content
}
