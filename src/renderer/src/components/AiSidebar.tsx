/**
 * AI 侧边栏。
 *
 * v1.0.0-rc1 变化：
 *  - 对话与智能体统一走 `tib.aiChat()` / `tib.aiAgent()`，流式增量走 `aiChunk` / `aiDone` / `aiError`；
 *  - 工具调用状态改为三段式（开始 / 成功 / 失败），因此消息里会显示工具结果而不只是调用；
 *  - 未配置模型时明确提示前往「设置 → AI 模型连接」，而不是让用户猜。
 */
import { useEffect, useRef, useState } from 'react'
import type { AiContext, AiMessage, CliPermissionLevel } from '@shared/bridge'
import { on, tib } from '../bridge'
import { Close, Gear, Send, Sparkles, Stop } from './icons'

interface Msg {
  id: string
  role: 'user' | 'assistant' | 'error' | 'tool'
  content: string
  tone?: 'ok' | 'err'
}

/** 智能体控制权限档位（与设置 → AI 模型连接 中的 cliPermission 同一份取值） */
const CLI_PERMISSION_LEVELS: { value: CliPermissionLevel; label: string; hint: string }[] = [
  { value: 'off', label: '关闭', hint: '仅基础对话，AI 不能控制浏览器' },
  { value: 'daily', label: '日常', hint: '可控制网页、帮你设置等安全操作' },
  { value: 'developer', label: '开发', hint: '额外增加抓包、执行 JS、读源码等开发功能' },
  { value: 'full', label: '全部', hint: '完全控制浏览器，含清空数据等危险操作，请谨慎开启' }
]

function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

/** 快捷功能（办公 / 开发 / 学习 / 娱乐） */
const QUICK_ACTIONS: {
  key: string
  label: string
  build: (ctx: Partial<AiContext>) => { label: string; prompt: string }
}[] = [
  {
    key: 'summarize',
    label: '📝 总结',
    build: (c) => ({
      label: '总结当前页面',
      prompt: `请用中文对以下网页内容进行要点总结（项目符号、简洁清晰）：\n\n【标题】${c.title ?? ''}\n【正文】\n${c.text ?? ''}`
    })
  },
  {
    key: 'translate',
    label: '🌐 翻译',
    build: (c) => ({
      label: '翻译当前页面',
      prompt: `请把以下网页内容翻译成中文（保留要点与结构）：\n\n【标题】${c.title ?? ''}\n【正文】\n${c.text ?? ''}`
    })
  },
  {
    key: 'polish',
    label: '✨ 润色',
    build: (c) => ({
      label: '润色选中文字',
      prompt: `请润色以下文字，使其更流畅、专业：\n\n${c.selectedText || '（未选中文字，请先在页面上选中要润色的内容）'}`
    })
  },
  {
    key: 'explain',
    label: '💻 解释代码',
    build: (c) => ({
      label: '解释选中代码',
      prompt: `请解释以下代码的功能与逻辑（中文）：\n\n${c.selectedText || '（未选中文字，请先在页面上选中要解释的代码）'}`
    })
  },
  {
    key: 'notes',
    label: '🎓 笔记',
    build: (c) => ({
      label: '生成学习笔记',
      prompt: `请根据以下网页内容生成一份结构化学习笔记（要点、知识点、小结）：\n\n【标题】${c.title ?? ''}\n【正文】\n${c.text ?? ''}`
    })
  },
  {
    key: 'email',
    label: '✉️ 写邮件',
    build: (c) => ({
      label: '根据选中内容写邮件',
      prompt: `请根据以下内容起草一封得体的邮件：\n\n${c.selectedText || c.text || ''}`
    })
  }
]

export function AiSidebar(): JSX.Element {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [hasKey, setHasKey] = useState(true)
  const [permission, setPermission] = useState<CliPermissionLevel>('daily')
  const reqIdRef = useRef('')
  const streamingMsgRef = useRef('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    tib
      .getAiConnection()
      .then((c) => setHasKey(Boolean(c.apiKeyMask) || c.method !== 'apiKey'))
      .catch(() => setHasKey(true))
    tib
      .getSettings()
      .then((s) => setPermission(s.cliPermission))
      .catch(() => undefined)

    const offs = [
      on('aiChunk', (c) => {
        if (c.requestId !== reqIdRef.current) return
        if (!streamingMsgRef.current) {
          const id = uid()
          streamingMsgRef.current = id
          setMessages((ms) => [...ms, { id, role: 'assistant', content: c.delta }])
        } else {
          const id = streamingMsgRef.current
          setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, content: m.content + c.delta } : m)))
        }
      }),
      on('aiTool', (t) => {
        if (t.requestId !== reqIdRef.current) return
        streamingMsgRef.current = ''
        setMessages((ms) => [
          ...ms,
          {
            id: uid(),
            role: 'tool',
            tone: t.phase === 'error' ? 'err' : t.phase === 'ok' ? 'ok' : undefined,
            content: `${t.phase === 'start' ? '调用' : t.phase === 'ok' ? '完成' : '失败'} · ${t.name} ${t.detail}`
          }
        ])
      }),
      on('aiDone', (d) => {
        if (d.requestId !== reqIdRef.current) return
        setStreaming(false)
        streamingMsgRef.current = ''
      }),
      on('aiError', (e) => {
        if (e.requestId !== reqIdRef.current) return
        const sid = streamingMsgRef.current
        setMessages((ms) => {
          const next = sid ? ms.filter((m) => !(m.id === sid && m.content === '')) : ms
          return [...next, { id: uid(), role: 'error', content: e.message }]
        })
        setStreaming(false)
        streamingMsgRef.current = ''
      })
    ]
    return () => offs.forEach((off) => off())
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  async function changePermission(level: CliPermissionLevel): Promise<void> {
    setPermission(level)
    try {
      await tib.setSettings({ cliPermission: level })
    } catch (err) {
      console.warn('[TiBrowser] 保存控制权限失败：', err)
    }
  }

  function toAiMessages(): AiMessage[] {
    return messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  }

  function sendChat(requestId: string, payload: AiMessage[]): void {
    reqIdRef.current = requestId
    streamingMsgRef.current = ''
    setStreaming(true)
    const call = permission === 'off' ? tib.aiChat({ requestId, messages: payload }) : tib.aiAgent({ requestId, messages: payload, permission })
    void call.catch((err: unknown) => {
      setStreaming(false)
      setMessages((ms) => [...ms, { id: uid(), role: 'error', content: `请求失败：${String(err)}` }])
    })
  }

  function send(): void {
    const text = input.trim()
    if (!text || streaming) return
    const payload: AiMessage[] = [...toAiMessages(), { role: 'user', content: text }]
    setMessages((ms) => [...ms, { id: uid(), role: 'user', content: text }])
    setInput('')
    sendChat(uid(), payload)
  }

  async function quickAction(action: (typeof QUICK_ACTIONS)[number]): Promise<void> {
    if (streaming) return
    let ctx: AiContext | null = null
    try {
      ctx = await tib.aiContext()
    } catch {
      ctx = null
    }
    const { label, prompt } = action.build(ctx ?? {})
    const payload: AiMessage[] = [...toAiMessages(), { role: 'user', content: prompt }]
    setMessages((ms) => [...ms, { id: uid(), role: 'user', content: label }])
    sendChat(uid(), payload)
  }

  function stopStreaming(): void {
    if (reqIdRef.current) void tib.aiAbort(reqIdRef.current)
    setStreaming(false)
    streamingMsgRef.current = ''
  }

  const permHint = CLI_PERMISSION_LEVELS.find((l) => l.value === permission)?.hint ?? ''

  return (
    <div className="ai-sidebar chrome">
      <div className="ai-header">
        <span className="ai-badge">
          <Sparkles size={15} />
        </span>
        <span>TiBrowser AI</span>
        <span className="spacer" />
        <span
          className="nav-btn"
          style={{ width: 28, height: 28 }}
          title="AI 设置"
          onClick={() => void tib.setOverlay('settings')}
        >
          <Gear size={16} />
        </span>
        <span className="nav-btn" style={{ width: 28, height: 28 }} title="收起侧边栏" onClick={() => void tib.toggleSidebar(false)}>
          <Close size={16} />
        </span>
      </div>

      <div className="ai-perm">
        <span className="ai-perm-label">控制权限</span>
        <select value={permission} onChange={(e) => void changePermission(e.target.value as CliPermissionLevel)}>
          {CLI_PERMISSION_LEVELS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
        <span className="ai-perm-hint">{permHint}</span>
      </div>

      <div className="ai-actions">
        {QUICK_ACTIONS.map((a) => (
          <button key={a.key} className="ai-quick" onClick={() => void quickAction(a)} disabled={streaming}>
            {a.label}
          </button>
        ))}
      </div>

      <div className="ai-messages" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="ai-empty">
            <Sparkles size={28} style={{ color: 'var(--tb-accent-ai)', marginBottom: 8 }} />
            <div>我是 TiBrowser 内置的 AI 助手。</div>
            <div>可以聊天，也可以按上方快捷功能处理网页内容。</div>
            <div>调整「控制权限」后，我还能帮你控制浏览器。</div>
          </div>
        ) : null}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role} ${m.tone === 'err' ? 'error' : ''}`}>
            {m.role === 'tool' ? `🔧 ${m.content}` : m.content || (m.role === 'assistant' && streaming ? '…' : '')}
          </div>
        ))}
      </div>

      {!hasKey ? (
        <div className="ai-warn">
          尚未配置模型连接，点击右上角齿轮前往「设置 → AI 模型连接」填写 API Key、MCP 服务器或完成 OAuth 授权。
        </div>
      ) : null}

      <div className="ai-input">
        <textarea
          rows={1}
          value={input}
          placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        {streaming ? (
          <span className="send-btn" onClick={stopStreaming} title="停止生成">
            <Stop size={16} />
          </span>
        ) : (
          <span
            className="send-btn"
            onClick={send}
            style={input.trim() ? undefined : { opacity: 0.4 }}
            title="发送（Enter）"
          >
            <Send size={16} />
          </span>
        )}
      </div>
    </div>
  )
}
