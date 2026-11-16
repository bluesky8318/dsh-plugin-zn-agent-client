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
  inject() {}, // commands 服务未组合，/acp 命令注册会被跳过
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

// 4) 会话续聊：把上一轮的 sessionId 传回去，agent 侧应恢复同一会话上下文。
//    先让它记住一个词，再用 sessionId 新一轮问回来——能答上说明会话真的恢复了。
const remember = await tool.execute(
  { agentId: 'qoder', prompt: 'Remember this codeword: ZNAC-7391. Reply with exactly: OK' },
  { signal: controller.signal },
)
console.log('remember:', JSON.stringify(remember))
assert.match(remember.response.trim(), /OK/)

const resume = await tool.execute(
  { agentId: 'qoder', sessionId: remember.sessionId, prompt: 'What codeword did I give you? Reply with exactly that codeword and nothing else.' },
  { signal: controller.signal },
)
console.log('resume:', JSON.stringify(resume))
assert.match(resume.response.trim(), /ZNAC-7391/, 'resumed session should recall the codeword')

// 5) 会话索引记录了句柄
const sessions = await registeredTools.find(t => t.name === 'list_acp_sessions').execute({})
console.log('sessions:', JSON.stringify(sessions))
assert.ok(sessions.sessions.some(s => s.sessionId === remember.sessionId), 'session index should record the handle')

// 6) 真正的 resume：全新插件实例（新 agent 进程），拿旧 sessionId 续聊。
//    新进程内存里没有会话，能答出 codeword 只可能走 session/load。
const tools2 = []
const ctx2 = {
  tools: { register(d) { tools2.push(d); return () => {} } },
  subagents: { registerProvider() { return () => {} } },
  inject() {},
  on() { return () => {} },
  effect() { return () => {} },
  emit() {},
}
apply(ctx2, config)
const tool2 = tools2.find(t => t.name === 'call_acp_agent')
const resumed2 = await tool2.execute(
  { agentId: 'qoder', sessionId: remember.sessionId, prompt: 'What codeword did I give you earlier in this session? Reply with exactly that codeword and nothing else.' },
  { signal: new AbortController().signal },
)
console.log('resume(fresh instance):', JSON.stringify(resumed2))
assert.match(resumed2.response.trim(), /ZNAC-7391/, 'fresh instance should resume the session via session/load')

console.log('e2e qoder ok')
process.exit(0)
