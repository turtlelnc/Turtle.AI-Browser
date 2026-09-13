/**
 * 本地开发模式（Tare + codex 能力对标）。
 *
 * 六项能力：
 * 1. `read`　读工程文件　2. `write`　写工程文件　3. `run`　运行命令
 * 4. `test`　跑测试　　　5. `patch`　生成补丁　6. `explain-error` 解释报错
 *
 * 三重安全边界（缺一不可）：
 * - **工作区沙箱**：所有路径必须落在用户授权目录内（见 `./workspace.ts`，含符号链接逃逸检查）；
 * - **显式白名单**：可执行命令必须在 `workspace.allowCommands` 中，且不经过 shell；
 * - **演练模式**：`workspace.dryRun=true` 时只返回「将要做什么」，绝不写文件、不跑命令。
 *
 * 诚实原则：能力不可用时返回明确的中文错误（未授权目录、命令不在白名单、文件是二进制……），
 * 绝不返回伪造的成功结果。本地不做 AST 级重构，补丁基于真实文件内容的行级 diff。
 */

import type { AiProviderConfig, CliPermissionLevel } from '../../shared/types.js'
import { simpleAsk } from '../client.js'
import { runAgent, type AgentResult, type AgentHandlers } from '../agent.js'
import type { ToolContext } from '../tools.js'
import type { CommandResult, Workspace } from './workspace.js'

export type DevAction = 'read' | 'write' | 'run' | 'test' | 'patch' | 'explain-error'

export interface DevCapability {
  id: DevAction
  name: string
  description: string
  /** 是否需要工作区授权 */
  requiresWorkspace: boolean
}

/** 本地开发模式的六项能力 */
export const DEV_CAPABILITIES: DevCapability[] = [
  {
    id: 'read',
    name: '读取工程文件',
    description: '读取工作区内的文本文件（二进制文件会被拒绝，单次默认最多 64 KiB）。',
    requiresWorkspace: true
  },
  {
    id: 'write',
    name: '写入工程文件',
    description:
      '写入或覆盖工作区内的文本文件（原子写：临时文件 + rename）。演练模式下只返回将要写入的内容，不落盘。',
    requiresWorkspace: true
  },
  {
    id: 'run',
    name: '运行命令',
    description:
      '在工作区内执行白名单命令（默认 node/npm/npx/git/tsc），不经 shell，含危险命令模式拦截与超时。',
    requiresWorkspace: true
  },
  {
    id: 'test',
    name: '运行测试',
    description:
      '自动识别工程类型（package.json / pyproject / Cargo.toml 等）并执行对应测试命令；识别失败时回退到用户配置的 testCommand。',
    requiresWorkspace: true
  },
  {
    id: 'patch',
    name: '生成补丁',
    description:
      '给定「原文件路径 + 目标文件路径（或新内容）」，生成统一 diff 补丁文本并写入 .patch 文件；不自动应用。',
    requiresWorkspace: true
  },
  {
    id: 'explain-error',
    name: '解释报错',
    description:
      '结合报错文本与相关源码，给出中文原因分析、定位线索与修复建议；不做 AST 级自动修复。',
    requiresWorkspace: false
  }
]

export interface DevResult {
  ok: boolean
  action: DevAction
  /** 中文消息（成功说明或失败原因） */
  message: string
  /** 结果数据（各能力不同） */
  data?: unknown
  /** 补丁文本（patch 能力） */
  patch?: string
  toolLogs: AgentResult['toolLogs']
}

export interface DevDeps {
  config: AiProviderConfig
  level: CliPermissionLevel
  workspace: Workspace | null
  makeToolContext: () => ToolContext
  signal: AbortSignal
  handlers?: AgentHandlers
}

/** 本地开发模式 */
export class DevMode {
  constructor(private readonly deps: DevDeps) {}

  listCapabilities(): DevCapability[] {
    return DEV_CAPABILITIES
  }

  /** 当前沙箱状态（供 UI 与自动化展示，避免用户误以为可以随便读写） */
  status(): {
    workspaceRoot: string
    available: boolean
    dryRun: boolean
    allowCommands: string[]
  } {
    const ws = this.deps.workspace
    return {
      workspaceRoot: ws?.root ?? '',
      available: Boolean(ws?.available),
      dryRun: ws?.dryRun ?? true,
      allowCommands: ws?.allowCommands ?? []
    }
  }

  async run(params: {
    action: DevAction
    path?: string
    content?: string
    command?: string
    cwd?: string
    errorText?: string
    instruction?: string
    options?: Record<string, unknown>
  }): Promise<DevResult> {
    const cap = DEV_CAPABILITIES.find((c) => c.id === params.action)
    if (!cap) {
      return this.fail(
        params.action,
        `未知的开发能力「${params.action}」。可用：${DEV_CAPABILITIES.map((c) => c.id).join('、')}`
      )
    }
    const ws = this.deps.workspace
    if (cap.requiresWorkspace && !ws?.available) {
      return this.fail(
        cap.id,
        ws?.root
          ? `工作区目录不可用：${ws.root}（可能不存在或没有权限）。`
          : '尚未授权工作区目录（settings.workspace.root）。出于安全考虑，本地开发模式默认不访问任何目录，请先在设置中授权。'
      )
    }

    try {
      switch (cap.id) {
        case 'read':
          return this.read(params.path ?? '')
        case 'write':
          return this.write(params.path ?? '', params.content ?? '')
        case 'run':
          return await this.runCommand(params.command ?? '', params.cwd ?? '.')
        case 'test':
          return await this.runTests(params.options)
        case 'patch':
          return await this.patch(params)
        case 'explain-error':
          return await this.explainError(params.errorText ?? '', params.path, params.instruction)
        default:
          return this.fail(cap.id, `能力「${cap.name}」尚未实现。`)
      }
    } catch (e) {
      return this.fail(cap.id, e instanceof Error ? e.message : String(e))
    }
  }

  /** 1. 读取工程文件 */
  private read(path: string): DevResult {
    const ws = this.requireWorkspace()
    if (!path.trim()) return this.fail('read', '请提供要读取的文件路径（path）。')
    const file = ws.readFile(path, 64 * 1024)
    return {
      ok: true,
      action: 'read',
      message: `已读取 ${file.path}（${file.size} 字节${file.truncated ? '，已截断到前 64 KiB' : ''}）。`,
      data: file,
      toolLogs: []
    }
  }

  /** 2. 写入工程文件 */
  private write(path: string, content: string): DevResult {
    const ws = this.requireWorkspace()
    if (!path.trim()) return this.fail('write', '请提供要写入的文件路径（path）。')
    if (content === undefined || content === null) {
      return this.fail('write', '请提供要写入的内容（content）。')
    }
    const r = ws.writeFile(path, content)
    return {
      ok: true,
      action: 'write',
      message: r.message,
      data: r,
      toolLogs: []
    }
  }

  /** 3. 运行命令 */
  private async runCommand(command: string, cwd: string): Promise<DevResult> {
    const ws = this.requireWorkspace()
    if (!command.trim()) return this.fail('run', '请提供要执行的命令（command）。')
    const result = await ws.runCommand(command, cwd)
    if (result.denied) {
      return { ok: false, action: 'run', message: result.denied, data: result, toolLogs: [] }
    }
    if (result.dryRun) {
      return {
        ok: true,
        action: 'run',
        message: `演练模式：已校验命令「${result.argv.join(' ')}」在白名单与安全规则内，但未真正执行。可在设置中关闭 workspace.dryRun 后重试。`,
        data: result,
        toolLogs: []
      }
    }
    return {
      ok: result.ok,
      action: 'run',
      message: result.ok
        ? `命令执行成功（退出码 0，耗时 ${result.elapsedMs} 毫秒）。`
        : `命令执行失败（退出码 ${result.exitCode ?? '未知'}，耗时 ${result.elapsedMs} 毫秒）。`,
      data: result,
      toolLogs: []
    }
  }

  /** 4. 运行测试（自动识别工程类型） */
  private async runTests(options?: Record<string, unknown>): Promise<DevResult> {
    const ws = this.requireWorkspace()
    const explicit = String(options?.['command'] ?? '').trim()
    const detected = explicit || detectTestCommand(ws)
    if (!detected) {
      return this.fail(
        'test',
        '无法自动识别测试命令：工作区内没有找到 package.json（带 test 脚本）、pyproject.toml/pytest.ini、Cargo.toml 或 go.mod。请在参数中显式提供 command。'
      )
    }
    const result = await ws.runCommand(detected, String(options?.['cwd'] ?? '.'))
    if (result.denied) {
      return { ok: false, action: 'test', message: result.denied, data: result, toolLogs: [] }
    }
    if (result.dryRun) {
      return {
        ok: true,
        action: 'test',
        message: `演练模式：识别到的测试命令为「${detected}」，未真正执行。`,
        data: result,
        toolLogs: []
      }
    }
    return {
      ok: result.ok,
      action: 'test',
      message: result.ok
        ? `测试通过（命令：${detected}，耗时 ${result.elapsedMs} 毫秒）。`
        : `测试失败（命令：${detected}，退出码 ${result.exitCode ?? '未知'}）。`,
      data: result,
      toolLogs: []
    }
  }

  /** 5. 生成补丁 */
  private async patch(params: {
    path?: string
    content?: string
    options?: Record<string, unknown>
  }): Promise<DevResult> {
    const ws = this.requireWorkspace()
    const originalPath = String(params.path ?? '').trim()
    if (!originalPath) return this.fail('patch', '请提供原文件路径（path）。')

    const original = ws.readFile(originalPath, 512 * 1024)
    let nextContent = params.content
    const targetPath = String(params.options?.['targetPath'] ?? '').trim()
    if (nextContent === undefined && targetPath) {
      nextContent = ws.readFile(targetPath, 512 * 1024).content
    }
    if (typeof nextContent !== 'string') {
      return this.fail(
        'patch',
        '生成补丁需要「修改后的完整内容」（content）或「修改后的文件路径」（options.targetPath）二者之一。'
      )
    }

    const patchText = unifiedDiff(original.path, original.content, nextContent)
    if (!patchText.trim()) {
      return {
        ok: true,
        action: 'patch',
        message: '两份内容完全一致，无需生成补丁。',
        patch: '',
        toolLogs: []
      }
    }

    // 补丁文件写入工作区（同样受沙箱约束）；演练模式不落盘
    const patchName = `${originalPath.replace(/[\\/]/g, '_')}.patch`
    let written = ''
    try {
      const r = ws.writeFile(patchName, patchText)
      written = r.dryRun ? `（演练模式：补丁未落盘，路径将为 ${r.path}）` : `补丁已写入 ${r.path}`
    } catch (e) {
      written = `补丁文件写入失败（${e instanceof Error ? e.message : String(e)}），但下方补丁文本仍然可用。`
    }

    return {
      ok: true,
      action: 'patch',
      message: `已生成统一 diff 补丁（${patchText.split('\n').length} 行）。${written} 可用 git apply 应用，边车不会自动修改文件。`,
      patch: patchText,
      data: { hunks: patchText.split('\n').filter((l) => l.startsWith('@@')).length },
      toolLogs: []
    }
  }

  /** 6. 解释报错 */
  private async explainError(
    errorText: string,
    path?: string,
    instruction?: string
  ): Promise<DevResult> {
    let source = ''
    let sourcePath = ''
    if (path?.trim() && this.deps.workspace?.available) {
      try {
        const f = this.deps.workspace.readFile(path, 64 * 1024)
        source = f.content
        sourcePath = f.path
      } catch (e) {
        // 读不到源码不影响解释报错，如实说明
        source = ''
        sourcePath = `（读取 ${path} 失败：${e instanceof Error ? e.message : String(e)}）`
      }
    }
    if (!errorText.trim() && !source) {
      return this.fail('explain-error', '请提供报错文本（errorText），或提供工作区内可读取的源文件路径（path）。')
    }
    const matches = matchKnownErrors(errorText)
    if (!this.deps.config.apiKey?.trim()) {
      return {
        ok: true,
        action: 'explain-error',
        message:
          '尚未设置 API Key，无法调用模型做深度解释。以下为本地规则库的匹配结果（不依赖模型）：',
        data: { knownErrors: matches, sourcePath },
        toolLogs: []
      }
    }
    try {
      const text = await simpleAsk(
        this.deps.config,
        '你是一名严谨的中文工程师助手。只依据用户提供的报错文本与源码作答，不要编造文件内容或行号；不确定时说明「需要更多信息」。',
        [
          '请解释下面的报错，并给出修复方案：',
          '1) 根本原因（中文，尽量具体到机制）；',
          '2) 定位线索（涉及哪些文件/行/模块，只依据提供的内容）；',
          '3) 修复步骤（可执行的改动，按优先级排序）；',
          '4) 如何验证已修复。',
          instruction ? `附加要求：${instruction}` : '',
          '',
          '报错文本：',
          '```',
          errorText || '（用户未提供报错文本）',
          '```',
          '',
          source ? `相关源码（${sourcePath}）：\n\`\`\`\n${source}\n\`\`\`` : '',
          matches.length
            ? `\n本地规则库匹配到以下已知错误模式（供参考）：\n\`\`\`json\n${JSON.stringify(matches, null, 2)}\n\`\`\``
            : ''
        ]
          .filter(Boolean)
          .join('\n'),
        { signal: this.deps.signal }
      )
      return {
        ok: true,
        action: 'explain-error',
        message: text,
        data: { knownErrors: matches, sourcePath },
        toolLogs: []
      }
    } catch (e) {
      return this.fail(
        'explain-error',
        `调用模型失败：${e instanceof Error ? e.message : String(e)}。本地规则库匹配结果：${JSON.stringify(matches)}`
      )
    }
  }

  /** 供上层调用：用智能体循环执行一个自由开发任务 */
  async runAgentTask(userMessage: string): Promise<AgentResult> {
    return runAgent({
      config: this.deps.config,
      level: this.deps.level,
      history: [],
      userMessage,
      ctx: this.deps.makeToolContext(),
      signal: this.deps.signal,
      ...(this.deps.handlers ? { handlers: this.deps.handlers } : {})
    })
  }

  private requireWorkspace(): Workspace {
    const ws = this.deps.workspace
    if (!ws?.available) {
      throw new Error(
        ws?.root
          ? `工作区目录不可用：${ws.root}`
          : '尚未授权工作区目录（settings.workspace.root）。'
      )
    }
    return ws
  }

  private fail(action: DevAction, message: string): DevResult {
    return { ok: false, action, message, toolLogs: [] }
  }
}

/** 依据工程标志文件推断测试命令；识别不到返回空串 */
export function detectTestCommand(ws: Workspace): string {
  const probe = (rel: string): string => {
    try {
      ws.readFile(rel, 4096)
      return rel
    } catch {
      return ''
    }
  }
  const pkg = probe('package.json')
  if (pkg) {
    try {
      const json = JSON.parse(ws.readFile('package.json', 64 * 1024).content) as {
        scripts?: Record<string, string>
      }
      if (json.scripts?.['test']) return 'npm test'
      if (json.scripts?.['test:unit']) return 'npm run test:unit'
    } catch {
      /* package.json 损坏，继续尝试其他标志 */
    }
  }
  if (probe('pyproject.toml') || probe('pytest.ini') || probe('setup.py')) return 'pytest'
  if (probe('Cargo.toml')) return 'cargo test'
  if (probe('go.mod')) return 'go test ./...'
  if (probe('Makefile')) return 'make test'
  return ''
}

/** 已知错误模式库（本地确定性匹配，不依赖模型） */
export const KNOWN_ERRORS: { re: RegExp; name: string; hint: string }[] = [
  {
    re: /EADDRINUSE/,
    name: '端口已被占用（EADDRINUSE）',
    hint: '该端口已被其他进程监听。换端口，或用 netstat -ano | findstr :<端口> 找到占用进程后结束它。'
  },
  {
    re: /ENOENT[^\n]*no such file|Cannot find module|MODULE_NOT_FOUND/,
    name: '文件或模块不存在',
    hint: '检查路径拼写、工作目录是否正确，以及依赖是否已安装（npm install）。'
  },
  {
    re: /EACCES|EPERM|permission denied/i,
    name: '权限不足（EACCES/EPERM）',
    hint: '目标文件被占用或当前用户无权限。关闭占用该文件的程序，或改用有写权限的目录。'
  },
  {
    re: /ECONNREFUSED/,
    name: '连接被拒绝（ECONNREFUSED）',
    hint: '目标服务未启动或地址/端口不对。确认服务已监听，并检查是否被防火墙拦截。'
  },
  {
    re: /ETIMEDOUT|timeout of \d+ms exceeded/i,
    name: '请求超时',
    hint: '目标服务响应过慢或网络不通。检查网络/代理，并适当提高超时时间。'
  },
  {
    re: /TS\d{4}:/,
    name: 'TypeScript 编译错误',
    hint: '按 TS 错误码定位：TS2307 找不到模块、TS2345 参数类型不匹配、TS2532 可能为 undefined。'
  },
  {
    re: /SyntaxError|Unexpected token/,
    name: '语法错误',
    hint: '检查报错指向位置的括号、逗号与引号匹配；注意 JSON 不允许尾随逗号与注释。'
  },
  {
    re: /TypeError: Cannot read prop\w* of (undefined|null)|undefined is not an object/i,
    name: '空值访问（Cannot read property of undefined）',
    hint: '访问链上某个对象为 undefined/null。用可选链 ?. 或在使用前做判空，并用断点确认哪一层为空。'
  },
  {
    re: /UnhandledPromiseRejection|unhandledRejection/,
    name: '未处理的 Promise 拒绝',
    hint: '有 async 调用未 catch。为相关调用补 try/catch 或 .catch()，避免异常被静默吞掉。'
  },
  {
    re: /heap out of memory|JavaScript heap/i,
    name: 'Node 堆内存溢出',
    hint: '提高内存或用流式处理：NODE_OPTIONS=--max-old-space-size=4096；同时排查内存泄漏（未释放的监听器/大数组）。'
  },
  {
    re: /npm ERR! code ERESOLVE/,
    name: '依赖版本冲突（ERESOLVE）',
    hint: '依赖树存在 peer 冲突。优先升级冲突包；临时可用 --legacy-peer-deps，但会隐藏真实冲突。'
  },
  {
    re: /error: failed to push some refs|rejected.*non-fast-forward/i,
    name: 'Git 推送被拒绝（非快进）',
    hint: '远端有新提交。先 git pull --rebase，解决冲突后再推送；不要直接 --force。'
  },
  {
    re: /CONFLICT \(content\)|Merge conflict in/,
    name: 'Git 合并冲突',
    hint: '手工编辑冲突文件（<<<<<<< / ======= / >>>>>>>），git add 后 git rebase --continue 或 git commit。'
  },
  {
    re: /Access is denied|拒绝访问/i,
    name: 'Windows 访问被拒绝',
    hint: '以管理员身份运行，或检查杀毒/受控文件夹访问是否拦截；也可换到用户目录下操作。'
  },
  {
    re: /out of disk|ENOSPC/,
    name: '磁盘空间不足（ENOSPC）',
    hint: '清理磁盘或更换输出目录；检查是否是依赖安装目录过大。'
  }
]

/** 匹配已知错误模式 */
export function matchKnownErrors(text: string): Array<{ name: string; hint: string }> {
  const out: Array<{ name: string; hint: string }> = []
  for (const k of KNOWN_ERRORS) {
    if (k.re.test(text)) out.push({ name: k.name, hint: k.hint })
  }
  return out
}

/**
 * 生成统一 diff（行级 LCS）。
 * 仅用于展示与 git apply，不做二进制 diff。
 */
export function unifiedDiff(
  path: string,
  before: string,
  after: string,
  contextLines = 3
): string {
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  const ops = diffOps(a, b)
  if (!ops.some((o) => o.type !== 'equal')) return ''

  const header = `--- a/${path}\n+++ b/${path}\n`
  const hunks: string[] = []
  let i = 0
  while (i < ops.length) {
    // 跳过相同的行，直到距离下一个变更不超过 contextLines
    if (ops[i]?.type === 'equal') {
      i++
      continue
    }
    const start = Math.max(0, i - contextLines)
    let end = i
    let gap = 0
    while (end < ops.length) {
      if (ops[end]?.type === 'equal') {
        gap++
        if (gap > contextLines * 2) break
      } else {
        gap = 0
      }
      end++
    }
    const slice = ops.slice(start, Math.min(ops.length, end))
    const aStart = 1 + ops.slice(0, start).filter((o) => o.type !== 'insert').length
    const bStart = 1 + ops.slice(0, start).filter((o) => o.type !== 'delete').length
    const aCount = slice.filter((o) => o.type !== 'insert').length
    const bCount = slice.filter((o) => o.type !== 'delete').length
    hunks.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`)
    for (const op of slice) {
      const prefix = op.type === 'equal' ? ' ' : op.type === 'delete' ? '-' : '+'
      hunks.push(`${prefix}${op.line}`)
    }
    i = end
  }
  return header + hunks.join('\n') + '\n'
}

interface DiffOp {
  type: 'equal' | 'delete' | 'insert'
  line: string
}

/** 基于 LCS 的行级 diff（工程文件规模下性能足够；超长文件退化为朴素替换） */
function diffOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length
  const m = b.length
  if (n * m > 4_000_000) {
    // 超大文件（约 > 2000 行 × 2000 行）退化为整体替换，避免 O(n*m) 内存
    return [
      ...a.map((line) => ({ type: 'delete' as const, line })),
      ...b.map((line) => ({ type: 'insert' as const, line }))
    ]
  }
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? (lcs[i + 1]![j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]![j] ?? 0, lcs[i]![j + 1] ?? 0)
    }
  }
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', line: a[i] ?? '' })
      i++
      j++
    } else if ((lcs[i + 1]![j] ?? 0) >= (lcs[i]![j + 1] ?? 0)) {
      ops.push({ type: 'delete', line: a[i] ?? '' })
      i++
    } else {
      ops.push({ type: 'insert', line: b[j] ?? '' })
      j++
    }
  }
  while (i < n) ops.push({ type: 'delete', line: a[i++] ?? '' })
  while (j < m) ops.push({ type: 'insert', line: b[j++] ?? '' })
  return ops
}

/** 命令执行结果的中文摘要（供 UI 展示） */
export function summarizeCommand(result: CommandResult): string {
  const lines = [
    `命令：${result.argv.join(' ')}`,
    `目录：${result.cwd}`,
    `退出码：${result.exitCode ?? '（未执行）'}`,
    `耗时：${result.elapsedMs} 毫秒`
  ]
  if (result.denied) lines.push(`已拒绝：${result.denied}`)
  if (result.dryRun) lines.push('演练模式：未真正执行。')
  if (result.stdout) lines.push(`--- stdout ---\n${result.stdout.slice(-4000)}`)
  if (result.stderr) lines.push(`--- stderr ---\n${result.stderr.slice(-4000)}`)
  return lines.join('\n')
}
