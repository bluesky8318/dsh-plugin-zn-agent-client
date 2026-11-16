// 构建产物上的冒烟测试：验证 list_acp_agents / call_acp_agent 两个工具已注册、
// acp 子代理提供方已注册、工具能按当前配置读到 agent 清单。
//
// 运行方式：先 `pnpm build`，再 `node test/smoke.mjs`。
//
// 覆盖的是构建产物，不是源码；浏览器半边（lib/client.js）需要真实 DOM 与
// 插槽宿主，不在这里测。
import assert from 'node:assert/strict'
import { apply, inject, name } from '../lib/index.js'

const registeredTools = []
const registeredProviders = []
const registeredCommands = []
const emitted = []
const ctx = {
  tools: {
    register(definition) {
      registeredTools.push(definition)
      return () => {}
    },
  },
  subagents: {
    registerProvider(provider) {
      registeredProviders.push(provider)
      return () => {}
    },
  },
  // 可选服务的组合点：本插件用它挂 /znacp 命令。
  inject(services, fn) {
    if (services.includes('commands')) {
      fn({
        commands: {
          register(definition) {
            registeredCommands.push(definition)
            return () => {}
          },
        },
      })
    }
  },
  on() {
    return () => {}
  },
  effect() {
    return () => {}
  },
  emit(event, payload) {
    emitted.push({ event, payload })
  },
}

// 配置值以 Volatile 引用的形式出现：{ get(): value }
const config = {
  agents: {
    get: () => [
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        command: 'claude-agent-acp',
        args: [],
        env: {},
        workingDirectory: process.cwd(),
      },
    ],
  },
  defaultAgent: { get: () => 'claude-code' },
  autoAllowPermissions: { get: () => true },
  logEvents: { get: () => false },
}

apply(ctx, config)

assert.equal(name, 'dsh-plugin-zn-agent-client')
assert.deepEqual(inject, ['tools', 'subagents'])

assert.ok(registeredTools.some(t => t.name === 'list_acp_agents'), 'list_acp_agents should be registered')
assert.ok(registeredTools.some(t => t.name === 'call_acp_agent'), 'call_acp_agent should be registered')
assert.ok(registeredTools.some(t => t.name === 'list_acp_sessions'), 'list_acp_sessions should be registered')
assert.equal(registeredProviders.length, 1, 'one subagent provider should be registered')
assert.equal(registeredProviders[0].name, 'acp')
assert.equal(typeof registeredProviders[0].start, 'function')
assert.ok(registeredCommands.some(c => c.name === 'znacp'), '/znacp command should be registered')
assert.ok(emitted.some(e => e.event === 'zn-agent-client/ready'), 'ready event should be emitted')

// list_acp_agents 直接执行即可（不 spawn 进程）。
const listTool = registeredTools.find(t => t.name === 'list_acp_agents')
const listed = await listTool.execute({})
assert.deepEqual(listed, {
  agents: [{ id: 'claude-code', displayName: 'Claude Code', command: 'claude-agent-acp' }],
})

// 配置实时读取：改清单后同一工具实例应读到新值。
config.agents.get = () => []
const listedEmpty = await listTool.execute({})
assert.deepEqual(listedEmpty, { agents: [] })

console.log('smoke ok')
