// 并行分块下载 CEF 内核发行包（单一 TCP 流在国内 CDN 上只有 ~0.4MB/s，8 路并发可显著提速）
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const URL_BASE = 'https://cef-builds.spotifycdn.com/'
const OUT_DIR = join(process.cwd(), '.cef-cache')
const CONCURRENCY = 8

/** 取发行索引，返回指定 channel / 架构的最新版本信息 */
async function resolveVersion(channel, arch) {
  const res = await fetch(URL_BASE + 'index.json')
  const idx = await res.json()
  const list = idx[`windows${arch}`]?.versions ?? []
  const hit = list.find((v) => v.channel === channel)
  if (!hit) throw new Error(`未找到 ${channel} / ${arch} 的 CEF 版本`)
  // 标准发行包 = 名字以 `_windows64.tar.bz2` 结尾（_minimal/_tools/_symbols 等变体不匹配）
  const standard = hit.files.find((f) => /_windows64\.tar\.bz2$/.test(f.name))
  if (!standard) throw new Error('未在索引中找到标准发行包（_windows64.tar.bz2）')
  const minimal = hit.files.find((f) => f.name.includes('_minimal.tar.bz2'))
  // 索引里给的是规范 URL（含百分号编码），直接使用，避免自己拼接时漏编码 `+`
  const url = standard.url ?? URL_BASE + hit.cef_version + '/' + standard.name
  return { version: hit.cef_version, standard, minimal, url }
}

/** 并行分块下载：按索引里已知的总长度切 N 段，各自带 Range 头并发写同一文件的对应偏移 */
async function parallelDownload(url, dest, expectedSize) {
  // 索引里已有权威大小，避免依赖 HEAD 的 content-length（该 CDN 不一定回）
  let total = expectedSize
  if (!total) {
    const head = await fetch(url, { method: 'HEAD' })
    total = Number(head.headers.get('content-length'))
  }
  if (!total) throw new Error('无法确定文件总长度，不能分块下载')
  const partSize = Math.ceil(total / CONCURRENCY)
  const fh = await open(dest, 'w')
  await fh.close()

  let done = 0
  const started = Date.now()
  const report = () => {
    const mb = done / 1048576
    const speed = mb / ((Date.now() - started) / 1000)
    process.stderr.write(
      `\r  进度 ${mb.toFixed(1)}/${(total / 1048576).toFixed(1)} MB  ${speed.toFixed(2)} MB/s   `
    )
  }

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async (_, i) => {
      const start = i * partSize
      const end = Math.min(start + partSize - 1, total - 1)
      if (start > end) return
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } })
      if (!res.ok) throw new Error(`分块 ${i} 请求失败 HTTP ${res.status}`)
      const f = await open(dest, 'r+')
      try {
        const reader = res.body.getReader()
        let pos = start
        for (;;) {
          const { done: end2, value } = await reader.read()
          if (end2) break
          await f.write(value, 0, value.length, pos)
          pos += value.length
          done += value.length
          if (done % (1 << 20) < value.length) report()
        }
      } finally {
        await f.close()
      }
    })
  )
  report()
  process.stderr.write('\n')
  return total
}

const channel = process.argv[2] ?? 'stable'
const arch = process.argv[3] ?? '64'
const info = await resolveVersion(channel, arch)
const meta = info.standard
const dest = join(OUT_DIR, meta.name)

mkdirSync(OUT_DIR, { recursive: true })
if (existsSync(dest) && statSync(dest).size === meta.size) {
  console.error(`已存在完整文件，跳过下载：${dest}`)
} else {
  await rm(dest, { force: true })
  console.error(`下载 CEF ${info.version} → ${dest}`)
  const got = await parallelDownload(info.url, dest, meta.size)
  if (got !== meta.size) {
    console.error(`大小校验失败：期望 ${meta.size}，实际 ${got}`)
    process.exit(1)
  }
}

// 交给调用方：打印结果 JSON，供脚本链式使用
console.log(
  JSON.stringify({
    cefVersion: info.version,
    archive: dest,
    size: meta.size,
    minimal: info.minimal?.name ?? null
  })
)
