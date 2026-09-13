/**
 * OAuth 2.0 授权码 + PKCE + 本地回环（loopback）流程助手（通用实现）。
 *
 * **为什么是通用的**：不同服务商的授权地址、令牌地址、scope、是否需要 client_secret
 * 都不一样，所以本模块不硬编码任何服务商，只接受配置参数。
 * `providers.ts` 里为 OpenAI 提供了默认的 authorize/token 地址，但**client_id 必须由用户
 * 自己申请**（`clientIdRequired: true`）——TiBrowser 不内置任何第三方应用的 client_id，
 * 也不会伪造登录成功。
 *
 * 已实现：
 * - `buildAuthorizeUrl()`：生成带 `state` / `code_challenge` 的授权地址；
 * - `startLoopbackFlow()`：监听 127.0.0.1 的随机端口，等待回调、校验 state、换取令牌；
 * - `exchangeCode()` / `refreshToken()`：PKCE 交换与刷新；
 * - `saveTokens()` / `loadTokens()`：令牌写入**加密的** secrets.json（DPAPI 或 weak 回退）。
 *
 * 未实现（诚实声明）：设备码（device_code）流程、JWT 本地验签、多账号令牌轮换。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { secrets } from '../store/secrets.js'
import type { SecretEntry } from '../store/secrets.js'

/** OAuth 配置（全部由调用方提供） */
export interface OAuthConfig {
  /** 授权端点，例如 https://auth.openai.com/authorize */
  authorizeUrl: string
  /** 令牌端点，例如 https://auth.openai.com/oauth/token */
  tokenUrl: string
  /** 客户端 ID（用户自备） */
  clientId: string
  /** 客户端密钥（公共客户端留空，走 PKCE） */
  clientSecret?: string
  /** 申请的 scope */
  scopes: string[]
  /** 额外授权参数（例如 audience、prompt） */
  extraAuthParams?: Record<string, string>
  /** 回环监听端口；0 或未填 = 系统分配 */
  loopbackPort?: number
  /** 回调路径，默认 /oauth/callback */
  callbackPath?: string
}

export interface OAuthTokens {
  accessToken: string
  refreshToken: string
  /** 绝对过期时间（毫秒时间戳）；0 表示服务端未返回 expires_in */
  expiresAt: number
  tokenType: string
  scope: string
  /** 获取时间 */
  obtainedAt: number
}

export interface FlowStart {
  /** 需要用户在浏览器中打开的授权地址 */
  authorizeUrl: string
  /** 回环回调地址（须与 OAuth 应用注册的 redirect_uri 一致） */
  redirectUri: string
  /** 等待回调的 Promise */
  waitForTokens: Promise<OAuthTokens>
  /** 取消等待并关闭监听 */
  cancel: () => void
}

/** PKCE code_verifier（RFC 7636：43-128 字符的 URL 安全随机串） */
export function createCodeVerifier(): string {
  return base64Url(randomBytes(32))
}

/** PKCE code_challenge = BASE64URL(SHA256(verifier)) */
export function createCodeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest())
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 构造授权地址（含 state 与 PKCE 参数） */
export function buildAuthorizeUrl(
  config: OAuthConfig,
  opts: { redirectUri: string; state: string; codeChallenge: string }
): string {
  if (!config.authorizeUrl?.trim()) throw new Error('缺少 OAuth 授权端点（authorizeUrl）。')
  if (!config.clientId?.trim()) {
    throw new Error(
      '缺少 OAuth client_id：该服务商要求用户自行申请应用并填入 client_id，TiBrowser 不内置任何第三方 client_id。'
    )
  }
  const url = new URL(config.authorizeUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', opts.redirectUri)
  url.searchParams.set('state', opts.state)
  url.searchParams.set('code_challenge', opts.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (config.scopes?.length) url.searchParams.set('scope', config.scopes.join(' '))
  for (const [k, v] of Object.entries(config.extraAuthParams ?? {})) {
    url.searchParams.set(k, v)
  }
  return url.toString()
}

interface TokenEndpointResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
  error?: string
  error_description?: string
}

/** 用授权码换取令牌 */
export async function exchangeCode(
  config: OAuthConfig,
  opts: {
    code: string
    codeVerifier: string
    redirectUri: string
    fetchImpl?: typeof fetch
  }
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: config.clientId,
    code_verifier: opts.codeVerifier
  })
  if (config.clientSecret) body.set('client_secret', config.clientSecret)
  return postToken(config, body, opts.fetchImpl)
}

/** 刷新令牌 */
export async function refreshToken(
  config: OAuthConfig,
  tokens: OAuthTokens,
  fetchImpl?: typeof fetch
): Promise<OAuthTokens> {
  if (!tokens.refreshToken) {
    throw new Error('没有 refresh_token，无法刷新。请重新完成一次授权登录。')
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: config.clientId
  })
  if (config.clientSecret) body.set('client_secret', config.clientSecret)
  const next = await postToken(config, body, fetchImpl)
  // 部分服务商刷新时不返回新的 refresh_token，沿用旧的
  if (!next.refreshToken) next.refreshToken = tokens.refreshToken
  return next
}

async function postToken(
  config: OAuthConfig,
  body: URLSearchParams,
  fetchImpl?: typeof fetch
): Promise<OAuthTokens> {
  if (!config.tokenUrl?.trim()) throw new Error('缺少 OAuth 令牌端点（tokenUrl）。')
  const impl = fetchImpl ?? fetch
  const res = await impl(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString()
  })
  const text = await res.text()
  let json: TokenEndpointResponse = {}
  try {
    json = text ? (JSON.parse(text) as TokenEndpointResponse) : {}
  } catch {
    throw new Error(`令牌端点返回了非 JSON 响应（HTTP ${res.status}）：${text.slice(0, 200)}`)
  }
  if (!res.ok || json.error) {
    throw new Error(
      `令牌请求失败（HTTP ${res.status}）：${json.error_description || json.error || text.slice(0, 200)}`
    )
  }
  if (!json.access_token) throw new Error('令牌端点未返回 access_token。')
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? '',
    expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : 0,
    tokenType: json.token_type ?? 'Bearer',
    scope: json.scope ?? (config.scopes ?? []).join(' '),
    obtainedAt: Date.now()
  }
}

/**
 * 启动本地回环流程：监听 127.0.0.1，返回授权地址与「等待令牌」的 Promise。
 * 调用方把 `authorizeUrl` 交给浏览器/系统浏览器打开即可。
 */
export function startLoopbackFlow(
  config: OAuthConfig,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch; openBrowser?: (url: string) => void } = {}
): Promise<FlowStart> {
  return new Promise<FlowStart>((resolveStart, rejectStart) => {
    const state = base64Url(randomBytes(24))
    const codeVerifier = createCodeVerifier()
    const codeChallenge = createCodeChallenge(codeVerifier)
    const callbackPath = config.callbackPath ?? '/oauth/callback'

    const server: Server = createServer()
    let settled = false
    let timer: NodeJS.Timeout | null = null
    /** 实际监听端口（listen 回调里赋值；回调处理时必然已就绪） */
    let port = 0

    const tokensPromise = new Promise<OAuthTokens>((resolveTokens, rejectTokens) => {
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        // 给浏览器一点时间渲染「登录成功」页面再关闭监听
        setTimeout(() => server.close(), 300)
        fn()
      }

      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== callbackPath) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('未知回调路径')
          return
        }
        const err = url.searchParams.get('error')
        const code = url.searchParams.get('code')
        const gotState = url.searchParams.get('state') ?? ''

        const stateOk =
          gotState.length === state.length &&
          safeEqual(Buffer.from(gotState), Buffer.from(state))

        const reply = (status: number, title: string, detail: string): void => {
          res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(
            `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head>` +
              `<body style="font-family:system-ui;padding:40px;background:#111;color:#eee">` +
              `<h2>${title}</h2><p>${detail}</p><p style="color:#888">TiBrowser 授权回调</p></body></html>`
          )
        }

        if (err) {
          reply(400, '授权失败', `服务商返回错误：${escapeHtml(err)}`)
          finish(() => rejectTokens(new Error(`授权被拒绝或失败：${err}`)))
          return
        }
        if (!stateOk) {
          reply(400, '授权校验失败', 'state 参数不匹配，可能是跨站请求伪造，已拒绝。')
          finish(() => rejectTokens(new Error('OAuth state 校验失败：回调参数与本次请求不匹配。')))
          return
        }
        if (!code) {
          reply(400, '授权失败', '回调中没有 code 参数。')
          finish(() => rejectTokens(new Error('OAuth 回调缺少 code 参数。')))
          return
        }

        const redirectUri = `http://127.0.0.1:${port}${callbackPath}`
        exchangeCode(config, { code, codeVerifier, redirectUri, fetchImpl: opts.fetchImpl })
          .then((tokens) => {
            reply(200, '授权成功', '已成功获取访问令牌，可以关闭此页面并返回 TiBrowser。')
            finish(() => resolveTokens(tokens))
          })
          .catch((e: unknown) => {
            reply(500, '令牌交换失败', escapeHtml(e instanceof Error ? e.message : String(e)))
            finish(() => rejectTokens(e instanceof Error ? e : new Error(String(e))))
          })
      })

      server.on('error', (e) => {
        finish(() => rejectStart(e))
      })

      // 先监听拿到真实端口，再构造 redirect_uri（port 0 = 系统分配）
      server.listen(config.loopbackPort ?? 0, '127.0.0.1', () => {
        const addr = server.address()
        port = typeof addr === 'object' && addr ? addr.port : 0
        const redirectUri = `http://127.0.0.1:${port}${callbackPath}`
        let authorizeUrl: string
        try {
          authorizeUrl = buildAuthorizeUrl(config, { redirectUri, state, codeChallenge })
        } catch (e) {
          finish(() => rejectStart(e))
          return
        }
        const timeoutMs = opts.timeoutMs ?? 300_000
        timer = setTimeout(() => {
          finish(() =>
            rejectTokens(
              new Error(`等待 OAuth 回调超时（${Math.round(timeoutMs / 1000)} 秒），请重新发起登录。`)
            )
          )
        }, timeoutMs)
        timer.unref?.()

        opts.openBrowser?.(authorizeUrl)
        resolveStart({
          authorizeUrl,
          redirectUri,
          waitForTokens: tokensPromise,
          cancel: () => {
            finish(() => rejectTokens(new Error('用户取消了 OAuth 登录。')))
          }
        })
      })
    })
  })
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
  )
}

// ---------- 令牌持久化（写入加密的 secrets.json） ----------

/** 密钥名：oauth:<providerId> */
export function tokenSecretName(providerId: string): string {
  return `oauth:${providerId}`
}

/** 保存令牌（加密存储，绝不落盘明文） */
export async function saveTokens(
  providerId: string,
  tokens: OAuthTokens
): Promise<{ insecure: boolean; note: string }> {
  const entry = await secrets.set(tokenSecretName(providerId), JSON.stringify(tokens))
  return {
    insecure: entry.insecure,
    note: entry.insecure
      ? '令牌已保存，但当前使用 base64 弱混淆存储（不安全）。'
      : '令牌已使用 Windows DPAPI 加密保存。'
  }
}

/** 载入令牌；不存在或损坏返回 null */
export async function loadTokens(providerId: string): Promise<OAuthTokens | null> {
  const raw = await secrets.get(tokenSecretName(providerId))
  if (!raw) return null
  try {
    const t = JSON.parse(raw) as OAuthTokens
    if (!t?.accessToken) return null
    return t
  } catch {
    return null
  }
}

/** 删除令牌 */
export function clearTokens(providerId: string): void {
  secrets.delete(tokenSecretName(providerId))
}

/** 令牌是否已过期（提前 60 秒视为过期） */
export function isExpired(tokens: OAuthTokens, skewMs = 60_000): boolean {
  if (!tokens.expiresAt) return false
  return Date.now() + skewMs >= tokens.expiresAt
}

/** 取一个可用令牌，必要时自动刷新并回写 */
export async function ensureFreshTokens(
  providerId: string,
  config: OAuthConfig,
  fetchImpl?: typeof fetch
): Promise<OAuthTokens | null> {
  const current = await loadTokens(providerId)
  if (!current) return null
  if (!isExpired(current)) return current
  const next = await refreshToken(config, current, fetchImpl)
  await saveTokens(providerId, next)
  return next
}

/** 生成一个临时的令牌条目（自检用，不落盘） */
export function fakeTokenEntry(accessToken: string): SecretEntry {
  return { mode: 'weak', value: Buffer.from(accessToken, 'utf-8').toString('base64'), insecure: true }
}
