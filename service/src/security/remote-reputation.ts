/**
 * 可选的自建 URL 信誉端点（增强型防护使用）。
 *
 * **诚实说明**：本节不接入、也无法接入 Google Safe Browsing / 微软 SmartScreen
 * ——那需要官方 API Key、账号与联网回传（见 `./protection.ts` 的 capability 矩阵）。
 * 这里只做「用户自己配置了一个信誉服务」时的最小化查询通道。
 *
 * 隐私设计（尽量少发数据）：
 * - 只发送域名与「路径 + 查询串」的 SHA-256 前 16 字节十六进制（`urlHash`）；
 * - **不发送完整 URL、不发送页面内容、不发送本机信息**；
 * - 未配置端点时直接返回 `{checked:false}`，不发任何请求。
 *
 * 端点的请求 / 响应契约（用户自建服务需按此实现）：
 * ```
 * POST <reputationEndpoint>
 * Content-Type: application/json
 * { "host": "example.com", "urlHash": "3f2a...", "kind": "url" }
 * 200 OK
 * { "verdict": "safe" | "suspicious" | "malicious", "reason": "中文原因" }
 * ```
 */

import { createHash } from 'node:crypto'

export type ReputationVerdict = 'safe' | 'suspicious' | 'malicious'

export interface ReputationResult {
  /** 是否真的发起了查询 */
  checked: boolean
  verdict: ReputationVerdict | null
  /** 中文原因 */
  reason: string
  /** 查询耗时（毫秒） */
  elapsedMs: number
}

const NOT_CHECKED = (reason: string): ReputationResult => ({
  checked: false,
  verdict: null,
  reason,
  elapsedMs: 0
})

/** 计算用于上报的哈希（域名单列，路径与查询串合并哈希） */
export function reputationHashes(rawUrl: string): { host: string; urlHash: string } | null {
  try {
    const u = new URL(rawUrl)
    const host = u.hostname.toLowerCase()
    const rest = `${u.pathname}${u.search}`
    return { host, urlHash: createHash('sha256').update(rest).digest('hex').slice(0, 32) }
  } catch {
    return null
  }
}

export interface ReputationOptions {
  /** 端点为空表示未配置 */
  endpoint: string
  /** 超时，默认 3000ms（宁可放弃查询也不能拖慢页面加载） */
  timeoutMs?: number
  /** 允许注入 fetch 便于测试 */
  fetchImpl?: typeof fetch
  /** 注入 Authorization 头（可选，自建服务常用静态 token） */
  authToken?: string
}

/** 查询自建信誉端点 */
export async function checkReputation(
  rawUrl: string,
  opts: ReputationOptions
): Promise<ReputationResult> {
  const endpoint = (opts.endpoint ?? '').trim()
  if (!endpoint) {
    return NOT_CHECKED(
      '未配置 reputationEndpoint，已跳过信誉查询（云端威胁库需要 Google/微软服务，本地不可用）。'
    )
  }
  if (!/^https?:\/\//i.test(endpoint)) {
    return NOT_CHECKED('reputationEndpoint 不是合法的 http(s) 地址，已跳过查询。')
  }
  const hashes = reputationHashes(rawUrl)
  if (!hashes) return NOT_CHECKED('网址无法解析，已跳过信誉查询。')

  const fetchImpl = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 3000)
  const started = Date.now()
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.authToken ? { Authorization: `Bearer ${opts.authToken}` } : {})
      },
      body: JSON.stringify({ ...hashes, kind: 'url' }),
      signal: controller.signal
    })
    const elapsedMs = Date.now() - started
    if (!res.ok) {
      return {
        checked: true,
        verdict: null,
        reason: `信誉端点返回 HTTP ${res.status}，无法判定（按未命中处理）。`,
        elapsedMs
      }
    }
    const json = (await res.json()) as { verdict?: string; reason?: string }
    const v = json.verdict
    if (v !== 'safe' && v !== 'suspicious' && v !== 'malicious') {
      return {
        checked: true,
        verdict: null,
        reason: '信誉端点返回了无法识别的结论，按未命中处理。',
        elapsedMs
      }
    }
    return {
      checked: true,
      verdict: v,
      reason: json.reason?.trim() || `信誉端点判定为 ${v}`,
      elapsedMs
    }
  } catch (e) {
    return {
      checked: true,
      verdict: null,
      reason: `信誉查询失败（${e instanceof Error ? e.message : String(e)}），按未命中处理。`,
      elapsedMs: Date.now() - started
    }
  } finally {
    clearTimeout(timer)
  }
}
