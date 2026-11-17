/**
 * Shared types for dsh-plugin-zn-agent-client.
 * Used by both host and client halves.
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Permission option for ACP agents. */
export interface PermissionOption {
  optionId: string
  name: string
  kind?: string
  description?: string
}

/** ACP agent configuration as stored in plugin config. */
export interface AgentConfig {
  /** Stable unique id for this agent, e.g. "claude-code-acp". */
  id: string
  /** Display name shown in UI, e.g. "Claude Code". */
  displayName: string
  /** Command to spawn the ACP agent, e.g. "claude-agent-acp". */
  command: string
  /** Additional arguments passed to the command. */
  args: readonly string[]
  /** Additional environment variables. */
  env: Readonly<Record<string, string>>
  /** Working directory (empty = workspace root). */
  workingDirectory?: string
  /** Optional API key configuration for API-key auth agents. */
  apiKey?: {
    /** DSH secret storage key. */
    secretId: string
    /** Environment variable name to inject, e.g. "ANTHROPIC_API_KEY". */
    envVarName: string
  }
  /** Internal metadata (preset source, etc.). */
  _meta?: Record<string, unknown>
}

/** Result of an ACP session operation. */
export interface SessionResult {
  /** The session id. */
  sessionId: string
  /** Modes state (if returned by agent). */
  modes?: {
    currentModeId: string
    availableModes: Array<{
      id: string
      name: string
      description: string
      category?: string
    }>
  }
  /** Config options (if returned by agent). */
  configOptions?: Array<{
    id: string
    name: string
    category: string
    type: string
    currentValue: string
    options?: Array<{ value: string; label: string }>
  }>
}

/** Session update event from ACP agent. */
export interface SessionUpdate {
  /** Type of update. */
  type: 'agent_message_chunk' | 'agent_thought_chunk' | 'user_message_chunk' | 'tool_call' | 'tool_call_update' | 'plan' | 'available_commands_update' | 'current_mode_update' | 'session_info_update' | 'usage_update' | 'config_option_update'
  /** Session id this update belongs to. */
  sessionId: string
  /** For agent_message_chunk / agent_thought_chunk / user_message_chunk. */
  content?: Array<{ type: 'text'; text: string }>
  /** For tool_call / tool_call_update. */
  toolCallId?: string
  title?: string
  status?: 'pending' | 'running' | 'completed' | 'failed'
  kind?: string
  toolContent?: ToolCallContent[]
  locations?: Array<{ path: string; line?: number }>
  rawInput?: Record<string, unknown>
  rawOutput?: Record<string, unknown>
  /** For plan. */
  entries?: Array<{ content: string; status: string; priority?: string }>
  /** For available_commands_update. */
  commands?: Array<{ name: string; description: string; hint?: string }>
  /** For current_mode_update / session_info_update. */
  currentModeId?: string
  updatedAt?: string
  /** For usage_update (ACP UsageUpdate: used/size/cost). */
  usage?: { used: number; size: number; cost?: { amount: number; currency: string } }
  /** For config_option_update. */
  configOptions?: Array<{
    id: string
    name: string
    category: string
    type: string
    currentValue: string
    options?: Array<{ value: string; label: string }>
  }>
  /** For permission request (embedded in tool_call). */
  permissionRequest?: {
    requestId: string
    options: Array<{ optionId: string; name: string; kind?: string; description?: string }>
    isActive: boolean
  }
}

/** ACP tool call content (matches ACP SDK structure; nullable mirrors SDK optionals). */
export interface ToolCallContent {
  type: 'content'
  content: Array<{
    type: 'text' | 'image' | 'audio' | 'resource_link' | 'resource'
    text?: string | null
    data?: string | null
    mimeType?: string | null
    uri?: string | null
    name?: string | null
    title?: string | null
    description?: string | null
    size?: number | null
    [key: string]: unknown
  }>
}

/** ACP ContentBlock re-export for convenience. */
export type { ContentBlock }

/** Subagent start request (from dsh-subagent). */
export interface SubagentStartRequest {
  cwd?: string
  agentPreset?: string
  label?: string
  prompt: any
  parent: any // Agent
  signal: AbortSignal
  agentOptions?: any
  outputSchema?: any
  maxDepth?: number
}