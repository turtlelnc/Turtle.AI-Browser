/**
 * 本地自动化 HTTP API（特性 15）。
 *
 * `POST /automation/<action>`，鉴权与 RPC 完全相同（`Authorization: Bearer <token>`），
 * 动作表见 `./actions.ts`。边车**只转发**：真正的执行在原生浏览器的自动化端点，
 * 因此需要用户在设置里提供原生端点地址（`browserAutomation.baseUrl`）。
 *
 * 未启用自动化 / 未配置原生端点时，一律返回明确的中文错误——绝不返回假成功。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJson, writeJsonAtomic } from '../store/json-store.js'
import { userDataFile } from '../paths.js'
import type { ToolExecutor } from '../ai/executor.js'
import { ExecutorError } from '../ai/executor.js'
import { ACTION_MAP, AUTOMATION_ACTIONS, type ActionDef } from './actions.js'

/** 原生浏览器自动化端点的配置（持久化到 <userData>/native-bridge.json） */
export interface NativeBridgeConfig {
  /** 原生自动化端点基址，例如 http://127.0.0.1:45123 */
  baseUrl: string
  /** 原生端点的 Bearer token（若原生侧要求） */
  token: string
}

/** 自动化 API 依赖 */
export interface AutomationDeps {
  /** 是否启用（settings.automation.enabled，默认 false） */
  isEnabled: () => boolean
  /** 转发到原生的执行器 */
  executor: ToolExecutor
  /** 读取原生端点配置 */
  getBridgeConfig: () => NativeBridgeConfig
  /** 版本信息（写入 automation.json） */
  version: string
  log?: (message: string) => void
  /** 事件广播（WS 通道使用） */
  broadcast?: (event: string, payload: unknown) => void
}

const BRIDGE_CONFIG_FILE = 'native-bridge.json'

/** 读写原生端点配置 */
export const nativeBridge = {
  read(): NativeBridgeConfig {
    const raw = readJson<Partial<NativeBridgeConfig>>(userDataFile(BRIDGE_CONFIG_FILE), {})
    return {
      baseUrl: (raw.baseUrl ?? '').trim(),
      token: (raw.token ?? '').trim()
    }
  },
  write(config: Partial<NativeBridgeConfig>): NativeBridgeConfig {
    const next: NativeBridgeConfig = { ...nativeBridge.read(), ...config }
    writeJsonAtomic(userDataFile(BRIDGE_CONFIG_FILE), next)
    return next
  }
}

export interface AutomationResponse {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
  /** 实际执行的协议动作名（便于排查） */
  action?: string
}

/** 执行一个自动化动作 */
export async function runAction(
  actionName: string,
  params: Record<string, unknown>,
  deps: AutomationDeps,
  source: 'external' | 'agent' = 'external'
): Promise<AutomationResponse> {
  const def: ActionDef | undefined = ACTION_MAP.get(actionName)
  if (!def) {
    return {
      ok: false,
      error: {
        code: 'unknown-action',
        message: `未知的自动化动作「${actionName}」。可用动作：${AUTOMATION_ACTIONS.map((a) => a.name).join('、')}`
      }
    }
  }
  if (!deps.isEnabled()) {
    return {
      ok: false,
      action: def.name,
      error: {
        code: 'automation-disabled',
        message:
          '本地自动化 API 当前处于关闭状态（默认关闭）。请在设置中开启 automation.enabled 后重试。'
      }
    }
  }

  // 必填参数校验（在边车侧先拦一道，减少无谓往返）
  const missing = def.required.filter(
    (k) => params[k] === undefined || params[k] === null || params[k] === ''
  )
  if (missing.length) {
    return {
      ok: false,
      action: def.name,
      error: {
        code: 'missing-param',
        message: `动作「${actionName}」缺少必填参数：${missing.join('、')}。`
      }
    }
  }

  try {
    // 统一走协议动作通道：外部调用与 AI 智能体走同一套原生接口，但来源标记不同
    const result = await deps.executor.action(def.name, params, source)
    return { ok: true, result: result ?? null, action: def.name }
  } catch (e) {
    if (e instanceof ExecutorError) {
      const code = e.code
      return { ok: false, action: def.name, error: { code, message: e.message } }
    }
    return {
      ok: false,
      action: def.name,
      error: {
        code: 'action-failed',
        message: `执行动作「${actionName}」失败：${e instanceof Error ? e.message : String(e)}`
      }
    }
  }
}

/**
 * 处理 `/automation/*` 请求。
 * 返回 true 表示已处理（调用方不需要再走 404）。
 */
export async function handleAutomationRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: AutomationDeps,
  readBody: (req: IncomingMessage, limit?: number) => Promise<string>
): Promise<boolean> {
  if (!url.pathname.startsWith('/automation')) return false

  const send = (status: number, body: unknown): void => {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'X-Content-Type-Options': 'nosniff'
    })
    res.end(text)
  }

  const method = (req.method ?? 'GET').toUpperCase()

  // 动作清单（便于用户自己的工具做能力发现）
  if (url.pathname === '/automation' || url.pathname === '/automation/') {
    send(200, {
      ok: true,
      enabled: deps.isEnabled(),
      actions: AUTOMATION_ACTIONS.map((a) => ({
        name: a.name,
        group: a.group,
        summary: a.summary,
        params: a.params,
        required: a.required,
        risky: Boolean(a.risky)
      }))
    })
    return true
  }

  if (method !== 'POST') {
    send(405, { ok: false, error: { code: 'method-not-allowed', message: '自动化端点只接受 POST 请求。' } })
    return true
  }

  const actionName = decodeURIComponent(url.pathname.slice('/automation/'.length))
  let params: Record<string, unknown> = {}
  try {
    const body = await readBody(req, 4 * 1024 * 1024)
    if (body.trim()) {
      const parsed = JSON.parse(body) as { params?: unknown } & Record<string, unknown>
      if (parsed && typeof parsed === 'object') {
        params =
          parsed.params && typeof parsed.params === 'object'
            ? (parsed.params as Record<string, unknown>)
            : (parsed as Record<string, unknown>)
      }
    }
  } catch (e) {
    send(400, {
      ok: false,
      error: { code: 'bad-json', message: `请求体不是合法 JSON：${e instanceof Error ? e.message : ''}` }
    })
    return true
  }

  const result = await runAction(actionName, params, deps)
  deps.log?.(`[automation] ${actionName} → ${result.ok ? 'ok' : result.error?.code}`)
  send(result.ok ? 200 : result.error?.code === 'unknown-action' ? 404 : 400, result)
  return true
}
