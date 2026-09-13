/**
 * 桥接适配层：外壳 UI 只通过本模块与原生宿主通信。
 *
 * ┌ 为什么要这一层 ────────────────────────────────────────────────────────┐
 * │ 1. CEF 宿主注入的是 `window.tib`（ARCHITECTURE.md §3），而组件不应该到处  │
 * │    写 `window.tib?.xxx`，否则每一处都要处理「桥不存在」。                │
 * │ 2. 在普通浏览器标签页里直接打开 UI（`npm run ui:dev`）时没有 `window.tib`，│
 * │    这里会自动降级为内存 mock，保证界面仍然完全可点。                     │
 * │ 3. 原生侧新增能力时只改这一个文件 + `src/shared/bridge.ts`。             │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * 类型来自 `@shared/bridge`（共享契约），本文件不重复定义任何桥类型。
 */
import type {
  TibBridge,
  TibEventMap,
  TibEventName,
  Unsubscribe
} from '@shared/bridge'
import { createMockBridge } from './mock'

/** 是否正在使用 mock 桥（等价于「没有原生宿主」） */
export const isMockBridge: boolean = typeof window !== 'undefined' && !window.tib

let bridge: TibBridge

if (typeof window !== 'undefined' && window.tib) {
  bridge = window.tib
} else {
  bridge = createMockBridge()
  // 明确、唯一的一条中文提示：避免开发同学误以为连上了原生内核
  console.info(
    '[TiBrowser] 未检测到 window.tib（原生 CEF 桥），已切换到开发用 mock 桥：' +
      '全部界面可正常点击，但数据均为本地假数据，不会写入磁盘。'
  )
}

/** 当前生效的桥（原生或 mock） */
export const tib: TibBridge = bridge

/**
 * 订阅事件并返回取消订阅函数。
 * 与直接调用 `tib.on` 相比，这里额外做了两件事：
 *  - 原生桥抛出的同步异常不会冒泡到 React 渲染流程；
 *  - `tib` 未就绪时返回一个空操作，组件无需写判空。
 */
export function on<K extends TibEventName>(
  event: K,
  cb: (payload: TibEventMap[K]) => void
): Unsubscribe {
  try {
    return tib.on(event, cb)
  } catch (err) {
    console.warn(`[TiBrowser] 订阅事件 ${event} 失败：`, err)
    return () => undefined
  }
}

/**
 * 批量订阅，返回「一次性取消全部」的函数。
 * 组件里最常见的写法：
 * ```ts
 * useEffect(() => subscribe({
 *   state: setState,
 *   windowState: (s) => setIsMaximized(s.isMaximized)
 * }), [])
 * ```
 */
export function subscribe(handlers: {
  [K in TibEventName]?: (payload: TibEventMap[K]) => void
}): Unsubscribe {
  const offs = (Object.keys(handlers) as TibEventName[]).map((event) => {
    const handler = handlers[event]
    if (!handler) return () => undefined
    return on(event, handler as (payload: TibEventMap[TibEventName]) => void)
  })
  return () => offs.forEach((off) => off())
}

/**
 * 统一的调用包装：把「桥不可用 / 原生返回异常」转成可展示的中文错误，
 * 让每个设置分区都能写出 `错误状态` 而不是白屏。
 */
export async function call<T>(
  fn: () => Promise<T>,
  fallbackMessage = '操作失败，请稍后重试'
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn('[TiBrowser] 桥调用失败：', detail)
    return { ok: false, error: `${fallbackMessage}（${detail}）` }
  }
}

/** 供设置面板等需要「重新拉取」的地方使用：等一帧再拉，避免竞态 */
export function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
