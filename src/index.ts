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
import { AcpClientManager, type PromptOutcome } from './acp/client-manager.ts'
import { SessionIndex } from './acp/session-index.ts'
import { createZnAgentClientRemote } from './acp/remote-service.ts'
import { CliTerminalController, type SubprocessFace } from './acp/cli-terminal.ts'
import { createCliTerminalRoutes, type WebServerFace, type RouteRequest, type RouteResponse } from './acp/cli-routes.ts'
import { openInExternalTerminal, type ExternalTerminal } from './external-terminal.ts'
import type { AgentConfig } from './types/index.ts'

/** 插件名（cordis.patch.yml 行 id 必须与此一致）。 */
export const name = 'dsh-plugin-zn-agent-client'

/** 依赖的宿主服务：tools 注册工具，subagents 注册子代理提供方。 */
export const inject = ['tools', 'subagents', 'subprocess', 'webServer', 'workingDirectory']

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

/** /znacp 斜杠命令名（/acp 被其他插件占用）。 */
export const ACP_COMMAND_NAME = 'znacp'

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

  // TypertRemote 服务：浏览器半边「在外部终端打开」按钮的宿主接收端。
  // workingDirectory 走可选注入（服务未组成时回调不执行，远端退回配置目录）。
  ctx.inject(['workingDirectory'], (inner) => {
    const cwdFace = (inner as Context & { workingDirectory?: { get(sessionId: unknown): string | undefined } }).workingDirectory
    void createZnAgentClientRemote(ctx, (agentKey) => resolveAgentConfig(agentKey) ?? undefined, cwdFace)
  })

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

  // CLI Agent 终端宿主（dsh-agents-cli 同款架构）：subprocess PTY + 自有 SSE 路由。
  // webServer/subprocess 是宿主核心服务，缺失则整个特性不可用——直接声明依赖。
  ctx.inject(['subprocess', 'webServer', 'workingDirectory'], (inner) => {
    const faces = inner as Context & {
      subprocess?: SubprocessFace
      webServer?: WebServerFace
      workingDirectory?: { defaultDirectory?: string }
    }
    const subprocess = faces.subprocess
    const webServer = faces.webServer
    if (subprocess === undefined || webServer === undefined) {
      log('CLI 终端宿主不可用：缺少 subprocess/webServer 服务')
      return
    }
    const defaultCwd = (): string => faces.workingDirectory?.defaultDirectory ?? process.cwd()
    const controller = new CliTerminalController(subprocess, defaultCwd)

    for (const route of createCliTerminalRoutes(controller, {
      resolveAgent: (agentId: string) => resolveAgentConfig(agentId),
      defaultCwd,
    })) {
      ctx.effect(() => {
        webServer.register({
        kind: 'exact',
        path: route.path,
        handler: (req: RouteRequest, res: RouteResponse): void => {
          // 'exact' 路由仍会收到其他路径/方法的请求，照参考插件做二次校验。
          const pathname = (req.url ?? '').split('?')[0]
          if (pathname !== route.path) {
            res.writeHead(404)
            res.end()
            return
          }
          if (req.method !== route.method) {
            res.writeHead(405, { allow: route.method })
            res.end()
            return
          }
          void route.handler(req, res).catch((error: unknown) => {
            if (res.headersSent !== true) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
            }
          })
        },
        })
        // 路由由宿主 webServer 的 effect 生命周期管理；这里返回空清理保持签名。
        return () => {}
      }, `${name}: ${route.method} ${route.path}`)
    }

    ctx.effect(() => () => {
      void controller.dispose()
    }, `${name}: cli terminal controller lifecycle`)
  })

  /**
   * 会话索引:ACP 会话历史存在 agent 侧(见 session-index.ts 模块注释),
   * 这里记录 sessionId 句柄,供 list_acp_sessions 与 call_acp_agent 续聊。
   */
  const sessionIndex = new SessionIndex()

  /** 短 id:会话句柄前 8 位,用于人类可读的展示与命令行引用。 */
  const shortId = (sessionId: string): string => sessionId.slice(0, 8)

  /** 相对时间:把 ISO 时间戳变成"3 分钟前"式表述。 */
  const relativeTime = (iso: string): string => {
    const diffMs = Date.now() - new Date(iso).getTime()
    if (!Number.isFinite(diffMs) || diffMs < 0) return iso
    const minutes = Math.floor(diffMs / 60000)
    if (minutes < 1) return '刚刚'
    if (minutes < 60) return `${minutes} 分钟前`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours} 小时前`
    const days = Math.floor(hours / 24)
    if (days < 30) return `${days} 天前`
    return new Date(iso).toLocaleString()
  }

  /** 会话清单的人类可读格式(工具与 /znacp sessions 共用)。 */
  const formatSessionLines = (records: ReadonlyArray<{ sessionId: string; agentId: string; cwd: string; lastUsedAt: string }>): string =>
    records
      .map((record, index) => `${index + 1}. [${record.agentId}] ${shortId(record.sessionId)}… · ${record.cwd} · ${relativeTime(record.lastUsedAt)}`)
      .join('\n')

  /**
   * 解析用户给的会话引用:完整 id / 唯一前缀 / 'latest'(该 agent 最近一次会话)。
   * 解析不出唯一匹配时原样返回,让 agent 侧给出更有针对性的报错。
   */
  const resolveSessionRef = async (agentId: string, cwd: string, raw: string): Promise<string> => {
    if (raw === 'latest') return (await sessionIndex.latestFor(agentId, cwd))?.sessionId ?? raw
    const records = await sessionIndex.list()
    if (records.some(record => record.sessionId === raw)) return raw
    const matches = records.filter(record => record.sessionId.startsWith(raw))
    return matches.length === 1 ? matches[0]!.sessionId : raw
  }

  /**
   * 所有通道(工具/命令/子代理)共用的"一轮 prompt":确保初始化 → 决定会话 →
   * 发送 → 把会话句柄写进索引(写失败不打断主流程)。
   *
   * 会话选择规则:显式 sessionId 优先;否则默认**自动延续**该 agent 最近一次
   * 会话(agent 声明了 loadSession 能力时),让跨重启的"接着聊"成为默认体验;
   * `resume: false` 强制开全新会话。
   */
  const runAgentTurn = async (
    agent: AgentConfig,
    prompt: string | readonly ContentBlock[],
    options: { sessionId?: string; resume?: boolean; track?: boolean } = {},
  ): Promise<PromptOutcome> => {
    await manager.ensureInitialized(agent)
    let effective = options.sessionId
    if (effective === undefined && options.resume !== false) {
      // 只延续同工作目录的会话：agent 侧(qoder/claude 等)按项目存放会话,
      // 跨目录 resume 会被对方拒掉,反而打断"新项目新会话"的预期。
      const latest = await sessionIndex.latestFor(agent.id, agent.workingDirectory)
      if (latest !== null && manager.canResumeSessions()) effective = latest.sessionId
    }
    if (options.resume === false && effective === undefined) {
      await manager.newSession()
    }
    const content: readonly ContentBlock[] = typeof prompt === 'string'
      ? [{ type: 'text', text: prompt } as ContentBlock]
      : prompt
    const outcome = await manager.sendPrompt(content, effective !== undefined ? { sessionId: effective } : {})
    if (options.track !== false) {
      void sessionIndex
        .record({ sessionId: outcome.sessionId, agentId: agent.id, cwd: agent.workingDirectory || process.cwd() })
        .catch(() => undefined)
    }
    return outcome
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
      description: 'Send a prompt to a locally configured ACP agent over stdio and return its reply. By default the conversation automatically continues from this agent\'s most recent session; pass newSession to start fresh. Use list_acp_agents first to discover agent ids.',
      parameters: {
        agentId: { type: 'string', required: true, description: 'Agent id from list_acp_agents.' },
        prompt: { type: 'string', required: true, description: 'Prompt text to send to the agent.' },
        sessionId: { type: 'string', description: 'Session to continue: full id, unique id prefix, or "latest" (this agent\'s most recent session). Omit to auto-continue the latest session.' },
        newSession: { type: 'boolean', description: 'Force a brand-new session instead of continuing the latest one.' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            response: { type: 'string', required: true },
            agentId: { type: 'string' },
            sessionId: { type: 'string' },
            resumed: { type: 'boolean' },
            stopReason: { type: 'string' },
            usage: { type: 'json' },
          },
          additionalProperties: false,
        },
        render: (_args, value) => {
          const tags: string[] = []
          if (value.agentId) tags.push(value.agentId)
          if (value.sessionId) tags.push(`${value.resumed ? '延续会话' : '新会话'} ${shortId(String(value.sessionId))}…`)
          if (value.stopReason) tags.push(String(value.stopReason))
          const suffix = tags.length > 0 ? `\n\n（${tags.join(' · ')}）` : ''
          return [{ type: 'text', text: `${String(value.response ?? '')}${suffix}` }]
        },
      },
      async execute(args, exec) {
        const agent = resolveAgentConfig(args.agentId)
        if (!agent) {
          throw new Error(`No ACP agent configured${args.agentId ? ` with id "${args.agentId}"` : ''}. Call list_acp_agents to see what is configured, or add agents in Settings → Plugins.`)
        }

        // 中止语义：工具被取消时向 agent 发 session/cancel。
        const onAbort = (): void => {
          void manager.cancel()
        }
        if (exec.signal.aborted) await manager.cancel()
        else exec.signal.addEventListener('abort', onAbort, { once: true })

        try {
          // 决定本轮挂在哪个会话上(仅用于结果标注 resumed):
          // 显式引用 > 自动延续最近会话 > 全新会话(newSession)。
          const autoTarget = args.newSession === true || args.sessionId !== undefined
            ? undefined
            : (await sessionIndex.latestFor(agent.id, agent.workingDirectory))?.sessionId
          const requested = args.newSession === true
            ? undefined
            : args.sessionId
              ? await resolveSessionRef(agent.id, agent.workingDirectory, args.sessionId)
              : undefined
          const outcome = await runAgentTurn(
            agent,
            [{ type: 'text', text: args.prompt }],
            requested !== undefined
              ? { sessionId: requested }
              : { ...(args.newSession === true ? { resume: false } : {}) },
          )
          return {
            response: outcome.agentText,
            agentId: agent.id,
            sessionId: outcome.sessionId,
            resumed: requested !== undefined || autoTarget !== undefined,
            ...(outcome.stopReason !== undefined ? { stopReason: outcome.stopReason } : {}),
            ...(outcome.usage !== null ? { usage: outcome.usage } : {}),
          }
        } finally {
          exec.signal.removeEventListener('abort', onAbort)
        }
      },
    }),
  )

  /** 列出本插件记录过的 ACP 会话句柄（历史在 agent 侧，这里只有 id）。 */
  ctx.tools.register(
    defineTool({
      name: 'list_acp_sessions',
      description: 'List ACP session handles previously used by this plugin (newest first). Pass a sessionId to call_acp_agent to continue one of these conversations on the agent side.',
      parameters: {
        agentId: { type: 'string', description: 'Only list sessions of this agent id; omit for all agents.' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            sessions: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                properties: {
                  sessionId: { type: 'string', required: true },
                  agentId: { type: 'string', required: true },
                  cwd: { type: 'string', required: true },
                  lastUsedAt: { type: 'string', required: true },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        render: (_args, value) => {
          const sessions = value?.sessions ?? []
          if (sessions.length === 0) return [{ type: 'text', text: '还没有记录过会话。调用一次 call_acp_agent 之后这里就会出现历史。' }]
          const lines = formatSessionLines(sessions)
          return [{
            type: 'text',
            text: `记录到的会话（新 → 旧）：\n${lines}\n\n续聊方式：call_acp_agent 传 sessionId（完整 id、上表前缀或 "latest"）；平时不带 sessionId 会自动延续该 agent 最近一次会话。`,
          }]
        },
      },
      async execute(args) {
        const records = await sessionIndex.list(args.agentId)
        return {
          sessions: records.map(record => ({
            sessionId: record.sessionId,
            agentId: record.agentId,
            cwd: record.cwd,
            lastUsedAt: record.lastUsedAt,
          })),
        }
      },
    }),
  )

  /** 高保真备选：在外部终端（Terminal/iTerm2/Ghostty）里启动 agent 的 TUI。 */
  ctx.tools.register(
    defineTool({
      name: 'open_agent_in_external_terminal',
      description: 'Open a configured ACP agent\'s interactive CLI in a real terminal app (macOS Terminal, iTerm2 or Ghostty) at its working directory — native rendering and system fonts, unlike the embedded view. macOS only.',
      parameters: {
        agentId: { type: 'string', required: true, description: 'Agent id from list_acp_agents.' },
        terminal: { type: 'string', description: 'Target terminal app: "terminal" (default), "iterm" or "ghostty".' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            terminal: { type: 'string', required: true },
            command: { type: 'string', required: true },
            workingDirectory: { type: 'string', required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [
          { type: 'text', text: `已在 ${String(value.terminal)} 中启动：${String(value.command)}（工作目录 ${String(value.workingDirectory)}）` },
        ],
      },
      async execute(args) {
        const agent = resolveAgentConfig(args.agentId)
        if (!agent) {
          throw new Error(`No ACP agent configured${args.agentId ? ` with id "${args.agentId}"` : ''}. Call list_acp_agents to see what is configured.`)
        }
        const requested = typeof args.terminal === 'string' ? args.terminal : 'terminal'
        const terminal: ExternalTerminal = requested === 'iterm' || requested === 'ghostty' ? requested : 'terminal'
        // 外部终端跑交互式 TUI：裸命令，不带 ACP 的 --acp 参数。
        const tuiAgent: AgentConfig = { ...agent, args: [] }
        return await openInExternalTerminal(tuiAgent, terminal)
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
        // 子代理委派语义上是独立任务:强制全新会话,不续聊主对话。
        const outcome = await runAgentTurn(agent, request.prompt, { resume: false, track: false })
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

  // /znacp 斜杠命令：键盘直达通道。命令处理器与本插件闭包共享同一个 manager,
  // 所以 `/znacp <agentId> <prompt>` 不经模型决策直接驱动 ACP 会话。
  // 命令服务是可选组合:宿主没组 dsh-commands 时静默跳过。
  ctx.inject(['commands'], (commandCtx) => {
    interface AcpCommandInvocation {
      readonly rawInput: string
    }
    interface AcpCommandResult {
      kind: 'success' | 'error'
      text?: string
    }
    interface AcpCommandDefinition {
      /** 稳定定义标识(与官方命令生产方同构,可选)。 */
      readonly definitionId?: string
      /** composer 输入提示(可选)。 */
      readonly input?: { readonly hint?: string }
      readonly name: string
      readonly description: string
      readonly handler: (invocation: AcpCommandInvocation) => AcpCommandResult | Promise<AcpCommandResult>
    }
    interface CommandsLike {
      register(definition: AcpCommandDefinition): unknown
    }
    ;(commandCtx as Context & { commands: CommandsLike }).commands.register({
      name: ACP_COMMAND_NAME,
      description: 'ACP 智能体：/znacp 看用法；/znacp <agentId> <消息> 直接对话（自动延续上次会话）。',
      handler: async ({ rawInput }): Promise<AcpCommandResult> => {
        const input = rawInput.trim()
        const agents = config.agents.get()
        const usageBlock = [
          '用法：',
          `  /${ACP_COMMAND_NAME}                          查看本清单`,
          `  /${ACP_COMMAND_NAME} <agentId> <消息>         和该 agent 对话（自动延续它最近的会话）`,
          `  /${ACP_COMMAND_NAME} new <agentId> <消息>     强制开一个全新会话`,
          `  /${ACP_COMMAND_NAME} sessions                 查看历史会话（可续聊）`,
        ].join('\n')
        if (input === '') {
          if (agents.length === 0) {
            return { kind: 'success', text: `还没有配置 ACP agent。到 设置 → 插件 → 本插件 里添加,或在 cordis.patch.yml 的 config.agents 里配置。\n\n${usageBlock}` }
          }
          const defaultId = config.defaultAgent.get()
          const lines = agents.map((agent, index) => {
            const star = agent.id === defaultId ? '★' : `${index + 1}.`
            return `${star} ${agent.id} — ${agent.displayName}（${`${agent.command} ${agent.args.join(' ')}`.trimEnd()}）`
          })
          return {
            kind: 'success',
            text: `已配置 ${agents.length} 个 ACP agent（★ 为默认）：\n${lines.join('\n')}\n\n${usageBlock}`,
          }
        }

        // ---- 子命令:sessions / new ----
        if (input === 'sessions' || input.startsWith('sessions ')) {
          const records = await sessionIndex.list()
          if (records.length === 0) {
            return { kind: 'success', text: `还没有会话历史。用 /${ACP_COMMAND_NAME} <agentId> <消息> 对话一次,这里就会出现记录。` }
          }
          return {
            kind: 'success',
            text: `历史会话（新 → 旧）：\n${formatSessionLines(records)}\n\n续聊：/${ACP_COMMAND_NAME} <会话ID前缀> <消息>；不指定时默认自动延续该 agent 最近一次会话。`,
          }
        }
        const [first, ...rest] = input.split(/\s+/)
        const wantsFresh = first === 'new'
        const tokens = wantsFresh ? rest : [first, ...rest]
        const head = tokens[0] ?? ''
        const tail = tokens.slice(1).join(' ')

        // 第一个 token 依次尝试:agent id → 会话 id 前缀 → 都不命中则整段交给默认 agent。
        const agentMatch = agents.find(agent => agent.id === head)
        const sessionMatch = agentMatch ? undefined : (await sessionIndex.list()).find(record => record.sessionId.startsWith(head))
        const agent = agentMatch ?? resolveAgentConfig()
        const prompt = agentMatch || sessionMatch ? tail : input
        if (!agent) {
          return { kind: 'error', text: `找不到 ACP agent "${head}"。用 /${ACP_COMMAND_NAME} 查看清单。` }
        }
        if (prompt === '') {
          return { kind: 'error', text: `缺少消息内容。用法: /${ACP_COMMAND_NAME} ${agentMatch ? agent.id : '<agentId>'} <消息>` }
        }
        try {
          // 标注"延续/新会话":显式会话或自动延续都算延续;其余是新会话。
          const autoTarget = sessionMatch || wantsFresh
            ? undefined
            : (await sessionIndex.latestFor(agent.id, agent.workingDirectory))?.sessionId
          const outcome = await runAgentTurn(
            agent,
            prompt,
            sessionMatch
              ? { sessionId: sessionMatch.sessionId }
              : { ...(wantsFresh ? { resume: false } : {}) },
          )
          const mode = sessionMatch !== undefined || outcome.sessionId === autoTarget ? '延续会话' : '新会话'
          const footer = `\n\n（${agent.id} · ${mode} ${shortId(outcome.sessionId)}… · 想开新会话说 /${ACP_COMMAND_NAME} new ${agent.id} <消息>）`
          return { kind: 'success', text: `${outcome.agentText}${footer}` }
        } catch (error) {
          return { kind: 'error', text: `ACP 调用失败: ${error instanceof Error ? error.message : String(error)}` }
        }
      },
      // definitionId + input.hint 与官方命令生产方(dsh-plan-mode)同构:
      // definitionId 是稳定标识,composer 的命令目录靠 remote.commands.list 拉取。
      definitionId: 'dsh-plugin-zn-agent-client',
      input: { hint: '[<agentId>|new|sessions] <消息>' },
    })
  })

  ctx.emit('zn-agent-client/ready', { id: name })
}
