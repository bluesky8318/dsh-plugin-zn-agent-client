/**
 * 主会话区的「CLI Agent」视图：在对话页签旁嵌一个内嵌终端。
 *
 * 注册 `conversation.view` 槽位（billion-context 的上下文视图同款机制）。
 * 每个会话一份；agent 芯片切换目标。每个"面"有独立 contentId（主区
 * znacp-view:*、侧边栏页签 znacp-tab:*、shell znacp-shell:*）——两个面
 * 挂同一个进程会让每帧画两遍、输入写两遍，是卡顿的根源。
 * 另提供系统 shell 直开（launchShells 枚举，可不跑 agent 直接用终端）。
 * @module dsh-plugin-zn-agent-client/client/conversation-view
 */

import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { PropsRuntime, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigFormController, ConfigSnapshot } from './config-form.ts'
import {
  agentTerminalIdentity,
  hasLaunchCommand,
  markLaunchCommand,
  shellTerminalIdentity,
  waitForWritable,
  webTerminals,
  type HostShell,
  type HostTerminalView,
  type WebTerminalsFace,
} from './term-model.ts'
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

/** 一个终端目标：agent TUI 或系统 shell。 */
interface TermTarget {
  readonly id: string
  readonly displayName: string
  readonly command: string
  readonly shellPath?: string
}

/**
 * 视图主体：芯片行 + 内嵌 xterm。会话未就绪或无 agent 时给占位文案。
 */
export function AgentTerminalView(props: ViewProps): React.ReactElement {
  const { t, useTemplateConfig, pluginCtx, sessionId } = props
  // 注入面的 hooks 舱位以 use<Name> 选择器钩子到达（见 InjectFace 契约）。
  const agents = useTemplateConfig((state: ConfigSnapshot) => readAgents(state.value))
  const shells = useSystemShells(pluginCtx, sessionId)

  const [selectedId, setSelectedId] = useState<string | null>(null)

  const targets = useMemo<TermTarget[]>(() => {
    const agentTargets = agents.map((agent: AgentEntry) => ({
      id: agent.id,
      displayName: agent.displayName,
      command: agent.command,
    }))
    const shellTargets = shells.map((shell: HostShell) => ({
      id: shellTerminalIdentity(shell.path),
      displayName: shell.name,
      command: '',
      shellPath: shell.path,
    }))
    return [...agentTargets, ...shellTargets]
  }, [agents, shells])

  const active = targets.find((target: TermTarget) => target.id === selectedId) ?? targets[0]

  if (targets.length === 0) return <div className="znac-view"><p className="znac-view-empty">{t('view.empty')}</p></div>

  return (
    <div className="znac-view">
      <div className="znac-view-chips" role="tablist" aria-label={t('view.label')}>
        {targets.map((target: TermTarget) => (
          <button
            key={target.id}
            type="button"
            role="tab"
            aria-selected={target.id === active?.id}
            className="znac-view-chip"
            data-active={target.id === active?.id}
            data-shell={target.shellPath !== undefined}
            onClick={() => { setSelectedId(target.id) }}
          >
            {target.displayName}
          </button>
        ))}
      </div>
      {active !== undefined && (
        <EmbeddedTerminal
          key={active.id}
          pluginCtx={pluginCtx}
          sessionId={sessionId}
          target={active}
          launchingLabel={t('view.launching')}
          noServiceLabel={t('view.noService')}
        />
      )}
    </div>
  )
}

/**
 * 枚举系统 shell（失败安静降级成空表——没有 shell 芯片而已）。
 * 结果在会话生命周期内只取一次。
 */
function useSystemShells(pluginCtx: Context, sessionId: string): HostShell[] {
  const [shells, setShells] = useState<HostShell[]>([])
  useEffect(() => {
    const service = webTerminals(pluginCtx)
    const launcher = service?.launchShells
    if (typeof launcher !== 'function') return undefined
    const controller = new AbortController()
    launcher.call(service, sessionId, controller.signal)
      .then((result: { shells: HostShell[]; selectedShell?: string | undefined }) => { setShells(result.shells) })
      .catch(() => undefined)
    return () => { controller.abort() }
  }, [pluginCtx, sessionId])
  return shells
}

/** 内嵌终端：一个目标一个模型实例（key 换代时重建）。 */
function EmbeddedTerminal(props: {
  pluginCtx: Context
  sessionId: string
  target: TermTarget
  launchingLabel: string
  noServiceLabel: string
}): React.ReactElement {
  const { pluginCtx, sessionId, target, launchingLabel, noServiceLabel } = props
  const [model, setModel] = useState<HostTerminalView | null>(null)
  const [failed, setFailed] = useState<'service' | 'timeout' | null>(null)

  const identity = target.shellPath !== undefined
    ? shellTerminalIdentity(target.shellPath)
    : agentTerminalIdentity(target.id)

  // webTerminals.view 立即分配 PTY 并记入花名册；视图实例随芯片切换重建。
  // shell 目标带 shellPath —— 登录 shell 由宿主挑选/记忆，无需注入命令。
  useEffect(() => {
    const service: WebTerminalsFace | undefined = webTerminals(pluginCtx)
    if (service === undefined) {
      setFailed('service')
      return
    }
    const instance = service.view(sessionId, identity, identity, undefined, target.shellPath)
    setModel(instance)
    setFailed(null)
  }, [pluginCtx, sessionId, identity, target.shellPath])

  // 状态订阅走 useSyncExternalStore：快照引用相同时 React 跳过重渲染，
  // 渲染帧（每个输出块）才触发一次。
  const state = useSyncExternalStore(
    useMemo(() => (callback: () => void) => model?.state.subscribe(callback) ?? (() => {}), [model]),
    useMemo(() => () => model?.state.getSnapshot(), [model]),
  )

  // DOM 生命周期挂载/卸载；进程不随卸载死。
  useEffect(() => {
    if (model === null) return
    return model.mount()
  }, [model])

  // 首次 writable 注入启动命令——登记表按（面, 会话, 身份）只放行一次，
  // 重挂载/芯片来回切不再往活着的 TUI 里重复敲（嵌套 TUI 是卡顿根源）。
  // shell 目标不注入。
  useEffect(() => {
    if (model === null || target.shellPath !== undefined) return
    if (hasLaunchCommand('view', sessionId, identity)) return
    const snapshot = model.state.getSnapshot()
    if (!snapshot.writable) {
      let cancelled = false
      void waitForWritable(model).then(() => {
        if (!cancelled && !hasLaunchCommand('view', sessionId, identity)) {
          markLaunchCommand('view', sessionId, identity)
          model.write(`${target.command}\r`)
        }
      }).catch(() => { setFailed('timeout') })
      return () => { cancelled = true }
    }
    markLaunchCommand('view', sessionId, identity)
    model.write(`${target.command}\r`)
    return undefined
  }, [model, target.command, target.shellPath, sessionId, identity])

  if (failed === 'service') return <p className="znac-view-empty">{noServiceLabel}</p>
  if (model === null) return <p className="znac-view-empty">{launchingLabel}</p>
  if (state === undefined) return <p className="znac-view-empty">{launchingLabel}</p>

  return (
    <div className="znac-view-term" data-phase={state.phase}>
      <TermScreen model={model} state={state} visible label={target.displayName} />
    </div>
  )
}
