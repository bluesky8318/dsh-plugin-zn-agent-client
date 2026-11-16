/**
 * ACP Agent Preset Definitions.
 * 
 * These are the built-in agent presets that come with the DSH plugin.
 * Users can configure these via the config form or add their own custom agents.
 *
 * @module dsh-plugin-zn-agent-client/acp/preset-agents
 */

import type { AgentConfig } from '../types/index.ts'

/**
 * Built-in ACP agent presets.
 * Users can configure these via the config form or add their own custom agents.
 */
export const presetAgents: AgentConfig[] = [
  // Claude Code (Claude Agent)
  {
    id: 'claude-code-acp',
    displayName: 'Claude Code',
    command: 'claude-agent-acp',
    args: [],
    env: {},
    workingDirectory: '',
    apiKey: {
      secretId: 'ANTHROPIC_API_KEY',
      envVarName: 'ANTHROPIC_API_KEY',
    },
  },
  // Codex
  {
    id: 'codex-acp',
    displayName: 'Codex',
    command: 'codex-acp',
    args: [],
    env: {},
    workingDirectory: '',
    apiKey: {
      secretId: 'OPENAI_API_KEY',
      envVarName: 'OPENAI_API_KEY',
    },
  },
  // Gemini CLI
  {
    id: 'gemini-cli',
    displayName: 'Gemini CLI',
    command: 'gemini',
    args: ['--experimental-acp'],
    env: {},
    workingDirectory: '',
    apiKey: {
      secretId: 'GEMINI_API_KEY',
      envVarName: 'GEMINI_API_KEY',
    },
  },
  // opencode (no API key, absorbs custom agent id)
  {
    id: 'opencode',
    displayName: 'OpenCode',
    command: 'opencode',
    args: ['acp'],
    env: {},
    workingDirectory: '',
  },
  // kiro-cli
  {
    id: 'kiro-cli',
    displayName: 'Kiro',
    command: 'kiro-cli',
    args: ['acp'],
    env: {},
    workingDirectory: '',
    apiKey: {
      secretId: 'KIRO_API_KEY',
      envVarName: 'KIRO_API_KEY',
    },
  },
  // hermes-agent
  {
    id: 'hermes-agent',
    displayName: 'Hermes Agent',
    command: 'hermes',
    args: ['acp'],
    env: {},
    workingDirectory: '',
  },
  // pi-acp
  {
    id: 'pi-acp',
    displayName: 'Pi',
    command: 'pi-acp',
    args: [],
    env: {},
    workingDirectory: '',
  },
  // grok-build
  {
    id: 'grok-build',
    displayName: 'Grok Build',
    command: 'grok',
    args: ['agent', 'stdio'],
    env: {},
    workingDirectory: '',
    apiKey: {
      secretId: 'XAI_API_KEY',
      envVarName: 'XAI_API_KEY',
    },
  },
  // bob-acp
  {
    id: 'bob-acp',
    displayName: 'IBM Bob',
    command: 'bob',
    args: ['acp'],
    env: {},
    workingDirectory: '',
    apiKey: {
      secretId: 'BOBSHELL_API_KEY',
      envVarName: 'BOBSHELL_API_KEY',
    },
  },
  // antigravity-cli
  {
    id: 'antigravity-cli',
    displayName: 'Antigravity CLI',
    command: 'agy',
    args: ['acp'],
    env: {},
    workingDirectory: '',
    apiKey: {
      secretId: 'GEMINI_API_KEY',
      envVarName: 'GEMINI_API_KEY',
    },
  },
  // mistral-vibe
  {
    id: 'mistral-vibe',
    displayName: 'Mistral Vibe',
    command: 'vibe-acp',
    args: [],
    env: {},
    workingDirectory: '',
    apiKey: {
      secretId: 'MISTRAL_API_KEY',
      envVarName: 'MISTRAL_API_KEY',
    },
  },
]