/**
 * ACP Client Manager: spawns and communicates with local ACP agents.
 *
 * Direct adaptation of obsidian-agent-client `src/acp/acp-client.ts`:
 * - spawn (detached process group on unix) + NDJSON over stdio
 * - `acp.client()` app with client-side handlers (permission, fs stubs, terminal)
 * - initialize / session/new / session/prompt / session/cancel lifecycle
 * - silent-failure detection with a rolling stderr buffer (8192/4096 window)
 * - late-exit guard: a replaced process's exit never tears down its successor
 * - API-key secret injection, skipping EMPTY values (an empty ANTHROPIC_API_KEY
 *   breaks subscription login)
 *
 * @module dsh-plugin-zn-agent-client/acp/client-manager
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import * as acp from '@agentclientprotocol/sdk'
import { TerminalManager, type TerminalCreateParams, type TerminalOutputResult } from './terminal-manager.ts'
import { PermissionManager } from './permission-manager.ts'
import { toAcpContentBlock, toInitializeSummary, toSessionResult, toSlashCommands, toToolCallContent } from './type-converter.ts'
import type { AgentConfig, ContentBlock, SessionResult, SessionUpdate } from '../types/index.ts'

const CLIENT_NAME = 'dsh-plugin-zn-agent-client'
const CLIENT_VERSION = '0.1.0'

/** Map ACP ToolCallStatus onto the plugin status union ('in_progress' → 'running'). */
function mapToolStatus(status: acp.ToolCallStatus): 'pending' | 'running' | 'completed' | 'failed' {
  return status === 'in_progress' ? 'running' : status
}

/** Map ACP ToolCallLocation[] (path/line) onto the plugin locations shape. */
function mapLocations(locations: acp.ToolCallLocation[]): Array<{ path: string; line?: number }> {
  return locations.map(loc => ({
    path: loc.path,
    ...(loc.line !== undefined && loc.line !== null ? { line: loc.line } : {}),
  }))
}

/** Options for constructing an {@link AcpClientManager}. */
export interface AcpClientManagerOptions {
  /** Auto-approve permission requests (first allow-ish option). Default false. */
  autoAllowPermissions?: boolean
  /** Resolve a secret id to its value; null/'' means unavailable. */
  getSecret?: (secretId: string) => Promise<string | null>
  /** Optional log sink (plugin log / ctx logger). */
  log?: (message: string) => void
}

/** Outcome of one completed prompt turn. */
export interface PromptOutcome {
  /** Accumulated agent_message_chunk text for this turn. */
  agentText: string
  /** Session the prompt ran in. */
  sessionId: string
  /** ACP stop reason (e.g. "end_turn"). */
  stopReason: string
  /** Token usage, when the agent reports it (UNSTABLE field). */
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null } | null
}

/**
 * Manages ONE ACP agent process at a time. Re-initializing with a different
 * `AgentConfig` kills the previous process tree first (same as the Obsidian
 * reference). Multiplexing several agents concurrently is out of scope here;
 * the tool layer resolves configs and calls {@link ensureInitialized}.
 */
export class AcpClientManager {
  private readonly autoAllow: boolean
  private readonly getSecret: (secretId: string) => Promise<string | null>
  private readonly log: (message: string) => void

  private terminalManager = new TerminalManager()
  private permissionManager = new PermissionManager()

  private agentProcess: ChildProcess | null = null
  private connection: acp.ClientConnection | null = null
  private currentConfig: AgentConfig | null = null
  private isInitializedFlag = false
  private currentSessionId: string | null = null
  /** agent 是否声明了 loadSession 能力(可续聊既有会话)。 */
  private supportsLoadSession = false
  private recentStderr = ''
  private updateListeners = new Set<(update: SessionUpdate) => void>()
  private promptBuffers: { text: string; updateCount: number } | null = null

  constructor(options: AcpClientManagerOptions = {}) {
    this.autoAllow = options.autoAllowPermissions ?? false
    this.getSecret = options.getSecret ?? (async () => null)
    this.log = options.log ?? (() => {})
    this.permissionManager.setAutoAllow(this.autoAllow)
  }

  /** Subscribe to normalized session updates; returns a disposer. */
  onSessionUpdate(listener: (update: SessionUpdate) => void): () => void {
    this.updateListeners.add(listener)
    return () => {
      this.updateListeners.delete(listener)
    }
  }

  isInitialized(): boolean {
    return this.isInitializedFlag && this.connection !== null && this.agentProcess !== null
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId
  }

  getCurrentAgentId(): string | null {
    return this.currentConfig?.id ?? null
  }

  getPendingPermissionCount(): number {
    return this.permissionManager.getPendingCount()
  }

  /**
   * Ensure the manager runs `config`'s agent, initializing (or re-initializing)
   * only when needed. Safe to call before every prompt.
   */
  async ensureInitialized(config: AgentConfig): Promise<void> {
    if (this.isInitialized() && this.currentConfig?.id === config.id) return
    await this.disconnect()
    await this.initialize(config)
  }

  /** Spawn the agent process and run the ACP initialize handshake. */
  private async initialize(config: AgentConfig): Promise<void> {
    if (!config.command) throw new Error(`Agent "${config.id}" has an empty command`)
    this.currentConfig = config
    this.log(`initializing ACP agent "${config.id}" (${config.command} ${config.args.join(' ')})`)

    const baseEnv: Record<string, string> = { ...process.env } as Record<string, string>
    if (config.apiKey?.secretId && config.apiKey?.envVarName) {
      const value = await this.getSecret(config.apiKey.secretId)
      // Skip EMPTY values: exporting ANTHROPIC_API_KEY="" breaks subscription login.
      if (value) {
        baseEnv[config.apiKey.envVarName] = value
        this.log(`injected secret into ${config.apiKey.envVarName}`)
      } else {
        this.log(`no secret resolved for "${config.apiKey.secretId}"; skipping env injection`)
      }
    }

    const workingDirectory = config.workingDirectory || process.cwd()
    const proc = spawn(config.command, config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: baseEnv,
      cwd: workingDirectory,
      // detached on unix creates a process group so killProcessTree can signal it.
      detached: process.platform !== 'win32',
    })
    this.agentProcess = proc
    this.recentStderr = ''

    proc.on('error', (err) => {
      this.log(`agent "${config.id}" process error: ${err.message}`)
    })

    proc.on('exit', (code, signal) => {
      // Late-exit guard: a replaced process's exit must not cancel its successor.
      if (this.agentProcess !== proc) return
      this.isInitializedFlag = false
      this.connection = null
      this.agentProcess = null
      this.currentSessionId = null
      const suffix = code === 127 ? ' — command not found; check the configured command path' : ''
      this.log(`agent "${config.id}" exited (code=${String(code)} signal=${String(signal)})${suffix}`)
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      this.recentStderr += chunk.toString()
      if (this.recentStderr.length > 8192) this.recentStderr = this.recentStderr.slice(-4096)
    })

    // Adapter: ACP SDK writable → child stdin.
    const stdin = new WritableStream<Uint8Array>({
      write: (chunk) => new Promise<void>((resolve, reject) => {
        const stream = proc.stdin
        if (!stream) {
          reject(new Error('agent stdin unavailable'))
          return
        }
        stream.write(chunk, (err) => (err ? reject(err) : resolve()))
      }),
      close: () => {
        proc.stdin?.end()
      },
    })
    // Adapter: child stdout → ACP SDK readable.
    const stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        proc.stdout?.on('data', (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk))
        })
        proc.stdout?.on('end', () => {
          try {
            controller.close()
          } catch {
            // already closed
          }
        })
        proc.stdout?.on('error', (err) => {
          try {
            controller.error(err)
          } catch {
            // already errored
          }
        })
      },
    })

    const app = acp.client({ name: CLIENT_NAME })
      .onNotification('session/update', (ctx) => {
        this.handleSessionNotification(ctx.params)
      })
      .onRequest('session/request_permission', (ctx) => {
        return this.permissionManager.request(ctx.params, (update) => this.emitUpdate(update))
      })
      // fs capabilities are declared false; answer defensively anyway.
      .onRequest('fs/read_text_file', async () => ({ content: '' }))
      .onRequest('fs/write_text_file', async () => ({}))
      .onRequest('terminal/create', async (ctx) => {
        const params: TerminalCreateParams = {
          command: ctx.params.command,
          args: ctx.params.args ?? [],
          cwd: ctx.params.cwd ?? workingDirectory,
          env: (ctx.params.env ?? {}) as Record<string, string>,
          ...(ctx.params.outputByteLimit !== undefined && ctx.params.outputByteLimit !== null
            ? { outputByteLimit: ctx.params.outputByteLimit }
            : {}),
        }
        const terminalId = this.terminalManager.createTerminal(params)
        return { terminalId }
      })
      .onRequest('terminal/output', async (ctx) => {
        const result: TerminalOutputResult = this.terminalManager.getOutput(ctx.params.terminalId)
        return {
          output: result.output,
          truncated: false,
          exited: result.exited,
          ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        }
      })
      .onRequest('terminal/wait_for_exit', async (ctx) => {
        const result = await this.terminalManager.waitForExit(ctx.params.terminalId)
        return {
          ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        }
      })
      .onRequest('terminal/kill', async (ctx) => {
        this.terminalManager.killTerminal(ctx.params.terminalId)
        return {}
      })
      .onRequest('terminal/release', async (ctx) => {
        this.terminalManager.releaseTerminal(ctx.params.terminalId)
        return {}
      })

    const stream = acp.ndJsonStream(stdin, stdout)
    this.connection = app.connect(stream)

    const init = await this.connection.agent.request('initialize', {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: true,
      },
      clientInfo: { name: CLIENT_NAME, title: 'Zn Agent Client', version: CLIENT_VERSION },
    })
    this.isInitializedFlag = true
    this.supportsLoadSession = init.agentCapabilities?.loadSession === true
    const summary = toInitializeSummary(init)
    this.log(
      `initialized agent "${config.id}" (protocol v${String(summary.protocolVersion)}` +
      `${summary.agentName ? `, ${summary.agentName} ${summary.agentVersion ?? ''}` : ''})`,
    )
    if (summary.authMethodCount > 0) {
      this.log(`agent "${config.id}" advertises ${String(summary.authMethodCount)} auth method(s)`)
    }
  }

  /** Create a new session for the running agent. */
  async newSession(cwd?: string): Promise<SessionResult> {
    const connection = this.requireConnection()
    const dir = cwd || this.currentConfig?.workingDirectory || process.cwd()
    const response = await connection.agent.request('session/new', { cwd: dir, mcpServers: [] })
    this.currentSessionId = response.sessionId
    return toSessionResult(response.sessionId, response)
  }

  /**
   * Resume an existing agent-side session (`session/load`). Only possible when
   * the agent advertised the loadSession capability at initialize time; ACP
   * session history lives on the agent side, so this re-attaches a handle.
   * @returns true when the session was loaded onto this connection.
   */
  async loadSession(sessionId: string, cwd?: string): Promise<boolean> {
    if (!this.supportsLoadSession) return false
    const connection = this.requireConnection()
    const dir = cwd || this.currentConfig?.workingDirectory || process.cwd()
    try {
      await connection.agent.request('session/load', { sessionId, cwd: dir, mcpServers: [] })
      this.currentSessionId = sessionId
      return true
    } catch (err) {
      this.log(`session/load ${sessionId} failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  /** Whether the running agent supports session resume. */
  canResumeSessions(): boolean {
    return this.supportsLoadSession
  }

  /**
   * Send one prompt turn and wait for the stop reason.
   * Agent text is collected from `agent_message_chunk` notifications.
   */
  async sendPrompt(content: readonly ContentBlock[], options: { sessionId?: string } = {}): Promise<PromptOutcome> {
    const connection = this.requireConnection()
    let sessionId = options.sessionId ?? this.currentSessionId
    if (!sessionId) {
      sessionId = (await this.newSession()).sessionId
    }
    // 显式给了不同的 sessionId:这是要续聊 agent 侧的既有会话。agent 没声明
    // loadSession 能力时明确报错,而不是让 session/prompt 吃一个未知 id。
    if (options.sessionId && options.sessionId !== this.currentSessionId) {
      const loaded = await this.loadSession(options.sessionId)
      if (!loaded) {
        throw new Error(
          this.supportsLoadSession
            ? `Failed to resume session ${options.sessionId}; it may not exist on the agent side for this working directory.`
            : `Session ${options.sessionId} cannot be resumed because the agent does not support session resume (loadSession capability false). Start a new session instead.`,
        )
      }
    }

    this.promptBuffers = { text: '', updateCount: 0 }
    try {
      const response = await connection.agent.request('session/prompt', {
        sessionId,
        prompt: toAcpContentBlock(content),
      })
      const agentText = this.promptBuffers.text
      // Silent-failure detection: end_turn with zero updates usually means the
      // agent never started (bad command, missing API key...). Wait briefly for
      // stderr to flush and surface its hint.
      if (this.promptBuffers.updateCount === 0 && response.stopReason === 'end_turn') {
        await new Promise(resolve => setTimeout(resolve, 100))
        const hint = this.extractStderrHint()
        if (hint) {
          throw new Error(`The agent returned an empty response. ${hint}`)
        }
      }
      return {
        agentText,
        sessionId,
        stopReason: response.stopReason,
        usage: response.usage
          ? {
              inputTokens: response.usage.inputTokens ?? null,
              outputTokens: response.usage.outputTokens ?? null,
              totalTokens: response.usage.totalTokens ?? null,
            }
          : null,
      }
    } finally {
      this.promptBuffers = null
    }
  }

  /** Cancel the active prompt turn (notification, not a request). */
  async cancel(sessionId?: string): Promise<void> {
    const id = sessionId ?? this.currentSessionId
    if (!this.connection || !id) return
    try {
      await this.connection.agent.notify('session/cancel', { sessionId: id })
    } catch (err) {
      this.log(`session/cancel failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.permissionManager.cancelAll()
    }
  }

  /** Kill the agent process tree and reset all state. Idempotent. */
  async disconnect(): Promise<void> {
    this.permissionManager.cancelAll()
    await this.killProcessTree()
    this.connection = null
    this.currentConfig = null
    this.isInitializedFlag = false
    this.currentSessionId = null
    this.supportsLoadSession = false
    this.recentStderr = ''
  }

  /** Respond to a pending permission request (delegated to PermissionManager). */
  respondPermission(requestId: string, optionId: string): boolean {
    return this.permissionManager.respond(requestId, optionId, (update) => this.emitUpdate(update))
  }

  private requireConnection(): acp.ClientConnection {
    if (!this.connection || !this.isInitializedFlag) {
      throw new Error('ACP agent is not initialized; call ensureInitialized() first')
    }
    return this.connection
  }

  private emitUpdate(update: SessionUpdate): void {
    for (const listener of this.updateListeners) {
      try {
        listener(update)
      } catch {
        // A faulty listener must not break the protocol loop.
      }
    }
  }

  private handleSessionNotification(params: acp.SessionNotification): void {
    const update = params.update
    const sessionId = params.sessionId
    if (this.promptBuffers && sessionId === this.currentSessionId) {
      this.promptBuffers.updateCount += 1
    }
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
      case 'user_message_chunk': {
        const content = update.content
        if (content?.type === 'text') {
          if (update.sessionUpdate === 'agent_message_chunk' && this.promptBuffers && sessionId === this.currentSessionId) {
            this.promptBuffers.text += content.text
          }
          this.emitUpdate({ type: update.sessionUpdate, sessionId, content: [{ type: 'text', text: content.text }] })
        }
        break
      }
      case 'tool_call': {
        this.emitUpdate({
          type: 'tool_call',
          sessionId,
          toolCallId: update.toolCallId,
          title: update.title ?? '',
          status: mapToolStatus(update.status ?? 'pending'),
          ...(update.kind !== undefined && update.kind !== null ? { kind: update.kind } : {}),
          toolContent: toToolCallContent(update.content) ?? [],
          ...(update.locations ? { locations: mapLocations(update.locations) } : {}),
          ...(update.rawInput !== undefined && update.rawInput !== null ? { rawInput: update.rawInput as Record<string, unknown> } : {}),
          ...(update.rawOutput !== undefined && update.rawOutput !== null ? { rawOutput: update.rawOutput as Record<string, unknown> } : {}),
        })
        break
      }
      case 'tool_call_update': {
        this.emitUpdate({
          type: 'tool_call_update',
          sessionId,
          toolCallId: update.toolCallId,
          ...(update.title !== undefined && update.title !== null ? { title: update.title } : {}),
          ...(update.status !== undefined && update.status !== null ? { status: mapToolStatus(update.status) } : {}),
          ...(update.kind !== undefined && update.kind !== null ? { kind: update.kind } : {}),
          toolContent: toToolCallContent(update.content) ?? [],
          ...(update.locations ? { locations: mapLocations(update.locations) } : {}),
          ...(update.rawOutput !== undefined && update.rawOutput !== null ? { rawOutput: update.rawOutput as Record<string, unknown> } : {}),
        })
        break
      }
      case 'plan': {
        this.emitUpdate({
          type: 'plan',
          sessionId,
          entries: update.entries.map(entry => ({
            content: entry.content,
            status: entry.status,
            ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
          })),
        })
        break
      }
      case 'available_commands_update': {
        this.emitUpdate({
          type: 'available_commands_update',
          sessionId,
          commands: toSlashCommands(update.availableCommands),
        })
        break
      }
      case 'current_mode_update': {
        this.emitUpdate({ type: 'current_mode_update', sessionId, currentModeId: update.currentModeId })
        break
      }
      case 'session_info_update': {
        this.emitUpdate({
          type: 'session_info_update',
          sessionId,
          ...(update.title !== undefined && update.title !== null ? { title: update.title } : {}),
          ...(update.updatedAt ? { updatedAt: update.updatedAt } : {}),
        })
        break
      }
      case 'usage_update': {
        this.emitUpdate({
          type: 'usage_update',
          sessionId,
          usage: {
            used: update.used,
            size: update.size,
            ...(update.cost ? { cost: { amount: update.cost.amount, currency: update.cost.currency } } : {}),
          },
        })
        break
      }
      case 'config_option_update': {
        this.emitUpdate({
          type: 'config_option_update',
          sessionId,
          configOptions: (update.configOptions ?? []).map(opt => ({
            id: opt.id,
            name: opt.name,
            category: opt.category ?? '',
            type: opt.currentValue === true || opt.currentValue === false ? 'boolean' : 'text',
            currentValue: String(opt.currentValue ?? ''),
          })),
        })
        break
      }
      default:
        break
    }
  }

  private extractStderrHint(): string {
    const trimmed = this.recentStderr.trim()
    if (!trimmed) return ''
    const tail = trimmed.length > 400 ? `…${trimmed.slice(-400)}` : trimmed
    return `Agent stderr: ${tail}`
  }

  private async killProcessTree(): Promise<void> {
    const proc = this.agentProcess
    if (!proc) return
    this.agentProcess = null
    const pid = proc.pid
    if (pid === undefined) return
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
        killer.on('error', () => {
          try {
            proc.kill()
          } catch {
            // already gone
          }
          resolve()
        })
        killer.on('exit', () => resolve())
      })
    } else {
      // detached:true → pid is the process-group leader; negative pid signals the group.
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        try {
          proc.kill('SIGTERM')
        } catch {
          // already gone
        }
      }
    }
  }
}
