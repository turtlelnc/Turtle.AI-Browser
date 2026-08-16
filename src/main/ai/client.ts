import type { AgentMessage, AiMessage, AiProviderConfig } from '@shared/types'

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
}

/** 非流式对话补全（供智能体工具调用循环使用） */
export async function chatCompletion(
  config: AiProviderConfig,
  messages: AgentMessage[],
  tools?: Array<{ type: 'function'; function: Record<string, unknown> }>
): Promise<CompletionResult> {
  const base = config.baseUrl.trim().replace(/\/+$/, '')
  const endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages,
      ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
      temperature: 0.3
    })
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`请求失败 (HTTP ${res.status})${detail ? '：' + detail.slice(0, 240) : ''}`)
  }
  const json = (await res.json()) as any
  const msg = json.choices?.[0]?.message ?? {}
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any) => ({
    id: tc.id,
    type: 'function' as const,
    function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '{}' }
  }))
  return { content: msg.content ?? '', toolCalls }
}

/**
 * 调用 OpenAI 兼容协议 /chat/completions（流式）。
 * 一套协议兼容 DeepSeek / OpenAI / 通义千问 / Moonshot / 智谱 等。
 */
export function chatStream(
  config: AiProviderConfig,
  messages: AiMessage[],
  handlers: StreamHandlers
): AbortController {
  const controller = new AbortController()
  const base = config.baseUrl.trim().replace(/\/+$/, '')
  const endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`

  void (async () => {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          stream: true,
          temperature: 0.7
        }),
        signal: controller.signal
      })

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`请求失败 (HTTP ${res.status})${detail ? '：' + detail.slice(0, 240) : ''}`)
      }
      if (!res.body) throw new Error('响应无数据流')

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
            const json = JSON.parse(data)
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
      if ((err as Error).name === 'AbortError') return
      handlers.onError((err as Error).message || '未知错误')
    }
  })()

  return controller
}

/** 校验配置是否足以发起请求 */
export function validateAiConfig(config: AiProviderConfig): string | null {
  if (!config.apiKey) return '尚未设置 API Key，请在设置中填写。'
  if (!config.baseUrl.trim()) return 'API 地址为空。'
  if (!config.model.trim()) return '模型名为空。'
  return null
}
