/**
 * dsh-plugin-zn-agent-client 宿主半边。
 *
 * 给 DSH 增加通过 ACP（Agent Client Protocol）调用本机 CLI agent 的能力：
 * - 工具 `list_acp_agents`：列出配置清单里的 agent；
 * - 工具 `call_acp_agent`：向指定 agent 发送一轮 prompt 并取回回复；
 * - 子代理提供方 `acp`：把同一能力接到 ctx.subagents 的委派通道上。
 *
 * ACP 连接管理（spawn + NDJSON + 会话生命周期 + 权限 + 终端）都在
 * ./acp/client-manager.ts；本文件只做注册与配置解析。
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SubagentProvider, SubagentRun, SubagentResult, ResolvedSubagentStartRequest, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { AcpClientManager } from './acp/client-manager.ts'
import type { AgentConfig } from './types/index.ts'

/** 插件名（cordis.patch.yml 行 id 必须与此一致）。 */
export const name = 'dsh-plugin-zn-agent-client'

/** 依赖的宿主服务：tools 注册工具，subagents 注册子代理提供方。 */
export const inject = ['tools', 'subagents']

/** 插件配置（设置命名空间由 cordis.patch.yml 行 id 派生）。 */
export interface Config {
  /** ACP agent 清单。 */
  agents: Volatile<AgentConfig[]>
  /** 未指定 agentId 时优先使用的 agent id。 */
  defaultAgent: Volatile<string>
  /** 自动允许 agent 的权限请求（跳过人工确认）。 */
  autoAllowPermissions: Volatile<boolean>
  /** 输出诊断日志（进程生命周期、stderr 摘要等）。 */
  logEvents: Volatile<boolean>
}

// Schema<any> 注解：嵌套在 Schema.array 里的 Schema.object 会把 cosmokit 的
// Dict 混进推断类型（TS2883 不可移植），而 Schema<Config> 精确注解又与
// exactOptionalPropertyTypes 冲突。运行时校验仍由 schema 本身完成；插件侧
// 类型由上方 Config 接口提供。
export const Config: Schema<any> = Schema.object({
  agents: Schema.array(
    Schema.object({
      id: Schema.string().required(),
      displayName: Schema.string().required(),
      command: Schema.string().required(),
      args: Schema.array(Schema.string()).default([]),
      // Schema.dict() 的推断类型引用 cosmokit 的 Dict，会让导出类型不可移植
      // （TS2883）；用 any + interface 约束代替。
      env: Schema.any(),
      workingDirectory: Schema.string().default(''),
      // apiKey 的内部字段不能 .required()：agent 未配置 apiKey 时 schemastery
      // 仍会用空对象走一遍校验，required 会把整行配置判非法。
      apiKey: Schema.object({
        secretId: Schema.string(),
        envVarName: Schema.string(),
      }),
    }),
  ).default([]).volatile(),
  defaultAgent: Schema.string().default('').volatile(),
  autoAllowPermissions: Schema.boolean().default(false).volatile(),
  logEvents: Schema.boolean().default(false).volatile(),
})

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 注册完成后发出一次，payload 为插件 id。 */
    'zn-agent-client/ready': (payload: { id: string }) => void
    /** agent 侧有新会话更新时发出（诊断用）。 */
    'zn-agent-client/agent-update': (payload: { agentId: string; sessionId: string | null; kind: string }) => void
  }
}

/** ACP stop reason → 子代理 stop reason。 */
function mapStopReason(stopReason: string | null | undefined): SubagentStopReason {
  switch (stopReason) {
    case 'cancelled':
      return 'aborted'
    case 'max_tokens':
      return 'max-tokens'
    case 'refusal':
      return 'refusal'
    default:
      return 'completed'
  }
}

/** diagnostic 上限 4096 UTF-8 字节（dsh-subagent 契约）。 */
function truncateDiagnostic(message: string): string {
  const bytes = new TextEncoder().encode(message)
  if (bytes.length <= 4096) return message
  return new TextDecoder().decode(bytes.slice(0, 4096))
}

/** 插件入口：一次 apply 生命周期里共享同一个 AcpClientManager。 */
export function apply(ctx: Context, config: Config): void {
  const log = (message: string): void => {
    if (config.logEvents.get()) console.log(`[${name}] ${message}`)
  }

  const manager = new AcpClientManager({
    autoAllowPermissions: config.autoAllowPermissions.get(),
    // TODO: 接入宿主 secret 存储后在此读取 secretId 对应值；空值必须跳过
    // （导出 ANTHROPIC_API_KEY="" 会破坏 agent 的账号登录态）。
    getSecret: async () => null,
    log,
  })

  ctx.effect(() => () => {
    void manager.disconnect()
  }, `${name}: acp manager lifecycle`)

  /** 解析要用的 agent：显式 id > 默认 id > 清单第一个。 */
  const resolveAgentConfig = (agentId?: string): AgentConfig | null => {
    const agents = config.agents.get()
    if (agents.length === 0) return null
    if (agentId) {
      const hit = agents.find((agent) => agent.id === agentId)
      if (hit) return hit
    }
    const fallbackId = config.defaultAgent.get()
    const fallback = fallbackId ? agents.find((agent) => agent.id === fallbackId) : undefined
    return fallback ?? agents[0] ?? null
  }

  ctx.tools.register(
    defineTool({
      name: 'list_acp_agents',
      description: 'List locally configured ACP agents (Claude Code, Codex, Gemini CLI, ...) available to call_acp_agent.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          properties: {
            agents: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', required: true },
                  displayName: { type: 'string', required: true },
                  command: { type: 'string', required: true },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        render: (_args, value) => {
          const agents = value?.agents ?? []
          if (agents.length === 0) {
            return [{ type: 'text', text: 'No ACP agents configured. Add agents in the plugin settings (Settings → Plugins).' }]
          }
          const lines = agents.map((agent) => `- ${agent.id} (${agent.displayName}) — ${agent.command}`)
          return [{ type: 'text', text: `Configured ACP agents:\n${lines.join('\n')}` }]
        },
      },
      async execute() {
        const agents = config.agents.get()
        return {
          agents: agents.map((agent) => ({ id: agent.id, displayName: agent.displayName, command: agent.command })),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'call_acp_agent',
      description: 'Send a prompt to a locally configured ACP agent over stdio and return its reply. Use list_acp_agents first to discover agent ids.',
      parameters: {
        agentId: { type: 'string', required: true, description: 'Agent id from list_acp_agents.' },
        prompt: { type: 'string', required: true, description: 'Prompt text to send to the agent.' },
        sessionId: { type: 'string', description: 'Existing ACP session id to continue; omit to start a new session.' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            response: { type: 'string', required: true },
            agentId: { type: 'string' },
            sessionId: { type: 'string' },
            stopReason: { type: 'string' },
            usage: { type: 'json' },
          },
          additionalProperties: false,
        },
        render: (_args, value) => {
          const parts: string[] = []
          if (value.agentId) parts.push(value.agentId)
          if (value.sessionId) parts.push(value.sessionId)
          if (value.stopReason) parts.push(value.stopReason)
          const suffix = parts.length > 0 ? `\n\n(${parts.join(' · ')})` : ''
          return [{ type: 'text', text: `${value.response}${suffix}` }]
        },
      },
      async execute(args, exec) {
        const agent = resolveAgentConfig(args.agentId)
        if (!agent) {
          throw new Error(`No ACP agent configured${args.agentId ? ` with id "${args.agentId}"` : ''}. Call list_acp_agents to see what is configured, or add agents in Settings → Plugins.`)
        }
        await manager.ensureInitialized(agent)

        // 中止语义：工具被取消时向 agent 发 session/cancel。
        const onAbort = (): void => {
          void manager.cancel()
        }
        if (exec.signal.aborted) await manager.cancel()
        else exec.signal.addEventListener('abort', onAbort, { once: true })

        try {
          const outcome = await manager.sendPrompt(
            [{ type: 'text', text: args.prompt }] satisfies ContentBlock[],
            args.sessionId ? { sessionId: args.sessionId } : {},
          )
          return {
            response: outcome.agentText,
            agentId: agent.id,
            sessionId: outcome.sessionId,
            ...(outcome.stopReason !== undefined ? { stopReason: outcome.stopReason } : {}),
            ...(outcome.usage !== null ? { usage: outcome.usage } : {}),
          }
        } finally {
          exec.signal.removeEventListener('abort', onAbort)
        }
      },
    }),
  )

  /** 一次性子代理：起一个 ACP 会话跑完 prompt，取回复文本作为输出。 */
  const startAcpSubagent = (request: ResolvedSubagentStartRequest): Promise<SubagentRun> => {
    const agent = resolveAgentConfig()
    const result: Promise<SubagentResult> = (async () => {
      if (!agent) {
        return {
          output: [],
          diagnostic: 'No ACP agent is configured for the acp subagent provider.',
          stopReason: 'error',
        }
      }
      try {
        await manager.ensureInitialized(agent)
        const outcome = await manager.sendPrompt(request.prompt, {})
        return {
          output: [{ type: 'text', text: outcome.agentText }],
          stopReason: mapStopReason(outcome.stopReason),
        }
      } catch (error) {
        return {
          output: [],
          diagnostic: truncateDiagnostic(error instanceof Error ? error.message : String(error)),
          stopReason: 'error',
        }
      }
    })()

    const run: SubagentRun = {
      id: crypto.randomUUID() as SessionId,
      result,
      dispose: async () => {
        // 一次性运行：dispose 时放弃结果即可（agent 进程由 manager 统一管理）。
        await result.catch(() => undefined)
      },
    }
    return Promise.resolve(run)
  }

  const provider: SubagentProvider = {
    name: 'acp',
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    inheritsParentContext: false,
    start: startAcpSubagent,
  }
  ctx.subagents.registerProvider(provider)

  // 诊断：把会话更新透传到宿主事件（可被其他插件监听）。
  const offUpdate = manager.onSessionUpdate((update) => {
    ctx.emit('zn-agent-client/agent-update', {
      agentId: manager.getCurrentAgentId() ?? '',
      sessionId: update.sessionId,
      kind: update.type,
    })
  })
  ctx.effect(() => offUpdate, `${name}: agent-update relay`)

  ctx.emit('zn-agent-client/ready', { id: name })
}
