/**
 * 浏览器半边的 TypertRemote 客户端：把宿主 `znAgentClient/openExternal`
 * 挂到远端网关，供 CLI Agent 视图的「在外部终端打开」按钮调用。
 *
 * 实现是 first-party dsh-action-cards 的同款形态：
 * - RemoteInfo/NamedInput/ResultValue 从 dsh-typert-protocol 的 remote-info.js
 *   原样内联（无运行时依赖，zod 由调用方注入）；
 * - `zod` 在 ModuleLoader 沙箱里是外部模块（action-cards 亦如此），构建时
 *   保持 external；
 * - 宿主服务缺失/挂载失败时 opener 保持 undefined，按钮随之隐藏（特性探测）。
 * @module dsh-plugin-zn-agent-client/client/remote-external
 */

import * as zod from 'zod'

/* ---------- RemoteInfo（vendor 自 dsh-typert-protocol/lib/types/remote-info.js） ---------- */

interface RemoteParameterSpec {
  name: string
  wire?: string
  description?: string
  source: 'json' | 'lookup'
  lookup?: string
  acceptsUndefined?: boolean
  codec: RemoteCodecSpec
  strictCodec?: RemoteCodecSpec
}

interface RemoteCodecSpec {
  mode: 'strict'
  typeSymbol: string
  create: () => unknown
  jsonSchema: Record<string, unknown> | undefined
  jsonSchemaError?: string
}

interface RemoteResultSpec {
  mode: 'strict'
  typeSymbol: string
  create: () => unknown
  description?: string
  jsonSchema?: Record<string, unknown>
  jsonSchemaError?: string
}

interface RemoteMethodSpec {
  service: string
  description?: string
  invocation: { kind: 'direct' }
  cancellation?: unknown
  scope?: { context: string; wire: string }
  parameters: RemoteParameterSpec[]
  result: RemoteResultSpec
  sourceLocation?: { file: string; line: number; column: number }
}

interface RemoteSpec {
  package: string
  methods: Record<string, RemoteMethodSpec>
}

/* eslint-disable @typescript-eslint/no-explicit-any */
class NamedInput {
  parameters: RemoteParameterSpec[]
  strict: boolean
  zod: any
  schema?: unknown
  projection?: { jsonSchema?: unknown; jsonSchemaError?: string }

  constructor(parameters: RemoteParameterSpec[], strict: boolean, zod: any) {
    this.parameters = parameters
    this.strict = strict
    this.zod = zod
  }

  codec(parameter: RemoteParameterSpec): RemoteCodecSpec {
    const value = this.strict ? parameter.strictCodec : parameter.codec
    return value as RemoteCodecSpec
  }

  create = (): unknown => (this.schema ??= this.zod.strictObject(Object.fromEntries(this.parameters.map((parameter) => {
    const value = this.codec(parameter).create() as { optional(): unknown; nonoptional(): unknown }
    return [parameter.wire, isOptional(parameter) ? value.optional() : value.nonoptional()]
  }))))

  get jsonSchema(): unknown { return this.project().jsonSchema }
  get jsonSchemaError(): string | undefined { return this.project().jsonSchemaError }

  project(): { jsonSchema?: unknown; jsonSchemaError?: string } {
    if (this.projection !== undefined) return this.projection
    const unavailable = this.parameters.find((parameter) => this.codec(parameter).jsonSchema === undefined)
    if (unavailable !== undefined) {
      this.projection = { jsonSchemaError: this.codec(unavailable).jsonSchemaError ?? `No JSON Schema for parameter ${String(unavailable.wire)}` }
      return this.projection
    }
    this.projection = {
      jsonSchema: {
        type: 'object',
        properties: Object.fromEntries(this.parameters.map((parameter) => [parameter.wire, {
          ...this.codec(parameter).jsonSchema,
          ...(parameter.description === undefined ? {} : { description: parameter.description }),
        }])),
        required: this.parameters.filter((parameter) => !isOptional(parameter)).map((parameter) => parameter.wire),
        additionalProperties: false,
      },
    }
    return this.projection
  }
}

class ResultValue {
  spec: RemoteResultSpec
  projection?: { value?: unknown }

  constructor(spec: RemoteResultSpec) {
    this.spec = spec
  }

  get mode(): string { return this.spec.mode }
  get typeSymbol(): string { return this.spec.typeSymbol }
  get create(): () => unknown { return this.spec.create }
  get description(): string | undefined { return this.spec.description }
  get jsonSchemaError(): string | undefined { return this.spec.jsonSchemaError }

  get jsonSchema(): unknown {
    if (this.projection === undefined) {
      const schema = this.spec.jsonSchema
      this.projection = { value: schema === undefined ? undefined : { ...schema, description: this.spec.description } }
    }
    return this.projection.value
  }
}

function isOptional(parameter: RemoteParameterSpec): boolean {
  return parameter.source === 'json' && parameter.acceptsUndefined === true
}

class RemoteInfo {
  spec: RemoteSpec
  zod: any
  index?: { descriptors: unknown[]; methods: Record<string, unknown> }

  constructor(spec: RemoteSpec, zod: any) {
    this.spec = spec
    this.zod = zod
  }

  get package(): string { return this.spec.package }
  get descriptors(): unknown[] { return this.resolve().descriptors }
  get methods(): Record<string, unknown> { return this.resolve().methods }

  resolve(): { descriptors: unknown[]; methods: Record<string, unknown> } {
    if (this.index !== undefined) return this.index
    const zodRuntime = this.zod
    const descriptors: unknown[] = []
    const methods: Record<string, unknown> = Object.create(null)
    for (const [endpoint, definition] of Object.entries(this.spec.methods)) {
      const separator = endpoint.indexOf('/')
      const namespace = endpoint.slice(0, separator)
      const method = endpoint.slice(separator + 1)
      const parameters = definition.parameters.map((parameter) => ({ ...parameter, wire: parameter.wire ?? parameter.name }))
      const descriptor: Record<string, unknown> = {
        ...definition,
        id: `${this.spec.package}#${endpoint}`,
        namespace,
        method,
        parameters,
        result: definition.result.description === undefined ? definition.result : new ResultValue(definition.result),
      }
      if (definition.invocation.kind === 'direct') {
        const inputs: unknown[] = []
        methods[endpoint] = Object.assign(descriptor, {
          input(options?: { strict?: boolean }): unknown {
            const strict = options?.strict === true
            return inputs[strict ? 1 : 0] ??= new NamedInput(parameters, strict, zodRuntime)
          },
          invoke(remote: unknown, input: unknown, signal?: AbortSignal): unknown {
            const named = input as Record<string, unknown>
            const values = parameters.map((parameter) => named[parameter.wire as string])
            if (definition.cancellation !== undefined) values.push(signal)
            // Namespace access retains the Gateway's mount checks and scoped receiver policy.
            const receiver = Reflect.get(remote as object, namespace) as object
            const call = Reflect.get(receiver, method) as (...args: unknown[]) => unknown
            return call.apply(receiver, values)
          },
        })
      }
      descriptors.push(descriptor)
    }
    this.index = { descriptors, methods }
    return this.index
  }
}

function createTypertRemoteInfo(spec: RemoteSpec, zodRuntime: any): RemoteInfo {
  return new RemoteInfo(spec, zodRuntime)
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* ---------- 本插件的 spec：znAgentClient/openExternal ---------- */

export interface ExternalLaunchValue {
  readonly opened: boolean
  readonly terminal: string
  readonly command: string
  readonly workingDirectory: string
}

/** 一个懒 zod schema 工厂（与 loader 生成物同形）。 */
function lazy<T>(factory: () => T): () => T {
  let value: T | undefined
  return () => (value ??= factory())
}

const stringSchema = lazy(() => zod.z.string())
const terminalOrUndefinedSchema = lazy(() => zod.z.union([zod.z.undefined(), zod.z.literal('terminal'), zod.z.literal('iterm'), zod.z.literal('ghostty')]))
const resultSchema = lazy(() => zod.z.object({
  opened: zod.z.boolean().readonly(),
  terminal: zod.z.string().readonly(),
  command: zod.z.string().readonly(),
  workingDirectory: zod.z.string().readonly(),
}))

const TYPERT_REMOTE = createTypertRemoteInfo({
  package: 'dsh-plugin-zn-agent-client',
  methods: {
    'znAgentClient/openExternal': {
      service: 'znAgentClient',
      description: 'Open a configured CLI agent TUI in a native macOS terminal app.',
      invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [
        {
          name: 'agent',
          wire: 'agentId',
          description: 'live root resolved from the displayed session.',
          source: 'lookup',
          lookup: 'agent',
          codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', create: stringSchema, jsonSchema: { type: 'string' } },
          strictCodec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', create: stringSchema, jsonSchema: { type: 'string' } },
        },
        {
          name: 'agentKey',
          description: 'the agent id in this plugin\'s configuration.',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: 'dsh-plugin-zn-agent-client#agentKey', create: stringSchema, jsonSchema: { type: 'string' } },
          strictCodec: { mode: 'strict', typeSymbol: 'dsh-plugin-zn-agent-client#agentKey', create: stringSchema, jsonSchema: { type: 'string' } },
        },
        {
          name: 'terminal',
          description: 'target terminal app; defaults to Terminal.app.',
          source: 'json',
          acceptsUndefined: true,
          codec: { mode: 'strict', typeSymbol: 'dsh-plugin-zn-agent-client#terminal', create: terminalOrUndefinedSchema, jsonSchema: { type: 'string', enum: ['terminal', 'iterm', 'ghostty'] } },
          strictCodec: { mode: 'strict', typeSymbol: 'dsh-plugin-zn-agent-client#terminal', create: terminalOrUndefinedSchema, jsonSchema: { type: 'string', enum: ['terminal', 'iterm', 'ghostty'] } },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-plugin-zn-agent-client#ExternalLaunchResult',
        create: resultSchema,
        description: 'the launched terminal, command line, and working directory.',
        jsonSchema: {
          type: 'object',
          properties: { opened: { type: 'boolean' }, terminal: { type: 'string' }, command: { type: 'string' }, workingDirectory: { type: 'string' } },
          required: ['opened', 'terminal', 'command', 'workingDirectory'],
          additionalProperties: true,
        },
      },
      sourceLocation: { file: 'src/acp/remote-service.ts', line: 88, column: 2 },
    },
  },
}, zod.z)

/* ---------- 挂载 + 特性探测 ---------- */

/** 远端命名空间面（挂载成功后由网关注入 `remote.znAgentClient`）。 */
interface ZnAgentNamespaceFace {
  openExternal(sessionId: string, agentKey: string, terminal?: 'terminal' | 'iterm' | 'ghostty'): Promise<{ ok: boolean; value?: ExternalLaunchValue }>
}

/** UI 调用的稳定入口；undefined = 远端不可用（按钮应隐藏）。 */
export type ExternalOpener = (sessionId: string, agentKey: string, terminal?: 'terminal' | 'iterm' | 'ghostty') => Promise<ExternalLaunchValue | undefined>

let opener: ExternalOpener | undefined

/** 取当前 opener（未挂载成功时为 undefined）。 */
export function getExternalOpener(): ExternalOpener | undefined {
  return opener
}

interface RemoteHostFace {
  remote: {
    $mount(contribution: unknown): Promise<unknown>
    [namespace: string]: unknown
  }
}

interface InjectFaceLike {
  inject(services: readonly string[], fn: (inner: unknown) => unknown): { dispose(): Promise<void> | void }
}

/**
 * 把贡献挂上网关，并捕获命名空间代理供 UI 调用。
 * 失败安静降级：opener 保持 undefined，按钮隐藏。
 */
export async function mountExternalLauncher(ctx: unknown): Promise<void> {
  const host = ctx as RemoteHostFace & InjectFaceLike
  try {
    await host.remote.$mount(TYPERT_REMOTE)
  } catch {
    return
  }
  try {
    host.inject(['remote.znAgentClient'], (inner) => {
      const namespace = (inner as { remote: { znAgentClient?: ZnAgentNamespaceFace } }).remote?.znAgentClient
      if (namespace === undefined || typeof namespace.openExternal !== 'function') return
      opener = async (sessionId, agentKey, terminal) => {
        try {
          const result = await namespace.openExternal(sessionId, agentKey, terminal)
          return result.ok ? result.value : undefined
        } catch {
          return undefined
        }
      }
    })
  } catch {
    opener = undefined
  }
}
