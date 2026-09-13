/**
 * 沙箱化本地工作区（本地开发模式 / 本地办公模式的共同基础设施）。
 *
 * 安全设计（**默认拒绝**）：
 * 1. 必须由用户显式授权 `root`（settings.workspace.root），未授权时所有操作直接报中文错误；
 * 2. 所有路径解析后必须仍然位于 `root` 之内——用 `relative()` 而不是字符串前缀比较，
 *    因此 `..\\..\\Windows\\System32`、`C:\\root-evil`（同前缀不同目录）、
 *    以及通过符号链接逃逸的路径都会被拒绝；
 * 3. 命中 `.git` / `node_modules` / 系统目录等敏感路径的黑名单时拒绝；
 * 4. 命令执行按**可执行文件名白名单**匹配，且不经过 shell（`spawn` + 参数数组），
 *    因此 `npm test; rm -rf /` 这类 shell 注入不成立（分号会作为普通参数传给 npm）；
 * 5. `dryRun` 演练模式：只返回「将要做什么」，不写文件、不执行命令。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writeTextAtomic } from '../../store/json-store.js'

/** 单文件读写上限（默认值，可被调用方覆盖） */
export const DEFAULT_MAX_READ_BYTES = 64 * 1024
export const MAX_WRITE_BYTES = 4 * 1024 * 1024

/** 命中即拒绝的路径片段（相对工作区） */
const DENY_SEGMENTS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.ssh',
  '.aws',
  '.gnupg',
  'AppData',
  'Windows',
  'System32',
  'Program Files',
  'Program Files (x86)'
])

/** 危险命令模式（即使可执行文件在白名单内也要拦） */
const DANGEROUS_PATTERNS: { re: RegExp; message: string }[] = [
  { re: /\brm\s+-[a-z]*[rf]/i, message: '包含递归/强制删除（rm -rf）' },
  { re: /\b(rmdir|rd)\s+\/s/i, message: '包含递归删除目录（rd /s）' },
  { re: /\bdel\s+\/[a-z]*[sq]/i, message: '包含静默/递归删除（del /s /q）' },
  { re: /\bformat\s+[a-z]:/i, message: '包含格式化磁盘' },
  { re: /\bmkfs(\.\w+)?\b/i, message: '包含创建文件系统（mkfs）' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, message: '包含关机/重启' },
  { re: /\bdiskpart\b/i, message: '包含磁盘分区工具' },
  { re: /\breg\s+(add|delete|import)\b/i, message: '包含注册表修改' },
  { re: /\bcurl\b[^|]*\|\s*(ba|z|da)?sh/i, message: '包含「下载后管道执行」（curl | sh）' },
  { re: /\biwr\b[^|]*\|\s*iex/i, message: '包含 PowerShell 远程执行（iwr | iex）' },
  { re: />\s*(\/dev\/sd|\\\\\.\\PhysicalDrive)/i, message: '包含对物理磁盘的写入' },
  { re: /\bchmod\s+-R\s+777\s+\//i, message: '包含对根目录的权限放开' },
  { re: /:\(\)\s*\{.*\};\s*:/, message: '包含 fork 炸弹' },
  { re: /\bgit\s+push\b[^|]*--force/i, message: '包含强制推送（--force）' }
]

/** 路径解析结果 */
export interface ResolvedPath {
  /** 绝对路径 */
  absolute: string
  /** 相对工作区根的路径（POSIX 风格斜杠） */
  relative: string
}

/** 命令执行结果 */
export interface CommandResult {
  ok: boolean
  /** 实际执行的命令（数组形式，便于用户核对） */
  argv: string[]
  cwd: string
  exitCode: number | null
  stdout: string
  stderr: string
  /** 是否被拒绝（含拒绝原因） */
  denied?: string
  /** 是否为演练模式（未真正执行） */
  dryRun?: boolean
  /** 耗时（毫秒） */
  elapsedMs: number
}

export interface RunCommandOptions {
  /** 超时（毫秒），默认 120 秒 */
  timeoutMs?: number
  maxOutputBytes?: number
}

export interface WorkspaceOptions {
  /** 工作区根目录；空串表示未授权 */
  root: string
  /** 可执行文件名白名单 */
  allowCommands: string[]
  /** 演练模式 */
  dryRun: boolean
  /** 额外允许的相对路径前缀（例如用户额外授权的子目录） */
  allowPaths?: string[]
  /** 单次命令超时 */
  timeoutMs?: number
}

/** 路径越界错误 */
export class WorkspaceDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceDeniedError'
  }
}

export class Workspace {
  constructor(private readonly options: WorkspaceOptions) {}

  get root(): string {
    return this.options.root?.trim() ?? ''
  }

  get dryRun(): boolean {
    return this.options.dryRun
  }

  get allowCommands(): string[] {
    return this.options.allowCommands.slice()
  }

  /** 是否已授权可用 */
  get available(): boolean {
    return Boolean(this.root) && existsSync(this.root)
  }

  /** 未授权时的统一中文错误 */
  private assertAvailable(): void {
    if (!this.root) {
      throw new WorkspaceDeniedError(
        '尚未授权本地工作区目录：请在设置（workspace.root）中指定一个目录后重试。出于安全考虑，边车默认不访问任何本地目录。'
      )
    }
    if (!existsSync(this.root)) {
      throw new WorkspaceDeniedError(`工作区目录不存在：${this.root}`)
    }
  }

  /**
   * 把用户/模型给出的路径解析为工作区内的绝对路径。
   * 越界、命中黑名单、绝对路径逃逸都会抛 `WorkspaceDeniedError`。
   */
  resolvePath(input: string): ResolvedPath {
    this.assertAvailable()
    const rootAbs = resolve(this.root)
    const raw = (input ?? '').trim() || '.'
    if (raw.includes('\0')) throw new WorkspaceDeniedError('路径包含非法字符（NUL）。')

    const target = isAbsolute(raw) ? resolve(raw) : resolve(rootAbs, raw)
    const rel = relative(rootAbs, target)

    if (rel === '') {
      return { absolute: target, relative: '.' }
    }
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new WorkspaceDeniedError(
        `路径越界：${raw} 不在已授权的工作区（${rootAbs}）之内，已拒绝访问。`
      )
    }

    const segments = rel.split(/[\\/]+/).filter(Boolean)
    for (const seg of segments) {
      if (DENY_SEGMENTS.has(seg)) {
        throw new WorkspaceDeniedError(`路径命中断点保护名单（${seg}），已拒绝访问：${raw}`)
      }
    }

    // 已存在的路径再做一次 realpath 校验，防止符号链接逃逸
    if (existsSync(target)) {
      try {
        const realRoot = realpathSync(rootAbs)
        const realTarget = realpathSync(target)
        const realRel = relative(realRoot, realTarget)
        if (realRel.startsWith('..') || isAbsolute(realRel)) {
          throw new WorkspaceDeniedError(
            `路径经符号链接后越出工作区，已拒绝访问：${raw} → ${realTarget}`
          )
        }
      } catch (e) {
        if (e instanceof WorkspaceDeniedError) throw e
        /* realpath 失败（权限等）时忽略，前面的相对路径校验已足够 */
      }
    }

    return { absolute: target, relative: segments.join('/') }
  }

  /** 列出目录内容 */
  listFiles(dir = '.', depth = 1): {
    root: string
    dir: string
    depth: number
    entries: Array<{ name: string; path: string; type: 'file' | 'dir'; size: number }>
  } {
    const { absolute, relative: rel } = this.resolvePath(dir)
    const d = Math.max(1, Math.min(3, Math.floor(Number(depth) || 1)))
    const entries: Array<{ name: string; path: string; type: 'file' | 'dir'; size: number }> = []
    const walk = (current: string, level: number): void => {
      if (level > d) return
      let names: string[] = []
      try {
        names = readdirSync(current)
      } catch {
        return
      }
      for (const name of names) {
        if (DENY_SEGMENTS.has(name)) continue
        const full = join(current, name)
        let st
        try {
          st = statSync(full)
        } catch {
          continue
        }
        const isDir = st.isDirectory()
        entries.push({
          name,
          path: relative(resolve(this.root), full).split(sep).join('/'),
          type: isDir ? 'dir' : 'file',
          size: isDir ? 0 : st.size
        })
        if (isDir && level < d) walk(full, level + 1)
        if (entries.length > 2000) return
      }
    }
    walk(absolute, 1)
    return { root: resolve(this.root), dir: rel, depth: d, entries }
  }

  /** 读取文本文件（超过上限会截断并标注） */
  readFile(
    path: string,
    maxBytes = DEFAULT_MAX_READ_BYTES
  ): { path: string; size: number; truncated: boolean; encoding: string; content: string } {
    const { absolute, relative: rel } = this.resolvePath(path)
    const st = statSync(absolute)
    if (st.isDirectory()) throw new WorkspaceDeniedError(`目标是一个目录，不是文件：${rel}`)
    const limit = Math.max(1, Math.min(st.size, Math.floor(Number(maxBytes) || DEFAULT_MAX_READ_BYTES)))
    const buf = readFileSync(absolute)
    const slice = buf.subarray(0, limit)
    // 二进制检测：出现 NUL 字节即判定为二进制，拒绝按文本返回
    if (slice.includes(0)) {
      throw new WorkspaceDeniedError(
        `文件 ${rel} 看起来是二进制文件（含 NUL 字节），本地开发模式只处理文本文件。`
      )
    }
    return {
      path: rel,
      size: st.size,
      truncated: st.size > limit,
      encoding: 'utf-8',
      content: slice.toString('utf-8')
    }
  }

  /** 写入文本文件（演练模式只返回计划） */
  writeFile(
    path: string,
    content: string
  ): { ok: boolean; path: string; bytes: number; dryRun: boolean; message: string } {
    const { absolute, relative: rel } = this.resolvePath(path)
    const bytes = Buffer.byteLength(content ?? '', 'utf-8')
    if (bytes > MAX_WRITE_BYTES) {
      throw new WorkspaceDeniedError(
        `写入内容过大（${bytes} 字节），单次上限 ${MAX_WRITE_BYTES} 字节。`
      )
    }
    if (this.dryRun) {
      return {
        ok: true,
        path: rel,
        bytes,
        dryRun: true,
        message: `演练模式：已规划写入 ${rel}（${bytes} 字节），未真正落盘。可在设置中关闭 workspace.dryRun 后重试。`
      }
    }
    mkdirSync(dirname(absolute), { recursive: true })
    // 原子写纯文本（临时文件 + fsync + rename），绝不走 JSON 序列化
    writeTextAtomic(absolute, content ?? '')
    return { ok: true, path: rel, bytes, dryRun: false, message: `已写入 ${rel}` }
  }

  /** 写入原始文本（保留原文，不做 JSON 转义） */
  writeTextFile(path: string, content: string): ReturnType<Workspace['writeFile']> {
    return this.writeFile(path, content)
  }

  /** 解析并校验命令（不执行） */
  inspectCommand(
    command: string,
    cwd = '.'
  ): {
    allowed: boolean
    reason: string
    argv: string[]
    exe: string
    cwdAbs: string
  } {
    const cmd = (command ?? '').trim()
    const dir = this.resolvePath(cwd)
    if (!cmd) {
      return { allowed: false, reason: '命令为空。', argv: [], exe: '', cwdAbs: dir.absolute }
    }
    // 简单分词（支持双引号包裹的参数），刻意不支持 shell 语法
    const argv = tokenize(cmd)
    const exe = (argv[0] ?? '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase()
    if (!exe) {
      return { allowed: false, reason: '命令为空。', argv, exe: '', cwdAbs: dir.absolute }
    }
    const allow = this.options.allowCommands.map((c) => c.toLowerCase())
    if (!allow.includes(exe)) {
      return {
        allowed: false,
        reason: `命令「${exe}」不在白名单内。当前允许：${allow.join('、') || '（空）'}。可在设置 workspace.allowCommands 中添加。`,
        argv,
        exe,
        cwdAbs: dir.absolute
      }
    }
    for (const p of DANGEROUS_PATTERNS) {
      if (p.re.test(cmd)) {
        return {
          allowed: false,
          reason: `命令被安全规则拒绝：${p.message}。`,
          argv,
          exe,
          cwdAbs: dir.absolute
        }
      }
    }
    // 参数中的路径也要在工作区内（拒绝 `node C:\\Windows\\x.js`）
    for (const arg of argv.slice(1)) {
      if (/^[a-z]:[\\/]/i.test(arg) || arg.startsWith('/') || arg.startsWith('..')) {
        try {
          this.resolvePath(arg)
        } catch (e) {
          return {
            allowed: false,
            reason: `命令参数中的路径越出工作区，已拒绝：${arg}（${e instanceof Error ? e.message : String(e)}）`,
            argv,
            exe,
            cwdAbs: dir.absolute
          }
        }
      }
    }
    return { allowed: true, reason: '允许执行', argv, exe, cwdAbs: dir.absolute }
  }

  /** 在沙箱内执行命令（演练模式只返回计划） */
  async runCommand(
    command: string,
    cwd = '.',
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    this.assertAvailable()
    const inspected = this.inspectCommand(command, cwd)
    const started = Date.now()
    if (!inspected.allowed) {
      return {
        ok: false,
        argv: inspected.argv,
        cwd: inspected.cwdAbs,
        exitCode: null,
        stdout: '',
        stderr: '',
        denied: inspected.reason,
        elapsedMs: 0
      }
    }
    if (this.dryRun) {
      return {
        ok: true,
        argv: inspected.argv,
        cwd: inspected.cwdAbs,
        exitCode: null,
        stdout: '',
        stderr: '',
        dryRun: true,
        elapsedMs: 0
      }
    }
    return execArgv(inspected.argv, inspected.cwdAbs, {
      timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? 120_000,
      maxOutputBytes: options.maxOutputBytes ?? 256 * 1024,
      started
    })
  }
}

/** 简单分词：支持双引号，不支持转义与 shell 语法（刻意为之） */
export function tokenize(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote = false
  for (const ch of command) {
    if (ch === '"') {
      quote = !quote
      continue
    }
    if (!quote && /\s/.test(ch)) {
      if (current) out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current) out.push(current)
  return out
}

interface ExecOptions {
  timeoutMs: number
  maxOutputBytes: number
  started: number
}

function execArgv(argv: string[], cwd: string, opts: ExecOptions): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const [file, ...args] = argv
    if (!file) {
      resolvePromise({
        ok: false,
        argv,
        cwd,
        exitCode: null,
        stdout: '',
        stderr: '',
        denied: '命令为空。',
        elapsedMs: 0
      })
      return
    }
    const child = spawn(file, args, {
      cwd,
      shell: false, // 关键：不经过 shell，杜绝命令注入
      windowsHide: true,
      env: { ...process.env, TIB_WORKSPACE: cwd }
    })
    let stdout = ''
    let stderr = ''
    let truncated = false
    let settled = false
    const append = (target: 'out' | 'err', chunk: string): void => {
      const total = stdout.length + stderr.length
      if (total >= opts.maxOutputBytes) {
        truncated = true
        return
      }
      const remain = opts.maxOutputBytes - total
      const text = chunk.length > remain ? chunk.slice(0, remain) : chunk
      if (chunk.length > remain) truncated = true
      if (target === 'out') stdout += text
      else stderr += text
    }
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (d: string) => append('out', d))
    child.stderr.on('data', (d: string) => append('err', d))

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* 忽略 */
      }
      resolvePromise({
        ok: false,
        argv,
        cwd,
        exitCode: null,
        stdout,
        stderr: stderr + `\n命令超时（${opts.timeoutMs} 毫秒），已终止。`,
        elapsedMs: Date.now() - opts.started
      })
    }, opts.timeoutMs)

    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        ok: false,
        argv,
        cwd,
        exitCode: null,
        stdout,
        stderr: `${stderr}\n无法启动命令：${e.message}`,
        elapsedMs: Date.now() - opts.started
      })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        ok: code === 0,
        argv,
        cwd,
        exitCode: code,
        stdout: truncated ? `${stdout}\n…（输出已截断）` : stdout,
        stderr,
        elapsedMs: Date.now() - opts.started
      })
    })
  })
}

/**
 * 对已有工作区做一次「只读体检」，供本地开发模式给出上下文。
 */
export function workspaceSnapshot(ws: Workspace, depth = 2): ReturnType<Workspace['listFiles']> {
  return ws.listFiles('.', depth)
}
