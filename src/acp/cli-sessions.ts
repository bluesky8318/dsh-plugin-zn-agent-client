/**
 * CLI Agent 会话数据源（方案C 的「历史▾」后端）。
 *
 * 每个 CLI 的会话列表与 resume 参数都不同，这里集中两件事：
 *  1. buildLaunchPlan —— 把 会话动作（新会话/继续最近/还原指定会话）翻译成
 *     该 agent 在登录 shell 里要敲的命令行（resume flag 按 CLI basename 映射）；
 *  2. listAgentSessions —— 枚举某个 agent 在某工作目录下的历史会话：
 *     qodercli 用官方 `--list-sessions`（按项目）；
 *     kimi 读 `~/.kimi-code/session_index.jsonl`（带 workDir/title/updatedAt，
 *     比 `kimi session list` 的输出更好解析）；
 *     claude 读 `~/.claude/projects/<cwd-slug>/*.jsonl` 的 mtime。
 * 失败一律返回空数组——历史是增强功能，不能把它变成硬依赖。
 * @module dsh-plugin-zn-agent-client/acp/cli-sessions
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentConfig } from '../types/index.ts'

/** 会话动作：attach=默认幂等复用；new/continue/resume 都要求重启 PTY。 */
export type SessionMode = 'attach' | 'new' | 'continue' | 'resume'

/** 一个历史会话条目（历史▾ 菜单的一行）。 */
export interface CliSessionEntry {
  /** resume 用的会话 id（原样传给 CLI 的 resume flag）。 */
  id: string
  /** 摘要（首条消息/标题），拿不到就给占位文案。 */
  summary: string
  updatedAt: string
  source: 'cli' | 'index'
}

/** resume 时各 CLI 的 flag 形态（按命令 basename 匹配）。 */
const RESUME_FLAGS: Record<string, string> = {
  qodercli: '-r',
  qoder: '-r',
  kimi: '-S',
  claude: '--resume',
  codex: 'resume',
  gemini: '--resume',
  opencode: '--resume',
}

/** 命令 basename（去路径去扩展名，Windows 反斜杠也处理）。 */
export function commandBasename(command: string): string {
  const name = command.replaceAll('\\', '/').split('/').pop() ?? command
  return name.replace(/\.(exe|cmd|bat|sh)$/i, '').toLowerCase().trim()
}

/**
 * 把会话动作翻译成要在登录 shell 里敲的完整命令行。
 * attach 模式返回 undefined（沿用 agent 配置的原始命令）。
 */
export function buildLaunchPlan(
  agent: Pick<AgentConfig, 'command'>,
  mode: SessionMode = 'attach',
  resumeTarget?: string,
): { mode: SessionMode; launchLine?: string } {
  const command = agent.command.trim()
  if (mode === 'attach' || command === '') return { mode: 'attach' }
  if (mode === 'new') return { mode, launchLine: command }
  if (mode === 'continue') return { mode, launchLine: `${command} -c` }
  const target = typeof resumeTarget === 'string' ? resumeTarget.trim() : ''
  if (target === '') return { mode: 'new', launchLine: command }
  const flag = RESUME_FLAGS[commandBasename(command)] ?? '-r'
  return { mode: 'resume', launchLine: `${command} ${flag} ${target}` }
}

/** execFile 的 Promise 化（默认 10s 超时，失败返回 null）。 */
async function runCommand(command: string, args: string[], cwd: string, timeoutMs = 10_000): Promise<string | null> {
  return await new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      resolve(error === null ? stdout : null)
    })
  })
}

/** 解析 `qodercli --list-sessions` 输出：`N. 摘要 (相对时间) [uuid]`。 */
export function parseQoderSessionList(output: string): CliSessionEntry[] {
  const entries: CliSessionEntry[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*\d+\.\s+(.+?)\s+\(([^)]+)\)\s+\[([0-9a-fA-F-]{8,})\]\s*$/.exec(line)
    if (match === null) continue
    // match[1]=首条消息摘要，match[2]=相对时间（如 "5 hours ago"），match[3]=会话 id。
    entries.push({ id: match[3] ?? '', summary: match[1] ?? '', updatedAt: match[2] ?? '', source: 'cli' })
  }
  return entries.filter((entry) => entry.id !== '')
}

/** kimi 的 session 索引行（~/.kimi-code/session_index.jsonl）。 */
interface KimiIndexLine {
  sessionId?: string
  workDir?: string
}

/** kimi 会话 state.json 的字段（取 title/updatedAt）。 */
interface KimiStateFile {
  title?: string
  updatedAt?: string
  lastPrompt?: string
}

async function listKimiSessions(cwd: string): Promise<CliSessionEntry[]> {
  const indexPath = join(homedir(), '.kimi-code', 'session_index.jsonl')
  let raw: string
  try {
    raw = await fs.readFile(indexPath, 'utf8')
  } catch {
    return []
  }
  const lines = raw.split('\n').filter((line) => line.trim() !== '')
  const matched: Array<{ id: string; updatedAt: string; summary: string }> = []
  for (const line of lines) {
    let parsed: KimiIndexLine
    try {
      parsed = JSON.parse(line) as KimiIndexLine
    } catch {
      continue
    }
    if (typeof parsed.sessionId !== 'string' || typeof parsed.workDir !== 'string') continue
    if (parsed.workDir !== cwd) continue
    let summary = 'Kimi 会话'
    let updatedAt = ''
    try {
      const stateRaw = await fs.readFile(join(homedir(), '.kimi-code', 'sessions', parsed.sessionId, 'state.json'), 'utf8')
      const state = JSON.parse(stateRaw) as KimiStateFile
      if (typeof state.title === 'string' && state.title.trim() !== '') summary = state.title.trim()
      else if (typeof state.lastPrompt === 'string' && state.lastPrompt.trim() !== '') summary = state.lastPrompt.trim()
      if (typeof state.updatedAt === 'string') updatedAt = state.updatedAt
    } catch {
      // state.json 缺失就用占位摘要。
    }
    matched.push({ id: parsed.sessionId, updatedAt, summary })
  }
  matched.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  return matched.slice(0, 20).map((entry) => ({ id: entry.id, summary: entry.summary, updatedAt: entry.updatedAt, source: 'cli' as const }))
}

/** cwd → claude 的项目目录 slug（/ → -，与 ~/.claude/projects 布局一致）。 */
function claudeSlug(cwd: string): string {
  return cwd.replaceAll('/', '-')
}

/** qoder 的项目目录与 claude 同一 slug 布局（/ → -）。 */
async function listQoderSessions(cwd: string): Promise<CliSessionEntry[]> {
  const projectDir = join(homedir(), '.qoder', 'projects', claudeSlug(cwd))
  let names: string[]
  try {
    names = await fs.readdir(projectDir)
  } catch {
    return []
  }
  const entries: CliSessionEntry[] = []
  for (const name of names.filter((file) => file.endsWith('.jsonl')).slice(-20)) {
    const id = name.replace(/\.jsonl$/, '')
    try {
      const stat = await fs.stat(join(projectDir, name))
      // 首行 jsonl 里通常有首条用户消息，取前 40 个字符当摘要（失败不影响列表）。
      let summary = 'Qoder 会话'
      try {
        const head = await fs.readFile(join(projectDir, name), 'utf8')
        const first = JSON.parse(head.slice(0, head.indexOf('\n') === -1 ? head.length : head.indexOf('\n'))) as { message?: { content?: unknown } }
        const content = first.message?.content
        const text = typeof content === 'string' ? content : Array.isArray(content)
          ? content.map((part) => typeof part === 'object' && part !== null && 'text' in part ? String((part as { text: unknown }).text) : '').join(' ')
          : ''
        const trimmed = text.trim()
        if (trimmed !== '') summary = trimmed.slice(0, 40)
      } catch {
        // 摘要尽力而为。
      }
      entries.push({ id, summary, updatedAt: stat.mtime.toISOString(), source: 'cli' })
    } catch {
      // 文件刚被删掉就跳过。
    }
  }
  entries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return entries
}

async function listClaudeSessions(cwd: string): Promise<CliSessionEntry[]> {
  const projectDir = join(homedir(), '.claude', 'projects', claudeSlug(cwd))
  let names: string[]
  try {
    names = await fs.readdir(projectDir)
  } catch {
    return []
  }
  const entries: CliSessionEntry[] = []
  for (const name of names.filter((file) => file.endsWith('.jsonl')).slice(-20)) {
    const id = name.replace(/\.jsonl$/, '')
    try {
      const stat = await fs.stat(join(projectDir, name))
      entries.push({ id, summary: 'Claude 会话', updatedAt: stat.mtime.toISOString(), source: 'cli' })
    } catch {
      // 文件刚被删掉就跳过。
    }
  }
  entries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return entries
}

/**
 * 枚举某 agent 在某工作目录下的历史会话（最多 20 条，新→旧）。
 * 按 CLI basename 分派；不认识的 CLI 返回空（客户端仍可用 session-index 记录）。
 */
export async function listAgentSessions(agent: Pick<AgentConfig, 'command'>, cwd: string): Promise<CliSessionEntry[]> {
  const base = commandBasename(agent.command)
  try {
    if (base === 'qodercli' || base === 'qoder') {
      // 优先直读 ~/.qoder/projects/<slug> 会话文件（毫秒级）；空了再退回
      // CLI 子进程枚举（--list-sessions 要拉起整个 CLI，秒级延迟）。
      const fileEntries = await listQoderSessions(cwd)
      if (fileEntries.length > 0) return fileEntries.slice(0, 20)
      // 回落枚举是子进程拉起整个 CLI（实测秒级），限时 3s 兜住弹层延迟。
      const output = await runCommand(agent.command, ['--list-sessions'], cwd, 3_000)
      if (output === null) return []
      const entries = parseQoderSessionList(output)
      return entries.slice(0, 20)
    }
    if (base === 'kimi') return await listKimiSessions(cwd)
    if (base === 'claude') return await listClaudeSessions(cwd)
    return []
  } catch {
    return []
  }
}
