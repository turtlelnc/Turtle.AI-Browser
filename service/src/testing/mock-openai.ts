/**
 * 自检 / 测试用：假的 OpenAI 兼容服务端。
 *
 * 在 127.0.0.1 上监听随机端口，按预设脚本依次返回响应：
 * 第一次返回带 `tool_calls` 的响应，第二次返回最终文本。
 * 也支持流式（`stream:true`）返回 SSE 增量，用于验证 chatStream。
 *
 * **兼容性说明**：这里用 `node:http` 手工实现，不依赖任何 Web 框架，
 * 保证自检环境零额外依赖。
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** 一次响应脚本 */
export interface MockTurn {
  /** 返回的正文（可为空） */
  content?: string
  /** 返回的工具调用 */
  toolCalls?: Array<{ id?: string; name: string; arguments: string }>
  /** finish_reason */
  finishReason?: string
  /** 直接返回错误（HTTP 状态码） */
  httpError?: number
}

export interface MockOpenAiOptions {
  /** 依次返回的响应；用完后重复最后一个 */
  turns: MockTurn[]
  /** 模型名（回显用） */
  model?: string
  /** 是否在流式请求时返回 SSE 增量 */
  supportsStream?: boolean
}

export interface MockOpenAiServer {
  url: string
  port: number
  /** 收到的全部请求体（便于断言 messages 内容） */
  readonly requests: Array<Record<string, unknown>>
  /** 已服务的请求数 */
  count(): number
  /** 收到的第 n 个请求体 */
  requestAt(index: number): Record<string, unknown> | undefined
  close(): Promise<void>
}

/** 启动假 OpenAI 服务端 */
export async function startMockOpenAi(options: MockOpenAiOptions): Promise<MockOpenAiServer> {
  const requests: Array<Record<string, unknown>> = []
  let index = 0

  const server: Server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf-8')
    req.on('data', (c: string) => (body += c))
    req.on('end', () => {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {}
      } catch {
        parsed = {}
      }
      requests.push(parsed)
      const turn = options.turns[Math.min(index, options.turns.length - 1)] ?? { content: '' }
      index++

      if (turn.httpError) {
        res.writeHead(turn.httpError, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: { message: `模拟的错误（HTTP ${turn.httpError}）` } }))
        return
      }

      const model = options.model ?? String(parsed['model'] ?? 'mock-model')
      const content = turn.content ?? ''
      const toolCalls = (turn.toolCalls ?? []).map((tc, i) => ({
        id: tc.id ?? `call_${index}_${i}`,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments }
      }))

      // 流式
      if (parsed['stream'] === true && (options.supportsStream ?? true)) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive'
        })
        for (const ch of chunkText(content, 8)) {
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: ch }, index: 0 }] })}\n\n`
          )
        }
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          id: `chatcmpl-mock-${index}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: content || null,
                ...(toolCalls.length ? { tool_calls: toolCalls } : {})
              },
              finish_reason: turn.finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop')
            }
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
        })
      )
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as AddressInfo
  const port = addr.port
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    count: () => requests.length,
    requestAt: (i: number) => requests[i],
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        setTimeout(resolve, 300).unref?.()
      })
  }
}

/** 把文本切成若干片，模拟流式增量 */
function chunkText(text: string, size: number): string[] {
  if (!text) return []
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}
