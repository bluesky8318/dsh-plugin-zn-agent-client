/**
 * 在外部终端（系统 Terminal.app / iTerm2 / Ghostty）里启动一个 CLI agent。
 *
 * 高保真备选：内嵌 xterm 在浏览器里渲染，观感/字体与系统终端总有差距；
 * 这里用 AppleScript 拉起真正的终端应用，在指定工作目录里启动 agent，
 * 获得原生 Metal/GPU 渲染、系统字体与输入法。macOS 优先，其它平台报错。
 * @module dsh-plugin-zn-agent-client/external-terminal
 */

import { spawn } from 'child_process'
import { platform } from 'os'
import type { AgentConfig } from './types/index.ts'

/** 目标外部终端应用。 */
export type ExternalTerminal = 'terminal' | 'iterm' | 'ghostty'

/** 启动结果。 */
export interface ExternalLaunchResult {
  readonly terminal: ExternalTerminal
  readonly command: string
  readonly workingDirectory: string
}

/** 转义 AppleScript 字符串里的反斜杠与双引号。 */
function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** 用 shell 引号包一个参数（单引号 + 内部单引号转义）。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * 生成在 cwd 下启动 agent 的 shell 命令行（cd + exec 命令）。
 * 参数逐个 shell-quote，避免注入。
 * @param cwdOverride - 覆盖工作目录（远端按钮传会话目录时用）。
 */
export function buildAgentShellLine(agent: AgentConfig, cwdOverride?: string): string {
  const cwd = cwdOverride ?? process.cwd()
  // 外部终端跑的是 TUI 会话：用 CLI 配置参数（cliArgs），不是 ACP 模式参数。
  const parts = [agent.command, ...(agent.cliArgs ?? [])].map(shellQuote).join(' ')
  return `cd ${shellQuote(cwd)} && exec ${parts}`
}

/**
 * 构造 AppleScript：在目标终端新建窗口/标签并运行命令。
 * - Terminal.app：`do script`（新窗口）。
 * - iTerm2：`create window with default profile command ...`。
 * - Ghostty 1.3+：AppleScript `new window ... command ...`（见官方 AppleScript 文档）。
 */
export function buildAppleScript(terminal: ExternalTerminal, shellLine: string): string {
  const cmd = escapeAppleScript(shellLine)
  if (terminal === 'iterm') {
    return [
      'tell application "iTerm2"',
      '  activate',
      `  create window with default profile command "${cmd}"`,
      'end tell',
    ].join('\n')
  }
  if (terminal === 'ghostty') {
    return [
      'tell application "Ghostty"',
      '  activate',
      `  new window with configuration {command:"${cmd}"}`,
      'end tell',
    ].join('\n')
  }
  // 默认：系统 Terminal.app
  return [
    'tell application "Terminal"',
    '  activate',
    `  do script "${cmd}"`,
    'end tell',
  ].join('\n')
}

/** 跑一次 osascript（-e 逐行），返回 stderr（非空即视为错误）。 */
function runOsascript(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = script.split('\n').flatMap((line) => ['-e', line])
    const proc = spawn('osascript', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `osascript exited with code ${code}`))
    })
  })
}

/**
 * 在外部终端里启动 agent。非 macOS 直接抛错。
 * @param agent - 要启动的 agent（用裸命令，不带 --acp）。
 * @param terminal - 目标终端应用。
 * @param cwdOverride - 覆盖工作目录（远端按钮传会话目录时用）。
 */
export async function openInExternalTerminal(
  agent: AgentConfig,
  terminal: ExternalTerminal = 'terminal',
  cwdOverride?: string,
): Promise<ExternalLaunchResult> {
  if (platform() !== 'darwin') {
    throw new Error('Opening an external terminal is only supported on macOS for now.')
  }
  const shellLine = buildAgentShellLine(agent, cwdOverride)
  const script = buildAppleScript(terminal, shellLine)
  await runOsascript(script)
  return { terminal, command: shellLine, workingDirectory: cwdOverride ?? process.cwd() }
}
