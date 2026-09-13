/**
 * 设置面板共用的小组件（开关 / 单选卡片 / 分段控件 / 统计块 / 状态视图 …）。
 * 全部为无状态展示组件，业务状态一律由各分区自行持有。
 */
import { useEffect, useState, type ReactNode, type SVGProps } from 'react'
import { Check, Info, Warning } from './icons'

export function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

// ---------------------------------------------------------------------------
// 开关
// ---------------------------------------------------------------------------

export function Switch({
  on,
  onToggle,
  disabled,
  title
}: {
  on: boolean
  onToggle: () => void
  disabled?: boolean
  title?: string
}): JSX.Element {
  return (
    <span
      className={`switch ${on ? 'on' : ''} ${disabled ? 'disabled' : ''}`}
      role="switch"
      aria-checked={on}
      aria-disabled={disabled}
      title={title}
      tabIndex={0}
      onClick={() => !disabled && onToggle()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onToggle()
        }
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// 一行设置项
// ---------------------------------------------------------------------------

export function Field({
  label,
  desc,
  children,
  alignTop
}: {
  label: ReactNode
  desc?: ReactNode
  children?: ReactNode
  alignTop?: boolean
}): JSX.Element {
  return (
    <div className={`field ${alignTop ? 'align-top' : ''}`}>
      <div className="f-label">
        <span>{label}</span>
        {desc ? <span className="f-desc">{desc}</span> : null}
      </div>
      {children ? <div className="f-control">{children}</div> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 可选卡片（radio card）
// ---------------------------------------------------------------------------

export interface OptCardProps {
  name: string
  value: string
  selected: boolean
  onSelect: (value: string) => void
  /** 直接传图标组件（推荐），内部会按当前皮肤令牌决定尺寸 */
  icon?: React.ComponentType<SVGProps<SVGSVGElement> & { size?: number }>
  title: ReactNode
  tag?: ReactNode
  desc?: ReactNode
  notes?: ReactNode[]
  foot?: ReactNode
}

export function OptCard({
  name,
  value,
  selected,
  onSelect,
  icon: IconCmp,
  title,
  tag,
  desc,
  notes,
  foot
}: OptCardProps): JSX.Element {
  return (
    <label className={`opt-card ${selected ? 'selected' : ''}`}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={selected}
        onChange={() => onSelect(value)}
      />
      <span className="opt-head">
        {IconCmp ? (
          <span className="opt-icon">
            <IconCmp size={17} />
          </span>
        ) : null}
        <span className="opt-title">{title}</span>
        {tag ? <span className="opt-tag">{tag}</span> : null}
      </span>
      {desc ? <span className="opt-desc">{desc}</span> : null}
      {notes && notes.length > 0 ? (
        <ul className="opt-notes">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
      {foot ? <span className="opt-foot">{foot}</span> : null}
    </label>
  )
}

// ---------------------------------------------------------------------------
// 分段控件
// ---------------------------------------------------------------------------

export function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}): JSX.Element {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          className={o.value === value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 统计 / 提示 / 状态
// ---------------------------------------------------------------------------

export function Stat({ value, label }: { value: ReactNode; label: string }): JSX.Element {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

export function Callout({
  children,
  tone,
  icon
}: {
  children: ReactNode
  tone?: 'accent' | 'warn' | 'danger'
  icon?: ReactNode
}): JSX.Element {
  return (
    <div className={`callout ${tone ?? ''}`}>
      <span className="callout-icon">{icon ?? <Info size={16} />}</span>
      <div>{children}</div>
    </div>
  )
}

export function Loading({ text = '正在加载…' }: { text?: string }): JSX.Element {
  return <div className="loading">{text}</div>
}

export function ErrorView({ message, onRetry }: { message: string; onRetry?: () => void }): JSX.Element {
  return (
    <div className="callout danger">
      <span className="callout-icon">
        <Warning size={16} />
      </span>
      <div>
        <div>{message}</div>
        {onRetry ? (
          <button className="btn small ghost" style={{ marginTop: 8 }} onClick={onRetry}>
            重试
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function EmptyView({ text, hint }: { text: string; hint?: string }): JSX.Element {
  return (
    <div className="empty">
      <div>{text}</div>
      {hint ? <div style={{ fontSize: 12, marginTop: 4 }}>{hint}</div> : null}
    </div>
  )
}

/** 状态徽标 */
export function Badge({
  children,
  tone
}: {
  children: ReactNode
  tone?: 'ok' | 'warn' | 'err' | 'accent'
}): JSX.Element {
  return <span className={`badge ${tone ?? ''}`}>{children}</span>
}

/** 带「已复制」反馈的复制按钮 */
export function CopyButton({
  text,
  onCopy,
  label = '复制'
}: {
  text: string
  onCopy: (text: string) => void | Promise<void>
  label?: string
}): JSX.Element {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(false), 1400)
    return () => clearTimeout(t)
  }, [done])
  return (
    <button
      className="btn small"
      type="button"
      onClick={async () => {
        await onCopy(text)
        setDone(true)
      }}
    >
      {done ? <Check size={13} /> : null}
      {done ? '已复制' : label}
    </button>
  )
}

/** 一次性 Toast（轻提示） */
export function Toast({ text, tone }: { text: string; tone?: 'err' }): JSX.Element {
  return <div className={`toast ${tone ?? ''}`}>{text}</div>
}
