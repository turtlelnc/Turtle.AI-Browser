import { useEffect, useRef, useState } from 'react'
import { CLI_PERMISSION_LEVELS } from '@shared/constants'
import type { CliPermissionLevel, Settings } from '@shared/types'
import { Close, Gear, Send, Sparkles, Stop } from './icons'

interface Msg {
  id: string
  role: 'user' | 'assistant' | 'error' | 'tool'
  content: string
}

function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

/** 快捷功能（办公/开发/学习/娱乐） */
const QUICK_ACTIONS: { key: string; label: string; build: (ctx: any) => { label: string; prompt: string } }[] = [
  { key: 'summarize', label: '📝 总结', build: (c) => ({ label: '总结当前页面', prompt: `请用中文对以下网页内容进行要点总结（项目符号、简洁清晰）：\n\n【标题】${c.title}\n【正文】\n${c.text}` }) },
  { key: 'translate', label: '🌐 翻译', build: (c) => ({ label: '翻译当前页面', prompt: `请把以下网页内容翻译成中文（保留要点与结构）：\n\n【标题】${c.title}\n【正文】\n${c.text}` }) },
  { key: 'polish', label: '✨ 润色', build: (c) => ({ label: '润色选中文字', prompt: `请润色以下文字，使其更流畅、专业：\n\n${c.selectedText || '（未选中文字，请先在页面上选中要润色的内容）'}` }) },
  { key: 'explain', label: '💻 解释代码', build: (c) => ({ label: '解释选中代码', prompt: `请解释以下代码的功能与逻辑（中文）：\n\n${c.selectedText || '（未选中文字，请先在页面上选中要解释的代码）'}` }) },
  { key: 'notes', label: '🎓 笔记', build: (c) => ({ label: '生成学习笔记', prompt: `请根据以下网页内容生成一份结构化学习笔记（要点、知识点、小结）：\n\n【标题】${c.title}\n【正文】\n${c.text}` }) },
  { key: 'email', label: '✉️ 写邮件', build: (c) => ({ label: '根据选中内容写邮件', prompt: `请根据以下内容起草一封得体的邮件：\n\n${c.selectedText || c.text}` }) }
]

export function AiSidebar(): JSX.Element {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [hasKey, setHasKey] = useState(false)
  const [permission, setPermission] = useState<CliPermissionLevel>('daily')
  const reqIdRef = useRef('')
  const streamingMsgRef = useRef('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.tibrowser.settings.get().then((s: Settings) => {
      setHasKey(s.ai.apiKey.length > 0)
      setPermission(s.ai.cliPermission ?? 'daily')
    })

    const offs = [
      window.tibrowser.ai.onChunk((c) => {
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
      window.tibrowser.ai.onTool((t) => {
        if (t.requestId !== reqIdRef.current) return
        streamingMsgRef.current = ''
        setMessages((ms) => [
          ...ms,
          { id: uid(), role: 'tool', content: `${t.name} ${t.detail}` }
        ])
      }),
      window.tibrowser.ai.onDone((d) => {
        if (d.requestId !== reqIdRef.current) return
        setStreaming(false)
        streamingMsgRef.current = ''
      }),
      window.tibrowser.ai.onError((e) => {
        if (e.requestId !== reqIdRef.current) return
        const sid = streamingMsgRef.current
        setMessages((ms) => {
          let next = sid ? ms.filter((m) => !(m.id === sid && m.content === '')) : ms
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

  function changePermission(level: CliPermissionLevel): void {
    setPermission(level)
    window.tibrowser.settings
      .get()
      .then((s: Settings) => window.tibrowser.settings.set({ ai: { ...s.ai, cliPermission: level } }))
  }

  function sendChat(requestId: string, payload: { role: 'user' | 'assistant'; content: string }[]): void {
    reqIdRef.current = requestId
    streamingMsgRef.current = ''
    setStreaming(true)
    window.tibrowser.ai.chat({ requestId, messages: payload })
  }

  function sendAgent(requestId: string, payload: { role: 'user' | 'assistant'; content: string }[]): void {
    reqIdRef.current = requestId
    streamingMsgRef.current = ''
    setStreaming(true)
    window.tibrowser.ai.agent({ requestId, messages: payload })
  }

  function historyMessages(): { role: 'user' | 'assistant'; content: string }[] {
    return messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  }

  function send(): void {
    const text = input.trim()
    if (!text || streaming) return
    const history = historyMessages()
    const payload = [...history, { role: 'user' as const, content: text }]
    const reqId = uid()
    setMessages((ms) => [...ms, { id: uid(), role: 'user', content: text }])
    setInput('')
    if (permission === 'off') sendChat(reqId, payload)
    else sendAgent(reqId, payload)
  }

  async function quickAction(action: (typeof QUICK_ACTIONS)[number]): Promise<void> {
    if (streaming) return
    const ctx = await window.tibrowser.ai.context()
    const { label, prompt } = action.build(ctx ?? {})
    const history = historyMessages()
    const payload = [...history, { role: 'user' as const, content: prompt }]
    const reqId = uid()
    setMessages((ms) => [...ms, { id: uid(), role: 'user', content: label }])
    sendChat(reqId, payload)
  }

  function stopStreaming(): void {
    if (reqIdRef.current) window.tibrowser.ai.abort(reqIdRef.current)
    setStreaming(false)
    streamingMsgRef.current = ''
  }

  const permHint = CLI_PERMISSION_LEVELS.find((l) => l.value === permission)?.hint ?? ''

  return (
    <div className="ai-sidebar">
      <div className="ai-header">
        <span className="ai-badge">
          <Sparkles size={15} />
        </span>
        <span>TIbrowser AI</span>
        <span className="spacer" />
        <span className="nav-btn" style={{ width: 28, height: 28 }} onClick={() => window.tibrowser.openOverlay('settings')} title="AI 设置">
          <Gear size={16} />
        </span>
        <span className="nav-btn" style={{ width: 28, height: 28 }} onClick={() => window.tibrowser.toggleSidebar()}>
          <Close size={16} />
        </span>
      </div>

      <div className="ai-perm">
        <span className="ai-perm-label">控制权限</span>
        <select
          value={permission}
          onChange={(e) => changePermission(e.target.value as CliPermissionLevel)}
        >
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
          <button key={a.key} className="ai-quick" onClick={() => quickAction(a)} disabled={streaming}>
            {a.label}
          </button>
        ))}
      </div>

      <div className="ai-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="ai-empty">
            <Sparkles size={28} style={{ color: 'var(--accent-ai)', marginBottom: 8 }} />
            <div>我是 TIbrowser 内置的 AI 助手。</div>
            <div>可以聊天，也可以按上方快捷功能处理网页内容。</div>
            <div>调整「控制权限」后，我还能帮你控制浏览器。</div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role === 'tool' ? (
              <span>🔧 {m.content}</span>
            ) : (
              m.content || (m.role === 'assistant' && streaming ? '…' : '')
            )}
          </div>
        ))}
      </div>

      {!hasKey && (
        <div className="ai-warn">
          尚未配置 API Key，点击右上角齿轮前往设置，填入你的 DeepSeek / OpenAI 等密钥。
        </div>
      )}

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
          <span className="send-btn" onClick={send} style={input.trim() ? undefined : { opacity: 0.4 }} title="发送">
            <Send size={16} />
          </span>
        )}
      </div>
    </div>
  )
}
