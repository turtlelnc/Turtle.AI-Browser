/**
 * 图标集：**全部由本项目自绘**的内联 SVG（24×24 网格、线宽跟随 `--tb-icon-stroke`）。
 *
 * 诚实性说明：这里没有任何第三方图标库或品牌图标的拷贝。
 * 皮肤（TiBrowser / Edge 风格 / Chrome 风格）只改变描边粗细与尺寸令牌，
 * 不引入上游产品的专有图形。
 */
import type { SVGProps } from 'react'

interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number
}

function Icon({ size = 16, children, ...rest }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

// ---------------- 导航 / 外壳 ----------------

export const ArrowLeft = (p: IconProps) => (
  <Icon {...p}>
    <path d="M19 12H5" />
    <path d="m12 19-7-7 7-7" />
  </Icon>
)
export const ArrowRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </Icon>
)
export const ArrowUp = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 19V5" />
    <path d="m5 12 7-7 7 7" />
  </Icon>
)
export const ArrowDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14" />
    <path d="m19 12-7 7-7-7" />
  </Icon>
)
export const Reload = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 12a9 9 0 0 1 15.36-6.36L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15.36 6.36L3 16" />
    <path d="M3 21v-5h5" />
  </Icon>
)
export const Close = (p: IconProps) => (
  <Icon {...p}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Icon>
)
export const Home = (p: IconProps) => (
  <Icon {...p}>
    <path d="m3 10 9-7 9 7" />
    <path d="M5 9v11h14V9" />
  </Icon>
)
export const Plus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Icon>
)
export const Minus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 12h14" />
  </Icon>
)
export const Square = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
  </Icon>
)
export const Restore = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5" y="8" width="12" height="12" rx="2" />
    <path d="M9 8V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-2" />
  </Icon>
)
export const Dots = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none" />
  </Icon>
)
export const DotsHorizontal = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </Icon>
)
export const PanelRight = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <path d="M15 3v18" />
  </Icon>
)
export const Stop = (p: IconProps) => (
  <Icon {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Icon>
)

// ---------------- 地址栏 / 状态 ----------------

export const Star = (p: IconProps) => (
  <Icon {...p}>
    <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.4l6.1-.9L12 3z" />
  </Icon>
)
export const StarFilled = (p: IconProps) => (
  <Icon {...p} fill="currentColor" stroke="none">
    <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.4l6.1-.9L12 3z" />
  </Icon>
)
export const Lock = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="11" width="18" height="11" rx="3" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </Icon>
)
export const Globe = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3c2.5 2.4 3.8 5.6 3.8 9S14.5 18.6 12 21c-2.5-2.4-3.8-5.6-3.8-9S9.5 5.4 12 3z" />
  </Icon>
)
export const Search = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </Icon>
)
export const Clock = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
)
export const Bookmark = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 3h12v18l-6-4.2L6 21V3z" />
  </Icon>
)
export const Download = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M4 21h16" />
  </Icon>
)
export const Folder = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
  </Icon>
)
export const External = (p: IconProps) => (
  <Icon {...p}>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
  </Icon>
)
export const Trash = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 6h18" />
    <path d="M8 6V4h8v2" />
    <path d="M19 6l-1 14H6L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
  </Icon>
)

// ---------------- 安全 / 隐私 ----------------

export const Shield = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3 5 6v6c0 4.6 3 8.6 7 10 4-1.4 7-5.4 7-10V6l-7-3z" />
    <path d="m9 12 2 2 4-4" />
  </Icon>
)
export const ShieldWarn = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3 5 6v6c0 4.6 3 8.6 7 10 4-1.4 7-5.4 7-10V6l-7-3z" />
    <path d="M12 8v4.5" />
    <path d="M12 16h.01" />
  </Icon>
)
export const ShieldOff = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3 5 6v6c0 4.6 3 8.6 7 10 4-1.4 7-5.4 7-10V6l-7-3z" />
    <path d="m9.5 9.5 5 5" />
    <path d="m14.5 9.5-5 5" />
  </Icon>
)
export const Fingerprint = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4c-2 0-3.8.7-5.2 2" />
    <path d="M4.6 8.4A8.9 8.9 0 0 0 3.2 13" />
    <path d="M20.8 12.4c0-3.9-2.4-7.2-5.8-8.6" />
    <path d="M8 20.2A9 9 0 0 1 4.4 16" />
    <path d="M12 8.4c1.9 0 3.4 1.5 3.4 3.4 0 2-.5 4-1.4 5.7" />
    <path d="M8.6 11.8c0-1.9 1.5-3.4 3.4-3.4" />
    <path d="M12 11.8v3.4c0 1-.2 2-.5 2.9" />
    <path d="M19 17.5c.5-1.4.8-2.8.8-4.3" />
  </Icon>
)
export const EyeOff = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 3l18 18" />
    <path d="M10.6 5.2A9.9 9.9 0 0 1 12 5c5 0 9 4.5 9 7 0 .8-.3 1.7-.9 2.7" />
    <path d="M6.6 6.7C4.3 8.1 3 10.2 3 12c0 2.5 4 7 9 7 1.3 0 2.5-.3 3.6-.8" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </Icon>
)
/** 显示（用于密钥 / Token 的明文切换） */
export const Eye = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 12c0-2.5 4-7 9-7s9 4.5 9 7-4 7-9 7-9-4.5-9-7z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
)
/** 重新检查 / 刷新（用于 MCP 服务器状态） */
export const Refresh = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" />
    <path d="M20.5 4v4h-4" />
  </Icon>
)
export const Incognito = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 13h18" />
    <path d="M6.5 13 9 6h6l2.5 7" />
    <circle cx="7" cy="17" r="2.4" />
    <circle cx="17" cy="17" r="2.4" />
  </Icon>
)

// ---------------- 功能分区图标 ----------------

export const Gear = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 14.6a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.4 1z" />
  </Icon>
)
export const Palette = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3a9 9 0 0 0 0 18c1.1 0 2-.9 2-2v-.7c0-.5.2-1 .5-1.3.3-.4.8-.6 1.3-.6H18a3 3 0 0 0 3-3c0-5.5-4-10.4-9-10.4z" />
    <circle cx="8" cy="10" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="7.5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="16" cy="10" r="1.2" fill="currentColor" stroke="none" />
  </Icon>
)
export const Bolt = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2z" />
  </Icon>
)
export const Leaf = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 20c0-8 5-14 16-15 0 11-5.5 16-13 15" />
    <path d="M8.5 15.5C10.5 12 3.8 12.2 4 20" />
  </Icon>
)
export const Rocket = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13.5 3.5C17 4 20 7 20.5 10.5c-1 3-3.5 5.4-6.5 6.5l-4-4c1.1-3 3.5-5.4 6.5-6.5" />
    <path d="M10 13c-1.5-1.5-3-1-4.5.5S4 17 4 17s2-.3 3.5-1.8S11 14.5 10 13z" />
    <circle cx="15.5" cy="8.5" r="1.4" />
  </Icon>
)
export const Gauge = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 18a9 9 0 1 1 16 0" />
    <path d="m12 14 4-4" />
    <circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none" />
  </Icon>
)
export const User = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
  </Icon>
)
export const Sync = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 11a8 8 0 0 0-13.7-5.3L4 8" />
    <path d="M4 4v4h4" />
    <path d="M4 13a8 8 0 0 0 13.7 5.3L20 16" />
    <path d="M20 20v-4h-4" />
  </Icon>
)
export const Grid = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
  </Icon>
)
export const Puzzle = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 4.5a2 2 0 1 1 4 0V6h3a1 1 0 0 1 1 1v3h1.5a2 2 0 1 1 0 4H18v3a1 1 0 0 1-1 1h-3v-1.5a2 2 0 1 0-4 0V18H7a1 1 0 0 1-1-1v-3H4.5a2 2 0 1 1 0-4H6V7a1 1 0 0 1 1-1h3V4.5z" />
  </Icon>
)
export const Plug = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 3v6" />
    <path d="M15 3v6" />
    <path d="M6 9h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V9z" />
    <path d="M12 18v3" />
  </Icon>
)
export const Server = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <path d="M7 7.5h.01" />
    <path d="M7 16.5h.01" />
  </Icon>
)
export const Key = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="m11 12 9-9" />
    <path d="m17 4 3 3" />
    <path d="m14.5 6.5 2.5 2.5" />
  </Icon>
)
export const Terminal = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="m7.5 9.5 2.5 2.5-2.5 2.5" />
    <path d="M13 15h4" />
  </Icon>
)
export const Info = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <path d="M12 8h.01" />
  </Icon>
)
export const Warning = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Icon>
)
export const Check = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5 13 4.5 4.5L19 7" />
  </Icon>
)
export const Sparkles = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5 13.7 9l5.3 1.7-5.3 1.7L12 18l-1.7-5.6L5 10.7 10.3 9 12 3.5z" />
    <path d="M18.5 3.5v3" />
    <path d="M20 5h-3" />
    <path d="M5.5 17v2.5" />
    <path d="M6.8 18.2H4.2" />
  </Icon>
)
export const Send = (p: IconProps) => (
  <Icon {...p}>
    <path d="m21.5 3-8 18-3.2-7.3L3 10.5 21.5 3z" />
  </Icon>
)
export const Copy = (p: IconProps) => (
  <Icon {...p}>
    <rect x="9" y="9" width="12" height="12" rx="2.5" />
    <path d="M15 6.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1.5" />
  </Icon>
)
export const Laptop = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="5" width="16" height="11" rx="2" />
    <path d="M2.5 19h19" />
  </Icon>
)
export const Doc = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h6" />
    <path d="M9 17h4" />
  </Icon>
)
export const Code = (p: IconProps) => (
  <Icon {...p}>
    <path d="m9 8-5 4 5 4" />
    <path d="m15 8 5 4-5 4" />
  </Icon>
)
export const Cloud = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 18a4 4 0 0 1-.4-8A5.5 5.5 0 0 1 17 8.6 3.7 3.7 0 0 1 17.5 18H7z" />
  </Icon>
)
export const Upload = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 17V5" />
    <path d="m7 10 5-5 5 5" />
    <path d="M4 21h16" />
  </Icon>
)
export const Backup = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7a8 8 0 1 1 2.3 5.6" />
    <path d="M4 3v4h4" />
    <circle cx="12" cy="13" r="2.5" />
    <path d="M12 15.5V19" />
  </Icon>
)
export const License = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="3" width="16" height="18" rx="2.5" />
    <path d="M8 8h8" />
    <path d="M8 12h8" />
    <path d="M8 16h4" />
  </Icon>
)

// ---------------- 品牌（自绘） ----------------

/** TiBrowser 标记：龟壳 + 火花，纯几何自绘，不含任何第三方品牌元素 */
export const TurtleMark = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5 19 8v6l-7 6.5L5 14V8l7-4.5z" />
    <path d="M12 8.5 15.5 11v3L12 16.5 8.5 14v-3L12 8.5z" />
  </Icon>
)
