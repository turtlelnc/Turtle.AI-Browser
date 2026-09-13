/**
 * 设置 · AI 模式（feature 12）
 *
 * 浏览 / 本地办公 / 本地开发 三种模式，每种都明确写出「AI 能看到什么、能改什么」。
 * 本地开发模式额外提供沙箱工作目录选择与目录白名单。
 */
import { useEffect, useState } from 'react'
import type { AiMode, AiModeInfo } from '@shared/bridge'
import { tib } from '../../bridge'
import { Badge, Callout, ErrorView, Field, Loading, OptCard } from '../ui'
import { Code, Doc, Folder, Globe, Info, Laptop, Plus, Trash, Warning } from '../icons'

/** 三种模式的能力与边界说明 */
const MODES: {
  value: AiMode
  label: string
  icon: typeof Globe
  desc: string
  can: string[]
  cannot: string[]
}[] = [
  {
    value: 'browse',
    label: '浏览',
    icon: Globe,
    desc: '默认模式。AI 只能看到你当前打开的网页内容，以及你自己填进对话的文字。',
    can: ['读取当前标签页的标题、正文与选中文字', '总结、翻译、润色、解释代码', '根据页面内容起草回复或表单草稿'],
    cannot: ['访问本机文件', '执行任何命令', '在你不知情时打开新页面']
  },
  {
    value: 'office',
    label: '本地办公',
    icon: Doc,
    desc: '在你指定的文档目录内读写 Office 文档，用于整理资料、生成表格与纪要。',
    can: ['读写你选择的文档目录（默认为「文档」）', '生成表格 / 幻灯片 / 会议纪要草稿', '批量重命名与归档文件'],
    cannot: ['访问该目录以外的文件', '执行命令行程序', '访问系统目录与凭据存储']
  },
  {
    value: 'dev',
    label: '本地开发',
    icon: Code,
    desc: '把 AI 接到一个沙箱工作目录，用于读写代码、跑命令、分析网络请求。权限最高，请谨慎授权。',
    can: ['读写沙箱工作目录及其白名单内的路径', '执行命令（每次都会先征求你的确认）', '抓包、分析请求与响应、运行代码检查'],
    cannot: ['访问白名单以外的路径', '在未经确认时执行任何命令', '读取浏览器保存的密码与 Cookie']
  }
]

export function AiModeSection(): JSX.Element {
  const [info, setInfo] = useState<AiModeInfo | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [newPath, setNewPath] = useState('')

  async function load(): Promise<void> {
    setError('')
    try {
      setInfo(await tib.getAiMode())
    } catch (err) {
      setError(`读取 AI 模式失败：${String(err)}`)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function choose(mode: AiMode): Promise<void> {
    setBusy(true)
    setNotice('')
    try {
      const next = await tib.setAiMode(mode)
      setInfo(next)
      setNotice(`已切换到「${MODES.find((m) => m.value === mode)?.label}」模式。`)
    } catch (err) {
      setError(`切换模式失败：${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function pickWorkdir(): Promise<void> {
    setBusy(true)
    try {
      const { path } = await tib.pickWorkdir()
      if (!path) {
        setNotice('已取消选择工作目录。')
        return
      }
      setInfo(await tib.getAiMode())
      setNotice(`沙箱工作目录已设为：${path}`)
    } catch (err) {
      setError(`选择工作目录失败：${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function addAllow(): Promise<void> {
    if (!info || !newPath.trim()) return
    const next = [...info.allowlist, newPath.trim()]
    try {
      setInfo(await tib.setWorkdirAllowlist(next))
      setNewPath('')
    } catch (err) {
      setError(`保存白名单失败：${String(err)}`)
    }
  }

  async function removeAllow(path: string): Promise<void> {
    if (!info) return
    try {
      setInfo(await tib.setWorkdirAllowlist(info.allowlist.filter((p) => p !== path)))
    } catch (err) {
      setError(`保存白名单失败：${String(err)}`)
    }
  }

  if (error && !info) return <ErrorView message={error} onRetry={() => void load()} />
  if (!info) return <Loading text="正在读取 AI 模式…" />

  const active = MODES.find((m) => m.value === info.mode)

  return (
    <section className="ov-section">
      <h2>AI 模式</h2>
      <p className="sec-desc">
        模式决定 AI 能触碰的范围。切换模式不会自动扩大权限：本地办公与本地开发都需要你先指定目录。
      </p>

      <div className="card-options cols-3" style={{ marginBottom: 16 }}>
        {MODES.map((m) => (
          <OptCard
            key={m.value}
            name="tb-ai-mode"
            value={m.value}
            selected={info.mode === m.value}
            onSelect={(v) => void choose(v as AiMode)}
            icon={m.icon}
            title={m.label}
            tag={busy ? '切换中…' : info.mode === m.value ? '使用中' : undefined}
            desc={m.desc}
            notes={m.can.map((c) => `可以：${c}`)}
            foot={m.cannot.map((c) => `不可以：${c}`).join('；')}
          />
        ))}
      </div>

      {notice ? <Callout tone="accent">{notice}</Callout> : null}
      {error ? <ErrorView message={error} /> : null}

      <Field label="当前模式的可用工具" desc={`「${active?.label ?? info.mode}」模式下 AI 可以调用的能力`}>
        <div className="tool-chips">
          {info.tools.map((t) => (
            <span key={t} className="tool-chip">
              {t}
            </span>
          ))}
        </div>
      </Field>

      {info.mode === 'dev' ? (
        <>
          <h2 style={{ marginTop: 24 }}>沙箱工作目录</h2>
          <p className="sec-desc">
            AI 只能在这个目录（及其白名单）内读写文件与执行命令。目录之外的任何路径都会被内核直接拒绝。
          </p>
          <Field
            label="工作目录"
            desc={info.workdir ? `已选择：${info.workdir}` : '尚未选择，本地开发模式当前不可用'}
          >
            <button className="btn small" type="button" onClick={() => void pickWorkdir()} disabled={busy}>
              <Folder size={14} />
              {info.workdir ? '重新选择…' : '选择目录…'}
            </button>
          </Field>

          <h2 style={{ marginTop: 24 }}>目录白名单</h2>
          <p className="sec-desc">白名单内的额外路径同样可被读写，适合放依赖缓存或共享组件库。</p>
          {info.allowlist.length === 0 ? (
            <div className="empty">白名单为空：当前只允许工作目录本身</div>
          ) : (
            <div className="list">
              {info.allowlist.map((p) => (
                <div key={p} className="list-item">
                  <Folder size={16} style={{ color: 'var(--tb-text-3)' }} />
                  <div className="li-main">
                    <div className="li-title" style={{ fontFamily: 'var(--tb-font-mono)', fontSize: 12 }}>
                      {p}
                    </div>
                  </div>
                  <span className="li-action always" title="移出白名单" onClick={() => void removeAllow(p)}>
                    <Trash size={15} />
                  </span>
                </div>
              ))}
            </div>
          )}
          <Field label="添加白名单路径" desc="必须是绝对路径">
            <input
              type="text"
              value={newPath}
              spellCheck={false}
              placeholder="D:\\work\\shared-libs"
              onChange={(e) => setNewPath(e.target.value)}
            />
            <button className="btn small" type="button" onClick={() => void addAllow()} disabled={!newPath.trim()}>
              <Plus size={14} />
              添加
            </button>
          </Field>

          <div style={{ marginTop: 16 }}>
            <Callout tone="warn" icon={<Warning size={16} />}>
              本地开发模式允许执行命令。TiBrowser 会在每次执行前弹窗确认并显示完整命令行；
              请勿把包含密钥、生产数据库或未备份代码的目录加入白名单。
            </Callout>
          </div>
        </>
      ) : null}

      {info.mode === 'office' && info.documentDirs && info.documentDirs.length > 0 ? (
        <Field label="可访问的文档目录" desc="本地办公模式仅能读写这些目录">
          <div className="tool-chips">
            {info.documentDirs.map((d) => (
              <span key={d} className="tool-chip">
                {d}
              </span>
            ))}
          </div>
        </Field>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <Callout icon={<Info size={16} />}>
          模式是<strong>每窗口</strong>生效的：
          <Laptop size={14} style={{ verticalAlign: -2, margin: '0 4px' }} />
          无痕窗口始终按「浏览」模式运行，不会继承本地开发权限。
          <Badge tone="accent">安全默认</Badge>
        </Callout>
      </div>
    </section>
  )
}
