/**
 * 主会话区的「CLI Agent」视图：在对话页签旁嵌一个内嵌终端。
 *
 * 注册 `conversation.view` 槽位（billion-context 的上下文视图同款机制）。
 * 每个会话一份；agent 芯片切换目标，同一 agent 复用 webTerminals 的
 * contentId 记忆——与侧边栏页签、浮层入口开的是同一个进程。
 * @module dsh-plugin-zn-agent-client/client/conversation-view
 */

import React, { useEffect, useRef, useState } from 'react'
import type { PropsRuntime, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigFormController, ConfigSnapshot } from './config-form.ts'
import { agentTerminalIdentity, webTerminals, waitForWritable, type HostTerminalView } from './term-model.ts'
import { readAgents } from './shell-overlay.tsx'
import type { AgentEntry } from './shell-overlay.tsx'
import type { TemplateFace } from './shell-overlay.tsx'
import { TermScreen } from './term-view.tsx'

/** conversation.view 是会话作用域槽位，运行时附带 sessionId。 */
type ConvProps = PropsRuntime<'conversation.view'> &
  PropsLocale<'settings.znAgentClient'> &
  InjectFace<TemplateFace> & { readonly pluginCtx: Context }

/**
 * 注册主区视图：id znacp-terminal，排在上下文视图之后。
 * @param ctx - 客户端上下文。
 * @param controller - 配置表单控制器（读 agent 列表）。
 */
export function registerConversationView(ctx: Context, controller: ConfigFormController): void {
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'znacp-terminal',
    order: 35,
    label: () => 'CLI Agent',
    locale: 'settings.znAgentClient',
    inject: () => controller.inject(),
  }, (props) => <AgentTerminalView {...props} pluginCtx={ctx} />))
}

type ViewProps = ConvProps & { readonly pluginCtx: Context; readonly sessionId: string }

/**
 * 视图主体：芯片行 + 内嵌 xterm。会话未就绪或无 agent 时给占位文案。
 */
export function AgentTerminalView(props: ViewProps): React.ReactElement {
  const { t, useTemplateConfig, pluginCtx, sessionId } = props
  // 注入面的 hooks 舱位以 use<Name> 选择器钩子到达（见 InjectFace 契约）。
  const agents = useTemplateConfig((state: ConfigSnapshot) => readAgents(state.value))

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const active = agents.find((agent: AgentEntry) => agent.id === selectedId) ?? agents[0]

  if (agents.length === 0) return <div className="znac-view"><p className="znac-view-empty">{t('view.empty')}</p></div>
  if (active === undefined) return <div className="znac-view"><p className="znac-view-empty">{t('view.empty')}</p></div>

  return (
    <div className="znac-view">
      <div className="znac-view-chips" role="tablist" aria-label={t('view.label')}>
        {agents.map((agent: AgentEntry) => (
          <button
            key={agent.id}
            type="button"
            role="tab"
            aria-selected={agent.id === active.id}
            className="znac-view-chip"
            data-active={agent.id === active.id}
            onClick={() => { setSelectedId(agent.id) }}
          >
            {agent.displayName}
          </button>
        ))}
      </div>
      <EmbeddedTerminal
        key={active.id}
        pluginCtx={pluginCtx}
        sessionId={sessionId}
        agent={active}
        launchingLabel={t('view.launching')}
        noServiceLabel={t('view.noService')}
      />
    </div>
  )
}

/** 内嵌终端：一个 agent 一个模型实例（key 换代时重建）。 */
function EmbeddedTerminal(props: {
  pluginCtx: Context
  sessionId: string
  agent: { readonly id: string; readonly displayName: string; readonly command: string }
  launchingLabel: string
  noServiceLabel: string
}): React.ReactElement {
  const { pluginCtx, sessionId, agent, launchingLabel, noServiceLabel } = props
  const [model, setModel] = useState<HostTerminalView | null>(null)
  const [failed, setFailed] = useState<'service' | 'timeout' | null>(null)
  const launchWritten = useRef(false)

  const identity = agentTerminalIdentity(agent.id)

  // webTerminals.view 立即分配 PTY 并记入花名册；视图实例随芯片切换重建。
  useEffect(() => {
    const service = webTerminals(pluginCtx)
    if (service === undefined) {
      setFailed('service')
      return
    }
    const instance = service.view(sessionId, identity, identity)
    setModel(instance)
    setFailed(null)
    launchWritten.current = false
  }, [pluginCtx, sessionId, identity])

  // 状态订阅：视图 state 是快照存储，用 useSyncExternalStore 接进 React。
  const [snapVersion, setSnapVersion] = useState(0)
  useEffect(() => {
    if (model === null) return
    return model.state.subscribe(() => { setSnapVersion((v) => v + 1) })
  }, [model])

  // DOM 生命周期挂载/卸载；进程不随卸载死。
  useEffect(() => {
    if (model === null) return
    return model.mount()
  }, [model])

  // 首次 writable 注入启动命令（每次挂载一次；重开同 contentId 不再注入）。
  useEffect(() => {
    if (model === null || launchWritten.current) return
    const state = model.state.getSnapshot()
    if (!state.writable) {
      let cancelled = false
      void waitForWritable(model).then(() => {
        if (!cancelled && !launchWritten.current) {
          launchWritten.current = true
          model.write(`${agent.command}\r`)
        }
      }).catch(() => { setFailed('timeout') })
      return () => { cancelled = true }
    }
    launchWritten.current = true
    model.write(`${agent.command}\r`)
    return undefined
  }, [model, agent.command])

  if (failed === 'service') return <p className="znac-view-empty">{noServiceLabel}</p>
  if (model === null) return <p className="znac-view-empty">{launchingLabel}</p>

  const state = model.state.getSnapshot()
  void snapVersion // 状态版本参与渲染刷新（快照存储不走 setState 通知）。

  return (
    <div className="znac-view-term" data-phase={state.phase}>
      <TermScreen model={model} state={state} visible label={agent.displayName} />
    </div>
  )
}
