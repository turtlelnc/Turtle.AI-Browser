/**
 * 展示层的格式化工具（时间 / 体积 / 域名）。
 * 与桥接无关，因此不与 `bridge.ts` 混在一起，避免设置分区为了格式化而依赖桥实现。
 */

/** 把毫秒时间戳格式化为「刚刚 / x 分钟前 / YYYY-MM-DD HH:mm」 */
export function formatTime(ts: number | undefined | null): string {
  if (!ts) return '从未'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 字节数格式化（1024 进制） */
export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

/** 从 URL 取主机名（失败时退化为原串） */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
