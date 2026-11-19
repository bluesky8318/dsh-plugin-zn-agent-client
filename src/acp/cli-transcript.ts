/**
 * CLI 会话 transcript 解析（工作区看板「CLI 会话」页签的内容预览用）。
 *
 * 三种可读格式（本机实测核对过行结构）：
 * - qoder / claude：`~/.{qoder,claude}/projects/<slug>/<sessionId>.jsonl`，
 *   行形如 {type:'user'|'assistant', timestamp, isMeta?, message:{content: string|[{type:'text',text}]}}。
 * - kimi：`~/.kimi-code/sessions/<wd_*>/session_<id>/agents/main/wire.jsonl`，
 *   行形如 {type:'agent.message.appended', message:{message:{role, content:[…]}, meta:{source, createdAt}}}。
 *
 * 其余 agent（codex/mcode/pi…）transcript 布局未核实 → supported:false，
 * 看板侧显示「暂不支持内容预览」，但复制恢复命令不受影响。
 *
 * 只读解析：绝不写任何 CLI/DSH 文件。
 * @module dsh-plugin-zn-agent-client/acp/cli-transcript
 */

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { commandBasename, claudeSlug } from './cli-sessions.ts'

/** 预览里的一条消息。 */
export interface TranscriptMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
  /** ISO 时间或空串（拿不到时间戳时不编造）。 */
  readonly time: string
}

/** 解析结果：supported=false 表示该 agent 的 transcript 布局未支持。 */
export interface TranscriptResult {
  readonly supported: boolean
  readonly messages: readonly TranscriptMessage[]
  /** 超过条数/字节上限被截断时为 true（预览用途，尾部省略）。 */
  readonly truncated: boolean
}

const MAX_MESSAGES = 400
const MAX_TEXT = 4000
const MAX_FILE_BYTES = 12 * 1024 * 1024

/** content（字符串或分段数组）→ 纯文本（只取 text/think 段里的 text）。 */
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (typeof item === 'object' && item !== null && 'text' in item) {
      const text = (item as { text?: unknown }).text
      if (typeof text === 'string' && text.trim() !== '') parts.push(text)
    }
  }
  return parts.join('\n')
}

/** 单条消息文本截断（超长尾部省略号）。 */
function clampText(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT)}…` : trimmed
}

/** 找 qoder/claude 的会话 jsonl：先按 cwd slug 精确找，找不到再全盘扫描。 */
async function findProjectJsonl(root: string, sessionId: string, cwd: string): Promise<string | null> {
  const direct = join(root, claudeSlug(cwd), `${sessionId}.jsonl`)
  if (cwd !== '' && await fs.stat(direct).then(() => true).catch(() => false)) return direct
  let dirs: string[]
  try {
    dirs = await fs.readdir(root)
  } catch {
    return null
  }
  for (const dir of dirs) {
    const candidate = join(root, dir, `${sessionId}.jsonl`)
    if (await fs.stat(candidate).then(() => true).catch(() => false)) return candidate
  }
  return null
}

/** 找 kimi 的 wire.jsonl：~/.kimi-code/sessions/<wd_*>/session_<id>/agents/main/wire.jsonl。 */
async function findKimiWire(sessionId: string): Promise<string | null> {
  const root = join(homedir(), '.kimi-code', 'sessions')
  let dirs: string[]
  try {
    dirs = await fs.readdir(root)
  } catch {
    return null
  }
  for (const dir of dirs) {
    const candidate = join(root, dir, `session_${sessionId}`, 'agents', 'main', 'wire.jsonl')
    if (await fs.stat(candidate).then(() => true).catch(() => false)) return candidate
  }
  return null
}

/** qoder/claude jsonl → 消息列表。 */
async function parseProjectJsonl(filePath: string): Promise<TranscriptResult> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
    if (raw.length > MAX_FILE_BYTES) raw = raw.slice(0, MAX_FILE_BYTES)
  } catch {
    return { supported: true, messages: [], truncated: false }
  }
  const messages: TranscriptMessage[] = []
  let truncated = false
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let parsed: {
      type?: unknown
      isMeta?: unknown
      timestamp?: unknown
      message?: { content?: unknown }
    }
    try {
      parsed = JSON.parse(line) as typeof parsed
    } catch {
      continue
    }
    if (parsed.type !== 'user' && parsed.type !== 'assistant') continue
    if (parsed.isMeta === true) continue
    const text = textFromContent(parsed.message?.content)
    if (text.trim() === '') continue
    // user 侧的 <command-name>/<local-command>/<system-reminder> 包装不是真对话。
    if (parsed.type === 'user' && text.trimStart().startsWith('<')) continue
    if (messages.length >= MAX_MESSAGES) {
      truncated = true
      break
    }
    messages.push({
      role: parsed.type,
      text: clampText(text),
      time: typeof parsed.timestamp === 'string' ? parsed.timestamp : '',
    })
  }
  return { supported: true, messages, truncated }
}

/** kimi wire.jsonl → 消息列表（agent.message.appended 事件流）。 */
async function parseKimiWire(filePath: string): Promise<TranscriptResult> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
    if (raw.length > MAX_FILE_BYTES) raw = raw.slice(0, MAX_FILE_BYTES)
  } catch {
    return { supported: true, messages: [], truncated: false }
  }
  const messages: TranscriptMessage[] = []
  let truncated = false
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let parsed: {
      type?: unknown
      message?: {
        message?: { role?: unknown; content?: unknown }
        meta?: { source?: unknown; createdAt?: unknown }
      }
    }
    try {
      parsed = JSON.parse(line) as typeof parsed
    } catch {
      continue
    }
    if (parsed.type !== 'agent.message.appended') continue
    const inner = parsed.message?.message
    const role = typeof inner?.role === 'string' ? inner.role : ''
    if (role !== 'user' && role !== 'assistant') continue
    const source = parsed.message?.meta?.source
    // user 只认 source==='input'（人类输入）；assistant 只认 'llm'。
    if (role === 'user' && source !== 'input') continue
    if (role === 'assistant' && source !== 'llm') continue
    const text = textFromContent(inner?.content)
    if (text.trim() === '') continue
    if (text.trimStart().startsWith('<system-reminder>')) continue
    if (messages.length >= MAX_MESSAGES) {
      truncated = true
      break
    }
    messages.push({
      role,
      text: clampText(text),
      time: typeof parsed.message?.meta?.createdAt === 'string' ? parsed.message.meta.createdAt : '',
    })
  }
  return { supported: true, messages, truncated }
}

/**
 * 解析一个 CLI 会话的可读 transcript。
 * @param command - agent 配置的启动命令（按 basename 分流解析器）。
 * @param sessionId - CLI 会话 id。
 * @param cwd - 工作区路径（加速定位；拿不到就全盘扫描）。
 */
export async function parseTranscript(command: string, sessionId: string, cwd = ''): Promise<TranscriptResult> {
  const base = commandBasename(command)
  if (base === 'qodercli' || base === 'qoder') {
    const file = await findProjectJsonl(join(homedir(), '.qoder', 'projects'), sessionId, cwd)
    return file === null ? { supported: true, messages: [], truncated: false } : parseProjectJsonl(file)
  }
  if (base === 'claude') {
    const file = await findProjectJsonl(join(homedir(), '.claude', 'projects'), sessionId, cwd)
    return file === null ? { supported: true, messages: [], truncated: false } : parseProjectJsonl(file)
  }
  if (base === 'kimi') {
    const file = await findKimiWire(sessionId)
    return file === null ? { supported: true, messages: [], truncated: false } : parseKimiWire(file)
  }
  return { supported: false, messages: [], truncated: false }
}
