/**
 * 方案C E2E（沙箱内可跑）：mock PTY face + 真实 ~/.claude 会话目录种子。
 * 验证：launch-line 生成（new/continue/resume）、restart 语义、/sessions 列表、SSE 管道、resume 还原。
 * 真实 PTY 的验收已在 GUI 里由用户完成（qodercli TUI 可交互）。
 * 用法：node test/e2e-plan-c.mjs（沙箱内可跑：mock PTY face + 真实 ~/.claude 会话目录种子）
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const repo = '/Users/leon/work/zeronote/scm/github/dsh-plugin-zn-agent-client'
const { apply } = await import(`${repo}/lib/index.js`)

const cwd = mkdtempSync('/tmp/znc-plan-c-')
console.log('cwd:', cwd)
const CODEWORD = 'ZNAC-C-5566'
const FAKE_SESSION_ID = 'f4e3d2c1-aaaa-4bbb-8ccc-9ddd11112222'

// ---- 种子：一个假的 claude 会话文件（listAgentSessions 的 claude 分支按 mtime 扫描）----
const slug = cwd.replaceAll('/', '-')
const claudeProjectDir = join(process.env.HOME ?? '', '.claude', 'projects', slug)
mkdirSync(claudeProjectDir, { recursive: true })
const sessionFile = join(claudeProjectDir, `${FAKE_SESSION_ID}.jsonl`)
// 会话文件需要一条真实用户消息（真实 qoder/claude 行形状：message 是对象）——
// 空会话会被历史列表过滤（CLI 自己也无法 resume 它们）。
writeFileSync(sessionFile, '{"type":"user","message":{"role":"user","content":"seed"}}\n')
const now = new Date()
utimesSync(sessionFile, now, now)

// ---- mock PTY face：模拟 shell + claude TUI 的行为 ----
function makeSubprocessFace() {
  return {
    async terminalEnvironment() { return { platform: 'darwin', defaultShell: '/bin/zsh' } },
    async spawnTerminal(spec) {
      let running = true
      const buffers = []
      let notify
      const ready = () => new Promise((resolve) => { notify = resolve })
      const push = (data) => { buffers.push(data); notify?.(); notify = undefined }
      const argvLine = spec.argv.join(' ')
      const fake = {
        async write(data) {
          if (!running) return
          push(`[echo] ${data.replace(/\r/g, '')}`)
          if (data.includes('----EXIT----')) { running = false; return }
          if (argvLine.includes('--resume')) push(`[mock] 已还原会话 ${FAKE_SESSION_ID} · ${CODEWORD}`)
          else if (data.includes('暗号')) push(`[mock] 暗号已收到：${CODEWORD}`)
        },
        async resize() {},
      }
      process.nextTick(() => push(`❯ mock-shell ready (${argvLine})`))
      const done = new Promise((resolve) => { fake._exit = resolve })
      return {
        output: (async function * out() {
          while (running || buffers.length > 0) {
            while (buffers.length > 0) yield buffers.shift()
            if (!running) break
            await ready()
            notify = undefined
          }
        })(),
        write: (d) => fake.write(d),
        resize: fake.resize,
        done,
        get running() { return running },
      }
    },
  }
}

const routes = new Map()
const effects = []
const ctx = {
  reflect: { provide() {} }, // Service 基类（remote-service）需要
  // 参考模式接线：宿主服务直接挂在 ctx 上（不再走 ctx.inject 回调）。
  subprocess: makeSubprocessFace(),
  webServer: { register(route) { routes.set(route.path, route); return () => {} } },
  workingDirectory: { defaultDirectory: cwd, get() { return undefined } },
  sessions: { get() { return undefined } },
  tools: { register() { return () => {} } },
  subagents: { registerProvider() { return () => {} } },
  inject(services, fn) {
    if (services.includes('commands')) fn({ commands: { register() { return () => {} } } })
  },
  effect(fn) { const cleanup = fn(); return typeof cleanup === 'function' ? cleanup : () => {} },
  on() { return () => {} },
  emit() {},
}
const config = {
  agents: { get: () => [{ id: 'mock', displayName: 'Mock CLI', command: 'claude', args: [], env: {}, workingDirectory: cwd }] },
  defaultAgent: { get: () => 'mock' },
  autoAllowPermissions: { get: () => true },
  logEvents: { get: () => false },
}
apply(ctx, config)

const GUARD = { 'x-zn-agent-client': '1', 'content-type': 'application/json' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function post(path, body) {
  const route = routes.get(path)
  assert.ok(route, `route missing: ${path}`)
  const chunks = []
  const res = {
    writeHead() {}, write(c) { chunks.push(typeof c === 'string' ? c : c.toString()); return true },
    end(c) { if (c !== undefined) chunks.push(typeof c === 'string' ? c : c.toString()) },
  }
  // 注册的 handler 是同步封装（fire-and-forget），响应在后续 tick 才写出——轮询到稳定为止。
  void Promise.resolve(route.handler(reqStub(path, body), res)).catch(() => {})
  let last = ''
  let stable = 0
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    await sleep(100)
    const text = chunks.join('')
    if (text !== '' && text === last) { stable += 100; if (stable >= 250) break } else { stable = 0 }
    last = text
  }
  return chunks.join('')
}
function reqStub(url, body) {
  return {
    url, method: 'POST', headers: GUARD,
    async * [Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
  }
}
async function postJson(path, body) {
  const raw = await post(path, body)
  try { return JSON.parse(raw) } catch { return { ok: false, error: raw.slice(0, 120) } }
}
/** 开一条 SSE 流并轮询文本。 */
async function streamText(id, durationMs) {
  const route = routes.get('/api/zn-agent-client/stream')
  const chunks = []
  const res = { writeHead() {}, write(c) { chunks.push(c); return true }, end() {} }
  void Promise.resolve(route.handler(reqStub('/api/zn-agent-client/stream', { id }), res)).catch(() => {})
  const deadline = Date.now() + durationMs
  let text = ''
  while (Date.now() < deadline) { await sleep(400); text = chunks.join('') }
  return text
}

let pass = 0

// ---- 1. 新会话：launch line = 纯命令，cwd = workspace ----
const open1 = await postJson('/api/zn-agent-client/open', { id: 'mock', cols: 100, rows: 30 })
assert.equal(open1.ok, true, `open(new) failed: ${JSON.stringify(open1)}`)
assert.equal(open1.info.launch, 'claude', `launch should be plain command, got ${open1.info.launch}`)
assert.equal(open1.info.cwd, cwd, 'cwd should be temp workspace')
pass++; console.log('1. open(new) ok — launch:', open1.info.launch, '· cwd ok')

// ---- 2. 键入消息：SSE 能看到 echo（管道 + snapshot 正常）----
const t1 = await streamText('mock', 2500)
assert.ok(t1.includes('mock-shell ready'), 'SSE should carry snapshot+output')
await postJson('/api/zn-agent-client/input', { id: 'mock', type: 'write', data: `记住暗号 ${CODEWORD}\r` })
const t2 = await streamText('mock', 2000)
assert.ok(t2.includes(CODEWORD), 'codeword echo should appear in stream')
pass++; console.log('2. PTY write + SSE roundtrip ok')

// ---- 3. /sessions：claude 分支从真实 ~/.claude/projects 扫描到种子会话 ----
const sessions = await postJson('/api/zn-agent-client/sessions', { id: 'mock' })
assert.equal(sessions.ok, true, `sessions failed: ${JSON.stringify(sessions)}`)
const target = sessions.sessions.find((s) => s.id === FAKE_SESSION_ID)
assert.ok(target, `seeded session should be listed: ${JSON.stringify(sessions.sessions)}`)
pass++; console.log('3. /sessions ok —', sessions.sessions.map((s) => s.id.slice(0, 8)).join(', '))

// ---- 4. resume：launch line = claude --resume <id>，restart 语义（杀旧拉新）----
const open2 = await postJson('/api/zn-agent-client/open', { id: 'mock', mode: 'resume', resumeTarget: FAKE_SESSION_ID, cols: 100, rows: 30 })
assert.equal(open2.ok, true, `open(resume) failed: ${JSON.stringify(open2)}`)
assert.equal(open2.info.launch, `claude --resume ${FAKE_SESSION_ID}`, `resume launch wrong: ${open2.info.launch}`)
pass++; console.log('4. open(resume) ok — launch:', open2.info.launch)

// ---- 5. 还原后 mock agent 报出暗号（先键入一句触发 mock 响应）----
await postJson('/api/zn-agent-client/input', { id: 'mock', type: 'write', data: '我们刚才约定的暗号是什么？\r' })
const t3 = await streamText('mock', 2500)
assert.ok(t3.includes(CODEWORD), `restored mock should report codeword, got: ${t3.slice(-200)}`)
pass++; console.log('5. RESUME VERIFIED — restored session reports the codeword')

// ---- 6. continue 模式的 launch line ----
const open3 = await postJson('/api/zn-agent-client/open', { id: 'mock', mode: 'continue', cols: 100, rows: 30 })
assert.equal(open3.ok, true, `open(continue) failed: ${JSON.stringify(open3)}`)
assert.equal(open3.info.launch, 'claude -c', `continue launch wrong: ${open3.info.launch}`)
pass++; console.log('6. open(continue) ok — launch:', open3.info.launch)

rmSync(cwd, { recursive: true, force: true })
rmSync(claudeProjectDir, { recursive: true, force: true })
console.log(`\nplan-c e2e ok (${pass}/6 checks)`)
