/**
 * Handoff DSH：把 DSH 会话快照交接给 CLI agent 继续工作。
 *
 * 三件事：
 *  1. buildHandoffDoc —— 把 deriveMessages()/snapshotEvents() 的只读结果
 *     拼成结构化交接文档（提取式模板；LLM 模式先经本地网关压缩再套同一模板）。
 *  2. llmSummarize —— 本机 magpie 网关（OpenAI 兼容 /v1）压缩全量对话；
 *     任何失败返回 null，由调用方回落提取式（永不阻塞交接）。
 *  3. buildHandoffLaunchLine —— 各 CLI 的初始 prompt 注入命令行：
 *     文档经 base64 传给 shell（规避引号/换行转义）；kimi 没有交互式
 *     初始 prompt 参数，走两阶段 `-p` 建会话 → `exec kimi -r <id>` 续接。
 *
 * 安全边界：只读 DSH 会话（deriveMessages/snapshotEvents），不写任何
 * DSH 会话文件；交接文档只作为新 CLI 会话的首条 prompt。
 * @module dsh-plugin-zn-agent-client/acp/cli-handoff
 */

import { commandBasename } from './cli-sessions.ts'

/** 交接用的单条消息（宿主已把 Message 投影成纯文本）。 */
export interface HandoffMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** 交接用的结构化事件素材（goal/todo，取最后一条）。 */
export interface HandoffEvents {
  readonly goal: string
  readonly todos: readonly string[]
}

/** buildHandoffDoc 的输入。 */
export interface HandoffInput {
  readonly sessionId: string
  readonly cwd: string
  readonly messages: readonly HandoffMessage[]
  readonly events: HandoffEvents
  readonly mode: 'extract' | 'llm'
  /** LLM 压缩结果；仅 mode==='llm' 且成功时有值。 */
  readonly llmSummary?: string
  /** LLM 调用失败回落提取式时为 true。 */
  readonly llmFallback?: boolean
  /** 接手说明段落（设置页可配；缺省用 DEFAULT_HANDOFF_TAIL）。 */
  readonly tail?: string
}

/** buildHandoffDoc 的产物（客户端预览卡片直接展示 doc）。 */
export interface HandoffResult {
  readonly doc: string
  readonly mode: 'extract' | 'llm'
  readonly chars: number
  readonly truncated: boolean
  readonly llmFallback?: boolean
}

/** 提取式模板的截断参数：最近消息条数 / 单条字符 / 文档总字节。 */
const RECENT_MESSAGES = 40
const MESSAGE_CHARS = 600
const GOAL_CHARS = 1200
const MAX_DOC_BYTES = 12 * 1024
/** LLM 输入的对话文本上限（字符）。 */
const LLM_INPUT_CHARS = 60_000

/** 截断到 n 字符，超长补省略号。 */
function clamp(text: string, n: number): string {
  const clean = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  return clean.length > n ? `${clean.slice(0, n)}…` : clean
}

/** 提取式模板：目标 / goal / 待办 / 最近对话。 */
function buildExtractiveBody(input: Omit<HandoffInput, 'mode' | 'llmSummary' | 'llmFallback'>): { body: string; truncated: boolean } {
  const lines: string[] = []
  const firstUser = input.messages.find((message) => message.role === 'user')
  lines.push('## 任务目标')
  lines.push(firstUser === undefined ? '（会话里没有用户消息）' : clamp(firstUser.text, GOAL_CHARS))
  if (input.events.goal !== '') {
    lines.push('')
    lines.push('## 会话目标（goal）')
    lines.push(clamp(input.events.goal, GOAL_CHARS))
  }
  if (input.events.todos.length > 0) {
    lines.push('')
    lines.push('## 待办清单（todo）')
    for (const todo of input.events.todos) lines.push(`- ${clamp(todo, 200)}`)
  }
  const recent = input.messages.slice(-RECENT_MESSAGES)
  const truncated = input.messages.length > RECENT_MESSAGES
  lines.push('')
  lines.push(`## 最近对话摘录（最后 ${recent.length} 条${truncated ? `，此前 ${input.messages.length - recent.length} 条已省略` : ''}）`)
  for (const message of recent) {
    const who = message.role === 'user' ? '用户' : '助手'
    lines.push(`[${who}] ${clamp(message.text, MESSAGE_CHARS)}`)
  }
  return { body: lines.join('\n'), truncated }
}

/**
 * 生成交接文档。llmSummary 有值时以它为主体（叙述式摘要）；
 * 否则走提取式模板。总字节超限时按行回退截断。
 */
export function buildHandoffDoc(input: HandoffInput): HandoffResult {
  const shortId = input.sessionId.replace(/^session-/, '').slice(0, 8)
  const header = [
    `# DSH 会话交接（源会话 ${shortId}）`,
    `- 工作区: ${input.cwd !== '' ? input.cwd : '（未知）'}`,
    '',
  ].join('\n')
  const tailText = input.tail !== undefined && input.tail.trim() !== '' ? input.tail.trim() : DEFAULT_HANDOFF_TAIL
  const tail = ['', '## 接手说明', tailText].join('\n')
  let body: string
  let truncated = false
  if (input.mode === 'llm' && typeof input.llmSummary === 'string' && input.llmSummary.trim() !== '') {
    body = input.llmSummary.trim()
  } else {
    const built = buildExtractiveBody(input)
    body = built.body
    truncated = built.truncated
  }
  let doc = `${header}${body}${tail}`
  while (Buffer.byteLength(doc, 'utf8') > MAX_DOC_BYTES && body.includes('\n')) {
    body = body.slice(0, Math.max(0, body.lastIndexOf('\n')))
    doc = `${header}${body}${tail}`
    truncated = true
  }
  return {
    doc,
    mode: input.mode,
    chars: doc.length,
    truncated,
    ...(input.llmFallback === true ? { llmFallback: true } : {}),
  }
}

/** 交接文档的「接手说明」缺省文案（设置页 handoffTail 可覆盖）。 */
export const DEFAULT_HANDOFF_TAIL =
  '以上是 DeepSeek Harness 的 DSH 会话快照。请基于这些上下文，给出需要继续完成未竟的工作列表，确认需要继续哪些工作；需要更多细节时直接查看工作区里的文件。'

/** LLM 网关缺省地址 / 模型 / key 环境变量名 / 系统提示（设置页可覆盖，空值回落这里）。 */
export const DEFAULT_LLM_BASE_URL = 'http://127.0.0.1:3425/v1'
export const DEFAULT_LLM_MODEL = 'group/smart-split'
export const DEFAULT_LLM_API_KEY_ENV = 'MAGPIE_GATEWAY_KEY'
export const DEFAULT_LLM_SYSTEM_PROMPT = [
  '你是会话交接摘要助手。把给定的 DSH 会话对话压缩成一份给下一个 AI agent 接手用的中文交接文档。',
  '严格用以下 Markdown 小节输出（没有内容的节写「（无）」）：',
  '# 任务目标\n# 已完成\n# 未完成与下一步\n# 关键决定与原因\n# 失败与教训',
  '只依据对话内容，不要编造；保留具体的文件路径、命令、报错原文等可执行细节。',
].join('\n')

/** LLM 调用配置（宿主从插件设置现读现传；字段空值回落上面各缺省）。 */
export interface LlmCallConfig {
  readonly baseUrl?: string
  readonly model?: string
  readonly apiKeyEnv?: string
  readonly systemPrompt?: string
}

/**
 * 调本地网关把对话压成摘要；任何失败返回 null（调用方回落提取式）。
 * 网关 key 缺省时也尝试无鉴权请求（本机网关实测可匿名列出模型）。
 */
export async function llmSummarize(messages: readonly HandoffMessage[], cfg: LlmCallConfig = {}): Promise<string | null> {
  const transcript = messages
    .map((message) => `[${message.role === 'user' ? '用户' : '助手'}] ${message.text}`)
    .join('\n')
    .slice(0, LLM_INPUT_CHARS)
  if (transcript.trim() === '') return null
  const baseUrl = (cfg.baseUrl !== undefined && cfg.baseUrl.trim() !== '' ? cfg.baseUrl : DEFAULT_LLM_BASE_URL).replace(/\/+$/, '')
  const model = cfg.model !== undefined && cfg.model.trim() !== '' ? cfg.model : DEFAULT_LLM_MODEL
  const systemPrompt = cfg.systemPrompt !== undefined && cfg.systemPrompt.trim() !== '' ? cfg.systemPrompt : DEFAULT_LLM_SYSTEM_PROMPT
  const keyEnv = cfg.apiKeyEnv !== undefined && cfg.apiKeyEnv.trim() !== '' ? cfg.apiKeyEnv : DEFAULT_LLM_API_KEY_ENV
  const key = process.env[keyEnv] ?? ''
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, 120_000)
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key !== '' ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: transcript },
        ],
      }),
      signal: controller.signal,
    })
    if (!response.ok) return null
    const payload = (await response.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null
    const text = payload?.choices?.[0]?.message?.content
    return typeof text === 'string' && text.trim() !== '' ? text : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 各 CLI 的交接启动命令行（在登录 shell 里执行）：
 * 文档 base64 进 shell 解出 P，再按 CLI 的初始 prompt 形态注入；
 * kimi 两阶段：`-p` 建会话（stream-json 里取 session_id）→ `exec kimi -r <id>`。
 */
export function buildHandoffLaunchLine(
  agent: Pick<{ command: string; cliArgs?: readonly string[] }, 'command' | 'cliArgs'>,
  doc: string,
): string {
  const command = agent.command.trim()
  const extra = (agent.cliArgs ?? []).map((arg) => arg.trim()).filter((arg) => arg !== '')
  const extraText = extra.length > 0 ? ` ${extra.join(' ')}` : ''
  const b64 = Buffer.from(doc, 'utf8').toString('base64')
  const readDoc = `P=$(printf %s ${b64} | base64 -d)`
  if (commandBasename(command) === 'kimi') {
    return [
      readDoc,
      `ID=$(kimi -p "$P" --output-format stream-json 2>/dev/null | sed -n 's/.*"session_id":"\\([^"]*\\)".*/\\1/p' | tail -1)`,
      `if [ -n "$ID" ]; then exec kimi${extraText} -r "$ID"; else exec kimi${extraText}; fi`,
    ].join('; ')
  }
  return `${readDoc}; exec ${command}${extraText} "$P"`
}
