// E2E（qodercli）：用构建产物驱动完整插件路径，对接真实的 qodercli --acp。
//
// 运行方式：先 `pnpm build`，再 `node test/e2e-qoder.mjs`。
// 前置：qodercli 已安装并登录（`qodercli login`）；ACP 入口是隐藏 flag `--acp`。
// 断言：call_acp_agent 返回 agent 文本 `PONG`。
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
        id: 'qoder',
        displayName: 'Qoder CLI',
        command: 'qodercli',
        args: ['--acp'],
        env: {},
        workingDirectory: '/tmp/acpprobe',
      },
    ],
  },
  defaultAgent: { get: () => 'qoder' },
  autoAllowPermissions: { get: () => true },
  logEvents: { get: () => true },
}

apply(ctx, config)

// 1) list_acp_agents 能看到 qoder
const listTool = registeredTools.find(t => t.name === 'list_acp_agents')
const listed = await listTool.execute({})
console.log('list:', JSON.stringify(listed))
assert.deepEqual(listed, { agents: [{ id: 'qoder', displayName: 'Qoder CLI', command: 'qodercli' }] })

// 2) call_acp_agent 走真实 ACP 往返
const tool = registeredTools.find(t => t.name === 'call_acp_agent')
assert.ok(tool, 'call_acp_agent registered')

const controller = new AbortController()
const result = await tool.execute(
  { agentId: 'qoder', prompt: 'Reply with exactly: PONG' },
  { signal: controller.signal },
)

console.log('E2E result:', JSON.stringify(result, null, 2))

assert.equal(typeof result.response, 'string')
assert.match(result.response.trim(), /PONG/, 'agent should reply PONG')
assert.equal(result.agentId, 'qoder')
assert.ok(result.sessionId, 'session id should be present')

// 3) 子代理提供方同一条链路
const run = await providers[0].start({
  cwd: '/tmp/acpprobe',
  prompt: [{ type: 'text', text: 'Reply with exactly: PONG' }],
  parent: {},
  signal: controller.signal,
  label: 'e2e-qoder-subagent',
})
const sub = await run.result
console.log('subagent:', JSON.stringify({ stopReason: sub.stopReason, output: sub.output }))
assert.equal(sub.stopReason, 'completed')
assert.match(sub.output[0].text.trim(), /PONG/)

console.log('e2e qoder ok')
process.exit(0)
