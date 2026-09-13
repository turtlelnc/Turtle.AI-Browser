/**
 * 边车服务入口。
 *
 * 用法：
 * ```text
 * node dist/index.js [--port <n>] [--token-file <path>] [--energy-mode <mode>] [--headless]
 *                    [--user-data <dir>] [--blocklists <dir>]
 * ```
 *
 * **stdout 只输出一行 JSON**（原生父进程据此判定就绪并解析端口）：
 * ```json
 * {"ready":true,"port":51234,"version":"1.0.0-rc1","build":260913,"capabilities":[...]}
 * ```
 * 其他一切日志（含警告与错误）一律写 stderr，避免污染这一行。
 *
 * 退出码：0 = 被正常要求关闭（SIGINT/SIGTERM/service.shutdown）；1 = 启动失败。
 */

import { existsSync, readFileSync } from 'node:fs'
import { TibService } from './app.js'
import { setLifecycleHooks } from './rpc/methods.js'
import { APP_BUILD, APP_VERSION } from './shared/constants.js'

interface CliOptions {
  port: number
  tokenFile: string
  token: string
  energyMode: string
  headless: boolean
  userData: string
  blocklists: string
  help: boolean
}

/** 解析命令行参数 */
export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    port: 0,
    tokenFile: '',
    token: '',
    energyMode: '',
    headless: false,
    userData: '',
    blocklists: '',
    help: false
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    const [flag, inlineValue] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, '']
    const next = (): string => inlineValue || argv[++i] || ''
    switch (flag) {
      case '--port':
      case '-p':
        opts.port = Number(next()) || 0
        break
      case '--token-file':
        opts.tokenFile = next()
        break
      case '--token':
        opts.token = next()
        break
      case '--energy-mode':
        opts.energyMode = next()
        break
      case '--user-data':
        opts.userData = next()
        break
      case '--blocklists':
        opts.blocklists = next()
        break
      case '--headless':
        opts.headless = true
        break
      case '--help':
      case '-h':
        opts.help = true
        break
      default:
        if (flag.startsWith('-')) {
          process.stderr.write(`[service] 未识别的参数：${flag}（已忽略）\n`)
        }
    }
  }
  return opts
}

/** 从握手文件读取 token（ARCHITECTURE.md §4：原生先写 <userData>/service.json） */
export function readTokenFile(path: string): string {
  if (!path || !existsSync(path)) return ''
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { token?: string }
    return (raw.token ?? '').trim()
  } catch (e) {
    process.stderr.write(
      `[service] 握手文件解析失败（将改用随机 token）：${path}（${e instanceof Error ? e.message : String(e)}）\n`
    )
    return ''
  }
}

const HELP = `TiBrowser 边车服务 ${APP_VERSION} (build ${APP_BUILD})

用法：node dist/index.js [选项]
  --port <n>              指定监听端口（默认 0 = 系统分配）
  --token-file <path>     从握手文件读取 Bearer token（默认 <userData>/service.json）
  --token <token>         直接指定 token（仅自检/调试使用）
  --energy-mode <mode>    能效档位（performance|balanced|saver|instant），用于能力降级提示
  --user-data <dir>       覆盖用户数据目录（默认 %APPDATA%/TiBrowser）
  --blocklists <dir>      运行时黑名单目录（默认 ./resources/blocklists）
  --headless              无界面模式：不自动拉起 MCP 服务器、不写自动化发现文件
  --help                  显示本帮助

stdout 只输出一行就绪 JSON；其余日志走 stderr。
`

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(HELP)
    process.exit(0)
  }

  const log = (m: string): void => void process.stderr.write(`${m}\n`)
  const token = opts.token.trim() || readTokenFile(opts.tokenFile) || ''

  const service = new TibService({
    port: opts.port,
    ...(token ? { token } : {}),
    ...(opts.userData ? { userDataDirOverride: opts.userData } : {}),
    ...(opts.blocklists ? { blocklistDir: opts.blocklists } : {}),
    energyMode: opts.energyMode,
    headless: opts.headless,
    log
  })

  // 生命周期钩子：优雅退出 & 设置变更后刷新发现文件
  setLifecycleHooks({
    shutdown: async () => {
      await service.stop()
      process.exit(0)
    },
    onSettingsChanged: () => service.onSettingsChanged()
  })

  let info
  try {
    info = await service.init()
  } catch (e) {
    log(`[service] 启动失败：${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
    return
  }

  // 唯一一行 stdout：原生父进程解析它判定就绪
  process.stdout.write(`${JSON.stringify(info)}\n`)
  log(
    `[service] 就绪：端口 ${info.port}，能力 ${info.capabilities.length} 项，能效模式 ${opts.energyMode || '(未指定)'}`
  )

  let closing = false
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return
    closing = true
    log(`[service] 收到 ${signal}，正在关闭……`)
    await service.stop().catch(() => {
      /* 忽略关闭错误 */
    })
    log('[service] 已关闭。')
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('uncaughtException', (e) => {
    log(`[service] 未捕获异常：${e.stack ?? e.message}`)
  })
  process.on('unhandledRejection', (e) => {
    log(`[service] 未处理的 Promise 拒绝：${e instanceof Error ? e.message : String(e)}`)
  })

  // 保持进程存活（RPC 服务器本身已持有 handle，这里只是显式声明意图）
  setInterval(() => {
    /* 心跳占位：真正的保活由 http server 负责 */
  }, 60_000).unref?.()
}

// 仅在被直接执行时启动（被 import 时只导出工具函数，便于自检复用 parseArgs）
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('index.js') || process.argv[1].endsWith('index.ts'))

if (isMain) {
  void main()
}

export { main }
