/**
 * 座位（方案A）客户端半边：CLI 实例 ↔ DSH 会话映射的取数 + 建座流程。
 *
 * - 取数：座位查询/注册走宿主 /api/zn-agent-client/seats 路由。
 * - 建座：uiWorkspace.connectWorkspace(workspaceId) 创建并打开真实空白会话，
 *   返回新 SessionId，再 POST seats 注册映射——侧栏立即出现可搜索的会话行。
 * - 装饰数据：模块级轮询缓存（侧栏 leading 芯片 / hover 卡片共用）。
 * @module dsh-plugin-zn-agent-client/client/seats
 */

/** 座位记录（宿主 cli-seats.ts CliSeatRecord + 展示字段的同构）。 */
export interface SeatRecord {
  readonly dshSessionId: string
  readonly agentId: string
  readonly cwd: string
  readonly workspaceId?: string
  readonly cliSessionId?: string
  readonly cliTitle?: string
  readonly agentDisplayName: string
  /** 宿主终端状态：running / exited / none。 */
  readonly terminalState: string
  readonly createdAt: string
  readonly updatedAt: string
}

const SEATS_URL = '/api/zn-agent-client/seats'
const SEAT_PREPARE_URL = '/api/zn-agent-client/seat-prepare'
const GUARD = { 'x-zn-agent-client': '1', 'content-type': 'application/json' } as const

/** uiWorkspace 客户端服务面（connectWorkspace = 创建并打开空白会话，返回新会话 id）。 */
interface UiWorkspaceFace {
  connectWorkspace(workspaceId: string, options?: unknown): Promise<string>
}

/** registerSeatsInfrastructure 捕获的 uiWorkspace（旧宿主缺失时为 null）。 */
let uiWorkspace: UiWorkspaceFace | null = null

/**
 * 客户端 apply 时调用：捕获 uiWorkspace 服务（同 pluginNavigation 捕获模式）。
 * @param ctx - 客户端上下文。
 */
export function registerSeatsInfrastructure(ctx: import('@deepseek-ai/cordis').Context): void {
  try {
    ctx.inject(['uiWorkspace'], (scope) => {
      uiWorkspace = (scope.get('uiWorkspace') as UiWorkspaceFace | undefined) ?? null
    })
  } catch { /* 服务缺失（旧宿主）：建座按钮点击时报错提示 */ }
}

/** POST JSON 并解析标准回包 {ok, data|error}。 */
async function postSeats<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers: { ...GUARD }, body: JSON.stringify(body) })
  const payload = (await response.json().catch(() => null)) as { ok?: boolean; data?: T; error?: string } | null
  if (!response.ok || payload === null || payload.ok !== true) {
    throw new Error(payload?.error ?? `请求失败（${response.status}）`)
  }
  return payload.data as T
}

/** 查一个 DSH 会话的座位（无座位 → null）。 */
export async function fetchSeat(sessionId: string): Promise<SeatRecord | null> {
  const data = await postSeats<{ seat: SeatRecord | null }>(SEATS_URL, { op: 'get', session: sessionId })
  return data.seat
}

/** 查全部座位（侧栏装饰数据源）。 */
export async function fetchSeats(): Promise<readonly SeatRecord[]> {
  const data = await postSeats<{ seats: readonly SeatRecord[] }>(SEATS_URL, { op: 'list' })
  return data.seats
}

/** 注册座位（懒注册：任意会话里第一次启动 CLI 时调用）。 */
export function registerSeat(input: {
  readonly session: string
  readonly agentId: string
  readonly cliSessionId?: string
  readonly cliTitle?: string
}): Promise<SeatRecord> {
  return postSeats<SeatRecord>(SEATS_URL, { op: 'register', ...input })
}

/** 删除座位（结束 CLI 会话时）。 */
export function removeSeat(sessionId: string): Promise<void> {
  return postSeats<{ removed: boolean }>(SEATS_URL, { op: 'remove', session: sessionId }).then(() => undefined)
}

/** 座位会话的视图偏好（DSH 会话 store 的持久化键，dsh-client-ui-conversation/stores.ts）。 */
const CONVERSATION_STORE_KEY = 'dsh.conversation'
/** 我们注册的 conversation.view 条目 id（conversation-view.tsx 同值）。 */
export const CLI_VIEW_ID = 'znacp-terminal'

/**
 * 建座全流程：prepare（宿主解析 cwd + workspaceId）→ connectWorkspace（真实
 * DSH 会话，侧栏立刻可见）→ register（映射 + 标题同步）。返回新会话 id。
 *
 * 会话创建后、其视图 store 物化前，把 `dsh.conversation.<id>.view` 预写为
 * CLI 标签页（readConversationViewPreference 在 store 物化前读取）——新座位
 * 会话一打开就落在 CLI Agent 标签上，不用每次手动点。
 *
 * @param agentId - CLI agent 配置 id。
 * @param fromSessionId - 当前 DSH 会话（决定工作目录/工作区）。
 * @throws uiWorkspace 缺失或宿主解析失败时抛错（调用方 toast）。
 */
export async function createSeatSession(agentId: string, fromSessionId: string): Promise<string> {
  if (uiWorkspace === null || typeof uiWorkspace.connectWorkspace !== 'function') {
    throw new Error('uiWorkspace 服务不可用（宿主版本过旧）')
  }
  const prepared = await postSeats<{ cwd: string; workspaceId: string | null }>(SEAT_PREPARE_URL, {
    agentId,
    fromSession: fromSessionId,
  })
  if (prepared.workspaceId === null) {
    throw new Error(`当前目录不在任何工作区内：${prepared.cwd}`)
  }
  const newSessionId = await uiWorkspace.connectWorkspace(prepared.workspaceId)
  if (typeof newSessionId !== 'string' || newSessionId === '') {
    throw new Error('会话创建失败（connectWorkspace 未返回会话 id）')
  }
  // 同步写（在 React 重渲染挂载新会话之前），赢下物化竞速。
  try {
    localStorage.setItem(`${CONVERSATION_STORE_KEY}.${newSessionId}`, JSON.stringify({ view: CLI_VIEW_ID }))
  } catch { /* localStorage 不可用：退化为手动点标签页 */ }
  await registerSeat({ session: newSessionId, agentId })
  return newSessionId
}

/* ---------------------------------------------------------------- *
 * 侧栏装饰用的轮询缓存（leading 芯片 + hover 卡片共用一份订阅）。
 * ---------------------------------------------------------------- */

interface SeatStoreState {
  readonly seats: ReadonlyMap<string, SeatRecord>
}

let storeState: SeatStoreState = { seats: new Map() }
const storeListeners = new Set<() => void>()
let pollTimer: ReturnType<typeof setInterval> | undefined
let pollInFlight = false

/** 通知所有订阅者（React useSyncExternalStore 用）。 */
function emit(): void {
  for (const listener of storeListeners) listener()
}

/** 拉一次座位列表并广播（失败保持旧值）。 */
async function refresh(): Promise<void> {
  if (pollInFlight) return
  pollInFlight = true
  try {
    const seats = await fetchSeats()
    const next = new Map<string, SeatRecord>()
    for (const seat of seats) next.set(seat.dshSessionId, seat)
    // 简单对比：内容没变就不广播，避免侧栏行无谓重渲。
    const prev = storeState.seats
    const same = next.size === prev.size && [...next.entries()].every(([key, seat]) => {
      const old = prev.get(key)
      return old !== undefined &&
        old.cliSessionId === seat.cliSessionId &&
        old.cliTitle === seat.cliTitle &&
        old.terminalState === seat.terminalState &&
        old.updatedAt === seat.updatedAt
    })
    if (!same) {
      storeState = { seats: next }
      emit()
    }
  } catch { /* 宿主不可达：保持旧值 */ } finally {
    pollInFlight = false
  }
}

/** 订阅座位缓存（引用计数式启停轮询：无订阅者不空转）。 */
export function subscribeSeats(onChange: () => void): () => void {
  storeListeners.add(onChange)
  if (storeListeners.size === 1) {
    void refresh()
    pollTimer = setInterval(() => { void refresh() }, 5000)
  }
  return () => {
    storeListeners.delete(onChange)
    if (storeListeners.size === 0 && pollTimer !== undefined) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
  }
}

/** 读座位缓存快照。 */
export function getSeatsSnapshot(): SeatStoreState {
  return storeState
}

/** 按 DSH 会话 id 查缓存的座位（不触发网络）。 */
export function seatForSession(sessionId: string): SeatRecord | undefined {
  return storeState.seats.get(sessionId)
}

/** 强制立即刷新（注册/删除座位后调用）。 */
export function refreshSeatsSoon(): void {
  void refresh()
}
