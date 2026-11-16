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
 * 浮层内容：已配置 agent 的卡片清单（来自配置表单模型快照），每张卡片带：
 * - "终端"：在当前会话（= 当前项目 cwd）开一个用户终端，写入 agent 的 TUI
 *   启动命令，然后在右侧边栏以终端页签打开 —— 渲染与键盘输入完全复用宿主
 *   自带的终端页签（dsh-client-ui-sidebar-terminal），本插件只做编排。
 * - "复制 /znacp 用法"：把斜杠命令放进剪贴板。
 *
 * 终端编排用的服务（sidebarRight / remote.terminal）在点击时用 ctx.get()
 * 惰性解析，而不是写进 inject —— 这两个服务由宿主应用客户端注册，缺一个
 * 不该让整个插件 apply 失败。
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

/** 从快照读出 agent 卡片数据（command 单独保留，供 TUI 启动用）。 */
function readAgents(value: Record<string, unknown>): Array<{ id: string; displayName: string; command: string; commandLine: string }> {
  const agents = Array.isArray(value.agents) ? value.agents as AcceptedAgent[] : []
  return agents.map((agent) => {
    const id = typeof agent.id === 'string' ? agent.id : ''
    const displayName = typeof agent.displayName === 'string' && agent.displayName !== '' ? agent.displayName : id
    const command = typeof agent.command === 'string' ? agent.command : ''
    const args = Array.isArray(agent.args) ? agent.args.map(String).join(' ') : ''
    return { id, displayName, command, commandLine: `${command} ${args}`.trim() }
  }).filter(agent => agent.id !== '')
}

/* ---------------------------------------------------------------- *
 * 宿主服务的最小结构面（不 import 宿主类型，缺服务时降级）
 * ---------------------------------------------------------------- */

/** 终端下行帧（我们只关心 snapshot）。 */
interface TerminalFrame {
  type: string
  writable?: boolean
}

/** 终端上行命令（我们只发 write）。 */
interface TerminalInputWrite {
  type: 'write'
  sequence: number
  data: string
  typed?: boolean
}

/** attach 返回的双向流句柄（AsyncIterable + 上行 send/end）。 */
interface TerminalStreamHandle extends AsyncIterable<TerminalFrame> {
  send(item: TerminalInputWrite): void
  end(): void
}

/** terminal 命名空间远程服务里本插件用到的三个方法。 */
interface TerminalRemoteFace {
  create(sessionId: string, request: { id: string; cols?: number; rows?: number }, signal?: AbortSignal): Promise<unknown>
  attach(sessionId: string, id: string, signal?: AbortSignal): TerminalStreamHandle
  rename(sessionId: string, id: string, title: string): Promise<unknown>
}

/** sidebarRight 服务里本插件用到的部分。 */
interface SidebarRightFace {
  readonly mounted: { getSnapshot(): string | undefined }
  openTab(kind: string, options?: { params?: Record<string, unknown> }): void
}

/** 惰性解析宿主客户端服务；缺注册时返回 undefined。 */
function getService(ctx: Context, name: string): unknown {
  return (ctx as { get(name: string): unknown }).get(name)
}

/** WebTerminalId 合法字符集 `/^[\w-]{1,128}$/u`：把 agent id 清洗成合规终端 id。 */
function terminalIdFor(agentId: string): string {
  return `znacp-${agentId}`.replace(/[^\w-]/g, '-').slice(0, 128)
}

/** 注册时捕获的客户端根上下文（本插件只 apply 一次）。 */
let pluginCtx: Context | undefined

/**
 * 在当前会话的终端里启动一个 agent 的 TUI：
 * 创建（幂等）用户终端 → attach 流 → 等首个 snapshot → 写入启动命令 →
 * 以宿主终端页签打开（渲染/输入全归宿主自带页签）→ 重命名页签。
 * @param agent - 目标 agent（command 作为 TUI 启动命令；ACP 参数不带入）。
 * @returns 成功时 undefined；失败时抛错（文案已本地化，调用方展示）。
 */
export async function openAgentTerminal(agent: { id: string; displayName: string; command: string }): Promise<void> {
  const ctx = pluginCtx
  if (ctx === undefined) throw new Error('launcher not ready')
  const sidebar = getService(ctx, 'sidebarRight') as SidebarRightFace | undefined
  const terminal = getService(ctx, 'remote.terminal') as TerminalRemoteFace | undefined
  if (sidebar === undefined || terminal === undefined) throw new Error('services unavailable')
  const sessionId = sidebar.mounted?.getSnapshot()
  if (sessionId === undefined) throw new Error('no session')
  if (agent.command === '') throw new Error('no command')

  const id = terminalIdFor(agent.id)
  await terminal.create(sessionId, { id, cols: 120, rows: 32 })

  const stream = terminal.attach(sessionId, id)
  try {
    for await (const frame of stream) {
      if (frame.type === 'snapshot') {
        // 首帧 snapshot 到达即流已打开；写一行启动命令（typed=false：程序注入）。
        if (frame.writable !== false) stream.send({ type: 'write', sequence: 1, data: `${agent.command}\r` })
        stream.end()
        break
      }
    }
  } catch {
    // 流提前断开不阻断打开页签：终端本身已创建，用户可在页签里手动启动。
  }

  await terminal.rename(sessionId, id, agent.displayName).catch(() => undefined)
  sidebar.openTab('terminal', { params: { terminalId: id } })
}

/** 注册项的 props：owner 的值、`t` 席位、配置模型注入面。 */
type LauncherProps = PropsLocale<typeof LOCALE_NAMESPACE> & InjectFace<ConfigFormFace>

/** 浮层内单张卡片的状态反馈。 */
type CardStatus = { agentId: string; kind: 'opening' } | { agentId: string; kind: 'opened' } | { agentId: string; kind: 'failed'; message: string }

/**
 * 注册 shell.overlay 的 agent picker 浮层。
 * @param ctx - 客户端根上下文。
 * @param controller - 入口创建的配置模型，与配置卡片共享。
 */
export function registerShellOverlay(ctx: Context, controller: ConfigFormController): void {
  pluginCtx = ctx
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
  const [cardStatus, setCardStatus] = React.useState<CardStatus | null>(null)

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

  const openTerminal = (agent: { id: string; displayName: string; command: string }): void => {
    setCardStatus({ agentId: agent.id, kind: 'opening' })
    void openAgentTerminal(agent)
      .then(() => { setCardStatus({ agentId: agent.id, kind: 'opened' }) })
      .catch((error: unknown) => {
        const message = error instanceof Error && error.message === 'no session'
          ? t('launcher.terminalNoSession')
          : t('launcher.terminalFailed')
        setCardStatus({ agentId: agent.id, kind: 'failed', message })
      })
  }

  const statusLineFor = (agentId: string): string | null => {
    if (cardStatus === null || cardStatus.agentId !== agentId) return null
    if (cardStatus.kind === 'opening') return t('launcher.terminalOpening')
    if (cardStatus.kind === 'opened') return t('launcher.terminalOpened')
    return cardStatus.message
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
              {agents.map(agent => {
                const statusLine = statusLineFor(agent.id)
                return (
                  <li key={agent.id} className="znac-launcher-item">
                    <div className="znac-launcher-meta">
                      <span className="znac-launcher-name">{agent.displayName}</span>
                      <code className="znac-launcher-cmd">{agent.commandLine}</code>
                      {statusLine !== null && <span className="znac-launcher-status">{statusLine}</span>}
                    </div>
                    <div className="znac-launcher-actions">
                      <button
                        type="button"
                        className="znac-launcher-open"
                        onClick={() => { openTerminal(agent) }}
                      >
                        {t('launcher.terminal')}
                      </button>
                      <button
                        type="button"
                        className="znac-launcher-copy"
                        onClick={() => { void copyUsage(agent.id) }}
                      >
                        {copiedId === agent.id ? t('launcher.copied') : t('launcher.copy')}
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        <p className="znac-launcher-hint">{t('launcher.hint')}</p>
      </div>
    </div>
  )
}
