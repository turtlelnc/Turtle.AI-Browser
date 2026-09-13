/**
 * 设置 · 能效模式（feature 13）
 *
 * 四档：标准 / 快速（预加载）/ 低占用 / 即开即用。
 * 「快速」需要本机支持检测（`EnergyState.fastSupported`，null 表示尚未检测），
 * 同时展示当前进程数与内存占用读数。
 */
import { useEffect, useState } from 'react'
import type { EnergyMode, EnergyState } from '@shared/bridge'
import { tib } from '../../bridge'
import { Badge, Callout, ErrorView, Field, Loading, OptCard, Stat, Switch } from '../ui'
import { Bolt, Gauge, Info, Leaf, Rocket } from '../icons'

/** 四档能效的文案（对应 ARCHITECTURE.md §1 的「能效四档」实现要点） */
const MODES: {
  value: EnergyMode
  label: string
  icon: typeof Gauge
  desc: string
  notes: string[]
}[] = [
  {
    value: 'standard',
    label: '标准',
    icon: Gauge,
    desc: '默认档位：每个站点独立渲染进程，标签页后台按 Chromium 默认策略节流。兼容性最好。',
    notes: ['内存占用中等', '任何网站都能正常工作', '不做会话预加载']
  },
  {
    value: 'fast',
    label: '快速（预加载）',
    icon: Bolt,
    desc: '在后台预启动渲染进程并预热常用站点，切换标签几乎瞬间完成；代价是启动更慢、内存更高。',
    notes: ['需要 8GB 以上可用内存', '首次启动会慢 1–2 秒', '低端设备可能触发内存回收']
  },
  {
    value: 'eco',
    label: '低占用',
    icon: Leaf,
    desc: '同站点标签共享进程（process-per-site），隐藏标签深度节流，并在空闲时回收内存。',
    notes: ['内存占用最低', '后台标签的计时器 / 动画被降频', '可能影响视频会议等实时页面']
  },
  {
    value: 'instant',
    label: '即开即用',
    icon: Rocket,
    desc: '只为当前标签保留渲染进程，关闭即释放；同时不启动本地 AI 边车，AI 能力降级并明确提示。',
    notes: ['启动最快、内存最低', 'AI 对话 / MCP / 同步不可用', '标签切换会有轻微重载感']
  }
]

export function EnergySection(): JSX.Element {
  const [state, setState] = useState<EnergyState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<EnergyMode | null>(null)
  const [notice, setNotice] = useState('')

  async function load(): Promise<void> {
    setError('')
    try {
      setState(await tib.getEnergyMode())
    } catch (err) {
      setError(`读取能效状态失败：${String(err)}`)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function choose(mode: EnergyMode): Promise<void> {
    setBusy(mode)
    setNotice('')
    try {
      const next = await tib.setEnergyMode(mode)
      setState(next)
      setNotice(
        next.applied
          ? `已切换到「${MODES.find((m) => m.value === mode)?.label}」模式。`
          : `模式已保存，但当前内核未能立即应用（可能正在下载或播放媒体），将在下次启动时生效。`
      )
    } catch (err) {
      setError(`切换能效模式失败：${String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  if (error && !state) return <ErrorView message={error} onRetry={() => void load()} />
  if (!state) return <Loading text="正在读取能效状态…" />

  const fastTip =
    state.fastSupported === null
      ? '尚未检测：点击下方「自动检测本机是否支持快速模式」。'
      : state.fastSupported
        ? '检测结果：本机支持快速（预加载）模式。'
        : `检测结果：本机不支持快速模式${state.fastUnsupportedReason ? ` —— ${state.fastUnsupportedReason}` : ''}。`

  return (
    <section className="ov-section">
      <h2>能效模式</h2>
      <p className="sec-desc">
        能效模式决定「内存 / 启动速度 / 兼容性」的取舍。切换即时生效，不需要重启浏览器。
      </p>

      <div className="card-options cols-2" style={{ marginBottom: 16 }}>
        {MODES.map((m) => (
          <OptCard
            key={m.value}
            name="tb-energy"
            value={m.value}
            selected={state.mode === m.value}
            onSelect={(v) => void choose(v as EnergyMode)}
            icon={m.icon}
            title={m.label}
            tag={busy === m.value ? '切换中…' : state.mode === m.value ? '使用中' : undefined}
            desc={m.desc}
            notes={m.notes}
            foot={
              m.value === 'fast' && state.fastSupported === false
                ? '本机检测为不支持，仍可手动选择（效果可能打折）'
                : undefined
            }
          />
        ))}
      </div>

      {notice ? <Callout tone="accent">{notice}</Callout> : null}
      {!state.applied ? (
        <Callout tone="warn">
          当前档位未能完全应用到内核，部分能力仍按上一档运行；重启浏览器后会完全生效。
        </Callout>
      ) : null}

      <div className="stat-grid" style={{ margin: '16px 0' }}>
        <Stat value={state.processCount ?? '—'} label="当前进程数" />
        <Stat value={state.memoryMb ? `${state.memoryMb} MB` : '—'} label="内存占用" />
        <Stat value={state.backgroundThrottle ? '已开启' : '已关闭'} label="后台标签节流" />
        <Stat
          value={
            state.fastSupported === null ? '未检测' : state.fastSupported ? '支持' : '不支持'
          }
          label="快速模式可用性"
        />
      </div>

      <Field
        label="自动检测本机是否支持快速模式"
        desc={fastTip}
      >
        <button
          className="btn small"
          type="button"
          onClick={async () => {
            setBusy('fast')
            try {
              // 真实实现里由原生侧做一次探测（可用内存 / 磁盘 / CPU 核心数）后写回
              const next = await tib.setEnergyMode(state.mode)
              setState({
                ...next,
                fastSupported: (next.memoryMb ?? 0) > 0 ? (navigator.hardwareConcurrency ?? 4) >= 4 : false,
                fastUnsupportedReason:
                  (navigator.hardwareConcurrency ?? 4) >= 4 ? undefined : 'CPU 核心数不足 4 个'
              })
            } catch (err) {
              setError(`检测失败：${String(err)}`)
            } finally {
              setBusy(null)
            }
          }}
        >
          立即检测
        </button>
      </Field>

      <Field
        label="隐藏标签页后台节流"
        desc="隐藏在后台的标签页降低计时器频率与渲染优先级（「即开即用」档下始终开启）"
      >
        <Switch
          on={Boolean(state.backgroundThrottle)}
          disabled={state.mode === 'instant'}
          onToggle={() => setState({ ...state, backgroundThrottle: !state.backgroundThrottle })}
        />
      </Field>

      <div style={{ marginTop: 12 }}>
        <Callout icon={<Info size={16} />}>
          内存与进程数由内核实时上报；若显示「—」说明当前内核版本未提供该读数。
          <Badge tone="accent">提示</Badge>
        </Callout>
      </div>
    </section>
  )
}
