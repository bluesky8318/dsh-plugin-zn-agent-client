/**
 * ACP 会话索引:把本插件用过的 ACP 会话句柄记录到宿主 profile 下的 JSON 文件。
 *
 * 背景:ACP 协议里,会话历史存在 **agent 侧**(qoder 写 ~/.qoder/projects/…/,
 * claude 写 ~/.claude/projects/…/,codex 写 ~/.codex/sessions/…)。DSH 侧拿到的
 * 只有 sessionId 这个句柄;agent 的 InitializeResponse.loadSession 为 true 时,
 * 可以用 `session/load` 重新挂上这个句柄继续对话。
 *
 * 本索引只做一件事:记住"哪个 agent 在哪个目录开过哪个会话",让
 * `list_acp_sessions` 工具和 `call_acp_agent` 的 sessionId 参数能真正续聊。
 * 文件是派生缓存:丢了最多失去续聊入口,agent 侧历史仍在。
 *
 * @module dsh-plugin-zn-agent-client/acp/session-index
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** 一条会话记录。 */
export interface AcpSessionRecord {
  /** ACP sessionId(agent 侧生成)。 */
  sessionId: string
  /** 本插件配置里的 agent id。 */
  agentId: string
  /** 会话 working directory(续聊时要一致)。 */
  cwd: string
  /** 首次记录时间(ISO 8601)。 */
  createdAt: string
  /** 最近一次使用时间(ISO 8601);排序与 touch 都用它。 */
  lastUsedAt: string
}

/** 索引文件结构。 */
interface IndexFile {
  version: 1
  sessions: AcpSessionRecord[]
}

/** 索引最多保留的记录数(防无限增长;超出后淘汰最旧的)。 */
const MAX_RECORDS = 200

/**
 * 默认索引路径:$DSH_PROFILE_DIR/plugin-data/<插件名>/sessions.json,
 * 没有该环境变量时回落到 ~/.dsh/profiles/desktop/(本机 desktop profile)。
 */
export function defaultSessionIndexPath(): string {
  const profileDir = process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'desktop')
  return join(profileDir, 'plugin-data', 'dsh-plugin-zn-agent-client', 'sessions.json')
}

/**
 * JSON 文件会话索引。全部方法容错:读失败当空表,写失败抛给调用方
 * (工具层把它折进回复文本,不打断主流程)。
 */
export class SessionIndex {
  private readonly filePath: string

  constructor(filePath: string = defaultSessionIndexPath()) {
    this.filePath = filePath
  }

  /** 读取全部记录(按 lastUsedAt 降序)。 */
  async list(agentId?: string): Promise<AcpSessionRecord[]> {
    const records = await this.readAll()
    const filtered = agentId ? records.filter(record => record.agentId === agentId) : records
    return filtered.sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : -1))
  }

  /** 某个 agent 最近一次使用的会话记录(没有则 null)。自动续聊的默认目标。 */
  async latestFor(agentId: string): Promise<AcpSessionRecord | null> {
    const [latest] = await this.list(agentId)
    return latest ?? null
  }

  /**
   * 记录(或 touch)一次会话使用:同一 sessionId 是 upsert,更新 cwd 与
   * lastUsedAt;新会话插入头部。超出上限时淘汰最旧的记录。
   */
  async record(input: { sessionId: string; agentId: string; cwd: string }): Promise<void> {
    const now = new Date().toISOString()
    const records = await this.readAll()
    const existing = records.findIndex(record => record.sessionId === input.sessionId)
    if (existing >= 0) {
      const current = records[existing]!
      records[existing] = { ...current, agentId: input.agentId, cwd: input.cwd, lastUsedAt: now }
    } else {
      records.push({ sessionId: input.sessionId, agentId: input.agentId, cwd: input.cwd, createdAt: now, lastUsedAt: now })
    }
    records.sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? -1 : 1))
    const trimmed = records.slice(-MAX_RECORDS)
    await this.writeAll(trimmed)
  }

  private async readAll(): Promise<AcpSessionRecord[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<IndexFile>
      if (!Array.isArray(parsed.sessions)) return []
      return parsed.sessions.filter(record =>
        typeof record?.sessionId === 'string'
        && typeof record?.agentId === 'string'
        && typeof record?.cwd === 'string',
      )
    } catch {
      // 文件不存在或损坏:从空表开始(索引是派生缓存,丢了不致命)。
      return []
    }
  }

  private async writeAll(records: AcpSessionRecord[]): Promise<void> {
    const file: IndexFile = { version: 1, sessions: records }
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    await rename(tmp, this.filePath)
  }
}
