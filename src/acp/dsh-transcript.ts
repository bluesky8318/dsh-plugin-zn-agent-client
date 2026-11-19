/**
 * DSH 自身会话的只读内容预览。
 *
 * 数据源：~/.dsh/sessions/<cwd-slug>/session-<id>/session.v4.jsonl.zstd
 * （session log 为 zstd 帧拼接的 JSONL；node:zlib 原生支持 zstd 解码）。
 *
 * 只读边界：本模块绝不写任何会话文件（699ebbe 事故红线：插件不得改动
 * 会话日志）。仅解压读取，事件过滤后输出人可读消息列表。
 * @module dsh-plugin-zn-agent-client/acp/dsh-transcript
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** 预览消息（role user = 真实用户输入，assistant = 助手文本）。 */
export interface DshTranscriptMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly time: number
}

/** parseDshTranscript 的结果（supported 恒为 true；读不到时抛错由路由转 404）。 */
export interface DshTranscriptResult {
  readonly supported: boolean
  readonly messages: readonly DshTranscriptMessage[]
  readonly truncated: boolean
}

const MAX_MESSAGES = 400
const MAX_TEXT = 4000
const MAX_FILE_BYTES = 12 * 1024 * 1024

/** sessionId 只允许安全字符（它要参与路径拼接，防目录穿越）。 */
function safeSessionId(sessionId: string): boolean {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(sessionId)
}

/** 会话日志根目录（DSH_HOME 可覆盖，默认 ~/.dsh）。 */
function sessionsRoot(): string {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/** 在 sessions 根下定位 session-<id> 目录（cwd slug 目录名不可预测，直接扫描）。 */
function findSessionDir(sessionId: string): string | null {
  const root = sessionsRoot()
  let slugs: string[]
  try {
    slugs = readdirSync(root)
  } catch {
    return null
  }
  const dirName = `session-${sessionId}`
  for (const slug of slugs) {
    const candidate = join(root, slug, dirName)
    try {
      if (statSync(candidate).isDirectory()) return candidate
    } catch {
      // 不是目录/不存在 → 继续扫
    }
  }
  return null
}

/** 解出日志全文（zstd 单文件多帧拼接；node sync API 可一次解完）。 */
function readLogText(dir: string): string | null {
  for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
    const filePath = join(dir, name)
    let raw: Buffer
    try {
      raw = readFileSync(filePath)
    } catch {
      continue
    }
    if (raw.length > MAX_FILE_BYTES) {
      raw = raw.subarray(0, MAX_FILE_BYTES)
    }
    if (name.endsWith('.zstd')) {
      return zstdDecompressSync(raw).toString('utf8')
    }
    return raw.toString('utf8')
  }
  return null
}

interface TextItem {
  readonly type?: unknown
  readonly text?: unknown
}

/** 从 content 数组里取全部 text 片段（跳过 tool-call/think 等）。 */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content as TextItem[]) {
    if (item !== null && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text)
    }
  }
  return parts.join('\n').trim()
}

interface LogEvent {
  readonly type?: unknown
  readonly seq?: unknown
  readonly time?: unknown
  readonly data?: {
    readonly source?: { readonly kind?: unknown }
    readonly content?: unknown
    readonly message?: { readonly content?: unknown }
  }
}

/**
 * 解析一个 DSH 会话为人可读预览：只保留真实用户输入（user/message 且
 * source.kind === 'user'）与助手文本（assistant/message 的 text 片段）。
 */
export function parseDshTranscript(sessionId: string): DshTranscriptResult {
  if (!safeSessionId(sessionId)) throw new Error('非法的 sessionId')
  const dir = findSessionDir(sessionId)
  if (dir === null) throw new Error(`找不到会话日志（session-${sessionId}）`)
  const text = readLogText(dir)
  if (text === null) throw new Error('会话日志文件不存在')

  const messages: DshTranscriptMessage[] = []
  let truncated = false
  let tailCut = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let event: LogEvent
    try {
      event = JSON.parse(trimmed) as LogEvent
    } catch {
      continue
    }
    if (event.type === 'user/message') {
      const kind = event.data?.source?.kind
      if (kind !== 'user') continue
      const body = textOfContent(event.data?.content)
      if (body === '' || body.startsWith('<system-reminder>')) continue
      messages.push({ role: 'user', text: body.slice(0, MAX_TEXT), time: typeof event.time === 'number' ? event.time : 0 })
    } else if (event.type === 'assistant/message') {
      const body = textOfContent(event.data?.message?.content)
      if (body === '') continue
      messages.push({ role: 'assistant', text: body.slice(0, MAX_TEXT), time: typeof event.time === 'number' ? event.time : 0 })
    }
    if (messages.length >= MAX_MESSAGES) {
      truncated = true
      tailCut = true
      break
    }
  }
  // 命中上限时丢掉最后一条（它可能被 MAX_TEXT 截断得不完整——保留完整观感）。
  if (tailCut && messages.length > 0) messages.pop()
  return { supported: true, messages, truncated }
}
