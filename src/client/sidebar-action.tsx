/**
 * 侧边栏底栏按钮组：主按钮一键开默认 agent 的 TUI，"..." 打开选择浮层。
 *
 * 参照 dsh-better-sidebar「新建终端」的动线——默认目标可在设置里配
 * （defaultAgent），省掉"浮层→挑 agent→终端"三跳。
 * @module dsh-plugin-zn-agent-client/client/sidebar-action
 */

import React from 'react'
import type { PropsRuntime, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigFormController, ConfigSnapshot } from './config-form.ts'
import { OPEN_LAUNCHER_EVENT, readAgents, launchAgentEntry } from './shell-overlay.tsx'
import type { TemplateFace, AgentEntry } from './shell-overlay.tsx'

/**
 * 注册侧边栏底栏按钮：主按钮（默认 agent 直启）+ "..."（浮层）。
 * @param ctx - 客户端上下文。
 * @param controller - 配置表单控制器（读 defaultAgent）。
 */
export function registerSidebarAction(ctx: Context, controller: ConfigFormController): void {
  ctx.slots.inject('sidebar.footer.action', () => [
    ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'znacp-sidebar-launch',
      order: 30,
      locale: 'settings.znAgentClient',
      inject: () => controller.inject(),
    }, (props) => <SidebarLaunchButton {...props} pluginCtx={ctx} />),
    ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'znacp-sidebar-more',
      order: 31,
      locale: 'settings.znAgentClient',
    }, (props) => <SidebarMoreButton {...props} />),
  ])
}

type FooterProps = PropsRuntime<'sidebar.footer.action'> &
  PropsLocale<'settings.znAgentClient'> &
  InjectFace<TemplateFace> & { readonly pluginCtx: Context }

/**
 * 主按钮：取 defaultAgent（缺省取第一个 agent），点击即开 TUI。
 */
export function SidebarLaunchButton(props: FooterProps): React.ReactElement {
  const { t, wide, pluginCtx, useTemplateConfig } = props
  const [busy, setBusy] = React.useState(false)
  const [failed, setFailed] = React.useState(false)

  // 注入面的 hooks 舱位以 use<Name> 选择器钩子到达（见 InjectFace 契约）。
  const { agents, defaultId } = useTemplateConfig((state: ConfigSnapshot) => ({
    agents: readAgents(state.value),
    defaultId: typeof state.value?.defaultAgent === 'string' ? state.value.defaultAgent : '',
  }))
  const target = agents.find((agent: AgentEntry) => agent.id === defaultId) ?? agents[0]
  const label = target === undefined ? t('footer.launch') : `${t('footer.launch')} ${target.displayName}`

  const onClick = (): void => {
    if (target === undefined || busy) return
    setBusy(true)
    setFailed(false)
    void launchAgentEntry(pluginCtx, target)
      .catch(() => { setFailed(true) })
      .finally(() => { setBusy(false) })
  }

  if (wide) {
    return (
      <button
        type="button"
        className={`znac-foot znac-foot-launch${failed ? ' znac-foot-failed' : ''}`}
        onClick={onClick}
        disabled={target === undefined || busy}
        aria-label={label}
        title={failed ? t('launcher.terminalFailed') : label}
      >
        <span className="znac-foot-dot" data-on={!busy} aria-hidden="true" />
        <span className="znac-foot-label">{label}</span>
      </button>
    )
  }
  return (
    <button
      type="button"
      className={`znac-foot-rail${failed ? ' znac-foot-failed' : ''}`}
      onClick={onClick}
      disabled={target === undefined || busy}
      aria-label={label}
      title={label}
    >
      <span className="znac-foot-dot" data-on={!busy} aria-hidden="true" />
    </button>
  )
}

/**
 * "..." 按钮：广播 OPEN_LAUNCHER_EVENT 打开 agent 选择浮层。
 */
export function SidebarMoreButton(props: PropsRuntime<'sidebar.footer.action'> & PropsLocale<'settings.znAgentClient'>): React.ReactElement {
  const { t, wide } = props
  const label = t('footer.more')
  const onClick = (): void => {
    document.dispatchEvent(new CustomEvent(OPEN_LAUNCHER_EVENT))
  }
  if (wide) {
    return (
      <button type="button" className="znac-foot znac-foot-dots" onClick={onClick} aria-label={label} title={label}>
        <span className="znac-foot-label">···</span>
      </button>
    )
  }
  return (
    <button type="button" className="znac-foot-rail znac-foot-dots" onClick={onClick} aria-label={label} title={label}>
      ···
    </button>
  )
}
