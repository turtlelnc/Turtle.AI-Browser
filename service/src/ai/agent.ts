/**
 * AI 智能体工具调用循环（移植自 `src/main/ai/agent.ts`，最多 8 轮）。
 *
 * 关键差异：
 * - 工具**执行**改为通过注入的 `ToolExecutor` 回调原生浏览器（见 `./executor.ts`）；
 * - 返回值从 `void` 改为结构化 `AgentResult`（自检需要断言实际调用）；
 * - 增加并发保护：同一工具的重复调用会被拒绝并回告模型，避免模型死循环刷同一个动作；
 * - 保留 v0.1.0 的权限语义：`off` 档位不提供任何工具，档位不足的工具调用被拒绝
 *   并以中文错误回填给模型（而不是抛异常中断整轮对话）。
 */

import type { AgentMessage, AiProviderConfig, CliPermissionLevel } from '../shared/types.js'
import { chatCompletion, type CompletionOptions, type ToolCall } from './client.js'
import { canRunTool, getTool, getToolsForLevel, toolSchemas, type ToolContext, type ToolLevel } from './tools.js'

/** 智能体循环的最大轮数（与 v0.1.0 一致） */
export const MAX_AGENT_ROUNDS = 8

export interface AgentHandlers {
  /** 模型产生的文本内容（每轮一次） */
  onContent?: (text: string) => void
  /** 工具开始执行 */
  onTool?: (name: string, detail: string, phase: 'start') => void
  /** 工具执行结束 */
  onToolDone?: (name: string, detail: string, phase: 'done' | 'error') => void
  /** 循环意外失败（网络/服务端错误） */
  onError?: (message: string) => void
}

/** 一次工具调用记录（自检与审计用） */
export interface AgentToolLog {
  round: number
  name: string
  args: unknown
  /** 是否被权限或并发规则拒绝 */
  denied: boolean
  /** 拒绝原因或错误消息（中文） */
  error: string
  /** 结果摘要（截断后） */
  resultPreview: string
  durationMs: number
}

export interface AgentResult {
  /** 是否正常结束（未因错误中断） */
  ok: boolean
  /** 实际执行的轮数 */
  rounds: number
  /** 模型最终文本（所有轮内容的拼接） */
  content: string
  /** 工具调用日志 */
  toolLogs: AgentToolLog[]
  /** 失败原因（中文），ok=true 时为空串 */
  error: string
}

export interface RunAgentOptions {
  config: AiProviderConfig
  level: CliPermissionLevel
  history: AgentMessage[]
  userMessage: string
  ctx: ToolContext
  signal: AbortSignal
  handlers?: AgentHandlers
  /** 覆盖最大轮数（默认 8，自检可调小） */
  maxRounds?: number
  /** 覆盖工具 schema（本地办公/开发模式注入额外的模式工具） */
  extraTools?: Array<{
    name: string
    description: string
    parameters: Record<string, unknown>
    minLevel: ToolLevel
    run: (args: Record<string, unknown>) => unknown | Promise<unknown>
  }>
  /** 传给 client 的额外选项（注入 fetch 供自检使用） */
  clientOptions?: CompletionOptions
}

function buildSystemPrompt(level: CliPermissionLevel, extra?: string): string {
  const base =
    '你是 TiBrowser 浏览器内置的 AI 智能体，请用中文帮助用户操作浏览器。' +
    '你可以调用提供的工具来完成用户请求，例如控制网页、帮用户设置、抓包、读写页面内容等。'
  const suffix =
    level === 'off'
      ? '\n当前未开启控制权限，你只能进行普通对话，不要调用任何工具。'
      : '\n按需调用工具；执行有风险的操作前先向用户说明。' +
        '\n注意：浏览器的实际动作由原生进程执行，如果工具返回「未连接到浏览器自动化端点」等错误，请如实告知用户，不要编造执行结果。'
  return `${base}${suffix}${extra ? '\n' + extra : ''}`
}

/** 把工具结果裁剪成可控长度的字符串（避免上下文爆炸） */
function stringifyResult(value: unknown, maxChars = 6000): string {
  let text: string
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  if (text === undefined) text = 'null'
  return text.length > maxChars ? `${text.slice(0, maxChars)}…（结果已截断）` : text
}

/**
 * 运行一次智能体工具调用循环。
 * 不会抛出网络错误——错误通过 `result.error` 与 `handlers.onError` 返回。
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const { config, level, history, userMessage, ctx, signal } = options
  const handlers = options.handlers ?? {}
  const maxRounds = Math.max(1, Math.min(options.maxRounds ?? MAX_AGENT_ROUNDS, 32))

  const messages: AgentMessage[] = [
    { role: 'system', content: buildSystemPrompt(level, ctx.workspace ? WORKSPACE_HINT : undefined) },
    ...history,
    { role: 'user', content: userMessage }
  ]

  const tools = level === 'off' ? [] : getToolsForLevel(level)
  const schemas = level === 'off' ? [] : toolSchemas(level)
  for (const extra of options.extraTools ?? []) {
    if (!canRunTool(extra.minLevel, level)) continue
    schemas.push({
      type: 'function',
      function: {
        name: extra.name,
        description: extra.description,
        parameters: extra.parameters
      }
    })
  }

  const toolLogs: AgentToolLog[] = []
  let content = ''
  let rounds = 0
  let error = ''
  /** 同一轮内已执行过的工具名 → 次数，用于阻断模型重复调用 */
  const perRoundCount = new Map<string, number>()

  for (let i = 0; i < maxRounds; i++) {
    if (signal.aborted) return { ok: true, rounds, content, toolLogs, error: '' }
    rounds++

    let result
    try {
      result = await chatCompletion(config, messages, {
        tools: schemas,
        signal,
        ...(options.clientOptions ?? {})
      })
    } catch (e) {
      if (signal.aborted) return { ok: true, rounds, content, toolLogs, error: '' }
      error = e instanceof Error ? e.message : String(e)
      handlers.onError?.(error)
      return { ok: false, rounds, content, toolLogs, error }
    }

    if (signal.aborted) return { ok: true, rounds, content, toolLogs, error: '' }
    if (result.content) {
      content += result.content
      handlers.onContent?.(result.content)
    }
    if (!result.toolCalls.length) {
      return { ok: true, rounds, content, toolLogs, error: '' }
    }

    messages.push({
      role: 'assistant',
      content: result.content || null,
      tool_calls: result.toolCalls
    })

    perRoundCount.clear()
    for (const tc of result.toolCalls) {
      if (signal.aborted) return { ok: true, rounds, content, toolLogs, error: '' }
      await handleToolCall(tc, { ctx, level, tools, extraTools: options.extraTools ?? [] }, messages, toolLogs, handlers, i + 1, perRoundCount)
    }
  }

  // 达到轮数上限：如实告知（不假装已完成）
  const note = `\n\n（已达到工具调用轮数上限 ${maxRounds} 轮，任务可能尚未完成。请缩小任务范围或分步执行。）`
  content += note
  handlers.onContent?.(note)
  return { ok: true, rounds, content, toolLogs, error: '' }
}

interface ToolCallEnv {
  ctx: ToolContext
  level: CliPermissionLevel
  tools: ReturnType<typeof getToolsForLevel>
  extraTools: NonNullable<RunAgentOptions['extraTools']>
}

async function handleToolCall(
  tc: ToolCall,
  env: ToolCallEnv,
  messages: AgentMessage[],
  toolLogs: AgentToolLog[],
  handlers: AgentHandlers,
  round: number,
  perRoundCount: Map<string, number>
): Promise<void> {
  const name = tc.function.name
  let args: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(tc.function.arguments || '{}') as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>
    }
  } catch {
    args = {}
  }
  const detail = safeJson(args)
  const started = Date.now()

  const deny = (reason: string): void => {
    messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: reason }) })
    toolLogs.push({
      round,
      name,
      args,
      denied: true,
      error: reason,
      resultPreview: '',
      durationMs: Date.now() - started
    })
    handlers.onToolDone?.(name, reason, 'error')
  }

  // 重复调用保护：同一轮内同名工具最多调用 2 次
  const count = (perRoundCount.get(name) ?? 0) + 1
  perRoundCount.set(name, count)
  if (count > 2) {
    deny(`工具「${name}」在本轮已被调用 ${count - 1} 次，为避免死循环已拒绝重复调用。请换用其他方式或直接回答用户。`)
    return
  }

  const builtin = getTool(name) ?? env.tools.find((t) => t.name === name)
  const extra = env.extraTools.find((t) => t.name === name)

  if (!builtin && !extra) {
    deny(`未知工具「${name}」。`)
    return
  }
  const minLevel = (builtin?.minLevel ?? extra?.minLevel ?? 'daily') as ToolLevel
  if (!canRunTool(minLevel, env.level)) {
    deny(
      `当前权限档位为「${levelLabel(env.level)}」，不足以执行工具「${name}」（需要「${levelLabel(minLevel)}」及以上）。请提示用户在设置中提高智能体权限档位。`
    )
    return
  }

  handlers.onTool?.(name, detail, 'start')
  let output: unknown
  let failed = false
  try {
    if (builtin) {
      // 内置工具：本地层直接执行，浏览器层经 ToolExecutor 回调原生
      output = await builtin.execute(env.ctx, args)
    } else if (extra) {
      output = await extra.run(args)
    }
  } catch (e) {
    failed = true
    output = { error: e instanceof Error ? e.message : String(e) }
  }

  const text = stringifyResult(output)
  messages.push({ role: 'tool', tool_call_id: tc.id, content: text })
  toolLogs.push({
    round,
    name,
    args,
    denied: false,
    error: failed ? text : '',
    resultPreview: text.slice(0, 400),
    durationMs: Date.now() - started
  })
  handlers.onToolDone?.(name, text.slice(0, 300), failed ? 'error' : 'done')
}

const WORKSPACE_HINT =
  '用户已授权本地工作区目录，你可以用 list_workspace_files / read_workspace_file / write_workspace_file 读写其中的文件，用 run_command 执行白名单内的命令。'

function levelLabel(level: string): string {
  return (
    { off: '关闭', daily: '日常', developer: '开发', full: '全部' }[level] ?? String(level)
  )
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v)
    return s.length > 300 ? `${s.slice(0, 300)}…` : (s ?? '{}')
  } catch {
    return '{}'
  }
}
