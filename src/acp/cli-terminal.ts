/**
 * CLI Agent 终端宿主：用官方 subprocess.spawnTerminal 起真正的 PTY，
 * 自持输出缓冲 + SSE 广播，客户端直接用 xterm 渲染原始字节。
 *
 * 架构照 dsh-agents-cli（dshmarket 验证过的方案）：不经过 webTerminals
 * 客户端管线——那是给官方终端面板用的状态机，内嵌第三方 xterm 和它抢状态
 * 正是前几版全屏 TUI 黑屏的根因。这里宿主独占 PTY 字节流：
 *   spawnTerminal(用户登录 shell) → 键击启动 agent → output 累积进 screen
 *   buffer → SSE 帧广播 → 客户端 xterm.write(原始字节)。
 * @module dsh-plugin-zn-agent-client/acp/cli-terminal
 */

import { createRequire } from 'node:module'

/** 官方 subprocess 服务的结构面（宿主 dsh-subprocess-local 提供）。 */
export interface SubprocessFace {
  spawnTerminal(spec: {
    argv: string[]
    cwd?: string
    cols?: number
    rows?: number
    terminalType?: string
    env?: Record<string, string>
    shellActivity?: boolean
    graceMs?: number
    signal?: AbortSignal
  }): Promise<TerminalHandle>
  terminalEnvironment?(signal?: AbortSignal): Promise<{ platform?: string; defaultShell?: string }>
  resolveExecutable?(candidate: string, signal?: AbortSignal): Promise<string>
}

/** spawnTerminal 返回的 PTY 句柄（结构面）。 */
export interface TerminalHandle {
  /** PTY 原始输出（字符串或字节块，流式）。 */
  output?: AsyncIterable<string | Uint8Array>
  write(data: string): Promise<void>
  resize(cols: number, rows: number): Promise<void>
  /** 进程退出后 resolve（带 exitCode）或 reject。 */
  done?: Promise<{ exitCode?: number } | void>
  running?: boolean
}

/** 尺寸/缓冲上限（照参考插件的钳制值）。 */
export const LIMITS = {
  maxCols: 500,
  maxRows: 200,
  scrollback: 2000,
  maxInputBytes: 64 * 1024,
  maxBufferedBytes: 4 * 1024 * 1024,
  disposeGraceMs: 4000,
} as const

/** SSE 响应的结构面（宿主 webServer 的 ServerResponse）。 */
export interface SseResponse {
  write(payload: string): boolean | void
  once?(event: string, cb: () => void): unknown
  off?(event: string, cb: () => void): unknown
  destroyed?: boolean
  writableEnded?: boolean
  writableLength?: number
}

/** 单个终端的状态快照（SSE state 帧 + state 路由共用）。 */
export interface TerminalStatus {
  id: string
  agentId: string
  displayName: string
  command: string
  /** 实际敲进 shell 的启动行（resume 时带 flag，普通启动=命令本身）。 */
  launch: string
  cwd: string
  cols: number
  rows: number
  state: 'running' | 'exited'
  exitCode: number | null
  error: string
}

/** 把尺寸钳到合法范围。 */
export function clampDimensions(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const c = typeof cols === 'number' && Number.isSafeInteger(cols) ? Math.min(Math.max(cols, 2), LIMITS.maxCols) : 100
  const r = typeof rows === 'number' && Number.isSafeInteger(rows) ? Math.min(Math.max(rows, 1), LIMITS.maxRows) : 30
  return { cols: c, rows: r }
}

/** 经官方 subprocess 服务解析用户首选 shell。 */
export async function resolveUserShell(subprocess: SubprocessFace): Promise<string> {
  const fallback = process.env.SHELL ?? (process.platform === 'win32' ? 'cmd.exe' : '/bin/zsh')
  try {
    const env = await subprocess.terminalEnvironment?.()
    const candidate = env?.defaultShell ?? fallback
    if (typeof subprocess.resolveExecutable === 'function') {
      try {
        return await subprocess.resolveExecutable(candidate)
      } catch {
        return candidate
      }
    }
    return candidate
  } catch {
    return fallback
  }
}

function shellKind(shellPath: string): string {
  const name = shellPath.replaceAll('\\', '/').split('/').pop() ?? ''
  return name.replace(/\.(exe|sh)$/i, '').toLowerCase()
}

/** 登录交互 shell 的启动 argv（-il 让 nvm 等 PATH 注入生效，agent 命令才找得到）。 */
export function buildShellLaunch(shellPath: string, platform: NodeJS.Platform = process.platform): { path: string; name: string; argv: string[] } {
  const kind = shellKind(shellPath)
  if (kind === 'cmd') return { path: shellPath, name: kind, argv: [shellPath, '/d', '/q'] }
  if (kind === 'pwsh' || kind === 'powershell') return { path: shellPath, name: kind, argv: [shellPath, '-NoLogo'] }
  if (kind === 'fish') return { path: shellPath, name: kind, argv: [shellPath, '-il'] }
  if (kind === 'zsh' || kind === 'bash') return { path: shellPath, name: kind, argv: [shellPath, '-il'] }
  const extra = platform === 'win32' ? [] : ['-i']
  return { path: shellPath, name: kind || 'sh', argv: [shellPath, ...extra] }
}

/**
 * 把 CLI 命令包进一次性的交互 shell 启动：`-c` 在 shell 初始化**完成后**执行命令
 * （zsh/bash 的重配置不再产生「命令敲早了被吞」的竞态）。CLI 退出后 -c shell
 * 随之退出 —— 不留悬挂 shell，终端转为 exited，由「重启/新会话」重新拉起。
 * 命令为空时退化为普通登录 shell。
 */
export function buildAgentShellLaunch(shellPath: string, command: string): { path: string; name: string; argv: string[] } {
  const kind = shellKind(shellPath)
  const line = command.trim()
  if (line === '') return buildShellLaunch(shellPath)
  if (kind === 'cmd') return { path: shellPath, name: kind, argv: [shellPath, '/d', '/c', line] }
  if (kind === 'pwsh' || kind === 'powershell') return { path: shellPath, name: kind, argv: [shellPath, '-NoLogo', '-Command', line] }
  if (kind === 'fish') return { path: shellPath, name: kind, argv: [shellPath, '-i', '-c', line] }
  if (kind === 'zsh' || kind === 'bash') return { path: shellPath, name: kind, argv: [shellPath, '-il', '-c', line] }
  return { path: shellPath, name: kind || 'sh', argv: [shellPath, '-i', '-c', line] }
}

/** 组装 spawnTerminal 的 env：剥掉 Electron/DSH 桌面注入，补终端变量。 */
export function buildTerminalEnv(baseEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== 'string') continue
    if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('DSH_DESKTOP_')) continue
    env[key] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  // 归属标记：插件拉起的终端进程都带这个变量，便于精确识别、绝不误伤
  // 用户在其他终端手工打开的 CLI（清理只针对插件自己 tracking 的句柄）。
  env.ZN_AGENT_CLIENT_OWNED = '1'
  return env
}

/* ------------------------------------------------------------------ *
 * screen buffer：服务端回放状态。优先用宿主运行时里的 @xterm/headless +
 * serialize（精确还原屏幕）；拿不到就退化为原始字节环形缓冲（重放进
 * xterm 同样能重建屏幕，只是 scrollback 有截断）。
 * ------------------------------------------------------------------ */

interface ScreenBuffer {
  write(data: string): Promise<void>
  serialize(): string
  dispose(): void
}

interface HeadlessTerminal {
  write(data: string, cb?: () => void): void
  resize(cols: number, rows: number): void
  dispose(): void
  loadAddon(addon: object): void
}

/** 尝试从宿主运行时加载 headless xterm + 序列化插件。 */
function loadHeadlessAddons(): { Terminal: new (options: object) => HeadlessTerminal; SerializeAddon: new () => { serialize(): string } } | null {
  const candidates = [process.argv[1], import.meta.url].filter((value): value is string => typeof value === 'string' && value !== '')
  for (const anchorPath of candidates) {
    try {
      const req = createRequire(anchorPath)
      const pkgPath = req.resolve('@deepseek-ai/dsh-api-terminal-controller/package.json')
      const ctrlReq = createRequire(pkgPath)
      const headless: unknown = ctrlReq('@xterm/headless')
      const serialize: unknown = ctrlReq('@xterm/addon-serialize')
      const Terminal = (headless as { Terminal?: unknown } | null)?.Terminal
      const SerializeAddon = (serialize as { SerializeAddon?: unknown } | null)?.SerializeAddon
      if (typeof Terminal === 'function' && typeof SerializeAddon === 'function') {
        return {
          Terminal: Terminal as new (options: object) => HeadlessTerminal,
          SerializeAddon: SerializeAddon as new () => { serialize(): string },
        }
      }
    } catch {
      // 宿主结构变化时退回环形缓冲。
    }
  }
  return null
}

const headlessAddons = loadHeadlessAddons()

export function createScreenBuffer(cols: number, rows: number, scrollback: number = LIMITS.scrollback): ScreenBuffer {
  if (headlessAddons !== null) {
    const screen = new headlessAddons.Terminal({ cols, rows, scrollback, allowProposedApi: true })
    const serializer = new headlessAddons.SerializeAddon()
    screen.loadAddon(serializer)
    return {
      write(data: string) {
        return new Promise((resolve) => screen.write(data, resolve))
      },
      serialize() {
        return serializer.serialize()
      },
      dispose() {
        screen.dispose()
      },
    }
  }
  let buffer = ''
  const maxChars = 256 * 1024
  return {
    async write(data: string) {
      buffer += data
      if (buffer.length > maxChars) buffer = buffer.slice(buffer.length - maxChars)
    },
    serialize() {
      return buffer
    },
    dispose() {
      buffer = ''
    },
  }
}

/* ------------------------------------------------------------------ *
 * ManagedTerminal：一个 agent 的 PTY 生命周期。
 * ------------------------------------------------------------------ */

export class ManagedTerminal {
  readonly status: TerminalStatus
  readonly screen: ScreenBuffer
  private readonly followers = new Set<SseResponse>()
  private sequence = 0
  private operations: Promise<unknown> = Promise.resolve()
  private exited = false
  private closing: Promise<void> | null = null

  constructor(
    readonly id: string,
    private readonly handle: TerminalHandle,
    status: TerminalStatus,
    private readonly onGone: (id: string) => void,
  ) {
    this.status = status
    this.screen = createScreenBuffer(status.cols, status.rows)
    void this.consume()
  }

  /** 是否仍在运行（未退出且没有正在进行的关闭流程）。 */
  get running(): boolean {
    return !this.exited && this.closing === null && this.status.state === 'running'
  }

  /** 串行化读写操作，避免 write/resize 与退出清理交错。 */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.operations.then(op)
    this.operations = next.catch(() => {})
    return next
  }

  /** 把一段输出写进 screen buffer 并广播 output 帧。 */
  async pushOutput(text: string): Promise<void> {
    if (text.length === 0) return
    await this.enqueue(async () => {
      await this.screen.write(text)
      this.sequence += 1
      this.broadcastFrame({ type: 'output', sequence: this.sequence, data: text })
    })
  }

  /** 给所有 SSE 订阅者推一帧；背压超限的订阅者直接摘除。 */
  broadcastFrame(frame: Record<string, unknown>): void {
    const payload = `data: ${JSON.stringify(frame)}\n\n`
    for (const res of [...this.followers]) {
      try {
        if (res.destroyed === true || (typeof res.writableLength === 'number' && res.writableLength > LIMITS.maxBufferedBytes)) {
          this.followers.delete(res)
          continue
        }
        res.write(payload)
      } catch {
        this.followers.delete(res)
      }
    }
  }

  broadcastState(): void {
    const writable = !this.exited && this.closing === null && this.status.state === 'running'
    this.broadcastFrame({ type: 'state', info: this.status, writable })
  }

  /** SSE 订阅：先发快照帧再挂 followers，快照与增量共享队列不会交错丢帧。 */
  async attachSse(res: SseResponse): Promise<() => void> {
    let attached = false
    const detach = (): void => {
      attached = false
      this.followers.delete(res)
    }
    res.once?.('close', detach)
    await this.enqueue(async () => {
      const writable = !this.exited && this.closing === null && this.status.state === 'running'
      if (res.destroyed === true || res.writableEnded === true || this.closing !== null) return
      const snapshot = {
        type: 'snapshot',
        sequence: this.sequence,
        screen: this.screen.serialize(),
        info: this.status,
        writable,
        environment: {
          cwd: this.status.cwd,
          maxCols: LIMITS.maxCols,
          maxRows: LIMITS.maxRows,
          scrollback: LIMITS.scrollback,
          maxInputBytes: LIMITS.maxInputBytes,
          maxBufferedBytes: LIMITS.maxBufferedBytes,
        },
      }
      this.followers.add(res)
      attached = true
      try {
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`)
      } catch (error) {
        detach()
        throw error
      }
    })
    if (!attached) res.off?.('close', detach)
    return () => {
      detach()
      res.off?.('close', detach)
    }
  }

  /** 让渲染器先挂上（收到快照）再敲启动命令；1s 超时兜底。 */
  async write(data: string): Promise<void> {
    if (typeof data !== 'string' || data.length === 0) return
    if (Buffer.byteLength(data, 'utf8') > LIMITS.maxInputBytes) throw new Error('输入超出单次长度上限')
    await this.enqueue(async () => {
      if (this.exited || this.closing !== null || this.status.state !== 'running') throw new Error('终端未在运行状态')
      await this.handle.write(data)
    })
  }

  async resize(cols: unknown, rows: unknown): Promise<void> {
    const dims = clampDimensions(cols, rows)
    await this.enqueue(async () => {
      if (this.exited || this.closing !== null || this.status.state !== 'running') return
      if (this.status.cols === dims.cols && this.status.rows === dims.rows) return
      await this.handle.resize(dims.cols, dims.rows)
      this.status.cols = dims.cols
      this.status.rows = dims.rows
      this.broadcastState()
    })
  }

  async close(): Promise<void> {
    if (this.closing !== null) return this.closing
    this.closing = this.enqueue(async () => {
      this.followers.clear()
      try {
        await this.handle.write('\u0003exit\r')
      } catch {
        // 已退出则忽略。
      }
      try {
        await Promise.race([
          this.handle.done?.catch(() => {}) ?? Promise.resolve(),
          new Promise((resolve) => setTimeout(resolve, LIMITS.disposeGraceMs)),
        ])
      } catch {
        // 超时不阻塞关闭。
      }
      this.screen.dispose()
      this.status.state = 'exited'
    })
    return this.closing
  }

  /** 持续消费 PTY 输出直到进程退出。 */
  private async consume(): Promise<void> {
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
    try {
      if (this.handle.output !== undefined) {
        for await (const chunk of this.handle.output) {
          const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
          if (text.length > 0) await this.pushOutput(text)
        }
      }
      await this.pushOutput(decoder.decode())
      const outcome = await (this.handle.done ?? Promise.resolve())
      this.status.exitCode = typeof outcome === 'object' && outcome !== null && 'exitCode' in outcome ? (outcome.exitCode ?? null) : null
      this.status.state = 'exited'
    } catch (error) {
      this.status.state = 'exited'
      this.status.error = error instanceof Error ? error.message : String(error)
    }
    this.broadcastState()
    this.onGone(this.id)
  }
}

/* ------------------------------------------------------------------ *
 * Controller：id → ManagedTerminal 的注册表。
 * ------------------------------------------------------------------ */

export interface OpenTerminalOptions {
  id: string
  agentId: string
  displayName: string
  command: string
  cwd: string
  cols?: unknown
  rows?: unknown
  restart?: boolean
  resume?: boolean
  /** attach=幂等复用（默认）；new/continue/resume=重启 PTY 并敲对应命令行。 */
  mode?: 'attach' | 'new' | 'continue' | 'resume'
  /** 覆盖敲入 shell 的启动行（resume 场景由 cli-sessions.buildLaunchPlan 生成）。 */
  launchLine?: string
}

export class CliTerminalController {
  private readonly terminals = new Map<string, ManagedTerminal>()
  private readonly pending = new Map<string, Promise<ManagedTerminal>>()
  private disposed = false

  constructor(
    private readonly subprocess: SubprocessFace,
    private readonly defaultCwd: () => string,
  ) {}

  /** 同一 id 的 open/restart/close 串行执行，不阻塞其他 agent。 */
  private schedule(id: string, operation: () => Promise<ManagedTerminal>): Promise<ManagedTerminal> {
    const task = (this.pending.get(id) ?? Promise.resolve<ManagedTerminal>(undefined as never)).catch(() => undefined as never).then(operation)
    this.pending.set(id, task)
    void task.finally(() => {
      if (this.pending.get(id) === task) this.pending.delete(id)
    }).catch(() => {})
    return task
  }

  openTerminal(options: OpenTerminalOptions): Promise<ManagedTerminal> {
    return this.schedule(options.id, () => this.open(options))
  }

  private async open(options: OpenTerminalOptions): Promise<ManagedTerminal> {
    if (this.disposed) throw new Error('终端控制器已关闭')
    if (typeof options.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(options.id)) throw new Error('无效的终端 ID')
    // new/continue/resume 都是「换会话」——正在跑的 TUI 必须先退掉再重新拉起。
    const wantsFresh = options.restart === true || options.mode === 'new' || options.mode === 'continue' || options.mode === 'resume'
    if (wantsFresh) await this.close(options.id)
    const existing = this.terminals.get(options.id)
    if (existing !== undefined && existing.running) {
      const dims = clampDimensions(options.cols, options.rows)
      await existing.resize(dims.cols, dims.rows)
      return existing
    }
    if (existing !== undefined) await this.close(options.id)

    if (typeof this.subprocess.spawnTerminal !== 'function') throw new Error('当前 DSH 宿主未提供 subprocess.spawnTerminal 终端服务')
    const dims = clampDimensions(options.cols, options.rows)
    const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : this.defaultCwd()
    const shellPath = await resolveUserShell(this.subprocess)
    const launchLine = options.launchLine !== undefined && options.launchLine !== '' ? options.launchLine : options.command
    // 命令直接由 shell 的 -c 启动：初始化完成才执行，CLI 退出后 shell 一并退出。
    // 不再「先起 shell 再敲命令」——那条路有敲早被吞的竞态（CLI 退出后点新会话
    // 只见 shell 不见 CLI 的根因）。
    const launch = buildAgentShellLaunch(shellPath, launchLine)
    const handle = await this.subprocess.spawnTerminal({
      argv: launch.argv,
      cwd,
      cols: dims.cols,
      rows: dims.rows,
      terminalType: 'xterm-256color',
      env: buildTerminalEnv(process.env),
      shellActivity: true,
      graceMs: LIMITS.disposeGraceMs,
    })
    const status: TerminalStatus = {
      id: options.id,
      agentId: options.agentId,
      displayName: options.displayName,
      command: options.command,
      launch: launchLine,
      cwd,
      cols: dims.cols,
      rows: dims.rows,
      state: 'running',
      exitCode: null,
      error: '',
    }
    const managed = new ManagedTerminal(
      options.id,
      handle,
      status,
      (id) => { this.terminals.delete(id) },
    )
    this.terminals.set(options.id, managed)
    return managed
  }

  async close(id: string): Promise<boolean> {
    const existing = this.terminals.get(id)
    if (existing === undefined) return false
    this.terminals.delete(id)
    await existing.close()
    return true
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const ids = [...new Set([...this.terminals.keys(), ...this.pending.keys()])]
    await Promise.allSettled(ids.map(async (id) => { await this.close(id) }))
  }

  listStatus(): Record<string, TerminalStatus> {
    const result: Record<string, TerminalStatus> = {}
    for (const [id, term] of this.terminals.entries()) result[id] = { ...term.status }
    return result
  }

  getTerminal(id: string): ManagedTerminal | undefined {
    return this.terminals.get(id)
  }
}
