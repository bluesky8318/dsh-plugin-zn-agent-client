/**
 * 工作区入口浮层：agent picker。
 *
 * `shell.overlay` 是帧级浮层插槽（root 级 list）。两个入口都会打开它：
 * - 侧栏底部动作（sidebar.footer.action，见 sidebar-action.tsx）
 * - 浮层自身按钮 / 点击外部 / Escape 关闭
 *
 * 打开信号经 document CustomEvent（'znac:open-launcher'）传递：插槽组件没有
 * 共同的父组件，跨插槽通信用宿主文档级事件最直白。
 *
 * 浮层内容：已配置 agent 的卡片清单（来自配置表单模型快照），每张卡片带
 * "复制 /znacp 用法" 按钮。真正的对话在宿主会话里由 /znacp 命令或 call_acp_agent
 * 工具驱动 —— DSH 目前的客户端面没有"插件客户端→宿主工具"通道，浮层内嵌
 * 聊天需要那样的桥，先不做（README 里有说明）。
 * @module dsh-plugin-zn-agent-client/client/agent-launcher
 */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import React from 'react'
import { LOCALE_NAMESPACE, NAMESPACE } from './constants.ts'
import type { ConfigFormController, ConfigFormFace, ConfigSnapshot } from './config-form.ts'

/** 打开浮层的 document 事件名。 */
export const OPEN_LAUNCHER_EVENT = 'znac:open-launcher'

/** 已接受值里的单条 agent 形状（宽松读取）。 */
interface AcceptedAgent {
  id?: unknown
  displayName?: unknown
  command?: unknown
  args?: unknown
}

/** 从快照读出 agent 卡片数据。 */
function readAgents(value: Record<string, unknown>): Array<{ id: string; displayName: string; commandLine: string }> {
  const agents = Array.isArray(value.agents) ? value.agents as AcceptedAgent[] : []
  return agents.map((agent) => {
    const id = typeof agent.id === 'string' ? agent.id : ''
    const displayName = typeof agent.displayName === 'string' && agent.displayName !== '' ? agent.displayName : id
    const command = typeof agent.command === 'string' ? agent.command : ''
    const args = Array.isArray(agent.args) ? agent.args.map(String).join(' ') : ''
    return { id, displayName, commandLine: `${command} ${args}`.trim() }
  }).filter(agent => agent.id !== '')
}

/** 注册项的 props：owner 的值、`t` 席位、配置模型注入面。 */
type LauncherProps = PropsLocale<typeof LOCALE_NAMESPACE> & InjectFace<ConfigFormFace>

/**
 * 注册 shell.overlay 的 agent picker 浮层。
 * @param ctx - 客户端根上下文。
 * @param controller - 入口创建的配置模型，与配置卡片共享。
 */
export function registerShellOverlay(ctx: Context, controller: ConfigFormController): void {
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    {
      name: 'shell.overlay',
      id: NAMESPACE,
      order: 30,
      locale: LOCALE_NAMESPACE,
      inject: () => controller.inject(),
    },
    AgentLauncherOverlay,
  ))
}

/**
 * agent picker 浮层：侧栏底部动作触发打开；三条路径可关闭。
 */
export function AgentLauncherOverlay(props: LauncherProps): React.ReactElement | null {
  const { t } = props
  const [open, setOpen] = React.useState(false)
  const snapshot = props.useTemplateConfig((state: ConfigSnapshot) => state)
  const [copiedId, setCopiedId] = React.useState<string | null>(null)

  React.useEffect(() => {
    const onOpen = (): void => { setOpen(true) }
    document.addEventListener(OPEN_LAUNCHER_EVENT, onOpen)
    return () => { document.removeEventListener(OPEN_LAUNCHER_EVENT, onOpen) }
  }, [])

  React.useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [open])

  if (!open) return null
  const agents = snapshot.status === 'ready' ? readAgents(snapshot.value) : []

  const copyUsage = async (agentId: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(`/znacp ${agentId} `)
      setCopiedId(agentId)
      window.setTimeout(() => { setCopiedId(current => (current === agentId ? null : current)) }, 1500)
    } catch {
      // 剪贴板不可用时静默：卡片上的命令行文本仍可手动选择复制。
    }
  }

  return (
    <div
      className="znac-overlay znac-launcher"
      role="dialog"
      aria-label={t('launcher.title')}
      onClick={() => { setOpen(false) }}
    >
      <div className="znac-launcher-body" onClick={(event) => { event.stopPropagation() }}>
        <div className="znac-launcher-head">
          <span className="znac-launcher-title">{t('launcher.title')}</span>
          <button
            type="button"
            className="znac-overlay-close"
            aria-label={t('launcher.close')}
            onClick={() => { setOpen(false) }}
          >
            ×
          </button>
        </div>
        {agents.length === 0
          ? <p className="znac-launcher-empty">{t('launcher.empty')}</p>
          : (
            <ul className="znac-launcher-list">
              {agents.map(agent => (
                <li key={agent.id} className="znac-launcher-item">
                  <div className="znac-launcher-meta">
                    <span className="znac-launcher-name">{agent.displayName}</span>
                    <code className="znac-launcher-cmd">{agent.commandLine}</code>
                  </div>
                  <button
                    type="button"
                    className="znac-launcher-copy"
                    onClick={() => { void copyUsage(agent.id) }}
                  >
                    {copiedId === agent.id ? t('launcher.copied') : t('launcher.copy')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        <p className="znac-launcher-hint">{t('launcher.hint')}</p>
      </div>
    </div>
  )
}
