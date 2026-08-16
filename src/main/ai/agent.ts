import type { AgentMessage, AiProviderConfig, CliPermissionLevel } from '@shared/types'
import { chatCompletion } from './client'
import { canRunTool, getToolsForLevel, type ToolContext } from './tools'

export interface AgentHandlers {
  onContent: (text: string) => void
  onTool: (name: string, detail: string) => void
}

function buildSystemPrompt(level: CliPermissionLevel): string {
  const base =
    '你是 TIbrowser 浏览器内置的 AI 智能体，请用中文帮助用户操作浏览器。' +
    '你可以调用提供的工具来完成用户请求，例如控制网页、帮用户设置、抓包、读写页面内容等。'
  if (level === 'off') {
    return base + '\n当前未开启控制权限，你只能进行普通对话，不要调用任何工具。'
  }
  return base + '\n按需调用工具；执行有风险的操作前先向用户说明。'
}

/** 运行一次智能体工具调用循环（最多 8 轮） */
export async function runAgent(
  config: AiProviderConfig,
  level: CliPermissionLevel,
  history: AgentMessage[],
  userMessage: string,
  ctx: ToolContext,
  handlers: AgentHandlers,
  signal: AbortSignal
): Promise<void> {
  const messages: AgentMessage[] = [
    { role: 'system', content: buildSystemPrompt(level) },
    ...history,
    { role: 'user', content: userMessage }
  ]
  const tools = level === 'off' ? [] : getToolsForLevel(level)
  const toolSchemas = tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))

  for (let i = 0; i < 8; i++) {
    if (signal.aborted) return
    const result = await chatCompletion(config, messages, toolSchemas)
    if (signal.aborted) return
    if (result.content) handlers.onContent(result.content)
    if (!result.toolCalls.length) break

    messages.push({
      role: 'assistant',
      content: result.content || null,
      tool_calls: result.toolCalls
    })

    for (const tc of result.toolCalls) {
      if (signal.aborted) return
      let args: Record<string, unknown>
      try {
        args = JSON.parse(tc.function.arguments || '{}')
      } catch {
        args = {}
      }
      const tool = tools.find((t) => t.name === tc.function.name)
      if (!tool) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: '未知工具' })
        })
        continue
      }
      if (!canRunTool(tool.minLevel, level)) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: '当前权限不足，无法执行此操作' })
        })
        continue
      }
      handlers.onTool(tool.name, JSON.stringify(args))
      let output: unknown
      try {
        output = await tool.run(ctx, args)
      } catch (e) {
        output = { error: String(e) }
      }
      const text = typeof output === 'string' ? output : JSON.stringify(output)
      messages.push({ role: 'tool', tool_call_id: tc.id, content: text })
    }
  }
}
