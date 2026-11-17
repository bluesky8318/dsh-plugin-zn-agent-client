/**
 * 本插件在 Plugins 页上的配置表单：agent 清单 CRUD + 全局开关。
 *
 * 插槽：`plugins.bundle.config`，keyed，键就是包名（`NAMESPACE`）。owner 只传
 * `view: 'page'`，已接受值与写动作来自 `ctx.configForms`，经 `config-form.ts`
 * 的模型与 `hooks` 舱交给渲染器，组件里没有任何订阅机制。
 *
 * 草稿是组件私有状态，只有「保存」会写入。agent 行的 args/env 在草稿里是文本
 * （空格分隔 / JSON），保存时才解析;解析失败就地报错并阻止提交。
 *
 * @module dsh-plugin-zn-agent-client/client/config-card
 */

// 类型引入：拉进各宿主包的 Context 与插槽表声明合并。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import React from 'react'
import { LOCALE_NAMESPACE, NAMESPACE } from './constants.ts'
import type { ConfigFormController, ConfigFormFace, ConfigSnapshot, WriteOp } from './config-form.ts'

/** 配置表单的 props：owner 传的值，本插件的 `t` 席位，以及模型的注入面。 */
type ConfigCardProps =
  & PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<typeof LOCALE_NAMESPACE>
  & InjectFace<ConfigFormFace>

/** 一行 agent 的表单草稿；args/env 保持文本，保存时才解析。 */
interface AgentDraft {
  key: string
  id: string
  displayName: string
  command: string
  argsText: string
  cliArgsText: string
  envText: string
  secretId: string
  envVarName: string
}

/** 表单草稿。 */
interface Draft {
  agents: AgentDraft[]
  defaultAgent: string
  autoAllow: boolean
  logEvents: boolean
}

/** 草稿行的 key 自增源（仅用于 React 列表稳定键）。 */
let draftKeyCounter = 0

function nextDraftKey(): string {
  draftKeyCounter += 1
  return `agent-${String(draftKeyCounter)}`
}

/**
 * 注册本插件的配置表单。
 * @param ctx - 客户端根上下文。
 * @param controller - 入口创建的配置模型，与浮层共享。
 */
export function registerConfigCard(ctx: Context, controller: ConfigFormController): void {
  ctx.effect(() => () => { controller.dispose() }, 'dsh-plugin-zn-agent-client: config form')
  // 注册不做服务门控：Plugins 页靠"这条插槽上有本 bundle 的注册项"决定那一节
  // 是否渲染，用 whileServed 包起来整节都不会出现。
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
    {
      name: 'plugins.bundle.config',
      key: NAMESPACE,
      locale: LOCALE_NAMESPACE,
      inject: () => controller.inject(),
    },
    ConfigCard,
  ))
}

/** 已接受值里的单条 agent 形状（宽松读取）。 */
interface AcceptedAgent {
  id?: unknown
  displayName?: unknown
  command?: unknown
  args?: unknown
  cliArgs?: unknown
  env?: unknown
  apiKey?: unknown
}

/** 把已接受的 agent 值读成草稿行。 */
function readAgentDraft(agent: AcceptedAgent): AgentDraft {
  const apiKey = (typeof agent.apiKey === 'object' && agent.apiKey !== null ? agent.apiKey : {}) as {
    secretId?: unknown
    envVarName?: unknown
  }
  return {
    key: nextDraftKey(),
    id: typeof agent.id === 'string' ? agent.id : '',
    displayName: typeof agent.displayName === 'string' ? agent.displayName : '',
    command: typeof agent.command === 'string' ? agent.command : '',
    argsText: Array.isArray(agent.args) ? agent.args.map(String).join(' ') : '',
    cliArgsText: Array.isArray(agent.cliArgs) ? agent.cliArgs.map(String).join(' ') : '',
    envText: typeof agent.env === 'object' && agent.env !== null && Object.keys(agent.env).length > 0
      ? JSON.stringify(agent.env)
      : '',
    secretId: typeof apiKey.secretId === 'string' ? apiKey.secretId : '',
    envVarName: typeof apiKey.envVarName === 'string' ? apiKey.envVarName : '',
  }
}

/**
 * 把已接受的值读成表单草稿。
 * @param value - 已接受的部分配置。
 * @returns 表单草稿。
 */
function readDraft(value: Record<string, unknown>): Draft {
  const agents = Array.isArray(value.agents) ? value.agents as AcceptedAgent[] : []
  return {
    agents: agents.map(readAgentDraft),
    defaultAgent: typeof value.defaultAgent === 'string' ? value.defaultAgent : '',
    autoAllow: value.autoAllowPermissions === true,
    logEvents: value.logEvents === true,
  }
}

/** 两个配置值是否等价；用于判断某字段是否还需要写入。 */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/** 某字段在用户层里存在即视为已覆盖。 */
function isOverridden(user: unknown, field: string): boolean {
  return typeof user === 'object' && user !== null && field in user
}

/** argsText → string[]（空格分隔，容忍多余空白）。 */
export function parseArgsText(text: string): string[] {
  return text.trim().length === 0 ? [] : text.trim().split(/\s+/)
}

/** envText → Record<string,string>；非法 JSON 或非字符串值时抛错。 */
export function parseEnvText(text: string): Record<string, string> {
  if (text.trim().length === 0) return {}
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('env must be a JSON object')
  }
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    result[key] = String(value)
  }
  return result
}

/** 草稿校验：返回错误文案（locale key 尾段），null 表示通过。 */
function validateAgent(agent: AgentDraft): 'invalidId' | 'invalidCommand' | 'invalidEnv' | null {
  if (agent.id.trim() === '' || agent.displayName.trim() === '' || agent.command.trim() === '') return 'invalidId'
  return null
}

/**
 * 把 agent 草稿行折成要写入的配置对象；解析失败抛 TypeError（调用方就地报错）。
 */
export function agentDraftToValue(agent: AgentDraft): Record<string, unknown> {
  const apiKey: Record<string, string> = {}
  if (agent.secretId.trim() !== '') apiKey.secretId = agent.secretId.trim()
  if (agent.envVarName.trim() !== '') apiKey.envVarName = agent.envVarName.trim()
  return {
    id: agent.id.trim(),
    displayName: agent.displayName.trim(),
    command: agent.command.trim(),
    args: parseArgsText(agent.argsText),
    cliArgs: parseArgsText(agent.cliArgsText),
    env: parseEnvText(agent.envText),
    ...(Object.keys(apiKey).length > 0 ? { apiKey } : {}),
  }
}

/**
 * 把草稿折成写入操作：与已接受值相同的字段不写；与部署默认值相同的字段清除
 * 覆盖，回落到组装层；其余字段写入新值。
 * @throws 解析 args/env 失败时抛 TypeError。
 */
export function buildOps(
  accepted: Record<string, unknown>,
  base: unknown,
  draft: Draft,
): WriteOp[] {
  const baseValues = (base ?? {}) as Record<string, unknown>
  const ops: WriteOp[] = []

  const agentsValue = draft.agents.map(agentDraftToValue)
  if (!sameValue(agentsValue, accepted.agents)) {
    if (agentsValue.length === 0 && sameValue([], baseValues.agents)) {
      ops.push({ op: 'unset', path: ['agents'] })
    } else {
      ops.push({ op: 'set', path: ['agents'], value: agentsValue })
    }
  }

  const defaultAgent = draft.defaultAgent.trim()
  if (defaultAgent !== accepted.defaultAgent) {
    if (defaultAgent === '' || sameValue(defaultAgent, baseValues.defaultAgent)) {
      ops.push({ op: 'unset', path: ['defaultAgent'] })
    } else {
      ops.push({ op: 'set', path: ['defaultAgent'], value: defaultAgent })
    }
  }

  if (draft.autoAllow !== accepted.autoAllowPermissions) {
    ops.push({ op: 'set', path: ['autoAllowPermissions'], value: draft.autoAllow })
  }
  if (draft.logEvents !== accepted.logEvents) {
    ops.push({ op: 'set', path: ['logEvents'], value: draft.logEvents })
  }
  return ops
}

/**
 * 渲染 Plugins 页上本插件的那一行摘要，或它的配置表单。
 */
export function ConfigCard(props: ConfigCardProps): React.ReactElement {
  const { t, view } = props
  const snapshot = props.useTemplateConfig((state: ConfigSnapshot) => state)
  if (view === 'summary') return <p className="znac-summary">{t('card.description')}</p>
  if (snapshot.status === 'loading') return <p className="znac-note">{t('card.loading')}</p>
  if (snapshot.status === 'unavailable') return <p className="znac-note">{t('card.unavailable')}</p>
  return <SettingsForm {...props} snapshot={snapshot} />
}

/** 配置表单本体：私有草稿在这里，读与写都经 props。 */
function SettingsForm(
  { t, submit, snapshot }: ConfigCardProps & { snapshot: ConfigSnapshot },
): React.ReactElement {
  const accepted = snapshot.value
  const [draft, setDraft] = React.useState<Draft>(() => readDraft(accepted))
  const [seeding, setSeeding] = React.useState<Draft>(() => readDraft(accepted))
  const [saving, setSaving] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const [envInvalid, setEnvInvalid] = React.useState(false)
  const dirty = !sameValue(draftToComparable(draft), draftToComparable(seeding))

  // 宿主接受了新值时，只有在用户没有待保存编辑的情况下才重新读成草稿。
  React.useEffect(() => {
    const next = readDraft(accepted)
    if (sameValue(draftToComparable(next), draftToComparable(seeding)) || !sameValue(draftToComparable(draft), draftToComparable(seeding))) return
    setSeeding(next)
    setDraft(next)
  }, [accepted, seeding, draft])

  const editable = snapshot.writable && !saving

  function updateAgent(key: string, patch: Partial<AgentDraft>): void {
    setDraft(current => ({
      ...current,
      agents: current.agents.map(agent => (agent.key === key ? { ...agent, ...patch } : agent)),
    }))
  }

  function addAgent(): void {
    setDraft(current => ({
      ...current,
      agents: [...current.agents, {
        key: nextDraftKey(), id: '', displayName: '', command: '', argsText: '', cliArgsText: '', envText: '', secretId: '', envVarName: '',
      }],
    }))
  }

  function removeAgent(key: string): void {
    setDraft(current => ({ ...current, agents: current.agents.filter(agent => agent.key !== key) }))
  }

  async function save(): Promise<void> {
    if (!dirty || saving) return
    const invalid = draft.agents.find(agent => validateAgent(agent) !== null)
    if (invalid) return
    setSaving(true)
    setFailed(false)
    setEnvInvalid(false)
    try {
      const ops = buildOps(accepted, snapshot.base, draft)
      if (ops.length === 0) return
      const written = await submit(ops, snapshot.revision)
      if (written) {
        setSeeding({ ...draft })
      } else {
        setFailed(true)
      }
    } catch (error) {
      if (error instanceof TypeError || error instanceof SyntaxError) setEnvInvalid(true)
      else setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="znac-form"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <h3 className="znac-form-title">{t('card.title')}</h3>

      <div className="znac-field">
        <div className="znac-field-label">
          <span>{t('field.agents.label')}</span>
          {isOverridden(snapshot.user, 'agents') && <em className="znac-badge">{t('card.overridden')}</em>}
        </div>
        <span className="znac-field-hint" id="znac-agents-hint">{t('field.agents.hint')}</span>
        {draft.agents.map((agent, index) => (
          <fieldset key={agent.key} className="znac-agent" aria-describedby="znac-agents-hint">
            <legend className="znac-agent-title">{`#${String(index + 1)} ${agent.id || t('field.agents.unnamed')}`}</legend>
            <div className="znac-agent-grid">
              <label className="znac-sublabel" htmlFor={`znac-agent-${agent.key}-id`}>{t('field.agent.id')}</label>
              <input
                id={`znac-agent-${agent.key}-id`}
                type="text"
                value={agent.id}
                disabled={!editable}
                onChange={(event) => { updateAgent(agent.key, { id: event.currentTarget.value }) }}
              />
              <label className="znac-sublabel" htmlFor={`znac-agent-${agent.key}-name`}>{t('field.agent.displayName')}</label>
              <input
                id={`znac-agent-${agent.key}-name`}
                type="text"
                value={agent.displayName}
                disabled={!editable}
                onChange={(event) => { updateAgent(agent.key, { displayName: event.currentTarget.value }) }}
              />
              <label className="znac-sublabel" htmlFor={`znac-agent-${agent.key}-command`}>{t('field.agent.command')}</label>
              <input
                id={`znac-agent-${agent.key}-command`}
                type="text"
                value={agent.command}
                disabled={!editable}
                placeholder="qodercli"
                onChange={(event) => { updateAgent(agent.key, { command: event.currentTarget.value }) }}
              />
              <label className="znac-sublabel" htmlFor={`znac-agent-${agent.key}-args`}>{t('field.agent.args')}</label>
              <input
                id={`znac-agent-${agent.key}-args`}
                type="text"
                value={agent.argsText}
                disabled={!editable}
                placeholder="--acp"
                onChange={(event) => { updateAgent(agent.key, { argsText: event.currentTarget.value }) }}
              />
              <label className="znac-sublabel" htmlFor={`znac-agent-${agent.key}-cliargs`}>{t('field.agent.cliArgs')}</label>
              <input
                id={`znac-agent-${agent.key}-cliargs`}
                type="text"
                value={agent.cliArgsText}
                disabled={!editable}
                placeholder="--dangerously-skip-permissions"
                onChange={(event) => { updateAgent(agent.key, { cliArgsText: event.currentTarget.value }) }}
              />
              <label className="znac-sublabel" htmlFor={`znac-agent-${agent.key}-env`}>{t('field.agent.env')}</label>
              <input
                id={`znac-agent-${agent.key}-env`}
                type="text"
                value={agent.envText}
                disabled={!editable}
                placeholder='{"KEY":"value"}'
                aria-invalid={envInvalid}
                onChange={(event) => { updateAgent(agent.key, { envText: event.currentTarget.value }) }}
              />
              <label className="znac-sublabel" htmlFor={`znac-agent-${agent.key}-secret`}>{t('field.agent.secretId')}</label>
              <input
                id={`znac-agent-${agent.key}-secret`}
                type="text"
                value={agent.secretId}
                disabled={!editable}
                onChange={(event) => { updateAgent(agent.key, { secretId: event.currentTarget.value }) }}
              />
              <label className="znac-sublabel" htmlFor={`znac-agent-${agent.key}-envvar`}>{t('field.agent.envVarName')}</label>
              <input
                id={`znac-agent-${agent.key}-envvar`}
                type="text"
                value={agent.envVarName}
                disabled={!editable}
                placeholder="ANTHROPIC_API_KEY"
                onChange={(event) => { updateAgent(agent.key, { envVarName: event.currentTarget.value }) }}
              />
            </div>
            <button
              type="button"
              className="znac-agent-remove"
              disabled={!editable}
              onClick={() => { removeAgent(agent.key) }}
            >
              {t('field.agents.remove')}
            </button>
          </fieldset>
        ))}
        <button type="button" className="znac-agent-add" disabled={!editable} onClick={addAgent}>
          {t('field.agents.add')}
        </button>
      </div>

      <div className="znac-field">
        <div className="znac-field-label">
          <label htmlFor="znac-default-agent">{t('field.defaultAgent.label')}</label>
          {isOverridden(snapshot.user, 'defaultAgent') && <em className="znac-badge">{t('card.overridden')}</em>}
        </div>
        <span className="znac-field-hint" id="znac-default-agent-hint">{t('field.defaultAgent.hint')}</span>
        <input
          id="znac-default-agent"
          type="text"
          value={draft.defaultAgent}
          disabled={!editable}
          aria-describedby="znac-default-agent-hint"
          onChange={(event) => { setDraft({ ...draft, defaultAgent: event.currentTarget.value }) }}
        />
      </div>

      <div className="znac-field znac-field-inline">
        <input
          id="znac-auto-allow"
          type="checkbox"
          checked={draft.autoAllow}
          disabled={!editable}
          aria-describedby="znac-auto-allow-hint"
          onChange={(event) => { setDraft({ ...draft, autoAllow: event.currentTarget.checked }) }}
        />
        <div>
          <label htmlFor="znac-auto-allow">{t('field.autoAllow.label')}</label>
          <span className="znac-field-hint" id="znac-auto-allow-hint">{t('field.autoAllow.hint')}</span>
        </div>
      </div>

      <div className="znac-field znac-field-inline">
        <input
          id="znac-log-events"
          type="checkbox"
          checked={draft.logEvents}
          disabled={!editable}
          aria-describedby="znac-log-events-hint"
          onChange={(event) => { setDraft({ ...draft, logEvents: event.currentTarget.checked }) }}
        />
        <div>
          <label htmlFor="znac-log-events">{t('field.logEvents.label')}</label>
          <span className="znac-field-hint" id="znac-log-events-hint">{t('field.logEvents.hint')}</span>
        </div>
      </div>

      {!snapshot.writable && <p className="znac-note">{t('card.readOnly')}</p>}
      {failed && <p className="znac-invalid" role="alert">{t('card.saveFailed')}</p>}
      {envInvalid && <p className="znac-invalid" role="alert">{t('field.agent.invalidEnv')}</p>}

      <div className="znac-form-actions">
        <button
          type="button"
          disabled={!snapshot.writable}
          onClick={() => {
            const next = readDraft(accepted)
            setSeeding(next)
            setDraft(next)
            setEnvInvalid(false)
          }}
        >
          {t('card.reset')}
        </button>
        <button type="submit" disabled={!editable || !dirty}>
          {saving ? t('card.saving') : t('card.save')}
        </button>
      </div>
    </form>
  )
}

/** 草稿的可比较形状（去掉 React key，剩下的全部参与相等判断）。 */
function draftToComparable(draft: Draft): unknown {
  return {
    agents: draft.agents.map(({ key: _key, ...rest }) => rest),
    defaultAgent: draft.defaultAgent,
    autoAllow: draft.autoAllow,
    logEvents: draft.logEvents,
  }
}
