/**
 * ACP Type Converter: conversions between ACP SDK types and DSH/plugin types.
 *
 * Mirrors obsidian-agent-client `src/acp/type-converter.ts` with adaptations
 * to DSH types and naming. All functions are pure and named exports.
 *
 * @module dsh-plugin-zn-agent-client/acp/type-converter
 */

import * as acp from '@agentclientprotocol/sdk'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionResult, ToolCallContent } from '../types/index.ts'

/** Any ACP session response that carries modes/configOptions (new/load/fork/resume). */
interface AcpSessionResponse {
  modes?: acp.SessionModeState | null
  configOptions?: acp.SessionConfigOption[] | null
}

/** Convert DSH `ContentBlock[]` (plugin-side prompt) to ACP `ContentBlock[]`. */
export function toAcpContentBlock(content: readonly ContentBlock[]): acp.ContentBlock[] {
  const blocks: acp.ContentBlock[] = []
  for (const c of content) {
    if ((c.type === 'text' || c.type === 'reasoning') && c.text !== '') {
      blocks.push({ type: 'text', text: c.text })
    } else {
      // Image/file/tool blocks have no direct ACP prompt equivalent here;
      // degrade to a text placeholder so the agent still sees an annotation.
      blocks.push({ type: 'text', text: `[${c.type} block omitted]` })
    }
  }
  return blocks
}

/** Convert ACP text content to a DSH text block (plugin-side output). */
export function acpTextToDshBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

/** Convert ACP `AvailableCommand[]` to plain slash-command records. */
export function toSlashCommands(
  commands: acp.AvailableCommand[] | null | undefined,
): Array<{ name: string; description: string; hint?: string }> {
  if (!commands) return []
  return commands.map(cmd => ({
    name: cmd.name,
    description: cmd.description ?? '',
    ...(cmd.input?.hint !== undefined && cmd.input?.hint !== null ? { hint: cmd.input.hint } : {}),
  }))
}

/** Convert one ACP `ContentBlock` to a plugin ToolCallContent inner item (loose pass-through). */
function convertInnerBlock(item: acp.ContentBlock): ToolCallContent['content'][number] {
  if (item.type === 'text') return item
  if (item.type === 'image') return item
  if (item.type === 'audio') return item
  if (item.type === 'resource_link') return item
  return item // resource: pass through as-is (loose shape)
}

/**
 * Convert ACP `ToolCallContent[]` to plugin `ToolCallContent[]`.
 * Three-state: undefined → undefined (unchanged), null/[] → [], array → converted.
 * The plugin type only models the "content" variant; `diff` and `terminal`
 * variants degrade to a descriptive text block (raw data stays with the caller).
 */
export function toToolCallContent(
  toolCallContent: acp.ToolCallContent[] | null | undefined,
): ToolCallContent[] | undefined {
  if (toolCallContent === undefined) return undefined
  if (toolCallContent === null || toolCallContent.length === 0) return []
  return toolCallContent.map(acpItem => {
    if (acpItem.type === 'content') {
      // ACP Content.content is a SINGLE ContentBlock — wrap in an array.
      return { type: 'content' as const, content: [convertInnerBlock(acpItem.content)] }
    }
    if (acpItem.type === 'diff') {
      return {
        type: 'content' as const,
        content: [{
          type: 'text' as const,
          text: `diff ${acpItem.path}\n${acpItem.newText ?? ''}`,
        }],
      }
    }
    return {
      type: 'content' as const,
      content: [{ type: 'text' as const, text: `[terminal ${acpItem.terminalId}]` }],
    }
  })
}

/** Convert ACP `SessionConfigOption[]` to plain config-option records. */
export function toSessionConfigOptions(
  options: acp.SessionConfigOption[] | null | undefined,
): Array<{
  id: string
  name: string
  category: string
  type: 'select' | 'boolean'
  currentValue: string
  options?: Array<{ value: string; label: string }>
}> {
  if (!options) return []
  return options.map(opt => {
    const base = {
      id: opt.id,
      name: opt.name,
      category: opt.category ?? '',
    }
    if (opt.type === 'boolean') {
      return { ...base, type: 'boolean' as const, currentValue: String(opt.currentValue) }
    }
    // select: currentValue is a SessionConfigValueId; options may be flat or grouped.
    const rawOptions = Array.isArray(opt.options) ? opt.options : []
    const flatOptions: Array<{ value: string; label: string }> = []
    for (const o of rawOptions) {
      if ('value' in o) {
        flatOptions.push({ value: String(o.value), label: o.name })
      } else {
        // Select group: flatten its member options.
        for (const inner of o.options) {
          flatOptions.push({ value: String(inner.value), label: inner.name })
        }
      }
    }
    return {
      ...base,
      type: 'select' as const,
      currentValue: String(opt.currentValue ?? ''),
      options: flatOptions,
    }
  })
}

/** Summarize an ACP `InitializeResponse` for logging/UI. */
export function toInitializeSummary(result: acp.InitializeResponse): {
  protocolVersion: number
  agentName: string | null
  agentVersion: string | null
  authMethodCount: number
} {
  return {
    protocolVersion: result.protocolVersion,
    agentName: result.agentInfo?.name ?? null,
    agentVersion: result.agentInfo?.version ?? null,
    authMethodCount: result.authMethods?.length ?? 0,
  }
}

/** Convert an ACP session response (session/new, session/load, ...) to `SessionResult`. */
export function toSessionResult(sessionId: string, response: AcpSessionResponse): SessionResult {
  const result: SessionResult = { sessionId }
  if (response.modes) {
    result.modes = {
      currentModeId: response.modes.currentModeId,
      availableModes: (response.modes.availableModes ?? []).map(m => ({
        id: m.id,
        name: m.name,
        description: m.description ?? '',
      })),
    }
  }
  if (response.configOptions) {
    result.configOptions = toSessionConfigOptions(response.configOptions)
  }
  return result
}
