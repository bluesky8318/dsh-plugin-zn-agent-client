/**
 * 终端编排层：把一个 agent 的 TUI 跑进宿主的浏览器终端。
 *
 * 一律走宿主 `ctx.webTerminals` 服务（`dsh-api-terminal-controller` 的客户端
 * 半边）——这是官方终端页签自己用的创建路径：`view()` 首次调用即分配 PTY 并
 * 注册进会话花名册，`(sessionId, contentId)` 绑定持久化在 localStorage，页面
 * 重载后用同一 contentId 再 view 会收养原进程。直接调 `remote.terminal.create`
 * 的裸路径不进这份绑定，宿主页签会报"终端已不存在"（v0.1.3 踩过的坑）。
 *
 * 服务探测是结构化的（view/close/recover 同形才算在），部署缺服务时降级成
 * 提示文案，绝不让插件 apply 失败。
 * @module dsh-plugin-zn-agent-client/client/term-model
 */

import type { Context } from '@deepseek-ai/cordis'

/** 宿主终端身份（每个会话、每次宿主生命周期内唯一）。 */
export type WebTerminalId = string

/** 宿主终端元信息（webTerminals.recover / state.info 的形状）。 */
export interface HostTerminalInfo {
  readonly id: WebTerminalId
  readonly title: string
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly state: 'running' | 'exited' | 'failed'
  readonly exitCode: number | null
  readonly error?: string
}

/** 宿主广播的终端帧（快照重放 / 增量输出 / 元数据）。 */
export type HostTerminalFrame =
  | { readonly type: 'snapshot'; readonly sequence: number; readonly screen: string; readonly info: HostTerminalInfo }
  | { readonly type: 'output'; readonly sequence: number; readonly data: string }
  | { readonly type: 'state'; readonly info: HostTerminalInfo }

/** 携带屏幕内容的帧（state 只是元数据，不进模拟器）。 */
export type HostRenderFrame = Extract<HostTerminalFrame, { type: 'snapshot' | 'output' }>

/** 单个终端视图的可观察状态。 */
export interface HostTerminalViewState {
  readonly phase: 'idle' | 'loading' | 'creating' | 'connecting' | 'connected' | 'disconnected' | 'closing' | 'closed' | 'failed'
  readonly cwd?: string | undefined
  readonly maxInputBytes?: number | undefined
  readonly maxCols?: number | undefined
  readonly maxRows?: number | undefined
  readonly scrollback?: number | undefined
  readonly title?: string | undefined
  readonly info?: HostTerminalInfo | undefined
  /** 本视图当前是否握有输入/尺寸控制权。 */
  readonly writable: boolean
  /** 等待 acknowledge 的下一帧。 */
  readonly render?: { readonly revision: number; readonly frame: HostRenderFrame } | undefined
  readonly error?: string | undefined
  readonly issue?: 'missingTerminal' | 'inputFull' | 'attachmentEnded' | 'invalidOutput' | 'terminalLimit' | undefined
}

/** 宿主快照存储的最小面。 */
export interface HostSnapshot<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** 一个终端视图的模型；DOM 卸载不杀进程。 */
export interface HostTerminalView {
  readonly id: WebTerminalId
  readonly state: HostSnapshot<HostTerminalViewState>
  /** 挂 DOM 生命周期；返回卸载回调（进程继续活着）。 */
  mount(): () => void
  /** 启动或恢复（服务去重）。 */
  refresh(): Promise<void>
  /** 以全新屏幕重连并拿回输入权。 */
  connect(): void
  /** 放行下一帧（模拟器解析完上一帧后调用）。 */
  acknowledge(revision: number): void
  /** 写原始输入（非 writable 时被宿主拒绝）。 */
  write(data: string): void
  /** 仅在 writable 时调尺寸。 */
  resize(cols: number, rows: number): void
  /** 结束进程。 */
  close(): Promise<void>
}

/** 本插件消费的 webTerminals 服务切片。 */
export interface WebTerminalsFace {
  /**
   * `key` 记忆化模型（重复调用免费），首次调用立即分配终端；
   * `contentId` 是持久化键 —— 同值重载后收养原进程。
   */
  view(sessionId: string, key: string, contentId: string, terminalId?: WebTerminalId, shellPath?: string): HostTerminalView
  /** 记住关闭意图并解绑 (sessionId, contentId)。 */
  close(sessionId: string, key: string, contentId: string, terminalId?: WebTerminalId): void
  /** 无视图查询会话终端。 */
  recover(sessionId: string): Promise<HostTerminalInfo[]>
}

/** sidebarRight 服务里用到的部分。 */
export interface SidebarRightFace {
  readonly mounted: { getSnapshot(): string | undefined }
  openTab(kind: string, options?: { params?: Record<string, unknown> }): void
}

/**
 * 结构化探测宿主终端服务；形状不对读作缺席。
 * @param ctx - 客户端上下文。
 */
export function webTerminals(ctx: Context): WebTerminalsFace | undefined {
  const service = (ctx as { get(name: string): unknown }).get('webTerminals') as Partial<WebTerminalsFace> | undefined
  if (service === undefined || service === null) return undefined
  if (typeof service.view !== 'function' || typeof service.close !== 'function') return undefined
  if (typeof service.recover !== 'function') return undefined
  return service as WebTerminalsFace
}

/** 结构化探测右侧边栏服务。 */
export function sidebarRight(ctx: Context): SidebarRightFace | undefined {
  const service = (ctx as { get(name: string): unknown }).get('sidebarRight') as Partial<SidebarRightFace> | undefined
  if (service === undefined || service === null) return undefined
  if (typeof service.openTab !== 'function' || service.mounted === undefined) return undefined
  return service as SidebarRightFace
}

/**
 * 一个 agent 在宿主终端里的持久身份（contentId 与 key 同值）。
 * 稳定值让页面重载收养同一进程；`#<n>` 后缀留给"重开"换生成。
 * @param agentId - agent 配置 id。
 */
export function agentTerminalIdentity(agentId: string): string {
  return `znacp-view:${agentId.replace(/[^\w-]/g, '-')}`
}

/**
 * 等待视图 writable（创建→连接→快照可达数秒）。
 * @param model - 终端视图模型。
 * @param timeoutMs - 超时上限；超时抛错（文案由调用方本地化）。
 */
export function waitForWritable(model: HostTerminalView, timeoutMs = 12000): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false
    const settle = (fn: () => void): void => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      unsubscribe()
      fn()
    }
    const check = (): void => {
      const state = model.state.getSnapshot()
      if (state.writable) return settle(resolve)
      if (state.issue === 'missingTerminal' || state.phase === 'failed' || state.phase === 'closed') {
        return settle(() => { reject(new Error(`terminal ${state.issue ?? state.phase}`)) })
      }
    }
    const unsubscribe = model.state.subscribe(check)
    const timer = window.setTimeout(() => {
      settle(() => { reject(new Error('terminal timeout')) })
    }, timeoutMs)
    check()
  })
}

/**
 * 启动 agent TUI 并在右侧边栏以宿主终端页签打开。
 * @param ctx - 客户端上下文（惰性取 webTerminals / sidebarRight）。
 * @param sessionId - 目标会话（终端跑在其工作目录）。
 * @param agent - 目标 agent（command 作为 TUI 启动命令）。
 * @returns 宿主终端 id（打开页签用）。
 */
export async function openAgentTerminalTab(
  ctx: Context,
  sessionId: string,
  agent: { id: string; displayName: string; command: string },
): Promise<WebTerminalId> {
  const service = webTerminals(ctx)
  if (service === undefined) throw new Error('no service')
  if (agent.command === '') throw new Error('no command')
  const identity = agentTerminalIdentity(agent.id)
  const model = service.view(sessionId, identity, identity)
  await waitForWritable(model)
  // 程序注入启动命令；typed 语义是"人敲的"，这里保持 false。
  model.write(`${agent.command}\r`)
  const sidebar = sidebarRight(ctx)
  const info = model.state.getSnapshot().info
  if (sidebar !== undefined && info !== undefined) {
    sidebar.openTab('terminal', { params: { terminalId: info.id } })
  }
  return info?.id ?? identity
}

/** 当前屏幕上的会话 id；没有就 undefined。 */
export function onScreenSession(ctx: Context): string | undefined {
  return sidebarRight(ctx)?.mounted?.getSnapshot()
}

/** launchAgentEntry 接受的最小 agent 形状。 */
export interface LaunchAgentInput {
  readonly id: string
  readonly displayName: string
  /** TUI 裸命令（不带 ACP 参数）。 */
  readonly command: string
}

/**
 * 启动一个 agent 的 TUI 并打开宿主终端页签；无屏幕会话或缺服务时拒绝。
 * @param ctx - 客户端上下文。
 * @param agent - 目标 agent 条目。
 */
export async function launchAgentEntry(ctx: Context, agent: LaunchAgentInput): Promise<void> {
  const sessionId = onScreenSession(ctx)
  if (sessionId === undefined) throw new Error('no session')
  await openAgentTerminalTab(ctx, sessionId, agent)
}
