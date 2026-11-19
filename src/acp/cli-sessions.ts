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
  /** 会话自己的工作目录（jsonl 头里记录的 workspace）；resume 必须回到这个目录。 */
  cwd?: string
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
 * 所有模式都带 CLI 配置参数（cliArgs，如 --dangerously-skip-permissions）；
 * attach 模式也显式回传命令行，供新终端直接敲入。
 */
export function buildLaunchPlan(
  agent: Pick<AgentConfig, 'command' | 'cliArgs'>,
  mode: SessionMode = 'attach',
  resumeTarget?: string,
): { mode: SessionMode; launchLine: string } {
  const command = agent.command.trim()
  const extra = (agent.cliArgs ?? []).map((arg) => arg.trim()).filter((arg) => arg !== '')
  const base = extra.length > 0 ? `${command} ${extra.join(' ')}` : command
  if (mode === 'attach' || command === '') return { mode: 'attach', launchLine: base }
  if (mode === 'new') return { mode, launchLine: base }
  if (mode === 'continue') return { mode, launchLine: `${base} -c` }
  const target = typeof resumeTarget === 'string' ? resumeTarget.trim() : ''
  if (target === '') return { mode: 'new', launchLine: base }
  const flag = RESUME_FLAGS[commandBasename(command)] ?? '-r'
  return { mode: 'resume', launchLine: `${base} ${flag} ${target}` }
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

/** cwd → claude/qoder 的项目目录 slug（/ → -，与 ~/.claude/projects 布局一致）。 */
export function claudeSlug(cwd: string): string {
  return cwd.replaceAll('/', '-')
}

/** cwd 归一化（去掉末尾斜杠），用于工作区相等比较。 */
function normalizeCwd(value: string): string {
  return value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value
}


/** 会话 jsonl 首段的形状（只取摘要要用的字段）。 */
interface SessionLine {
  type?: unknown
  message?: { content?: unknown }
  humanInput?: { text?: unknown }
  isMeta?: unknown
}

/**
 * 从会话 jsonl 文件前 64KB 里找第一条人类输入当摘要。
 * qoder/claude 的文件头几行常是元数据（workspace-directories、active-leaf 等），
 * 必须逐行找到 type==='user' 的行；跳过 <local-command 之类的包装文本。
 */
/**
 * 扫描会话 jsonl 前 64KB 找第一条真实用户输入。
 * hasContent=false 表示会话里没有任何真实用户消息（只有 /quit 这类本地命令包装
 * 或系统 meta 行）——空会话，CLI 自己也无法 resume。
 */
async function scanFirstUser(filePath: string): Promise<{ text: string | null; hasContent: boolean }> {
  const handle = await fs.open(filePath, 'r').catch(() => null)
  if (handle === null) return { text: null, hasContent: false }
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(65_536), 0, 65_536, 0)
    let hasContent = false
    for (const line of buffer.toString('utf8', 0, bytesRead).split('\n')) {
      if (line.trim() === '') continue
      let parsed: SessionLine
      try {
        parsed = JSON.parse(line) as SessionLine
      } catch {
        continue
      }
      if (parsed.type !== 'user') continue
      if (parsed.isMeta === true) continue
      const human = typeof parsed.humanInput?.text === 'string' ? parsed.humanInput.text.trim() : ''
      const content = parsed.message?.content
      const text = human !== '' ? human
        : typeof content === 'string' ? content.trim()
        : Array.isArray(content)
          ? content.map((part) => typeof part === 'object' && part !== null && 'text' in part ? String((part as { text: unknown }).text) : '').join(' ').trim()
          : ''
      if (text !== '' && !text.startsWith('<')) {
        return { text: text.slice(0, 60), hasContent: true }
      }
      // 字符串内容是 <command-name> 这类本地命令包装 → 不算内容；但数组内容
      //（图片/多段）即使提不出纯文本也算真实输入。
      if (Array.isArray(content) && content.length > 0) hasContent = true
    }
    return { text: null, hasContent }
  } catch {
    return { text: null, hasContent: false }
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * 从会话 jsonl 前 64KB 里解析会话自己的工作目录：
 * qoder 头行是 {type:'workspace-directories', directories:[…]}；claude 行内带 cwd 字段。
 * 拿不到返回 null（调用方退回其它 cwd 来源）。
 */
async function firstWorkspaceDir(filePath: string): Promise<string | null> {
  const handle = await fs.open(filePath, 'r').catch(() => null)
  if (handle === null) return null
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(65_536), 0, 65_536, 0)
    for (const line of buffer.toString('utf8', 0, bytesRead).split('\n')) {
      if (line.trim() === '') continue
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (parsed.type === 'workspace-directories' && Array.isArray(parsed.directories)) {
        const first = parsed.directories.find((item): item is string => typeof item === 'string')
        if (first !== undefined && first !== '') return first
      }
      if (typeof parsed.cwd === 'string' && parsed.cwd !== '') return parsed.cwd
    }
  } catch {
    // 尽力而为。
  } finally {
    await handle.close().catch(() => {})
  }
  return null
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
    const filePath = join(projectDir, name)
    try {
      const stat = await fs.stat(filePath)
      const [scan, workdir] = await Promise.all([
        scanFirstUser(filePath),
        firstWorkspaceDir(filePath),
      ])
      // 空会话（没有任何真实用户输入）不列：CLI 自己也无法 resume 它们。
      if (!scan.hasContent) continue
      // 只列当前工作区的会话：跨 worktree 的会话 CLI resume 不到，历史里直接不出现。
      if (workdir !== null && normalizeCwd(workdir) !== normalizeCwd(cwd)) continue
      entries.push({
        id,
        summary: scan.text ?? 'Qoder 会话',
        updatedAt: stat.mtime.toISOString(),
        source: 'cli',
        ...(workdir !== null ? { cwd: workdir } : {}),
      })
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
    const filePath = join(projectDir, name)
    try {
      const stat = await fs.stat(filePath)
      const [scan, workdir] = await Promise.all([
        scanFirstUser(filePath),
        firstWorkspaceDir(filePath),
      ])
      // 空会话（没有任何真实用户输入）不列：CLI 自己也无法 resume 它们。
      if (!scan.hasContent) continue
      // 只列当前工作区的会话：跨 worktree 的会话 CLI resume 不到，历史里直接不出现。
      if (workdir !== null && normalizeCwd(workdir) !== normalizeCwd(cwd)) continue
      entries.push({
        id,
        summary: scan.text ?? 'Claude 会话',
        updatedAt: stat.mtime.toISOString(),
        source: 'cli',
        ...(workdir !== null ? { cwd: workdir } : {}),
      })
    } catch {
      // 文件刚被删掉就跳过。
    }
  }
  entries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return entries
}

/**
 * 按会话 id 反查它自己的工作目录（resume 前把 spawn cwd 纠正回会话所属 worktree）。
 * qoder/claude 都是 ~/.<cli>/projects/<slug>/<sessionId>.jsonl 布局；查不到返回 null。
 */
export async function resolveSessionWorktree(command: string, sessionId: string): Promise<string | null> {
  const base = commandBasename(command)
  const roots = base === 'qodercli' || base === 'qoder'
    ? [join(homedir(), '.qoder', 'projects')]
    : base === 'claude' ? [join(homedir(), '.claude', 'projects')]
    : []
  for (const root of roots) {
    let projects: string[]
    try {
      projects = await fs.readdir(root)
    } catch {
      continue
    }
    for (const project of projects) {
      const filePath = join(root, project, `${sessionId}.jsonl`)
      try {
        await fs.access(filePath)
      } catch {
        continue
      }
      const workdir = await firstWorkspaceDir(filePath)
      if (workdir !== null) return workdir
    }
  }
  return null
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
      const parsed = parseQoderSessionList(output)
      // CLI 兜底可能列出跨 worktree 的会话：逐条反查记录工作区，只留当前工作区的
      //（反查不到的按用户预期直接丢弃——宁可少列，不可列出 resume 不到的）。
      const entries: CliSessionEntry[] = []
      for (const entry of parsed) {
        const workdir = await resolveSessionWorktree(agent.command, entry.id)
        if (workdir === null || normalizeCwd(workdir) !== normalizeCwd(cwd)) continue
        entries.push(entry)
      }
      return entries.slice(0, 20)
    }
    if (base === 'kimi') return await listKimiSessions(cwd)
    if (base === 'claude') return await listClaudeSessions(cwd)
    return []
  } catch {
    return []
  }
}
