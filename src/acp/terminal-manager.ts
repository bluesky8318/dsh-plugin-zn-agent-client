/**
 * Terminal manager for ACP terminal operations.
 *
 * Mirrors obsidian-agent-client `src/acp/terminal-handler.ts` but simplified
 * for DSH: manages ACP terminal lifecycle records. Processes are spawned and
 * wired by the client manager layer; this class tracks their output/state.
 *
 * @module dsh-plugin-zn-agent-client/acp/terminal-manager
 */

import type { ChildProcess } from 'node:child_process'

/** Parameters for ACP `terminal/create` request. */
export interface TerminalCreateParams {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  outputByteLimit?: number
}

/** Result for ACP `terminal/output` and `terminal/wait_for_exit` requests. */
export interface TerminalOutputResult {
  output: string
  exited: boolean
  exitCode?: number
}

/** Internal representation of a managed terminal. */
interface ManagedTerminal {
  id: string
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  outputByteLimit: number
  process: ChildProcess | null
  output: string
  exited: boolean
  exitCode: number | null
  resolveOnExit: ((result: TerminalOutputResult) => void) | null
}

/**
 * TerminalManager: manages ACP terminal operations (create, output, wait, kill, release).
 */
export class TerminalManager {
  private terminals = new Map<string, ManagedTerminal>()
  private idCounter = 0

  /** Create a new terminal record. Returns the terminal id. */
  createTerminal(params: TerminalCreateParams): string {
    const id = `term-${++this.idCounter}-${Date.now()}`
    const terminal: ManagedTerminal = {
      id,
      command: params.command,
      args: params.args,
      cwd: params.cwd,
      env: params.env || {},
      outputByteLimit: params.outputByteLimit || 1024 * 1024, // 1MB default
      process: null,
      output: '',
      exited: false,
      exitCode: null,
      resolveOnExit: null,
    }
    this.terminals.set(id, terminal)
    return id
  }

  /** Attach a spawned process to a terminal record. */
  attachProcess(terminalId: string, proc: ChildProcess): void {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) return
    terminal.process = proc
  }

  /** Get terminal output (for ACP `terminal/output` request). */
  getOutput(terminalId: string): TerminalOutputResult {
    const terminal = this.requireTerminal(terminalId)
    return {
      output: terminal.output,
      exited: terminal.exited,
      ...(terminal.exitCode !== null ? { exitCode: terminal.exitCode } : {}),
    }
  }

  /** Wait for terminal to exit (for ACP `terminal/wait_for_exit` request). */
  waitForExit(terminalId: string): Promise<TerminalOutputResult> {
    const terminal = this.requireTerminal(terminalId)
    if (terminal.exited) {
      return Promise.resolve({
        output: terminal.output,
        exited: true,
        ...(terminal.exitCode !== null ? { exitCode: terminal.exitCode } : {}),
      })
    }
    return new Promise((resolve) => {
      terminal.resolveOnExit = resolve
    })
  }

  /** Kill a terminal (for ACP `terminal/kill` request). */
  killTerminal(terminalId: string): boolean {
    const terminal = this.requireTerminal(terminalId)
    const proc = terminal.process
    if (proc && !terminal.exited) {
      try {
        proc.kill('SIGTERM')
      } catch {
        try {
          proc.kill()
        } catch {
          // already gone
        }
      }
      return true
    }
    return false
  }

  /** Release terminal resources (for ACP `terminal/release` request). */
  releaseTerminal(terminalId: string): boolean {
    // Tolerate already-released terminals.
    return this.terminals.delete(terminalId)
  }

  /** Append output to a terminal's rolling buffer. */
  appendOutput(terminalId: string, data: string): void {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) return
    terminal.output += data
    if (terminal.output.length > terminal.outputByteLimit) {
      terminal.output = terminal.output.slice(-terminal.outputByteLimit)
    }
  }

  /** Mark terminal as exited and settle any waiters. */
  markExited(terminalId: string, exitCode?: number): void {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) return
    terminal.exited = true
    terminal.exitCode = exitCode ?? null
    const resolve = terminal.resolveOnExit
    terminal.resolveOnExit = null
    if (resolve) {
      resolve({
        output: terminal.output,
        exited: true,
        ...(exitCode !== undefined ? { exitCode } : {}),
      })
    }
  }

  /** Get all terminal IDs. */
  getAllIds(): string[] {
    return Array.from(this.terminals.keys())
  }

  private requireTerminal(terminalId: string): ManagedTerminal {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) throw new Error(`Terminal ${terminalId} not found`)
    return terminal
  }
}
