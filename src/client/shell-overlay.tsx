/**
 * Agent 选择浮层：列出配置里的所有 agent，可复制 /znacp 命令或一键开 TUI。
 *
 * 启动走 `webTerminals` 编排层（term-model.ts）——和主会话视图同一条路径，
 * 保证同一 contentId 下两个入口开的是同一个进程。
 * @module dsh-plugin-zn-agent-client/client/shell-overlay
 */

import React, { useCallback, useEffect, useState } from 'react'
import type { PropsRuntime, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import { launchAgentEntry } from './term-model.ts'
import type { ConfigFormController, ConfigSnapshot } from './config-form.ts'
import { ACP_COMMAND_BASE } from './constants.ts'

/** 触发浮层打开的 document 事件名。 */
export const OPEN_LAUNCHER_EVENT = 'znac:open-launcher'

/** 从配置快照读出的 agent 条目。 */
export interface AgentEntry {
  readonly id: string
  readonly displayName: string
  /** TUI 启动命令（裸命令，不带 ACP 参数）。 */
  readonly command: string
  /** 展示用命令行（command + args join）。 */
  readonly commandLine: string
}

/**
 * 把配置里的 agents 数组规范化成条目列表（过滤无 id/无命令的残行）。
 * @param value - 配置对象（或 undefined）。
 */
export function readAgents(value: unknown): readonly AgentEntry[] {
  const record = value as Record<string, unknown> | undefined | null
  const list = record === undefined || record === null ? undefined : record.agents
  if (!Array.isArray(list)) return []
  return list
    .map((raw) => {
      const item = raw as Record<string, unknown>
      const id = typeof item.id === 'string' ? item.id : ''
      const displayName = typeof item.displayName === 'string' && item.displayName !== '' ? item.displayName : id
      const command = typeof item.command === 'string' ? item.command.trim() : ''
      const args = Array.isArray(item.args) ? item.args.filter((a): a is string => typeof a === 'string') : []
      return { id, displayName, command, commandLine: [command, ...args].join(' ').trim() }
    })
    .filter((entry) => entry.id !== '' && entry.command !== '')
}

/** 配置注入面（controller.inject() 的返回）。 */
export type TemplateFace = ReturnType<ConfigFormController['inject']>

type OverlayProps = PropsRuntime<'shell.overlay'> &
  PropsLocale<'settings.znAgentClient'> &
  InjectFace<TemplateFace> & { readonly pluginCtx: Context }

/**
 * 注册 shell.overlay 槽位：agent 选择浮层（闭包捕获 ctx 传给组件）。
 * @param ctx - 客户端上下文。
 * @param controller - 配置表单控制器（读 agent 列表）。
 */
export function registerShellOverlay(ctx: Context, controller: ConfigFormController): void {
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'znacp-agent-launcher',
    order: 40,
    locale: 'settings.znAgentClient',
    inject: () => controller.inject(),
  }, (props) => <AgentLauncherOverlay {...props} pluginCtx={ctx} />))
}

/**
 * 浮层组件：监听 OPEN_LAUNCHER_EVENT 打开；点外部、Escape 或关闭按钮收起。
 */
export function AgentLauncherOverlay(props: OverlayProps): React.ReactElement | null {
  const { t, useTemplateConfig, pluginCtx } = props
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [launchState, setLaunchState] = useState<{ agentId: string; phase: 'opening' | 'failed'; message?: string } | null>(null)

  useEffect(() => {
    const onOpen = (): void => { setOpen(true) }
    document.addEventListener(OPEN_LAUNCHER_EVENT, onOpen)
    return () => { document.removeEventListener(OPEN_LAUNCHER_EVENT, onOpen) }
  }, [])

  // 注入面的 hooks 舱位以 use<Name> 选择器钩子到达（见 InjectFace 契约）。
  const agents = useTemplateConfig((state: ConfigSnapshot) => readAgents(state.value))

  const close = useCallback(() => { setOpen(false); setLaunchState(null) }, [])

  // 点浮层外关闭：根元素铺满 overlay 层，落点不在卡片内即收起。
  const onRootMouseDown = useCallback((event: React.MouseEvent) => {
    if (event.target === event.currentTarget) close()
  }, [close])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [open, close])

  if (!open) return null

  const copyCommand = (agent: AgentEntry): void => {
    void navigator.clipboard?.writeText(`${ACP_COMMAND_BASE} ${agent.id} `).then(() => {
      setCopied(agent.id)
      window.setTimeout(() => { setCopied((current) => (current === agent.id ? null : current)) }, 1500)
    })
  }

  const launch = (agent: AgentEntry): void => {
    setLaunchState({ agentId: agent.id, phase: 'opening' })
    void launchAgentEntry(pluginCtx, agent)
      .then(() => { close() })
      .catch(() => {
        setLaunchState({ agentId: agent.id, phase: 'failed', message: t('launcher.terminalFailed') })
      })
  }

  return (
    <div className="znac-overlay" onMouseDown={onRootMouseDown} role="presentation">
      <div className="znac-launcher" role="dialog" aria-modal="true" aria-label={t('launcher.title')}>
        <div className="znac-overlay-head">
          <span className="znac-launcher-title">{t('launcher.title')}</span>
          <button type="button" className="znac-overlay-close" aria-label={t('launcher.close')} onClick={close}>×</button>
        </div>
        <p className="znac-launcher-hint">{t('launcher.hint')}</p>
        {agents.length === 0 ? (
          <p className="znac-launcher-empty">{t('launcher.empty')}</p>
        ) : (
          <ul className="znac-launcher-list">
            {agents.map((agent: AgentEntry) => (
              <li key={agent.id} className="znac-launcher-row">
                <div className="znac-launcher-meta">
                  <span className="znac-launcher-name">{agent.displayName}</span>
                  <code className="znac-launcher-cmd">{agent.commandLine}</code>
                </div>
                <div className="znac-launcher-actions">
                  <button type="button" className="znac-launcher-copy" onClick={() => { copyCommand(agent) }}>
                    {copied === agent.id ? t('launcher.copied') : t('launcher.copy')}
                  </button>
                  <button type="button" className="znac-launcher-open" onClick={() => { launch(agent) }}>
                    {launchState?.agentId === agent.id && launchState?.phase === 'opening' ? t('launcher.terminalOpening') : t('launcher.terminal')}
                  </button>
                </div>
                {launchState?.agentId === agent.id && launchState?.phase === 'failed' ? (
                  <p className="znac-launcher-status" role="alert">{launchState.message ?? t('launcher.terminalFailed')}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** 供 footer 主按钮等外部入口直接启动（无浮层）。 */
export { launchAgentEntry } from './term-model.ts'
