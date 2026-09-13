/**
 * 自检用：极小的 MCP 服务器（stdio，换行分隔 JSON-RPC 2.0）。
 *
 * 由 `selftest.ts` 通过 `spawn(process.execPath, [thisFile])` 拉起，
 * 用来验证 MCP 客户端的真实 stdio 往返（initialize / tools/list / tools/call）。
 *
 * 支持的行为：
 * - `initialize` → 返回 serverInfo 与 capabilities；
 * - `tools/list` → 返回两个工具（echo、add）；
 * - `tools/call` → 真的执行 echo / add，返回 MCP 规范形状的 content 数组；
 * - `debug.crash` → 立即退出（用于验证崩溃重启，非默认路径）。
 */

import { createInterface } from 'node:readline'

const PROTOCOL_VERSION = '2024-11-05'

interface Request {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: Record<string, unknown>
}

const TOOLS = [
  {
    name: 'echo',
    description: '原样回显 text 参数（自检用）',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text']
    }
  },
  {
    name: 'add',
    description: '计算 a + b（自检用）',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b']
    }
  }
]

function write(msg: unknown): void {
  // MCP stdio 传输：每条消息一行 JSON
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

function result(id: Request['id'], payload: unknown): void {
  write({ jsonrpc: '2.0', id: id ?? null, result: payload })
}

function error(id: Request['id'], code: number, message: string): void {
  write({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let req: Request
  try {
    req = JSON.parse(text) as Request
  } catch {
    return
  }
  const { id, method, params } = req
  switch (method) {
    case 'initialize':
      result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'tib-mock-mcp', version: '1.0.0' }
      })
      return
    case 'notifications/initialized':
      return // 通知无需响应
    case 'tools/list':
      result(id, { tools: TOOLS })
      return
    case 'tools/call': {
      const name = String(params?.['name'] ?? '')
      const args = (params?.['arguments'] ?? {}) as Record<string, unknown>
      if (name === 'echo') {
        result(id, { content: [{ type: 'text', text: String(args['text'] ?? '') }] })
        return
      }
      if (name === 'add') {
        const sum = Number(args['a'] ?? 0) + Number(args['b'] ?? 0)
        result(id, { content: [{ type: 'text', text: String(sum) }] })
        return
      }
      error(id, -32602, `未知工具：${name}`)
      return
    }
    case 'debug.crash':
      process.exit(3)
      return
    default:
      error(id, -32601, `未实现的方法：${method}`)
  }
})

rl.on('close', () => process.exit(0))
