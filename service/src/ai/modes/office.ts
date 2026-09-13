/**
 * 本地办公模式（WorkBuddy 能力对标）。
 *
 * 六项能力，全部基于**用户显式授权的工作区目录**里的真实文件：
 * 1. 文档摘要　2. 表格处理　3. 邮件草拟　4. 会议纪要　5. 日程整理　6. 演示大纲
 *
 * 诚实原则：
 * - 未授权工作区 → 直接返回中文错误，不做任何「假装读完文件」的回答；
 * - 表格处理会**真的**解析 CSV 并做确定性统计（行数/列/数值列合计/空值），
 *   再把统计结果交给模型做解读，而不是让模型凭空计算；
 * - 读取失败、编码不支持、文件过大都会如实报错。
 */

import type { AiProviderConfig, CliPermissionLevel } from '../../shared/types.js'
import { simpleAsk } from '../client.js'
import { runAgent, type AgentResult, type AgentHandlers } from '../agent.js'
import type { ToolContext } from '../tools.js'
import type { Workspace } from './workspace.js'

export type OfficeCapabilityId =
  | 'doc-summary'
  | 'sheet-process'
  | 'email-draft'
  | 'meeting-minutes'
  | 'schedule-organize'
  | 'slide-outline'

export interface OfficeCapability {
  id: OfficeCapabilityId
  /** 中文名称 */
  name: string
  /** 需要用户提供的输入（中文） */
  inputs: string[]
  /** 产出（中文） */
  output: string
  /** 是否必需工作区授权 */
  requiresWorkspace: boolean
  /** 中文说明（含能力边界，不夸大） */
  description: string
}

/** 六项办公能力清单 */
export const OFFICE_CAPABILITIES: OfficeCapability[] = [
  {
    id: 'doc-summary',
    name: '文档摘要',
    inputs: ['工作区内的文本文件路径（.md/.txt/.csv/.json/.log 等）'],
    output: '结构化中文摘要：核心结论、关键数据、待办事项',
    requiresWorkspace: true,
    description:
      '读取本地文本文件并生成摘要。仅支持**纯文本类**文件；PDF/Word 二进制格式不会被解析（边车不内置解析库，也不谎称支持）。'
  },
  {
    id: 'sheet-process',
    name: '表格处理',
    inputs: ['工作区内的 CSV 文件路径', '可选：分析目标（如「按月份汇总销售额」）'],
    output: '确定性统计（行数/列/数值合计/空值/重复行）+ 中文解读',
    requiresWorkspace: true,
    description:
      '边车**本地真实解析 CSV**（支持引号转义与双引号转义），统计结果由代码计算而非模型估算。仅支持逗号分隔的 CSV；xlsx 需用户先另存为 CSV。'
  },
  {
    id: 'email-draft',
    name: '邮件草拟',
    inputs: ['邮件目的', '收件人称呼', '可选：要点清单/附件路径'],
    output: '中文邮件草稿（主题 + 正文），不发送',
    requiresWorkspace: false,
    description:
      '只生成草稿文本，**不会发送邮件**、不访问邮箱、不读取通讯录。需要发送请用户自行复制到邮件客户端。'
  },
  {
    id: 'meeting-minutes',
    name: '会议纪要',
    inputs: ['工作区内的会议记录/转写文本路径', '可选：参会人名单'],
    output: '规范会议纪要：议题、结论、决议、待办（含负责人与期限占位）',
    requiresWorkspace: true,
    description:
      '基于用户提供的**文本**记录整理。边车不做语音转写（无本地 ASR 能力），需要用户自行提供文字稿。'
  },
  {
    id: 'schedule-organize',
    name: '日程整理',
    inputs: ['工作区内的日程/待办文本路径', '可选：时间范围'],
    output: '按时间与优先级排序的日程表，标注冲突与缺口',
    requiresWorkspace: true,
    description:
      '整理文本形式的日程。边车**不接入**系统日历/Outlook/Google Calendar（无凭据、无 API），只做文本层面的整理。'
  },
  {
    id: 'slide-outline',
    name: '演示大纲',
    inputs: ['主题或源文档路径', '可选：页数、听众'],
    output: '分页大纲：每页标题、要点、建议配图方向',
    requiresWorkspace: false,
    description:
      '生成 Markdown 大纲文本。边车**不生成** .pptx 文件（不内置 Office 文档库），用户可用大纲在任意演示工具中落地。'
  }
]

export interface OfficeTaskResult {
  ok: boolean
  capability: OfficeCapabilityId
  /** 中文结果（正文） */
  content: string
  /** 涉及的文件（相对工作区路径） */
  files: string[]
  /** 确定性统计（表格能力会填） */
  facts?: Record<string, unknown>
  /** 智能体工具调用日志 */
  toolLogs: AgentResult['toolLogs']
  /** 失败原因（中文） */
  error: string
}

export interface OfficeDeps {
  config: AiProviderConfig
  level: CliPermissionLevel
  workspace: Workspace | null
  /** 构造工具上下文（用于智能体循环） */
  makeToolContext: () => ToolContext
  /** 是否允许智能体使用浏览器工具（办公模式默认不需要） */
  signal: AbortSignal
  handlers?: AgentHandlers
}

/** 本地办公模式 */
export class OfficeMode {
  constructor(private readonly deps: OfficeDeps) {}

  listCapabilities(): OfficeCapability[] {
    return OFFICE_CAPABILITIES
  }

  /** 统一的输入 */
  async run(params: {
    capability: OfficeCapabilityId
    /** 主输入：文件路径或自由文本 */
    input: string
    /** 附加要求 */
    instruction?: string
    /** 表格/日程等能力的时间范围等 */
    options?: Record<string, unknown>
  }): Promise<OfficeTaskResult> {
    const cap = OFFICE_CAPABILITIES.find((c) => c.id === params.capability)
    if (!cap) {
      return this.fail(
        params.capability,
        `未知的办公能力「${params.capability}」。可用：${OFFICE_CAPABILITIES.map((c) => c.id).join('、')}`
      )
    }
    const input = (params.input ?? '').trim()
    if (!input) return this.fail(cap.id, `能力「${cap.name}」需要输入：${cap.inputs.join('；')}`)
    if (cap.requiresWorkspace && !this.deps.workspace?.available) {
      return this.fail(
        cap.id,
        `能力「${cap.name}」需要读取本地文件，但尚未授权工作区目录（settings.workspace.root）。请在设置中指定目录后重试。`
      )
    }

    switch (cap.id) {
      case 'doc-summary':
        return this.docSummary(input, params.instruction)
      case 'sheet-process':
        return this.sheetProcess(input, params.instruction)
      case 'email-draft':
        return this.emailDraft(input, params.instruction, params.options)
      case 'meeting-minutes':
        return this.meetingMinutes(input, params.instruction, params.options)
      case 'schedule-organize':
        return this.scheduleOrganize(input, params.instruction, params.options)
      case 'slide-outline':
        return this.slideOutline(input, params.instruction, params.options)
      default:
        return this.fail(cap.id, `能力「${cap.name}」尚未实现。`)
    }
  }

  // ---------- 1. 文档摘要 ----------
  private async docSummary(path: string, instruction?: string): Promise<OfficeTaskResult> {
    const ws = this.requireWorkspace()
    let file: ReturnType<Workspace['readFile']>
    try {
      file = ws.readFile(path, 120_000)
    } catch (e) {
      return this.fail('doc-summary', `读取文件失败：${e instanceof Error ? e.message : String(e)}`)
    }
    const content = await this.ask(
      '你是一名严谨的中文文档助理。请只依据用户提供的文本作答，不得编造未出现的信息；信息不足时明确写出「原文未提及」。',
      [
        `请对以下文件生成中文摘要，结构为：`,
        `1) 一句话结论；2) 核心要点（3-7 条，每条一行）；3) 关键数据（原文出现的数字/日期/金额，逐条列出）；4) 待办或后续动作（如无则写「未提及」）。`,
        instruction ? `附加要求：${instruction}` : '',
        ``,
        `文件路径：${file.path}（共 ${file.size} 字节${file.truncated ? '，已截断到前 12 万字节' : ''}）`,
        '```',
        file.content,
        '```'
      ]
        .filter(Boolean)
        .join('\n')
    )
    if (!content.ok) return this.fail('doc-summary', content.error)
    return this.ok('doc-summary', content.text, [file.path], { size: file.size, truncated: file.truncated })
  }

  // ---------- 2. 表格处理（本地确定性统计 + 模型解读） ----------
  private async sheetProcess(path: string, instruction?: string): Promise<OfficeTaskResult> {
    const ws = this.requireWorkspace()
    let file: ReturnType<Workspace['readFile']>
    try {
      file = ws.readFile(path, 4 * 1024 * 1024)
    } catch (e) {
      return this.fail('sheet-process', `读取 CSV 失败：${e instanceof Error ? e.message : String(e)}`)
    }
    let stats: CsvStats
    try {
      stats = analyzeCsv(file.content)
    } catch (e) {
      return this.fail('sheet-process', `解析 CSV 失败：${e instanceof Error ? e.message : String(e)}`)
    }
    const content = await this.ask(
      '你是一名中文数据分析助理。下面的统计数字由程序精确计算得出，**必须直接采信**，不要自行重新计算或质疑数字。',
      [
        `以下是对 CSV 文件 ${file.path} 的程序化统计结果（JSON）：`,
        '```json',
        JSON.stringify(stats, null, 2),
        '```',
        instruction ? `用户的分析目标：${instruction}` : '用户未指定分析目标，请给出总体解读。',
        '',
        '请输出：1) 数据概览（行数/列数/表头）；2) 数值列的关键结论（合计/均值/极值，引用上面的数字）；3) 数据质量问题（空值、重复行、类型混杂）；4) 建议的下一步分析。全部用中文。'
      ].join('\n')
    )
    if (!content.ok) {
      // 即使模型不可用，也把程序算出的统计结果返回给用户（本地能力不依赖模型）
      return {
        ok: true,
        capability: 'sheet-process',
        content: `（模型不可用：${content.error}）以下为本地程序计算的统计结果：\n\n\`\`\`json\n${JSON.stringify(stats, null, 2)}\n\`\`\``,
        files: [file.path],
        facts: stats as unknown as Record<string, unknown>,
        toolLogs: [],
        error: ''
      }
    }
    return this.ok('sheet-process', content.text, [file.path], stats as unknown as Record<string, unknown>)
  }

  // ---------- 3. 邮件草拟 ----------
  private async emailDraft(
    purpose: string,
    instruction?: string,
    options?: Record<string, unknown>
  ): Promise<OfficeTaskResult> {
    const to = String(options?.['to'] ?? '').trim()
    const tone = String(options?.['tone'] ?? '正式').trim()
    const content = await this.ask(
      '你是一名中文商务写作助理。只输出邮件本身（主题 + 正文），不要添加解释性文字，不要编造收件人姓名、公司名或具体承诺。',
      [
        `请草拟一封中文邮件。`,
        `写作目的：${purpose}`,
        to ? `收件人称呼：${to}` : '收件人称呼：请用「您好」等通用称呼，不要编造姓名。',
        `语气：${tone}`,
        instruction ? `附加要求：${instruction}` : '',
        '',
        '输出格式：',
        '主题：<一行主题>',
        '',
        '<正文，含称呼、正文段落、结尾与署名占位【您的姓名】>'
      ]
        .filter(Boolean)
        .join('\n')
    )
    if (!content.ok) return this.fail('email-draft', content.error)
    return this.ok('email-draft', content.text, [], { note: '仅生成草稿，未发送任何邮件。' })
  }

  // ---------- 4. 会议纪要 ----------
  private async meetingMinutes(
    path: string,
    instruction?: string,
    options?: Record<string, unknown>
  ): Promise<OfficeTaskResult> {
    const ws = this.requireWorkspace()
    let file: ReturnType<Workspace['readFile']>
    try {
      file = ws.readFile(path, 200_000)
    } catch (e) {
      return this.fail('meeting-minutes', `读取会议记录失败：${e instanceof Error ? e.message : String(e)}`)
    }
    const attendees = String(options?.['attendees'] ?? '').trim()
    const content = await this.ask(
      '你是一名专业的中文会议记录员。只依据提供的文字稿整理，不得虚构发言人、决议或时间。信息缺失时写「未提及」。',
      [
        '请把下面的会议文字稿整理成规范的中文会议纪要，包含：',
        '一、会议信息（时间/地点/参会人——文字稿未提及则写「未提及」）',
        '二、议题清单',
        '三、讨论要点（按议题分条）',
        '四、形成的决议（明确区分「已决议」与「待定」）',
        '五、待办事项（表格：事项 | 建议负责人 | 期限；文字稿未指定则填「待确认」）',
        attendees ? `已知参会人：${attendees}` : '',
        instruction ? `附加要求：${instruction}` : '',
        '',
        `文字稿（${file.path}，${file.size} 字节${file.truncated ? '，已截断' : ''}）：`,
        '```',
        file.content,
        '```'
      ]
        .filter(Boolean)
        .join('\n')
    )
    if (!content.ok) return this.fail('meeting-minutes', content.error)
    return this.ok('meeting-minutes', content.text, [file.path], { size: file.size })
  }

  // ---------- 5. 日程整理 ----------
  private async scheduleOrganize(
    path: string,
    instruction?: string,
    options?: Record<string, unknown>
  ): Promise<OfficeTaskResult> {
    const ws = this.requireWorkspace()
    let file: ReturnType<Workspace['readFile']>
    try {
      file = ws.readFile(path, 200_000)
    } catch (e) {
      return this.fail('schedule-organize', `读取日程文件失败：${e instanceof Error ? e.message : String(e)}`)
    }
    const range = String(options?.['range'] ?? '').trim()
    // 本地确定性提取：日期/时间样式的行，交给模型前先做一遍结构化
    const dateHits = extractDateLines(file.content)
    const content = await this.ask(
      '你是一名中文日程助理。只整理用户提供的文本，不要凭空添加会议或时间。',
      [
        '请把下面的日程/待办文本整理成清晰的日程表：',
        '1) 按时间先后排序的列表（时间 | 事项 | 地点/参与人 | 优先级）；',
        '2) 冲突提示（同一时间段重叠的事项）；',
        '3) 时间空档（若可判断）；',
        '4) 信息不全、需要用户补充确认的条目。',
        range ? `用户关注的时间范围：${range}` : '',
        instruction ? `附加要求：${instruction}` : '',
        '',
        '程序已识别出以下含日期/时间的行（供参考，可能有遗漏）：',
        '```json',
        JSON.stringify(dateHits.slice(0, 60), null, 2),
        '```',
        '',
        '原始文本：',
        '```',
        file.content,
        '```'
      ]
        .filter(Boolean)
        .join('\n')
    )
    if (!content.ok) return this.fail('schedule-organize', content.error)
    return this.ok('schedule-organize', content.text, [file.path], { dateLines: dateHits.length })
  }

  // ---------- 6. 演示大纲 ----------
  private async slideOutline(
    input: string,
    instruction?: string,
    options?: Record<string, unknown>
  ): Promise<OfficeTaskResult> {
    const slides = Number(options?.['slides'] ?? 12)
    const audience = String(options?.['audience'] ?? '').trim()
    const output = await this.ask(
      '你是一名中文演示顾问。只输出大纲文本，不要生成文件，不要编造未提供的数据。',
      [
        `请为下面的主题/源材料生成演示文稿大纲，共约 ${Number.isFinite(slides) ? slides : 12} 页。`,
        audience ? `目标听众：${audience}` : '目标听众：未指定，请按通用商务场景处理。',
        instruction ? `附加要求：${instruction}` : '',
        '',
        '输出格式（Markdown）：',
        '## 第 N 页：标题',
        '- 要点 1',
        '- 要点 2',
        '- 建议配图/呈现方式：…',
        '',
        '主题或源材料：',
        '```',
        input,
        '```'
      ]
        .filter(Boolean)
        .join('\n')
    )
    if (!output.ok) return this.fail('slide-outline', output.error)
    return this.ok('slide-outline', output.text, [], {
      note: '仅生成 Markdown 大纲，未生成 .pptx 文件（边车不内置 Office 文档库）。'
    })
  }

  // ---------- 内部工具 ----------

  /** 单轮模型调用（办公模式不需要工具循环） */
  private async ask(system: string, user: string): Promise<{ ok: boolean; text: string; error: string }> {
    const cfg = this.deps.config
    if (!cfg.apiKey?.trim()) {
      return { ok: false, text: '', error: '尚未设置 API Key，无法调用模型。请在设置中填写后重试。' }
    }
    try {
      const text = await simpleAsk(cfg, system, user, { signal: this.deps.signal })
      return { ok: true, text, error: '' }
    } catch (e) {
      return { ok: false, text: '', error: `调用模型失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  private requireWorkspace(): Workspace {
    const ws = this.deps.workspace
    if (!ws || !ws.available) {
      throw new Error('尚未授权工作区目录（settings.workspace.root）。')
    }
    return ws
  }

  private ok(
    capability: OfficeCapabilityId,
    content: string,
    files: string[],
    facts?: Record<string, unknown>
  ): OfficeTaskResult {
    return { ok: true, capability, content, files, ...(facts ? { facts } : {}), toolLogs: [], error: '' }
  }

  private fail(capability: OfficeCapabilityId, error: string): OfficeTaskResult {
    return { ok: false, capability, content: '', files: [], toolLogs: [], error }
  }

  /** 供上层调用：用智能体循环执行一个自由办公任务（会用到工作区工具） */
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
}

// ---------- CSV 确定性分析 ----------

export interface CsvColumnStat {
  name: string
  /** 推断类型 */
  type: 'number' | 'text' | 'empty'
  /** 非空数量 */
  nonEmpty: number
  /** 空值数量 */
  empty: number
  /** 唯一值数量（仅非数值列统计，最多统计 5000 个不同值） */
  unique?: number
  /** 数值列统计 */
  sum?: number
  mean?: number
  min?: number
  max?: number
}

export interface CsvStats {
  /** 总行数（不含表头） */
  rows: number
  columns: number
  header: string[]
  columnStats: CsvColumnStat[]
  /** 完全重复的行数 */
  duplicateRows: number
  /** 解析告警（中文） */
  warnings: string[]
}

/** 解析一行 CSV（支持双引号包裹与 "" 转义） */
export function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

/** 对 CSV 文本做确定性统计（不调用模型） */
export function analyzeCsv(text: string): CsvStats {
  const warnings: string[] = []
  const lines = text.split(/\r?\n/).filter((l, idx, arr) => !(idx === arr.length - 1 && !l.trim()))
  if (!lines.length) throw new Error('CSV 内容为空。')
  const header = parseCsvLine(lines[0] ?? '').map((h, i) => h.trim() || `列${i + 1}`)
  const dataLines = lines.slice(1).filter((l) => l.trim())
  const seen = new Set<string>()
  let duplicateRows = 0

  const numeric: number[][] = header.map(() => [])
  const nonEmpty: number[] = header.map(() => 0)
  const uniqueSets: Array<Set<string> | null> = header.map(() => new Set<string>())

  for (const line of dataLines) {
    const cells = parseCsvLine(line)
    if (cells.length !== header.length) {
      if (warnings.length < 5) {
        warnings.push(`第 ${dataLines.indexOf(line) + 2} 行有 ${cells.length} 个字段，与表头 ${header.length} 列不一致。`)
      }
    }
    const key = cells.join('\u0001')
    if (seen.has(key)) duplicateRows++
    else seen.add(key)

    for (let c = 0; c < header.length; c++) {
      const raw = (cells[c] ?? '').trim()
      if (raw === '') continue
      nonEmpty[c] = (nonEmpty[c] ?? 0) + 1
      const numericValue = Number(raw.replace(/,/g, ''))
      if (raw !== '' && Number.isFinite(numericValue) && /^[-+]?[\d.,]+%?$/.test(raw)) {
        numeric[c]?.push(raw.endsWith('%') ? numericValue : numericValue)
      }
      const set = uniqueSets[c]
      if (set && set.size < 5000) set.add(raw)
    }
  }

  const columnStats: CsvColumnStat[] = header.map((name, c) => {
    const nums = numeric[c] ?? []
    const filled = nonEmpty[c] ?? 0
    const isNumeric = filled > 0 && nums.length >= Math.max(1, Math.floor(filled * 0.8))
    const stat: CsvColumnStat = {
      name,
      type: isNumeric ? 'number' : filled === 0 ? 'empty' : 'text',
      nonEmpty: filled,
      empty: dataLines.length - filled
    }
    if (isNumeric && nums.length) {
      const sum = nums.reduce((a, b) => a + b, 0)
      stat.sum = round(sum)
      stat.mean = round(sum / nums.length)
      stat.min = round(Math.min(...nums))
      stat.max = round(Math.max(...nums))
    } else if (filled > 0) {
      stat.unique = uniqueSets[c]?.size ?? 0
    }
    return stat
  })

  if (header.some((h) => /^\s*$/.test(h))) warnings.push('表头存在空列名，已自动命名为「列N」。')

  return { rows: dataLines.length, columns: header.length, header, columnStats, duplicateRows, warnings }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** 提取含日期/时间的行（日程整理的确定性预处理） */
export function extractDateLines(text: string): string[] {
  const re =
    /(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}|\d{1,2}[-/]\d{1,2}|\d{1,2}:\d{2}|周[一二三四五六日天]|星期[一二三四五六日天]|今天|明天|后天|下周)/
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && re.test(l))
    .slice(0, 200)
}
