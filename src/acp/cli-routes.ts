/**
 * CLI Agent 终端的宿主 HTTP/SSE 路由（dsh-agents-cli 同款传输层）。
 *
 * 客户端（同源相对路径 fetch）：
 *   POST /api/zn-agent-client/state   终端状态清单
 *   POST /api/zn-agent-client/open    打开/复用一个 agent PTY
 *   POST /api/zn-agent-client/stream  SSE：snapshot + output + state 帧
 *   POST /api/zn-agent-client/input   键击 write / 尺寸 resize
 *   POST /api/zn-agent-client/close   关闭终端
 * 所有路由要求静态防误触头 `x-zn-agent-client: 1`。
 * @module dsh-plugin-zn-agent-client/acp/cli-routes
 */

import type { AgentConfig } from '../types/index.ts'
import {
  CliTerminalController,
  LIMITS,
  type ManagedTerminal,
  type SseResponse,
  type TerminalStatus,
} from './cli-terminal.ts'
import { buildLaunchPlan, listAgentSessions, type SessionMode } from './cli-sessions.ts'

/** 插件路由防误触头（照参考插件的静态头约定）。 */
export const GUARD_HEADER = 'x-zn-agent-client'

/** 路由基地址。 */
export const ROUTES = {
  state: '/api/zn-agent-client/state',
  open: '/api/zn-agent-client/open',
  stream: '/api/zn-agent-client/stream',
  input: '/api/zn-agent-client/input',
  close: '/api/zn-agent-client/close',
  sessions: '/api/zn-agent-client/sessions',
} as const

/** 宿主 webServer 服务的结构面（dsh-host-webserver）。 */
export interface WebServerFace {
  register(route: { kind: string; path: string; handler: (req: RouteRequest, res: RouteResponse) => void }): void
}

/** IncomingMessage 的结构面。 */
export interface RouteRequest {
  url?: string
  method?: string
  headers?: Record<string, string | string[] | undefined>
  on?(event: string, cb: () => void): unknown
  destroy?(): unknown
  [Symbol.asyncIterator](): AsyncIterable<string | Uint8Array>
}

/** ServerResponse 的结构面。 */
export interface RouteResponse {
  writeHead(code: number, headers?: Record<string, string>): unknown
  end(payload?: string): unknown
  write(payload: string): boolean | void
  flushHeaders?(): unknown
  once?(event: string, cb: () => void): unknown
  off?(event: string, cb: () => void): unknown
  destroyed?: boolean
  writableEnded?: boolean
  writableLength?: number
  headersSent?: boolean
}

/** 发一个 JSON 响应。 */
function json(res: RouteResponse, status: number, payload: unknown): RouteResponse {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
  return res
}

/** 读取并解析 JSON 请求体（带 256KB 上限）。 */
async function readJsonBody(req: RouteRequest, limit = 256 * 1024): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    const bodyStream = req as unknown as AsyncIterable<string | Uint8Array>
    for await (const chunk of bodyStream) {
      const buf: Buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
      size += buf.length
      if (size > limit) {
        req.destroy?.()
        return null
      }
      chunks.push(buf)
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function guarded(req: RouteRequest): boolean {
  return req.headers?.[GUARD_HEADER] === '1'
}

function ok(result: Record<string, unknown>): Record<string, unknown> {
  return { ok: true, ...result }
}

function fail(res: RouteResponse, status: number, message: string): RouteResponse {
  return json(res, status, { ok: false, error: message })
}

/** openTerminal 的参数装配：配置解析由调用方注入。 */
export interface CliRouteOptions {
  /** 解析 agent 配置（apply 闭包里的 resolveAgentConfig）。 */
  resolveAgent: (agentId: string) => AgentConfig | null
  /** 终端 cwd 为空时的默认目录（工作区目录）。 */
  defaultCwd: () => string
  /** 会话 id → 该会话的工作目录（= 工作区根）；拿不到时回退 defaultCwd。 */
  resolveSessionCwd?: (sessionId: string) => string | undefined
}

/** 组装五条路由定义（注册交给调用方走 ctx.effect）。 */
export function createCliTerminalRoutes(controller: CliTerminalController, options: CliRouteOptions): Array<{ path: string; method: string; handler: (req: RouteRequest, res: RouteResponse) => Promise<void> }> {
  const resolveAgent = options.resolveAgent

  async function openTerminal(req: RouteRequest, res: RouteResponse): Promise<void> {
    if (!guarded(req)) return void fail(res, 403, 'missing plugin header')
    const body = await readJsonBody(req)
    if (body === null) return void fail(res, 400, 'invalid body')
    const agentId = typeof body.id === 'string' ? body.id.trim() : ''
    if (agentId === '') return void fail(res, 400, 'missing agent id')
    const agent = resolveAgent(agentId)
    if (agent === null) return void fail(res, 404, `未找到入口：${agentId}`)
    const requested = typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : undefined
    const fromSession = typeof body.session === 'string' && body.session !== ''
      ? options.resolveSessionCwd?.(body.session)
      : undefined
    const rawMode = typeof body.mode === 'string' ? (body.mode as SessionMode) : 'attach'
    const mode: SessionMode = rawMode === 'new' || rawMode === 'continue' || rawMode === 'resume' ? rawMode : 'attach'
    const plan = buildLaunchPlan(agent, mode, typeof body.resumeTarget === 'string' ? body.resumeTarget : undefined)
    try {
      const term = await controller.openTerminal({
        id: agent.id,
        agentId: agent.id,
        displayName: agent.displayName,
        command: agent.command,
        cwd: requested ?? fromSession ?? options.defaultCwd(),
        cols: body.cols,
        rows: body.rows,
        restart: body.restart === true,
        resume: body.resume === true,
        mode: plan.mode,
        ...(plan.launchLine !== undefined ? { launchLine: plan.launchLine } : {}),
      })
      return void json(res, 200, ok({
        info: term.status,
        environment: {
          maxCols: LIMITS.maxCols,
          maxRows: LIMITS.maxRows,
          scrollback: LIMITS.scrollback,
          maxInputBytes: LIMITS.maxInputBytes,
          maxBufferedBytes: LIMITS.maxBufferedBytes,
        },
      }))
    } catch (error) {
      return void fail(res, 500, error instanceof Error ? error.message : String(error))
    }
  }

  async function stream(req: RouteRequest, res: RouteResponse): Promise<void> {
    if (!guarded(req)) return void fail(res, 403, 'missing plugin header')
    const body = await readJsonBody(req)
    const id = typeof body?.id === 'string' && body.id !== '' ? body.id : ''
    const term = id === '' ? undefined : controller.getTerminal(id)
    if (term === undefined) return void fail(res, 404, 'terminal not found')
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.flushHeaders?.()
    const detach = await term.attachSse(res as SseResponse)
    const beat = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        stop()
      }
    }, 25000)
    beat.unref?.()
    const stop = (): void => {
      clearInterval(beat)
      detach()
    }
    // IncomingMessage 的 'close' 可能只代表 POST body 结束，用 aborted + res close 双保险。
    req.on?.('aborted', stop)
    res.once?.('close', stop)
  }

  async function input(req: RouteRequest, res: RouteResponse): Promise<void> {
    if (!guarded(req)) return void fail(res, 403, 'missing plugin header')
    const body = await readJsonBody(req)
    if (body === null) return void fail(res, 400, 'invalid body')
    const id = typeof body.id === 'string' ? body.id : ''
    const term: ManagedTerminal | undefined = id === '' ? undefined : controller.getTerminal(id)
    if (term === undefined) return void fail(res, 404, 'terminal not found')
    try {
      if (body.type === 'write') {
        await term.write(typeof body.data === 'string' ? body.data : '')
      } else if (body.type === 'resize') {
        await term.resize(body.cols, body.rows)
      } else {
        return void fail(res, 400, 'unsupported input command')
      }
      return void json(res, 200, ok({}))
    } catch (error) {
      return void fail(res, 400, error instanceof Error ? error.message : String(error))
    }
  }

  async function closeTerminal(req: RouteRequest, res: RouteResponse): Promise<void> {
    if (!guarded(req)) return void fail(res, 403, 'missing plugin header')
    const body = await readJsonBody(req)
    if (body === null) return void fail(res, 400, 'invalid body')
    const id = typeof body.id === 'string' ? body.id : ''
    const closed = id === '' ? false : await controller.close(id)
    return void json(res, 200, ok({ closed, terminals: controller.listStatus() }))
  }

  async function state(req: RouteRequest, res: RouteResponse): Promise<void> {
    if (!guarded(req)) return void fail(res, 403, 'missing plugin header')
    return void json(res, 200, ok({ terminals: serializeStatuses(controller.listStatus()) }))
  }

  /** 历史▾ 的数据源：agent × 工作目录下的历史会话列表。 */
  async function sessions(req: RouteRequest, res: RouteResponse): Promise<void> {
    if (!guarded(req)) return void fail(res, 403, 'missing plugin header')
    const body = await readJsonBody(req)
    if (body === null) return void fail(res, 400, 'invalid body')
    const agentId = typeof body.id === 'string' ? body.id.trim() : ''
    if (agentId === '') return void fail(res, 400, 'missing agent id')
    const agent = resolveAgent(agentId)
    if (agent === null) return void fail(res, 404, `未找到入口：${agentId}`)
    const cwd = typeof body.session === 'string' && body.session !== ''
      ? options.resolveSessionCwd?.(body.session) ?? options.defaultCwd()
      : options.defaultCwd()
    try {
      const found = await listAgentSessions(agent, cwd)
      return void json(res, 200, ok({ sessions: found, cwd }))
    } catch (error) {
      return void fail(res, 500, error instanceof Error ? error.message : String(error))
    }
  }

  return [
    { path: ROUTES.state, method: 'POST', handler: state },
    { path: ROUTES.open, method: 'POST', handler: openTerminal },
    { path: ROUTES.stream, method: 'POST', handler: stream },
    { path: ROUTES.input, method: 'POST', handler: input },
    { path: ROUTES.close, method: 'POST', handler: closeTerminal },
    { path: ROUTES.sessions, method: 'POST', handler: sessions },
  ]
}

/** JSON 化状态清单（去掉运行时字段，保持路由载荷轻）。 */
export function serializeStatuses(statuses: Record<string, TerminalStatus>): Record<string, TerminalStatus> {
  const result: Record<string, TerminalStatus> = {}
  for (const [id, status] of Object.entries(statuses)) {
    result[id] = {
      id: status.id,
      agentId: status.agentId,
      displayName: status.displayName,
      command: status.command,
      launch: status.launch,
      cwd: status.cwd,
      cols: status.cols,
      rows: status.rows,
      state: status.state,
      exitCode: status.exitCode,
      error: status.error,
    }
  }
  return result
}
