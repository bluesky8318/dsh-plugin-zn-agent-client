/**
 * 宿主侧 TypertRemote 服务：把「在外部终端打开」暴露给浏览器半边。
 *
 * DSH 的 client→host 通道是 TypertRemote（dsh-api-remotes 网关）。网关发现
 * 宿主方法有两条路：严格描述符（`typert.register`，编译器生成的 schema，依赖
 * dsh-typert-protocol）与 SRC 反射（读 ctx.reflect.props 里的 Service 实例：
 * `typertRemote` 绑定 + 原型上的 `@deepseek-ai/dsh-typert-protocol/remote-methods`
 * 标记 + 未压缩的参数名）。我们走 SRC 路——三个要件都能手工构造，不需要新增
 * dsh-typert-protocol 依赖（参照 first-party dsh-action-cards 的打包形态）。
 *
 * 参数约定（SRC 模式）：
 * - 参数名恰为 `agent` 的参数经全局 `agent` lookup 自动解析（wire `agentId`，
 *   即当前会话的 live Agent）；其余 json 参数的 wire 不得撞 `agentId`。
 * - 末位可选 `signal` 参数 = 取消语义，必须是最后一个参数。
 * - 返回值走 src-json 直通，必须是可 JSON 序列化的普通对象。
 * @module dsh-plugin-zn-agent-client/acp/remote-service
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { openInExternalTerminal, type ExternalTerminal, type ExternalLaunchResult } from '../external-terminal.ts'
import type { AgentConfig } from '../types/index.ts'

/** typert-protocol 在服务原型上存 @Remote 标记的属性键（plain string key）。 */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** 会话目录解析面（宿主 workingDirectory 服务；缺失时安静降级）。 */
interface WorkingDirectoryFace {
  /** 同步取会话当前工作目录；未知会话给 undefined。 */
  get(sessionId: unknown): string | undefined
}

/** openExternal 的返回（src-json 直通对象）。 */
export interface OpenExternalResult {
  readonly opened: boolean
  readonly terminal: ExternalTerminal
  readonly command: string
  readonly workingDirectory: string
}

/** agent 配置解析器（apply 闭包注入，复用插件现有解析规则）。 */
export type AgentConfigResolver = (agentKey?: string) => AgentConfig | undefined

/**
 * `znAgentClient` 远端：浏览器半边唯一可见的宿主面。
 *
 * 有意保持极小——只暴露「在外部终端打开」这一个动作。
 */
export class ZnAgentClientRemote extends Service {
  /** typert-protocol 的 Remote 绑定（网关 collectSrcClaims 靠它发现本服务）。 */
  typertRemote: { readonly service: ZnAgentClientRemote; readonly serviceKey: string; readonly namespace: string }

  private readonly resolveAgent: AgentConfigResolver
  private readonly workingDirectory: WorkingDirectoryFace | undefined

  constructor(ctx: Context, resolveAgent: AgentConfigResolver, workingDirectory?: WorkingDirectoryFace) {
    super(ctx, 'znAgentClient')
    // bindTypertRemote 的等价物：frozen 绑定对象（service/serviceKey/namespace）。
    this.typertRemote = Object.freeze({ service: this, serviceKey: this.name, namespace: 'znAgentClient' })
    // @Remote 装饰器的等价物：直接在原型上写标记描述符。
    Object.defineProperty(Object.getPrototypeOf(this), REMOTE_METHOD_DESCRIPTOR, {
      configurable: true,
      value: Object.freeze({
        version: 1,
        methods: Object.freeze([
          Object.freeze({ method: 'openExternal', invocation: Object.freeze({ kind: 'direct' as const }) }),
        ]),
      }),
    })
    this.resolveAgent = resolveAgent
    this.workingDirectory = workingDirectory
  }

  /**
   * 在外部终端里打开一个已配置的 CLI agent（裸 TUI，不带 --acp）。
   * 工作目录优先用会话目录（agent lookup 拿到的 live Agent），退回 agent 配置值。
   * @param agent - 会话 lookup 注入的 live Agent（运行期对象，不依赖具体类型）。
   * @param agentKey - 插件配置里的 agent id。
   * @param terminal - 目标终端应用；缺省 Terminal.app。
   * @param signal - 网关注入的取消信号（遵守 SRC 末位约定）。
   */
  openExternal(agent: unknown, agentKey: string, terminal?: ExternalTerminal, signal?: AbortSignal): Promise<OpenExternalResult> {
    void signal
    const config = this.resolveAgent(agentKey)
    if (config === undefined) {
      return Promise.reject(new Error(`Unknown ACP agent: ${agentKey}`))
    }
    const cwd = this.sessionWorkingDirectory(agent) ?? config.workingDirectory
    return openInExternalTerminal(config, terminal ?? 'terminal', cwd || undefined).then((result) => ({ ...result, opened: true }))
  }

  /** 从 live Agent 上摸会话目录；摸不到就 undefined（调用方退回配置值）。 */
  private sessionWorkingDirectory(agent: unknown): string | undefined {
    const wd = this.workingDirectory
    if (wd === undefined) return undefined
    const session = (agent as { session?: unknown } | null | undefined)?.session
    if (session === undefined || session === null) return undefined
    try {
      return wd.get(session)
    } catch {
      return undefined
    }
  }
}

/** 便捷工厂：创建服务实例（在 apply 里于 ctx.effect 内调用）。 */
export function createZnAgentClientRemote(
  ctx: Context,
  resolveAgent: AgentConfigResolver,
  workingDirectory?: WorkingDirectoryFace,
): ZnAgentClientRemote {
  return new ZnAgentClientRemote(ctx, resolveAgent, workingDirectory)
}

/** 导出类型供 index.ts 复用。 */
export type { ExternalLaunchResult }
