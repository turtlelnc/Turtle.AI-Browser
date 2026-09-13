/**
 * 自检 / 测试用的极简 RPC 客户端。
 * 直接使用全局 fetch，不引入任何运行时依赖。
 */

export interface ApiResult<T = unknown> {
  ok: boolean
  result: T | null
  status: number
  /** 出错时的 code（中文消息在 message 中） */
  code?: string
  message?: string
  raw: string
}

export interface RawResult {
  status: number
  body: Record<string, unknown> | null
  raw: string
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  /** 原始请求（可覆盖 token，用于鉴权用例）；path 不含 `rpc/` 前缀时会自动补上 */
  async raw(
    path: string,
    params?: unknown,
    opts: { token?: string | null } = {}
  ): Promise<RawResult> {
    const token = opts.token === undefined ? this.token : opts.token
    const isAbsolute = path.startsWith('http')
    const normalized = isAbsolute || path.startsWith('rpc/') ? path : `rpc/${path}`
    const url = isAbsolute ? path : `${this.baseUrl}/${normalized.replace(/^\/+/, '')}`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: params === undefined ? '' : JSON.stringify({ params })
    })
    const text = await res.text()
    let body: Record<string, unknown> | null = null
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : null
    } catch {
      body = null
    }
    return { status: res.status, body, raw: text }
  }

  /** 调用一个 RPC 方法 */
  async call<T = unknown>(method: string, params?: unknown): Promise<ApiResult<T>> {
    const r = await this.raw(`rpc/${method}`, params)
    const body = r.body ?? {}
    if (body['ok'] === true) {
      return { ok: true, result: (body['result'] ?? null) as T, status: r.status, raw: r.raw }
    }
    const error = (body['error'] ?? {}) as { code?: string; message?: string }
    return {
      ok: false,
      result: null,
      status: r.status,
      code: error.code,
      message: error.message,
      raw: r.raw
    }
  }
}
