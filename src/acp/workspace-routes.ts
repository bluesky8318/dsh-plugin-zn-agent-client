/**
 * 工作区看板的路由：AGENTS.md 读写 + CLI 会话内容预览/恢复命令。
 *
 * 安全边界：
 * - AGENTS.md 的路径一律由 workspaceId 经宿主 workspaceRegistry 解析，
 *   客户端不能传任意路径（防目录穿越/任意写）。
 * - 两条路由都走 cli-routes 的 guarded()（插件 GUARD 头 + 同源校验）。
 * @module dsh-plugin-zn-agent-client/acp/workspace-routes
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { fail, guarded, json, ok, readJsonBody, type RouteRequest, type RouteResponse } from './cli-routes.ts'
import { buildLaunchPlan } from './cli-sessions.ts'
import type { AgentConfig } from '../types/index.ts'
import { parseTranscript } from './cli-transcript.ts'
import { buildHandoffDoc, llmSummarize, type HandoffEvents, type HandoffMessage } from './cli-handoff.ts'

/** createWorkspaceRoutes 的依赖面。 */
export interface WorkspaceRouteDeps {
  /** agentId → agent 配置（拿启动命令）。 */
  resolveAgent(agentId: string): Pick<AgentConfig, 'command'> & { readonly cliArgs?: readonly string[] } | undefined
  /** workspaceId → 工作区绝对路径；解析不到返回 null。 */
  resolveWorkspacePath(workspaceId: string): Promise<string | null>
  /** 会话 id → 宿主 Session 对象（只读 face；拿不到返回 undefined）。 */
  getSession(sessionId: string): unknown
  /** 会话 id → 当前工作区目录。 */
  resolveSessionCwd(sessionId: string): string | undefined
}

const MAX_AGENTS_MD_BYTES = 512 * 1024

/** HandoffResult → ok() 载荷（接口没有索引签名，摊开成 Record）。 */
function handoffPayload(result: ReturnType<typeof buildHandoffDoc>): Record<string, unknown> {
  return {
    doc: result.doc,
    mode: result.mode,
    chars: result.chars,
    truncated: result.truncated,
    ...(result.llmFallback === true ? { llmFallback: true } : {}),
  }
}

/** 从 Message.content（string 或 ContentBlock[]）里抽取纯文本。 */
function textFromMessageContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string' && text.trim() !== '') parts.push(text)
    }
  }
  return parts.join('\n')
}

/** 防御式归一 deriveMessages()：只留 user/assistant 的文本消息。 */
function normalizeHandoffMessages(raw: unknown): HandoffMessage[] {
  if (!Array.isArray(raw)) return []
  const out: HandoffMessage[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const role = (item as { role?: unknown }).role
    if (role !== 'user' && role !== 'assistant') continue
    const text = textFromMessageContent((item as { content?: unknown }).content).trim()
    if (text !== '') out.push({ role, text })
  }
  return out
}

/** 防御式归一 snapshotEvents()：取最后一条 goal/change 与 todo/write。 */
function normalizeHandoffEvents(raw: unknown): HandoffEvents {
  let goal = ''
  const todos: string[] = []
  if (Array.isArray(raw)) {
    for (const event of raw) {
      if (event === null || typeof event !== 'object') continue
      const type = (event as { type?: unknown }).type
      const data = (event as { data?: unknown }).data
      if (data === null || typeof data !== 'object') continue
      if (type === 'goal/change') {
        const value = (data as { goal?: unknown; text?: unknown }).goal ?? (data as { text?: unknown }).text
        if (typeof value === 'string' && value.trim() !== '') goal = value
      } else if (type === 'todo/write') {
        const list = (data as { todos?: unknown }).todos
        if (Array.isArray(list)) {
          const next: string[] = []
          for (const todo of list) {
            if (todo === null || typeof todo !== 'object') continue
            const content = (todo as { content?: unknown }).content
            if (typeof content === 'string' && content.trim() !== '') next.push(content)
          }
          if (next.length > 0) todos.splice(0, todos.length, ...next)
        }
      }
    }
  }
  return { goal, todos }
}

/**
 * 看板/交接路由（三条，均 POST）：
 * - POST /api/zn-agent-client/workspace-config  {op:'read'|'write', workspaceId, content?}
 * - POST /api/zn-agent-client/cli-session-detail {agentId, resumeTarget, cwd?}
 * - POST /api/zn-agent-client/handoff-prepare   {session, mode?}
 *   （Handoff DSH：只读 deriveMessages/snapshotEvents 生成交接文档）
 *
 * DSH 会话预览不走宿主路由：客户端经授权的 SessionProvider +
 * conversation.content 工厂槽位直接渲染原生会话（零日志解析、零文件读取）。
 */
export function createWorkspaceRoutes(deps: WorkspaceRouteDeps): Array<{
  path: string
  method: string
  handler: (req: RouteRequest, res: RouteResponse) => Promise<void>
}> {
  return [
    {
      path: '/api/zn-agent-client/workspace-config',
      method: 'POST',
      handler: async (req: RouteRequest, res: RouteResponse): Promise<void> => {
        if (!guarded(req)) return void fail(res, 403, 'missing plugin header')
        const body = await readJsonBody(req)
        if (body === null) return void fail(res, 400, 'invalid body')
        const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : ''
        const op = body.op === 'write' ? 'write' : 'read'
        if (workspaceId === '') return void fail(res, 400, '缺少 workspaceId')
        const root = await deps.resolveWorkspacePath(workspaceId)
        if (root === null || root.trim() === '') return void fail(res, 404, '找不到该工作区（workspaceId 无法解析）')
        const filePath = join(root, 'AGENTS.md')
        if (op === 'read') {
          try {
            const content = await fs.readFile(filePath, 'utf8')
            json(res, 200, ok({ exists: true, content, path: filePath }))
          } catch {
            json(res, 200, ok({ exists: false, content: '', path: filePath }))
          }
          return
        }
        const content = typeof body.content === 'string' ? body.content : ''
        if (Buffer.byteLength(content, 'utf8') > MAX_AGENTS_MD_BYTES) return void fail(res, 413, 'AGENTS.md 内容过大（上限 512KB）')
        try {
          await fs.writeFile(filePath, content, 'utf8')
          json(res, 200, ok({ path: filePath }))
        } catch (error) {
          fail(res, 500, `写入失败：${error instanceof Error ? error.message : String(error)}`)
        }
      },
    },
    {
      path: '/api/zn-agent-client/cli-session-detail',
      method: 'POST',
      handler: async (req: RouteRequest, res: RouteResponse): Promise<void> => {
        if (!guarded(req)) return void fail(res, 403, 'missing plugin header')
        const body = await readJsonBody(req)
        if (body === null) return void fail(res, 400, 'invalid body')
        const agentId = typeof body.agentId === 'string' ? body.agentId : ''
        const resumeTarget = typeof body.resumeTarget === 'string' ? body.resumeTarget.trim() : ''
        const cwd = typeof body.cwd === 'string' ? body.cwd : ''
        if (resumeTarget === '') return void fail(res, 400, '缺少 resumeTarget')
        const agent = deps.resolveAgent(agentId)
        if (agent === undefined) return void fail(res, 404, `未知的 agent：${agentId}`)
        const transcript = await parseTranscript(agent.command, resumeTarget, cwd)
        // 恢复命令独立于预览：即使 transcript 不支持，命令照样能给出。
        const resumeCommand = buildLaunchPlan(agent, 'resume', resumeTarget).launchLine
        json(res, 200, ok({ ...transcript, resumeCommand }))
      },
    },
    {
      path: '/api/zn-agent-client/handoff-prepare',
      method: 'POST',
      handler: async (req: RouteRequest, res: RouteResponse): Promise<void> => {
        if (!guarded(req)) return void fail(res, 403, 'missing plugin header')
        const body = await readJsonBody(req)
        if (body === null) return void fail(res, 400, 'invalid body')
        const sessionId = typeof body.session === 'string' ? body.session.trim() : ''
        if (sessionId === '') return void fail(res, 400, '缺少会话 id')
        const mode = body.mode === 'llm' ? 'llm' : 'extract'
        // 只读 face：deriveMessages/snapshotEvents 都不改会话状态。
        const sessionObj = deps.getSession(sessionId) as
          | { deriveMessages?: () => unknown; snapshotEvents?: () => unknown }
          | undefined
        if (sessionObj === null || sessionObj === undefined || typeof sessionObj.deriveMessages !== 'function') {
          return void fail(res, 404, '会话不存在或无法读取（需要宿主会话服务）')
        }
        const messages = normalizeHandoffMessages(sessionObj.deriveMessages())
        const events = normalizeHandoffEvents(typeof sessionObj.snapshotEvents === 'function' ? sessionObj.snapshotEvents() : undefined)
        const cwd = deps.resolveSessionCwd(sessionId) ?? ''
        if (mode === 'llm' && messages.length > 0) {
          const summary = await llmSummarize(messages)
          if (summary !== null) {
            json(res, 200, ok(handoffPayload(buildHandoffDoc({ sessionId, cwd, messages, events, mode, llmSummary: summary }))))
            return
          }
          // LLM 失败回落提取式，标记 llmFallback 让客户端提示。
          json(res, 200, ok(handoffPayload(buildHandoffDoc({ sessionId, cwd, messages, events, mode, llmFallback: true }))))
          return
        }
        json(res, 200, ok(handoffPayload(buildHandoffDoc({ sessionId, cwd, messages, events, mode }))))
      },
    },
  ]
}
