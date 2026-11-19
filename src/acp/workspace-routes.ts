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

/** createWorkspaceRoutes 的依赖面。 */
export interface WorkspaceRouteDeps {
  /** agentId → agent 配置（拿启动命令）。 */
  resolveAgent(agentId: string): Pick<AgentConfig, 'command'> & { readonly cliArgs?: readonly string[] } | undefined
  /** workspaceId → 工作区绝对路径；解析不到返回 null。 */
  resolveWorkspacePath(workspaceId: string): Promise<string | null>
}

const MAX_AGENTS_MD_BYTES = 512 * 1024

/**
 * 看板路由（两条，均 POST）：
 * - POST /api/zn-agent-client/workspace-config  {op:'read'|'write', workspaceId, content?}
 * - POST /api/zn-agent-client/cli-session-detail {agentId, resumeTarget, cwd?}
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
  ]
}
