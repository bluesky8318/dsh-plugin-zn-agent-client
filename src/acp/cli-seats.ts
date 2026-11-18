/**
 * CLI 座位（方案A）宿主半边：每个 CLI Agent 实例住在一个真实的 DSH 会话里。
 *
 * 职责：
 *  1. 持久化映射 {dshSessionId ↔ agentId ↔ cwd ↔ cliSessionId}（插件自有数据，
 *     可删；CLI 会话文件永远是 CLI 自己的，本模块只读不改）。
 *  2. 路由：/api/zn-agent-client/seats（list/get/register/remove）+
 *     /api/zn-agent-client/seat-prepare（解析工作区给 connectWorkspace）。
 *  3. 标题同步：注册座位时把 DSH 会话改名 `CLI·<agent>`；监听 CLI 原生会话
 *     目录，出现新会话后改名 `CLI·<agent> · <首条消息>`（sessionTitle.rename
 *     是日志级持久操作，侧栏/sessions.search 直接可见）。
 * @module dsh-plugin-zn-agent-client/acp/cli-seats
 */

import { mkdir, readFile, rename as fsRename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentConfig } from '../types/index.ts'
import { listAgentSessions } from './cli-sessions.ts'
import { fail, guarded, json, ok, readJsonBody, type RouteRequest, type RouteResponse } from './cli-routes.ts'

/** 一条座位映射。 */
export interface CliSeatRecord {
  /** DSH 会话 id（座位的宿主）。 */
  readonly dshSessionId: string
  /** CLI agent 配置 id。 */
  readonly agentId: string
  /** PTY 工作目录（座位创建时确定，之后固定）。 */
  readonly cwd: string
  /** 创建时解析出的工作区 id（仅记录，便于排查）。 */
  readonly workspaceId?: string
  /** CLI 原生会话 id（watcher 探测到后回填）。 */
  readonly cliSessionId?: string
  /** CLI 首条消息文本（标题第二段）。 */
  readonly cliTitle?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** seats.json 的磁盘形态。 */
interface SeatsFile {
  readonly version: 1
  readonly seats: readonly CliSeatRecord[]
}

/** 座位 JSON 存放路径：~/.dsh/plugin-data/<plugin>/seats.json。 */
function seatsFilePath(): string {
  return join(homedir(), '.dsh', 'plugin-data', 'dsh-plugin-zn-agent-client', 'seats.json')
}

/** 插件自有、可删的展示数据：fs JSON + 防抖写盘；损坏即重开（数据可再生成）。 */
export class CliSeatStore {
  private seats = new Map<string, CliSeatRecord>()
  private loaded = false
  private writeTimer: NodeJS.Timeout | undefined

  /** 启动时读盘；并发调用只读一次。 */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(seatsFilePath(), 'utf8')
      const parsed = JSON.parse(raw) as SeatsFile
      if (Array.isArray(parsed?.seats)) {
        for (const seat of parsed.seats) {
          if (typeof seat?.dshSessionId === 'string' && typeof seat?.agentId === 'string') {
            this.seats.set(seat.dshSessionId, seat)
          }
        }
      }
    } catch {
      // 不存在/损坏都从空开始——座位只是展示映射。
    }
  }

  list(): readonly CliSeatRecord[] {
    return [...this.seats.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  get(dshSessionId: string): CliSeatRecord | undefined {
    return this.seats.get(dshSessionId)
  }

  /** 按 CLI 原生会话 id 反查座位（避免同一 CLI 会话被两个座位争用）。 */
  findByCliSession(cliSessionId: string): CliSeatRecord | undefined {
    return this.list().find((seat) => seat.cliSessionId === cliSessionId)
  }

  async register(input: {
    readonly dshSessionId: string
    readonly agentId: string
    readonly cwd: string
    readonly workspaceId?: string
    readonly cliSessionId?: string
    readonly cliTitle?: string
  }): Promise<CliSeatRecord> {
    const existing = this.seats.get(input.dshSessionId)
    const now = new Date().toISOString()
    const record: CliSeatRecord = {
      ...input,
      ...(existing?.workspaceId !== undefined && input.workspaceId === undefined ? { workspaceId: existing.workspaceId } : {}),
      ...(existing?.cliSessionId !== undefined && input.cliSessionId === undefined ? { cliSessionId: existing.cliSessionId } : {}),
      ...(existing?.cliTitle !== undefined && input.cliTitle === undefined ? { cliTitle: existing.cliTitle } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.seats.set(input.dshSessionId, record)
    await this.scheduleWrite()
    return record
  }

  async attachCli(dshSessionId: string, cliSessionId: string, cliTitle?: string): Promise<CliSeatRecord | undefined> {
    const existing = this.seats.get(dshSessionId)
    if (existing === undefined) return undefined
    const record: CliSeatRecord = {
      ...existing,
      cliSessionId,
      ...(cliTitle !== undefined && cliTitle !== '' ? { cliTitle } : {}),
      updatedAt: new Date().toISOString(),
    }
    this.seats.set(dshSessionId, record)
    await this.scheduleWrite()
    return record
  }

  async remove(dshSessionId: string): Promise<boolean> {
    const existed = this.seats.delete(dshSessionId)
    if (existed) await this.scheduleWrite()
    return existed
  }

  /** 防抖 300ms 合并连续写。 */
  private scheduleWrite(): Promise<void> {
    return new Promise((resolve) => {
      if (this.writeTimer !== undefined) clearTimeout(this.writeTimer)
      this.writeTimer = setTimeout(() => {
        this.writeTimer = undefined
        void this.flush().finally(resolve)
      }, 300)
    })
  }

  private async flush(): Promise<void> {
    const path = seatsFilePath()
    const payload: SeatsFile = { version: 1, seats: this.list() }
    try {
      await mkdir(dirname(path), { recursive: true })
      const temp = `${path}.tmp`
      await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      await fsRename(temp, path)
    } catch {
      // 写盘失败不影响内存态；下次变更再试。
    }
  }

  /** 插件停用时落盘并清理监听。 */
  async dispose(): Promise<void> {
    if (this.writeTimer !== undefined) {
      clearTimeout(this.writeTimer)
      this.writeTimer = undefined
      await this.flush()
    }
  }
}

/** 座位路由的依赖注入面（index.ts 装配，全部可选降级）。 */
export interface SeatRouteDeps {
  /** agent 配置解析（与终端路由同一实现）。 */
  resolveAgent: (agentId: string) => AgentConfig | null
  /** DSH 会话 id → 工作目录。 */
  resolveSessionCwd?: (sessionId: string) => string | undefined
  /** 无会话上下文时的默认目录。 */
  defaultCwd: () => string
  /** cwd → 工作区 id（connectWorkspace 需要）；解析不到回 null。 */
  resolveWorkspaceId?: (cwd: string) => Promise<string | null>
  /** 活会话对象（sessionTitle.rename 需要；冷会话 undefined → 跳过改名）。 */
  getSession?: (sessionId: string) => unknown | undefined
  /** 日志级改名（user source，钉住标题）。 */
  renameTitle?: (session: unknown, title: string) => void
  /** 终端状态查询（composite id → running/exited）。 */
  terminalState?: (terminalId: string) => string | undefined
  /** agent 显示名（标题第一段）。 */
  agentDisplayName?: (agentId: string) => string
  /** 日志。 */
  log?: (message: string) => void
}

/** 座位路由定义（与 cli-routes 的返回形态一致）。 */
export interface SeatRoute {
  readonly path: string
  readonly method: string
  readonly handler: (req: RouteRequest, res: RouteResponse) => Promise<void>
}

const SEATS_POLL_INTERVAL_MS = 2500
const SEATS_POLL_ROUNDS = 96 // ~4 分钟：覆盖用户先点开会话再输入首条消息的节奏

/** 组装座位路由（注册交给调用方走 ctx.effect）。 */
export function createSeatRoutes(
  store: CliSeatStore,
  deps: SeatRouteDeps,
): readonly SeatRoute[] {
  /** 每个座位的 watcher：基线差分找 CLI 新会话 → 回填 + 改名。 */
  interface Watcher {
    baseline: ReadonlySet<string>
    timer: NodeJS.Timeout | undefined
    rounds: number
  }
  const watchers = new Map<string, Watcher>()

  const stopWatcher = (dshSessionId: string): void => {
    const watcher = watchers.get(dshSessionId)
    if (watcher?.timer !== undefined) clearTimeout(watcher.timer)
    watchers.delete(dshSessionId)
  }

  /** sessionTitle.rename 封装：冷会话/服务缺失时静默跳过。 */
  const pinTitle = (dshSessionId: string, title: string): void => {
    if (deps.renameTitle === undefined) return
    const session = deps.getSession?.(dshSessionId)
    if (session === undefined || session === null) return
    try {
      deps.renameTitle(session, title)
    } catch (error) {
      deps.log?.(`座位改名失败 ${dshSessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const titleFor = (seat: CliSeatRecord): string => {
    const display = deps.agentDisplayName?.(seat.agentId) ?? seat.agentId
    return seat.cliTitle !== undefined && seat.cliTitle !== ''
      ? `CLI·${display} · ${seat.cliTitle}`
      : `CLI·${display}`
  }

  /**
   * 座位标记：给会话写入一对空 turn 事件（`turn/start` + `turn/end`，无任何
   * 消息），解除会话的 blank 状态。
   *
   * 为什么必须：DSH 侧栏 `sessionVisible` 对 blank 会话「除当前打开外一律
   * 隐藏」，且 blank 行标题强制显示「新会话」、搜索排除、`sidebar.session
   * .row.leading` 槽位不挂载（`!row.blank`）。blank 的唯一解除条件是日志里
   * 出现 `turn/start` 事件（`applySessionListMetadata`）。写入一对已完成、
   * 无消息的 turn 是最小标记：不触发 agent、不产生模型调用，代理循环的
   * lastTurn 折叠会接续该编号。
   */
  const markSeatTurn = (dshSessionId: string): void => {
    const session = deps.getSession?.(dshSessionId) as
      | { snapshotEvents?(): unknown[]; append(type: string, data: unknown): void }
      | undefined
      | null
    if (session === undefined || session === null) return
    try {
      const events = (typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []) as Array<{ type: string; data?: { turn?: unknown } }>
      // 只标记 blank 会话（日志里从未有过 turn/start）。正常会话（有历史轮次）
      // 已经非 blank，不需要也不应该被追加幻影 turn。
      const hasTurn = events.some((event) => event.type === 'turn/start')
      if (hasTurn) return
      const last = [...events].reverse().find((event) => event.type === 'turn/start')
      const turn = Number(last?.data?.turn ?? 0) + 1
      session.append('turn/start', { turn })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    } catch (error) {
      deps.log?.(`座位标记失败 ${dshSessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 注册后启动监听：等 CLI 侧出现新会话（首条消息落盘）→ 回填 + 二段改名。 */
  const startWatcher = (seat: CliSeatRecord): void => {
    const agent = deps.resolveAgent(seat.agentId)
    if (agent === null || seat.cliSessionId !== undefined) return
    stopWatcher(seat.dshSessionId)
    const watcher: Watcher = { baseline: new Set<string>(), timer: undefined, rounds: 0 }
    watchers.set(seat.dshSessionId, watcher)
    // 基线异步拍（先于 spawn；register 时已存在的 CLI 会话都不算「新」）。
    // 拍失败（目录不存在）就保持空基线=之后出现的都算新。
    void listAgentSessions(agent, seat.cwd)
      .then((items) => {
        if (watchers.get(seat.dshSessionId) !== watcher) return
        watcher.baseline = new Set(items.map((item) => item.id))
      })
      .catch(() => { /* 空基线 */ })
    const tick = (): void => {
      if (watchers.get(seat.dshSessionId) !== watcher) return
      watcher.rounds += 1
      void listAgentSessions(agent, seat.cwd)
        .then((next) => {
          if (watchers.get(seat.dshSessionId) !== watcher) return
          const fresh = next.find((item) => !watcher.baseline.has(item.id))
          if (fresh === undefined) {
            if (watcher.rounds >= SEATS_POLL_ROUNDS) stopWatcher(seat.dshSessionId)
            else watcher.timer = setTimeout(tick, SEATS_POLL_INTERVAL_MS)
            return
          }
          stopWatcher(seat.dshSessionId)
          void store.attachCli(seat.dshSessionId, fresh.id, fresh.summary)
            .then((updated) => {
              if (updated !== undefined) pinTitle(seat.dshSessionId, titleFor(updated))
            })
        })
        .catch(() => {
          // 枚举失败（目录还没建）：继续下一轮，到轮数上限为止。
          if (watcher.rounds >= SEATS_POLL_ROUNDS) stopWatcher(seat.dshSessionId)
          else watcher.timer = setTimeout(tick, SEATS_POLL_INTERVAL_MS)
        })
    }
    watcher.timer = setTimeout(tick, SEATS_POLL_INTERVAL_MS)
  }

  return [
    {
      path: '/api/zn-agent-client/seats',
      method: 'POST',
      handler: async (req, res) => {
        if (!guarded(req)) return void fail(res, 403, 'missing plugin header')
        const body = await readJsonBody(req)
        if (body === null) return void fail(res, 400, 'invalid body')
        const op = typeof body.op === 'string' ? body.op : ''
        if (op === 'list') {
          const seats = store.list().map((seat) => ({
            ...seat,
            agentDisplayName: deps.agentDisplayName?.(seat.agentId) ?? seat.agentId,
            terminalState: deps.terminalState?.(`${seat.dshSessionId}:${seat.agentId}`) ?? 'none',
          }))
          return void json(res, 200, ok({ seats }))
        }
        if (op === 'get') {
          const sessionId = typeof body.session === 'string' ? body.session : ''
          const seat = sessionId === '' ? undefined : store.get(sessionId)
          return void json(res, 200, ok({
            seat: seat === undefined ? null : {
              ...seat,
              agentDisplayName: deps.agentDisplayName?.(seat.agentId) ?? seat.agentId,
              terminalState: deps.terminalState?.(`${seat.dshSessionId}:${seat.agentId}`) ?? 'none',
            },
          }))
        }
        if (op === 'register') {
          const sessionId = typeof body.session === 'string' ? body.session.trim() : ''
          const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : ''
          if (sessionId === '' || agentId === '') return void fail(res, 400, 'missing session/agent id')
          if (deps.resolveAgent(agentId) === null) return void fail(res, 404, `未找到入口：${agentId}`)
          const cwd = typeof body.cwd === 'string' && body.cwd !== ''
            ? body.cwd
            : deps.resolveSessionCwd?.(sessionId) ?? deps.defaultCwd()
          const cliSessionId = typeof body.cliSessionId === 'string' && body.cliSessionId !== '' ? body.cliSessionId : undefined
          const cliTitle = typeof body.cliTitle === 'string' && body.cliTitle !== '' ? body.cliTitle : undefined
          const seat = await store.register({
            dshSessionId: sessionId,
            agentId,
            cwd,
            ...(cliSessionId !== undefined ? { cliSessionId } : {}),
            ...(cliTitle !== undefined ? { cliTitle } : {}),
          })
          // 一段改名（注册即钉住 `CLI·<agent>`）；resume 流程带 cliTitle 直接二段。
          pinTitle(sessionId, titleFor(seat))
          // 解除 blank：侧栏可见/可搜索/装饰槽位的共同前提（见 markSeatTurn 注释）。
          markSeatTurn(sessionId)
          if (cliSessionId === undefined || cliTitle === undefined) startWatcher(seat)
          // resume 且已带 cliTitle：标题已钉，无需监听。
          deps.log?.(`座位已注册: ${sessionId} → ${agentId} @ ${cwd}`)
          return void json(res, 200, ok({ seat }))
        }
        if (op === 'remove') {
          const sessionId = typeof body.session === 'string' ? body.session : ''
          stopWatcher(sessionId)
          const removed = sessionId === '' ? false : await store.remove(sessionId)
          return void json(res, 200, ok({ removed }))
        }
        return void fail(res, 400, `unsupported op: ${op}`)
      },
    },
    {
      path: '/api/zn-agent-client/seat-prepare',
      method: 'POST',
      handler: async (req, res) => {
        if (!guarded(req)) return void fail(res, 403, 'missing plugin header')
        const body = await readJsonBody(req)
        if (body === null) return void fail(res, 400, 'invalid body')
        const fromSession = typeof body.fromSession === 'string' && body.fromSession !== '' ? body.fromSession : undefined
        const cwd = (fromSession !== undefined ? deps.resolveSessionCwd?.(fromSession) : undefined)
          ?? deps.defaultCwd()
        const workspaceId = deps.resolveWorkspaceId === undefined ? null : await deps.resolveWorkspaceId(cwd)
        return void json(res, 200, ok({ cwd, workspaceId }))
      },
    },
  ]
}

/** 插件停用时停止全部监听并落盘。 */
export function disposeSeatWatchers(store: CliSeatStore, stopAll: () => void): Promise<void> {
  stopAll()
  return store.dispose()
}
