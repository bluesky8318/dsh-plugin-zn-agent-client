# dsh-plugin-zn-agent-client 设计方案

## 目标
为 DeepSeek Harness (DSH) 增加通过 **Agent Client Protocol (ACP)** 调用本机其他 CLI Agent 的能力。
- 让 DSH 成为 ACP **Client**，通过 stdio 与本地 ACP Agent 通信
- 支持 Claude Code (`claude-agent-acp`)、Codex (`codex-acp`)、Gemini CLI (`gemini --experimental-acp`)、opencode (`opencode acp`) 等
- 复用 obsidian-agent-client 的成熟 ACP 实现架构
- 适配 DSH 的插件机制、工具系统、会话模型、UI 扩展点

---

## 1. 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                         DeepSeek Harness                        │
├─────────────────────────────────────────────────────────────────┤
│  dsh-plugin-zn-agent-client                                     │
│  ├── Host Half (Node/Electron)                                  │
│  │   ├── Plugin Entry (src/index.ts)                            │
│  │   │   ├── Config: agents[], defaultAgent, autoAllow, ...    │
│  │   │   ├── register tool: `call_acp_agent`                   │
│  │   │   ├── register tool: `list_acp_agents`                  │
│  │   │   ├── subagent provider: `acp` (implements SubagentProvider) │
│  │   │   └── session projections for agent state               │
│  │   │                                                          │
│  │   ├── ACP Client Manager (src/acp/client-manager.ts)        │
│  │   │   ├── spawn/manage ACP agent processes                  │
│  │   │   ├── NDJSON transport over stdio                       │
│  │   │   ├── session lifecycle (new/load/resume/fork/close)   │
│  │   │   ├── permission request handling (via tools/pre-execute)│
│  │   │   ├── terminal operations (create/output/wait/kill)     │
│  │   │   └── stderr rolling buffer for silent-failure detection│
│  │   │                                                          │
│  │   ├── Type Converter (src/acp/type-converter.ts)            │
│  │   │   ├── ACP ContentBlock ↔ DSH ContentBlock               │
│  │   │   ├── ACP SessionUpdate → DSH session events            │
│  │   │   ├── ACP ToolCall → DSH tool calls                     │
│  │   │   └── ACP ConfigOptions → DSH model config             │
│  │   │                                                          │
│  │   ├── Permission Manager (src/acp/permission-manager.ts)    │
│  │   │   ├── queue + auto-allow                                │
│  │   │   ├── emits tool_call with permissionRequest            │
│  │   │   └── resolves via respond(optionId)                    │
│  │   │                                                          │
│  │   └── Terminal Manager (src/acp/terminal-manager.ts)        │
│  │       └── manages ACP terminal operations                    │
│  │                                                             │
│  ├── Client Half (Browser)                                      │
│  │   ├── Config Form (src/client/config-form.tsx)              │
│  │   │   ├── agent list with add/edit/remove                   │
│  │   │   ├── per-agent: id, displayName, command, args, env,  │
│  │   │   │   workingDirectory, apiKey (secretId + envVarName)  │
│  │   │   ├── global: defaultAgent, autoAllowPermissions        │
│  │   │   └── windowsWslMode, wslDistribution, nodePath         │
│  │   ├── Sidebar Panel (src/client/sidebar-panel.tsx)          │
│  │   │   ├── agent selector + new session button               │
│  │   │   ├── session history list                               │
│  │   │   └── quick actions                                      │
│  │   ├── Input Dock (src/client/input-dock.tsx)                │
│  │   │   ├── shows current agent + session status              │
│  │   │   └── mode selector                                     │
│  │   └── Chat Rows for tool calls, permissions, terminal      │
│  │                                                             │
│  └── Shared Types (src/types/*.ts)                             │
│       ├── AgentConfig, SessionResult, SessionUpdate, ...       │
│       └── DSH integration types                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. 核心组件设计

### 2.1 Host Half - Plugin Entry (`src/index.ts`)

```typescript
export const name = 'dsh-plugin-zn-agent-client'
export const inject = ['tools', 'subagents', 'sessionProjections', 'configForms', 'slots', 'locale']

export interface Config {
  agents: Volatile<AgentConfig[]>
  defaultAgent: Volatile<string>
  autoAllowPermissions: Volatile<boolean>
  windowsWslMode: Volatile<boolean>
  wslDistribution: Volatile<string>
  nodePath: Volatile<string>
}

export const Config = Schema.object({
  agents: Schema.array(AgentConfigSchema).default([]).volatile(),
  defaultAgent: Schema.string().default('').volatile(),
  autoAllowPermissions: Schema.boolean().default(false).volatile(),
  windowsWslMode: Schema.boolean().default(false).volatile(),
  wslDistribution: Schema.string().default('').volatile(),
  nodePath: Schema.string().default('').volatile(),
})
```

**注册内容：**
1. **Tool: `call_acp_agent`** - 统一入口，model 可调用任意 ACP agent
   - 参数：`agentId` (string), `prompt` (ContentBlock[]), `sessionId?` (string), `mode?` (string)
   - 内部通过 ACP Client Manager 发送 `session/prompt`，流式返回 `agent_message_chunk`
   - 权限请求通过 `tools/pre-execute` waterfall 处理（见 2.4）

2. **Tool: `list_acp_agents`** - 列出已配置的 agents

3. **SubagentProvider: `acp`** - 实现 `SubagentProvider` 接口
   - `name: 'acp'`
   - `capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: false }`
   - `inheritsParentContext: false` (ACP agent 是独立进程)
   - `start(request)` → spawn agent process, return `SubagentRun`
   - 用于 `dsh-tool-subagent` 的 delegation

4. **Session Projection** - 维护当前 session 的 agent 状态
   - `currentAgentId`, `currentSessionId`, `mode`, `availableCommands`, `usage`

5. **Config Form 注册** - 通过 `configForms` service

6. **UI Slots 注册** - sidebar, input-dock, chat rows

### 2.2 ACP Client Manager (`src/acp/client-manager.ts`)

**参考：obsidian-agent-client `src/acp/acp-client.ts`**

核心职责：
- **进程管理**：spawn, kill tree (Unix `process.kill(-pid, 'SIGTERM')`, Windows `taskkill /T`)
- **NDJSON 传输**：`acp.ndJsonStream(input, output)` over stdio
- **ACP 握手**：`initialize` → `session/new|load|resume|fork`
- **会话生命周期**：
  - `newSession(cwd)` → `session/new {cwd, mcpServers: []}`
  - `loadSession(sessionId, cwd)` → `session/load`
  - `resumeSession(sessionId, cwd)` → `session/resume`
  - `forkSession(sessionId, cwd)` → `session/fork`
  - `listSessions(cwd?, cursor?)` → `session/list`
  - `closeSession(sessionId)` → `session/close`
  - `setConfigOption(sessionId, configId, value)` → `session/set_config_option`
  - `setMode(sessionId, modeId)` → `session/set_mode` (deprecated)
- **Prompt 发送**：`sendPrompt(sessionId, content)` → `session/prompt`
  - 支持流式 `agent_message_chunk` / `agent_thought_chunk`
  - **Silent failure detection**：若 `end_turn` 且无 updates，等待 100ms 检查 stderr 后抛错
- **取消**：`cancel(sessionId)` → `session/cancel` notification
- **权限请求**：通过 `onRequest('session/request_permission', ...)` 注册处理器
- **终端操作**：`terminal/create/output/wait/kill/release`
- **Stderr 滚动缓冲**：8KB 上限，截取后 4KB

**AgentConfig（对应 obsidian 的 AgentConfig）：**
```typescript
interface AgentConfig {
  id: string                    // stable id, e.g. "claude-code-acp"
  displayName: string           // "Claude Code"
  command: string               // "claude-agent-acp"
  args: string[]                // []
  env?: Record<string, string>  // additional env vars
  workingDirectory: string      // default: process.cwd()
  apiKey?: {                    // optional, for API-key auth agents
    secretId: string            // DSH secret storage key
    envVarName: string          // e.g. "ANTHROPIC_API_KEY"
  }
}
```

### 2.3 Type Converter (`src/acp/type-converter.ts`)

**参考：obsidian-agent-client `src/acp/type-converter.ts`**

```typescript
// ACP ContentBlock → DSH ContentBlock
static toDshContentBlock(acp: acp.ContentBlock): ContentBlock
static toAcpContentBlock(dsh: ContentBlock): acp.ContentBlock

// ACP SessionUpdate → DSH SessionUpdate (internal event)
static toSessionUpdate(params: acp.SessionNotification): SessionUpdate

// ACP ToolCallContent → DSH ToolCallContent
static toToolCallContent(acp: acp.ToolCallContent[]): ToolCallContent[]

// ACP SlashCommand → DSH SlashCommand
static toSlashCommands(acp: acp.AvailableCommand[]): SlashCommand[]

// ACP SessionConfigOption → DSH ConfigOption
static toSessionConfigOptions(acp: acp.SessionConfigOption[]): ConfigOption[]

// ACP InitializeResult → DSH AgentInfo
static toInitializeResult(acp: acp.InitializeResult): InitializeResult

// ACP SessionResponse → DSH SessionResult
static toSessionResult(sessionId: string, acp: AcpSessionResponse): SessionResult
```

### 2.4 Permission Manager (`src/acp/permission-manager.ts`)

**参考：obsidian-agent-client `src/acp/permission-handler.ts`**

**DSH 适配点**：DSH 没有 Obsidian 那样的独立 UI 队列，权限请求通过 `tools/pre-execute` waterfall 处理。

```typescript
class PermissionManager {
  private pendingRequests = new Map<string, {
    resolve: (outcome: 'selected' | 'cancelled', optionId?: string) => void
    toolCallId: string
    sessionId: string
    options: PermissionOption[]
  }>
  private requestQueue: string[] = []  // requestIds, first = active
  private autoAllow = false

  // Called by ACP handler when agent requests permission
  async handleRequest(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    if (this.autoAllow) {
      const opt = params.options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always') ?? params.options[0]
      return { outcome: { outcome: 'selected', optionId: opt.optionId } }
    }

    const requestId = crypto.randomUUID()
    const toolCallId = params.toolCall?.toolCallId ?? crypto.randomUUID()
    
    // Store pending request
    this.pendingRequests.set(requestId, { ... })
    this.requestQueue.push(requestId)
    
    // Emit session update for UI (tool_call with permissionRequest)
    this.emitSessionUpdate({
      type: 'tool_call',
      sessionId: params.sessionId,
      toolCallId,
      title: 'Permission Request',
      status: 'pending',
      permissionRequest: { requestId, options: normalizedOptions, isActive: this.requestQueue.length === 1 }
    })

    // Return a promise that resolves when user responds via tool
    return new Promise((resolve) => {
      this.pendingRequests.get(requestId).resolve = resolve
    })
  }

  // Called by DSH tool `respond_acp_permission`
  respond(requestId: string, optionId: string) { ... }
  cancelAll() { ... }
}
```

**DSH Tool: `respond_acp_permission`**
- 参数：`requestId` (string), `optionId` (string)
- 仅在 permission request pending 时可用
- 通过 PermissionManager 解析 pending promise

### 2.5 Terminal Manager (`src/acp/terminal-manager.ts`)

**参考：obsidian-agent-client `src/acp/terminal-handler.ts`**

管理 ACP terminal 操作：
- `createTerminal(params)` → 返回 `terminalId`
- `getOutput(terminalId)` → `{ output, exited, exitCode? }`
- `waitForExit(terminalId)` → Promise resolves on exit
- `killTerminal(terminalId)` → boolean
- `releaseTerminal(terminalId)` → boolean (清理资源)

---

## 3. Client Half (Browser UI)

### 3.1 Config Form (`src/client/config-form.tsx`)

**Slot**: `plugins.bundle.config` (keyed by package name)

字段：
- **Agents 列表** (可增删改)：
  - `id` (string, required, unique)
  - `displayName` (string, required)
  - `command` (string, required)
  - `args` (string[], 可选)
  - `env` (key-value pairs, 可选)
  - `workingDirectory` (string, 可选，默认 workspace root)
  - `apiKey` (object, 可选):
    - `secretId` (string, DSH secret storage)
    - `envVarName` (string, e.g. "ANTHROPIC_API_KEY")
- **全局设置**：
  - `defaultAgent` (select from agents)
  - `autoAllowPermissions` (boolean)
  - `windowsWslMode` (boolean)
  - `wslDistribution` (string)
  - `nodePath` (string, absolute path to node dir)

### 3.2 Sidebar Panel (`src/client/sidebar-panel.tsx`)

**Slot**: `sidebar.footer.action` + `sidebar.panel` (如果有)

内容：
- 当前 agent 选择器 (dropdown)
- "New Session" 按钮
- 会话历史列表 (来自 `listSessions`)
- 快速切换 mode

### 3.3 Input Dock (`src/client/input-dock.tsx`)

**Slot**: `conversation.input.dock`

显示：
- 当前 agent 名称 + 状态 (connected/disconnected)
- 当前 session ID (短)
- Mode 选择器 (如果 agent 支持 modes)

### 3.4 Chat Rows

**Slot**: `conversation.chat.node` (keyed by event kind)

注册事件类型：
- `acp_tool_call` - 工具调用显示 (含 permission request)
- `acp_tool_call_update` - 工具调用更新
- `acp_agent_message_chunk` - agent 消息流式 chunk
- `acp_terminal` - 终端输出
- `acp_plan` - 计划更新
- `acp_usage` - token usage

---

## 4. 配置与部署

### 4.1 `cordis.patch.yml`

```yaml
- id: dsh-plugin-zn-agent-client
  name: dsh-plugin-zn-agent-client
  config:
    agents: []
    defaultAgent: ''
    autoAllowPermissions: false
    windowsWslMode: false
    wslDistribution: ''
    nodePath: ''
```

### 4.2 `package.json` 关键字段

```json
{
  "name": "dsh-plugin-zn-agent-client",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./service": { "types": "./lib/service.d.ts", "default": "./lib/service.js" },
    "./client": { "types": "./lib/client.d.ts", "default": "./lib/client.js" },
    "./locale/*.json": "./locale/*.json",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": [
    "lib",
    "locale",
    "cordis.patch.yml",
    "icon.svg"
  ],
  "dsh.bundle.patch": "./cordis.patch.yml",
  "dsh.client.platform": "web",
  "dsh.client.inject": ["@deepseek-ai/dsh-client-ui-plugin-manager"],
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.1.0",
    "@deepseek-ai/dsh-tools": "0.2.2-rc.3"
  },
  "dependencies": {
    "@agentclientprotocol/sdk": "^1.4.0",
    "@deepseek-ai/schemastery": "~3.19.0"
  }
}
```

### 4.3 `tsdown.config.ts` (参考 template)

- Host: entries `src/index.ts`, `src/service.ts`, `src/acp/*.ts` → `lib/` ESM, dts
- Client: entry `src/client/index.ts` → `lib/client.js` CJS, browser, with `__ModuleLoader__.load` wrapper

---

## 5. 依赖关系与版本对齐

| 依赖 | 版本 | 说明 |
|------|------|------|
| `@agentclientprotocol/sdk` | ^1.4.0 | ACP 协议核心，DSH 内置同版本 |
| `@deepseek-ai/cordis` | ~4.1.0 | DSH 核心框架，当前运行时 4.1.0 |
| `@deepseek-ai/dsh-tools` | 0.2.2-rc.3 | 工具定义，当前运行时版本 |
| `@deepseek-ai/schemastery` | ~3.19.0 | Schema 定义，当前运行时版本 |
| `@deepseek-ai/dsh-subagent` | 0.2.2-rc.3 | Subagent seam，provider 接口 |
| `@deepseek-ai/dsh-agent` | 0.2.2-rc.3 | Agent 类型 |
| `@deepseek-ai/dsh-session` | 0.2.2-rc.3 | Session 类型 |
| `@deepseek-ai/dsh-llm` | 0.2.2-rc.3 | ContentBlock, MessageId 等 |

**注意**：template 使用的 `dsh-tools@0.1.7-rc.2` 与运行时 `0.2.2-rc.3` 有差异，必须对齐到运行时版本。

---

## 6. 本机测试计划

### 6.1 单元测试 (vitest, node env)
- Config schema 验证
- Type converter 双向转换
- Permission manager 队列逻辑
- Terminal manager 状态机
- Session projection 事件折叠

### 6.2 集成测试 (smoke test)
- 构建后加载到 DSH desktop profile
- 配置 claude-agent-acp
- 调用 `call_acp_agent` 发送 "Reply PONG"，验证返回
- 测试权限请求流程 (autoAllow=false)
- 测试 session new/load/resume
- 测试 terminal create/output

### 6.3 端到端验证
- DSH Web UI: 配置表单保存生效
- Sidebar panel 显示 agent 列表
- Input dock 显示当前 agent/session
- Chat rows 渲染 tool calls, permissions, terminal output

---

## 7. 实现里程碑

| 阶段 | 交付物 | 预估工作量 |
|------|--------|------------|
| M1: Scaffold | package.json, tsdown, cordis.patch.yml, 基础类型, Config schema | 0.5 天 |
| M2: Host Core | ACP Client Manager, Type Converter, Permission Manager, Terminal Manager | 2 天 |
| M3: DSH Integration | Plugin entry, tools 注册, SubagentProvider, session projection | 1.5 天 |
| M4: Client UI | Config Form, Sidebar, Input Dock, Chat Rows | 1.5 天 |
| M5: Testing & Polish | 单测、集成测、E2E 验证、文档、图标 | 1 天 |
| **总计** | **完整可用插件** | **~6.5 天** |

---

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| ACP SDK 版本不匹配 | 协议不兼容 | 对齐 DSH 内置 `@agentclientprotocol/sdk@1.4.0` |
| Windows 进程树 kill 失败 | 残留进程 | 复用 obsidian 成熟的 `taskkill /T` 方案 |
| 权限 UI 与 DSH 工作流冲突 | 卡死或漏响应 | 通过 `tools/pre-execute` waterfall 统一处理 |
| Client bundle 过大 | 加载慢 | 仅 external react，其余 noExternal，tree-shaking |
| Secret storage 集成 | API key 泄露或丢失 | 使用 DSH 现有 secret storage service（需确认可用性） |

---

## 9. 后续扩展

- 支持更多 ACP agent (kiro, hermes, pi, grok, bob, antigravity 等)
- MCP server 集成 (通过 ACP 的 `mcpServers` 参数)
- Agent marketplace / 一键安装预设
- 会话导出/导入 (参考 obsidian `chat-exporter.ts`)
- 多 agent 并行编排 (通过 `ctx.subagents` + `dsh-tool-subagent`)

---

**文档版本**: v0.1 (设计草案)
**状态**: 待用户确认后实施

---

## 实施状态（as-built，2026-11-16）

以上方案已落地为 v0.1.0，与设计的差异：

- **会话投影 / configForms 注册**：首版只保留 `inject = ['tools', 'subagents']`；
  session projection 与客户端配置表单留到后续里程碑（客户端半边目前是
  sidebar 状态钮 + shell overlay 的最小表面）。
- **权限**：`autoAllowPermissions` 自动放行；人工确认暂通过管理器队列 +
  诊断事件暴露，`respond_acp_permission` 工具未注册（后续里程碑）。
- **Secret**：`getSecret` 目前返回 null（TODO 接宿主 secret 存储）；空值跳过
  注入的行为已实现。
- **终端**：terminal/* 请求由 TerminalManager 状态机应答，但尚未真正 spawn
  PTY 进程（占位实现，返回空输出）。
- **已验证**：`pnpm typecheck` 干净；vitest 20 用例通过；`test/smoke.mjs`
  构建产物冒烟通过；`test/e2e-acp.mjs` 对接真实 `claude-agent-acp`
  （0.107.2，protocol v1）端到端返回 `PONG`，usage `{inputTokens:9734,
  outputTokens:3,totalTokens:9737}`。
