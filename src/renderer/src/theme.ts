/**
 * 运行时外观应用层：把「皮肤 / 主题 / 性能档」写到 `<html>` 上。
 *
 * 三项互不干扰的属性：
 *   data-skin   = tibrowser | edge | chrome   → 形状与密度令牌（feature 8）
 *   data-theme  = light | dark                → 颜色令牌（已经是解析后的结果，
 *                                               'system' 会在本文件里被解析掉）
 *   data-perf   = high | low                  → 关闭模糊/阴影/过渡（低端设备）
 *
 * 之所以要在 React 之外单独做一层：首屏渲染前就要把属性写好，
 * 否则会出现「先按默认皮肤画一帧、再跳成用户皮肤」的闪烁。
 */
import type { BrowserSkin, PerfMode, ThemeMode2 } from '@shared/bridge'

/** 已解析的主题（不会出现 system） */
export type ResolvedTheme = 'light' | 'dark'

const DARK_QUERY = '(prefers-color-scheme: dark)'

export function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

export function resolveTheme(mode: ThemeMode2): ResolvedTheme {
  return mode === 'system' ? systemTheme() : mode
}

/** 应用皮肤 */
export function applySkin(skin: BrowserSkin): void {
  document.documentElement.dataset.skin = skin
}

/** 应用主题（已解析） */
export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme
}

/** 应用性能档 */
export function applyPerf(perf: PerfMode): void {
  document.documentElement.dataset.perf = perf
}

/** 一次性应用全部外观（首屏用） */
export function applyAppearance(opts: {
  skin?: BrowserSkin
  theme?: ThemeMode2
  perf?: PerfMode
}): ResolvedTheme {
  const theme = resolveTheme(opts.theme ?? 'system')
  applySkin(opts.skin ?? 'tibrowser')
  applyTheme(theme)
  applyPerf(opts.perf ?? 'high')
  return theme
}

/**
 * 监听系统主题变化；仅在用户选择「跟随系统」时生效。
 * @returns 取消监听函数
 */
export function watchSystemTheme(onChange: (theme: ResolvedTheme) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined
  const mql = window.matchMedia(DARK_QUERY)
  const handler = (e: MediaQueryListEvent): void => onChange(e.matches ? 'dark' : 'light')
  mql.addEventListener('change', handler)
  return () => mql.removeEventListener('change', handler)
}
