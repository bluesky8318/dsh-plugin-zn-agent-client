/**
 * CLI Agent 终端的浏览器半边（dsh-agents-cli 同款传输层）。
 *
 * 与宿主 `src/acp/cli-routes.ts` 的 SSE 协议配对：
 *   POST /open    幂等打开/复用 PTY（服务端负责「只敲一次启动命令」）
 *   POST /stream  SSE：snapshot（屏幕回放）+ output（增量）+ state（可写/状态）
 *   POST /input   键击 write / 尺寸 resize
 *
 * 会话按 agentId 全局复用：进程与屏幕状态活在本模块注册表里，React 视图
 * 挂载/卸载/切换芯片只是 attach/detach DOM，不杀进程（终端停在隐蔽节点）。
 * @module dsh-plugin-zn-agent-client/client/agent-stream
 */

import { FitAddon, type ITerminalDimensions } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'

/** 与宿主 cli-routes.ts 一致的路由与防误触头。 */
const OPEN_URL = '/api/zn-agent-client/open'
const STREAM_URL = '/api/zn-agent-client/stream'
const INPUT_URL = '/api/zn-agent-client/input'
const GUARD = { 'x-zn-agent-client': '1', 'content-type': 'application/json' } as const

/** 服务端环境上限（snapshot 帧里的 environment 同构）。 */
interface TermEnvironment {
  cwd: string
  maxCols: number
  maxRows: number
  scrollback: number
  maxInputBytes: number
  maxBufferedBytes: number
}

/** 服务端状态快照（TerminalStatus 的 JSON 形态）。 */
interface TermInfo {
  id: string
  agentId: string
  displayName: string
  command: string
  cwd: string
  cols: number
  rows: number
  state: 'running' | 'exited'
  exitCode: number | null
  error: string
}

/** SSE 帧的联合。 */
type StreamFrame =
  | { type: 'snapshot'; sequence: number; screen: string; info: TermInfo; writable: boolean; environment: TermEnvironment }
  | { type: 'output'; sequence: number; data: string }
  | { type: 'state'; info: TermInfo; writable: boolean }

/** React 订阅用的外部状态。 */
export interface SessionState {
  /** connecting：还没拿到快照；live：快照已到；reconnecting：传输断了在重连；exited：进程结束。 */
  readonly phase: 'connecting' | 'live' | 'reconnecting' | 'exited'
  readonly writable: boolean
  readonly info: TermInfo | undefined
  /** 最近一次错误文案（重连中/退出时展示）。 */
  readonly error: string
}

const INITIAL_STATE: SessionState = { phase: 'connecting', writable: false, info: undefined, error: '' }

/** 与宿主 LIMITS 对齐的本地钳制（快照到达前就要建终端）。 */
const LOCAL_LIMITS = { maxCols: 500, maxRows: 200, scrollback: 2000 }

function clampDimension(value: number, max: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback
}

/** 等宽字体栈：跟宿主终端一致，不跟随容器正文/系统字体。 */
const TERMINAL_FONT_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/** SSE 文本缓冲解析：按空行分帧，取 `data:` 行的 JSON。 */
function readFrames(buffer: string): { frames: StreamFrame[]; rest: string } {
  const frames: StreamFrame[] = []
  let rest = buffer
  for (;;) {
    const boundary = rest.indexOf('\n\n')
    if (boundary < 0) break
    const raw = rest.slice(0, boundary)
    rest = rest.slice(boundary + 2)
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue
      try {
        frames.push(JSON.parse(line.slice(5).trim()) as StreamFrame)
      } catch {
        // 半帧/脏帧直接丢弃——下一帧快照或 state 会纠正状态。
      }
    }
  }
  return { frames, rest }
}

/** 视图不可见时的 DOM 停车场：终端 detach 到这里，进程不死。 */
const parkingNode: HTMLElement | null = typeof document === 'undefined'
  ? null
  : (() => {
    const node = document.createElement('div')
    node.setAttribute('aria-hidden', 'true')
    node.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none'
    document.body.appendChild(node)
    return node
  })()

/**
 * 一个 agent 一个会话：xterm 实例 + 传输 + 拟合 + 主题都归它管。
 * React 只是外壳——挂 DOM、订阅状态。
 */
export class AgentTerminalSession {
  readonly agentId: string
  private readonly listeners = new Set<() => void>()
  private snapshotState: SessionState = INITIAL_STATE
  private readonly terminal: Terminal
  private readonly fit: FitAddon
  private webgl: WebglAddon | undefined
  private container: HTMLElement | null = null
  private host: HTMLElement | null = null
  private readonly element: HTMLElement
  private controller: AbortController | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private writable = false
  private sendTimer: ReturnType<typeof setTimeout> | undefined
  private sendBuffer = ''
  private fitScheduled = false
  private readonly observer: ResizeObserver | undefined
  private lastDimensions: ITerminalDimensions | undefined

  constructor(agentId: string) {
    this.agentId = agentId
    this.element = document.createElement('div')
    this.element.className = 'znac-agent-term-screen'
    this.terminal = new Terminal({
      fontFamily: TERMINAL_FONT_STACK,
      fontSize: 13,
      lineHeight: 1.0,
      letterSpacing: 0,
      minimumContrastRatio: 4.5,
      cursorBlink: true,
      scrollback: LOCAL_LIMITS.scrollback,
    })
    this.fit = new FitAddon()
    this.terminal.loadAddon(this.fit)
    this.terminal.open(this.element)
    this.attachWebgl()
    // WebGL 首帧需要一次重排+刷新，否则打开时黑屏直到第一次输出。
    requestAnimationFrame(() => {
      try { this.fit.fit() } catch { /* 容器还没尺寸时忽略 */ }
      this.webgl?.clearTextureAtlas()
      this.terminal.refresh(0, this.terminal.rows - 1)
    })
    this.terminal.onData((data) => { this.send(data) })
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.scheduleFit())
    }
  }

  /* ---------------- 状态订阅（useSyncExternalStore 接口） ---------------- */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): SessionState => this.snapshotState

  private publish(patch: Partial<SessionState>): void {
    this.snapshotState = { ...this.snapshotState, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  /* ---------------- DOM 生命周期 ---------------- */

  /** 挂到可见容器；会话被别的容器占用时先从那里摘下来。 */
  attach(host: HTMLElement): void {
    if (this.host === host) return
    this.host = host
    if (this.container !== null && this.element.parentElement === this.container) {
      this.container.removeChild(this.element)
    }
    host.appendChild(this.element)
    this.container = host
    this.observer?.observe(host)
    this.scheduleFit()
    this.terminal.focus()
  }

  /** 摘下并停进停车场（进程与屏幕保留）。 */
  detach(): void {
    if (this.host !== null) this.observer?.unobserve(this.host)
    this.host = null
    this.container = null
    if (parkingNode !== null) parkingNode.appendChild(this.element)
  }

  private attachWebgl(): void {
    try {
      const webgl = new WebglAddon()
      // context loss 只 dispose 会让终端没有渲染器 → 永久黑屏（hermes-agent
      // #27740）；dispose 后立刻重挂一个新的 WebGL addon。
      webgl.onContextLoss(() => {
        webgl.dispose()
        if (this.webgl === webgl) this.webgl = undefined
        this.attachWebgl()
        requestAnimationFrame(() => {
          try { this.fit.fit() } catch { /* 忽略 */ }
          this.webgl?.clearTextureAtlas()
          this.terminal.refresh(0, this.terminal.rows - 1)
        })
      })
      this.webgl = webgl
      this.terminal.loadAddon(webgl)
    } catch {
      this.webgl = undefined // 无 WebGL2：保留默认 DOM 渲染
    }
  }

  /** 主题 token → xterm 具体色值（容器样式由 styles.ts 的 .znac-agent-term 提供）。 */
  syncTheme(node: HTMLElement | null): void {
    const target = node ?? this.host ?? this.element
    const style = getComputedStyle(target)
    const background = style.backgroundColor
    const foreground = style.color
    if (background === '' || foreground === '' || background === 'rgba(0, 0, 0, 0)') return
    this.terminal.options.theme = {
      background,
      foreground,
      cursor: foreground,
      cursorAccent: background,
      selectionBackground: foreground,
      selectionForeground: background,
    }
  }

  /* ---------------- 传输 ---------------- */

  /** 打开（幂等）并接入 SSE 流；进程已在跑时服务端直接回快照。 */
  async connect(options: { restart?: boolean } = {}): Promise<void> {
    if (this.disposed) return
    const dims = this.currentDimensions()
    try {
      const opened = await fetch(OPEN_URL, {
        method: 'POST',
        headers: { ...GUARD },
        body: JSON.stringify({
          id: this.agentId,
          cols: dims?.cols,
          rows: dims?.rows,
          restart: options.restart === true,
        }),
      })
      if (!opened.ok) {
        const payload = (await opened.json().catch(() => null)) as { error?: string } | null
        this.publish({ phase: 'exited', error: payload?.error ?? `open 失败（${opened.status}）` })
        return
      }
      await this.openStream()
    } catch (error) {
      this.publish({ phase: 'exited', error: error instanceof Error ? error.message : String(error) })
    }
  }

  private currentDimensions(): { cols: number; rows: number } | undefined {
    const host = this.host
    if (host === null || host.clientWidth === 0 || host.clientHeight === 0) return undefined
    try { this.fit.fit() } catch { return undefined }
    return { cols: this.terminal.cols, rows: this.terminal.rows }
  }

  private async openStream(): Promise<void> {
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    const response = await fetch(STREAM_URL, {
      method: 'POST',
      headers: { ...GUARD },
      body: JSON.stringify({ id: this.agentId }),
      signal: controller.signal,
    })
    if (!response.ok || response.body === null) {
      this.publish({ phase: 'reconnecting', error: `stream 失败（${response.status}）` })
      this.scheduleReconnect()
      return
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parsed = readFrames(buffer)
        buffer = parsed.rest
        for (const frame of parsed.frames) this.applyFrame(frame)
      }
    } catch {
      // 主动断开（dispose/重连）会走 AbortError——静默即可。
    }
    if (controller.signal.aborted || this.disposed) return
    if (this.snapshotState.phase !== 'exited') {
      this.publish({ phase: 'reconnecting', error: '连接中断' })
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== undefined) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.disposed) return
      // 重连只重开传输，绝不 restart 进程——重复敲键会在 TUI 里执行两遍。
      void this.openStream().catch(() => this.scheduleReconnect())
    }, 1500)
  }

  private applyFrame(frame: StreamFrame): void {
    if (frame.type === 'snapshot') {
      this.writable = frame.writable
      this.terminal.reset()
      this.terminal.resize(
        clampDimension(frame.info.cols, LOCAL_LIMITS.maxCols, 80),
        clampDimension(frame.info.rows, LOCAL_LIMITS.maxRows, 24),
      )
      // reset 会把 glyph atlas 映射清掉——重放前清一次纹理避免残影/黑屏。
      this.webgl?.clearTextureAtlas()
      this.terminal.write(frame.screen)
      this.publish({
        phase: frame.info.state === 'exited' ? 'exited' : 'live',
        writable: frame.writable,
        info: frame.info,
        error: frame.info.error,
      })
      this.scheduleFit()
    } else if (frame.type === 'output') {
      this.terminal.write(frame.data)
    } else {
      this.writable = frame.writable
      this.publish({
        phase: frame.info.state === 'exited' ? 'exited' : this.snapshotState.phase === 'connecting' ? 'live' : this.snapshotState.phase,
        writable: frame.writable,
        info: frame.info,
        error: frame.info.error,
      })
    }
  }

  /* ---------------- 输入与尺寸 ---------------- */

  /** 键击批量上行：8ms / 16KB 攒一批，避免粘贴大段文本时请求爆炸。 */
  private send(data: string): void {
    if (!this.writable || data.length === 0) return
    this.sendBuffer += data
    if (this.sendTimer !== undefined) return
    this.sendTimer = setTimeout(() => { void this.flushInput() }, 8)
  }

  private async flushInput(): Promise<void> {
    this.sendTimer = undefined
    const payload = this.sendBuffer
    this.sendBuffer = ''
    if (payload.length === 0 || this.disposed) return
    for (let offset = 0; offset < payload.length; offset += 16384) {
      try {
        await fetch(INPUT_URL, {
          method: 'POST',
          headers: { ...GUARD },
          body: JSON.stringify({ id: this.agentId, type: 'write', data: payload.slice(offset, offset + 16384) }),
        })
      } catch {
        return // 传输断了：reconnect 循环会重建流，未确认的键击不重放。
      }
    }
  }

  /** rAF 合并的拟合循环：本地 fit → resize 终端 → 上报服务端。 */
  private scheduleFit(): void {
    if (this.fitScheduled || this.host === null) return
    this.fitScheduled = true
    requestAnimationFrame(() => {
      this.fitScheduled = false
      const host = this.host
      if (this.disposed || host === null || !this.writable) return
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      try { this.fit.fit() } catch { return }
      const dims = { cols: this.terminal.cols, rows: this.terminal.rows }
      const last = this.lastDimensions
      if (last !== undefined && last.cols === dims.cols && last.rows === dims.rows) return
      this.lastDimensions = dims
      void fetch(INPUT_URL, {
        method: 'POST',
        headers: { ...GUARD },
        body: JSON.stringify({ id: this.agentId, type: 'resize', cols: dims.cols, rows: dims.rows }),
      }).catch(() => {})
    })
  }

  /** 主动请求重启进程（重新敲一遍启动命令）。 */
  async restart(): Promise<void> {
    if (this.disposed) return
    this.publish({ phase: 'connecting', error: '' })
    await this.connect({ restart: true })
  }

  /** 只断传输与 DOM；进程留给服务端（插件卸载才统一回收）。 */
  dispose(): void {
    this.disposed = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    if (this.sendTimer !== undefined) clearTimeout(this.sendTimer)
    this.controller?.abort()
    this.observer?.disconnect()
    this.detach()
    this.terminal.dispose()
  }
}

/** agentId → 会话注册表：进程与屏幕状态跨 React 挂载存活。 */
const sessions = new Map<string, AgentTerminalSession>()

/** 取（或建）一个 agent 的会话。 */
export function acquireSession(agentId: string): AgentTerminalSession {
  const existing = sessions.get(agentId)
  if (existing !== undefined) return existing
  const session = new AgentTerminalSession(agentId)
  sessions.set(agentId, session)
  void session.connect()
  return session
}

/** 插件卸载时统一回收（client apply 的 ctx.effect 用）。 */
export function disposeAllSessions(): void {
  for (const session of sessions.values()) session.dispose()
  sessions.clear()
}
