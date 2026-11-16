// E2E：用构建产物驱动完整插件路径，对接真实的 claude-agent-acp。
//
// 运行方式：先 `pnpm build`，再 `node test/e2e-acp.mjs`。
// 前置：`npm install -g @agentclientprotocol/claude-agent-acp@latest`（或本地 bin 可用）。
// 断言：call_acp_agent 返回 agent 文本 `PONG`，会话 id 与 usage 齐全。
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const registeredTools = []
const providers = []
const ctx = {
  tools: { register(d) { registeredTools.push(d); return () => {} } },
  subagents: { registerProvider(p) { providers.push(p); return () => {} } },
  on() { return () => {} },
  effect() { return () => {} },
  emit(event, payload) { console.log(`[event] ${event}`, JSON.stringify(payload)) },
}

const config = {
  agents: {
    get: () => [
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        command: 'claude-agent-acp',
        args: [],
        env: {},
        workingDirectory: '/tmp/acpprobe',
      },
    ],
  },
  defaultAgent: { get: () => 'claude-code' },
  autoAllowPermissions: { get: () => true },
  logEvents: { get: () => true },
}

apply(ctx, config)

const tool = registeredTools.find(t => t.name === 'call_acp_agent')
assert.ok(tool, 'call_acp_agent registered')

const controller = new AbortController()
const result = await tool.execute(
  { agentId: 'claude-code', prompt: 'Reply with exactly: PONG' },
  { signal: controller.signal },
)

console.log('E2E result:', JSON.stringify(result, null, 2))

assert.equal(typeof result.response, 'string')
assert.match(result.response.trim(), /PONG/, 'agent should reply PONG')
assert.equal(result.agentId, 'claude-code')
assert.ok(result.sessionId, 'session id should be present')
assert.ok(result.stopReason === 'end_turn' || result.stopReason === undefined)

console.log('e2e ok')
process.exit(0)
