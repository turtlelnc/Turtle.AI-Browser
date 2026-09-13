/**
 * 皮肤元数据（feature 8）。
 *
 * **诚实性说明**：三种皮肤都是 TiBrowser 用自己的 CSS 令牌 + 自绘内联 SVG 实现的
 * 渲染效果，只是「受 Edge / Chrome 的界面布局启发」。我们**不**包含、不复制任何
 * Microsoft Edge 或 Google Chrome 的专有资源、商标、图标与字体；上游产品名仅用于
 * 向用户说明「当前外观接近哪种布局」。该说明同时会展示在「设置 → 外观」中。
 */
import type { BrowserSkin } from '@shared/bridge'
import edgeCss from './edge.css?inline'
import chromeCss from './chrome.css?inline'
import tibrowserCss from './tibrowser.css?inline'

export interface SkinMeta {
  id: BrowserSkin
  /** 展示名 */
  name: string
  /** 一句话说明（中文） */
  description: string
  /** 皮肤预览用的强调色（与令牌一致，仅用于设置页的小色块） */
  swatch: string
  /** 该皮肤的字号/密度描述 */
  density: string
}

export const SKINS: SkinMeta[] = [
  {
    id: 'tibrowser',
    name: 'TiBrowser',
    description: '原生外观：胶囊标签、柔和大圆角、青蓝强调色，留白最舒展。',
    swatch: '#0e8f84',
    density: '宽松'
  },
  {
    id: 'edge',
    name: 'Microsoft Edge 风格',
    description: '布局致敬：小圆角矩形标签、蓝色强调色、中等密度。',
    swatch: '#0f6cbd',
    density: '适中'
  },
  {
    id: 'chrome',
    name: 'Google Chrome 风格',
    description: '布局致敬：上圆下方标签、中性灰、最紧凑的信息密度。',
    swatch: '#1b6ef3',
    density: '紧凑'
  }
]

/** 皮肤 id → 展示名 */
export function skinName(id: BrowserSkin | undefined | null): string {
  return SKINS.find((s) => s.id === id)?.name ?? 'TiBrowser'
}

/**
 * 三种皮肤的 CSS 文本（内联为字符串，便于在原生环境下按需注入，
 * 也便于在开发预览里手写 `<style>` 覆盖，避免多打一次网络请求）。
 * 使用 `?inline` 由 Vite 在构建期完成内联，运行时**不新增依赖**。
 */
export const SKIN_CSS: Record<BrowserSkin, string> = {
  tibrowser: tibrowserCss,
  edge: edgeCss,
  chrome: chromeCss
}

/** 诚实性提示文案（展示在「设置 → 外观」） */
export const SKIN_HONESTY_NOTE =
  '以上皮肤均为 TiBrowser 自行绘制的界面效果（布局致敬，非复制）：不含任何第三方专有图标、商标或资源，所有图标均由本项目自绘。'
