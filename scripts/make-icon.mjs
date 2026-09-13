// 从 build/icon.png（根目录 ico.png 的放大版，512x512）生成多尺寸 Windows 图标 build/icon.ico
// 用法：node scripts/make-icon.mjs
//
// 为什么需要这一步：ico.png 原始尺寸只有 152x152，而 Windows 需要 256x256 档图标；
// 本脚本以同一图形放大后的 build/icon.png 为源，生成 256/128/64/48/32/16 六个尺寸，
// 供原生外壳（native/resources/tibrowser.rc）与安装包共用。
//
// 实现说明：Node 没有内置图像处理能力，缩放与 PNG 编码交给 Windows 自带的 .NET
// （System.Drawing），ICO 容器由本脚本按规范拼装，因此不引入任何 npm 依赖。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SOURCE = join(ROOT, 'build', 'icon.png')
const TARGET = join(ROOT, 'build', 'icon.ico')
const SIZES = [256, 128, 64, 48, 32, 16]

/** ICO 容器里直接嵌入 PNG（Vista 及以上支持），无需额外的图像库 */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(entries.length, 4)

  let offset = 6 + 16 * entries.length
  const directory = []
  for (const { size, data } of entries) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0) // 宽（0 表示 256）
    entry.writeUInt8(size >= 256 ? 0 : size, 1) // 高
    entry.writeUInt8(0, 2) // 调色板数
    entry.writeUInt8(0, 3) // 保留
    entry.writeUInt16LE(1, 4) // 色彩平面
    entry.writeUInt16LE(32, 6) // 位深
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += data.length
    directory.push(entry)
  }
  return Buffer.concat([header, ...directory, ...entries.map((e) => e.data)])
}

if (!existsSync(SOURCE)) {
  console.error(`未找到源图 ${SOURCE}。请先把根目录 ico.png 放大为 512x512 的 build/icon.png。`)
  process.exit(1)
}

const outDir = join(ROOT, '.cef-cache', 'icons')
const ps = `
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path "${outDir}" | Out-Null
$src = [System.Drawing.Image]::FromFile("${SOURCE}")
foreach ($s in @(${SIZES.join(',')})) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($src, 0, 0, $s, $s)
  $g.Dispose()
  $bmp.Save("${outDir}\\$s.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
$src.Dispose()
`
const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
  stdio: 'inherit'
})
if (res.status !== 0) {
  console.error('缩放 PNG 失败：请确认系统 PowerShell 与 .NET System.Drawing 可用')
  process.exit(1)
}

const entries = SIZES.map((size) => ({
  size,
  data: readFileSync(join(outDir, `${size}.png`))
}))
writeFileSync(TARGET, buildIco(entries))
console.log(`已生成 ${TARGET}（尺寸 ${SIZES.join('/')}，${(entries.reduce((n, e) => n + e.data.length, 0) / 1024).toFixed(1)} KB）`)
