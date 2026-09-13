/**
 * 皮肤设计令牌（design tokens）类型清单。
 *
 * 这套令牌是「皮肤系统」（feature 8）的**唯一契约**：
 * - CSS 侧：`styles/skins/*.css` 只允许通过覆盖这些 `--tb-*` 变量来换肤，
 *   不得改动布局结构（见 skins/tibrowser.css 顶部说明）。
 * - TS 侧：需要读取尺寸（标签栏高度、工具栏高度等）时，只允许读这里导出的常量，
 *   避免出现「CSS 里一套、JS 里另一套」的错位。
 *
 * 令牌分七组：颜色 color / 圆角 radius / 高度 height / 阴影 elevation /
 * 动效 motion / 密度 density / 图标与动效开关。
 */

/** 皮肤与主题的组合键：`<skin>` 或 `<skin>-<light|dark>` 或 `*` */
export type TokenKey = `--tb-${string}`

/** 一套完整令牌表 */
export type TokenTable = Record<TokenKey, string>

// ---------------------------------------------------------------------------
// 尺寸常量（JS 需要与 CSS 对齐的部分）
// ---------------------------------------------------------------------------

/**
 * 各皮肤外壳高度的 TS 镜像（单位 px），必须与 `skins/*.css` 中的
 * `--tb-tab-outer-h` / `--tb-toolbar-h` / `--tb-bookmark-h` 一一对应。
 *
 * 用途：供**原生侧**（CefWindow 布局、视图定位）与需要预知高度的代码参考。
 * renderer 自己在运行时是用 `getComputedStyle` 直接读 CSS 变量的（见 App.tsx），
 * 因此换皮肤不需要改 JS；但原生侧若要同步调整，就应该读这张表。
 * **改 CSS 时必须同步改这里。**
 */
export const SKIN_HEIGHTS: Record<string, { tab: number; toolbar: number; bookmark: number }> = {
  tibrowser: { tab: 40, toolbar: 46, bookmark: 32 },
  edge: { tab: 40, toolbar: 44, bookmark: 32 },
  chrome: { tab: 38, toolbar: 42, bookmark: 30 }
}

/** 页内查找栏高度（各皮肤一致） */
export const FIND_BAR_HEIGHT = 42

/** 默认侧边栏宽度（各皮肤一致，用户可拖拽） */
export const DEFAULT_SIDEBAR_WIDTH = 360
