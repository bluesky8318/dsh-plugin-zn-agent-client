/**
 * 工作区看板：`main` 主区面板 + `sidebar.panellist` 侧栏图标。
 *
 * 只读展示（对话 tab + CLI 会话 tab），所有数据来自宿主官方运行时：
 * - 会话/工作区/状态：main 面板标准 props 的 useSessions / useSessionStatus /
 *   useWorkspaces 快照钩子（dsh-board 同款消费方式），纯客户端内存态。
 * - CLI 会话历史：插件自己的 /api/zn-agent-client/sessions 路由（带 cwd）。
 * - 动作只用授权 API：openSession / connectWorkspace / archiveSession。
 *
 * 不写任何 DSH 会话日志、不改侧栏结构（699ebb 教训：会话日志是宿主私有格式）。
 * @module dsh-plugin-zn-agent-client/client/workspace-board
 */

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
// SlotMap 的 'main' 键由 layout 包声明合并；不引入则 register('main') 编译不过。
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// 'sidebar.panellist' 的 owner props 由 sidebar 包声明合并（入口也已引入，双保险）。
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { LOCALE_NAMESPACE } from './constants.ts'
import type { CliSessionEntry } from './agent-stream.ts'
import { listSessions } from './agent-stream.ts'
import { readAgents, type AgentEntry, type TemplateFace } from './shell-overlay.tsx'
import type { ConfigSource } from './config-form.ts'

/** 主区面板 id（侧栏图标 ↔ 面板匹配键；conversation 是宿主保留键）。 */
export const BOARD_PANEL_ID = 'zn-agent-client-board'

/** 跨视图交接：看板「恢复」到新会话后，CLI 视图读取的一次性启动动作。 */
export interface PendingCliHandoff {
  readonly agentId: string
  readonly mode: 'resume'
  readonly resumeTarget: string
}

/** 会话列表行（运行时 SessionSummary 的子集，手写避免引入缺失的包）。 */
interface BoardSessionRow {
  readonly id: string
  readonly displayTitle: string
  readonly blank: boolean
  readonly origin?: 'subagent'
  readonly running: boolean
  readonly updatedAt: number
}

/** useSessions 快照。 */
interface BoardSessionList {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, BoardSessionRow>>
}

/** useSessionStatus 单行。 */
interface BoardStatus {
  readonly running?: boolean
  readonly pendingInteraction?: unknown
  readonly completionUnread?: boolean
}

/** useWorkspaces 单行。 */
interface BoardWorkspace {
  readonly workspaceId: string
  readonly title: string
  readonly path: string
  readonly sessionIds: readonly string[]
}

/** useWorkspaces 快照。 */
interface BoardWorkspaceSnapshot {
  readonly items: readonly BoardWorkspace[]
  readonly archivedSessionIds: readonly string[]
}

/** 快照选择钩子（运行时签名，手写）。 */
type BoardHook<T> = <S>(selector: (state: T) => S) => S

/** 看板页面 props：手写（useSessions 等舱位在缺失的 session 包里声明）。 */
interface BoardPageProps {
  readonly t: (key: string) => string
  readonly useSessions: BoardHook<BoardSessionList>
  readonly useSessionStatus: BoardHook<ReadonlyMap<string, BoardStatus>>
  readonly useWorkspaces: BoardHook<BoardWorkspaceSnapshot>
  /** 配置快照源（controller.inject().hooks.templateConfig，经 useSyncExternalStore 读）。 */
  readonly templateConfig: ConfigSource
}

/** 宿主 uiWorkspace 服务面（结构化子集，运行时来自 dsh-client-ui-workspace）。 */
interface ZnUiWorkspace {
  openSession(target: unknown): void
  connectWorkspace(workspaceId: string): Promise<string>
  archiveSession(sessionId: string, options?: { readonly stopActivity?: boolean }): Promise<void>
}

/** 宿主 layout 服务面（结构化子集）。 */
interface ZnLayout {
  selectPanel(panelId: string | null): void
}

/** registerWorkspaceBoard 捕获的服务（旧宿主缺失时为 null，动作降级禁用）。 */
let uiWorkspace: ZnUiWorkspace | null = null
let layout: ZnLayout | null = null

/**
 * 注册看板：main 面板 + 侧栏图标（dsh-context/plugin-manager 同款两段式）。
 * @param ctx - 客户端上下文。
 * @param controller - 配置表单控制器（inject 面带 useTemplateConfig 舱位）。
 */
export function registerWorkspaceBoard(ctx: Context, controller: { inject(): TemplateFace }): void {
  // 声明依赖宿主的 uiWorkspace / layout 服务（授权 API：开/建/归档会话、切主区面板）。
  ctx.inject(['uiWorkspace', 'layout'], (scope: Context) => {
    const raw = scope as unknown as { get?(key: string): unknown }
    uiWorkspace = (raw.get?.('uiWorkspace') ?? null) as ZnUiWorkspace | null
    layout = (raw.get?.('layout') ?? null) as ZnLayout | null
  })
  const tBind = ctx.locale.bind(LOCALE_NAMESPACE)
  // main 面板的 register 选项没有 inject 舱位 → 配置 hooks 舱位在注册时直接
  // 取面（controller.inject() 只是构造 hooks，不依赖挂载时机）。
  const face = controller.inject()
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: BOARD_PANEL_ID,
    locale: LOCALE_NAMESPACE,
  }, (props: unknown) => (
    <WorkspaceBoardPage
      {...(props as unknown as Omit<BoardPageProps, 'templateConfig'>)}
      templateConfig={face.hooks.templateConfig}
    />
  )))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: BOARD_PANEL_ID,
    order: 30,
    label: () => tBind('board.label'),
    locale: LOCALE_NAMESPACE,
  }, BoardIcon))
}

/** 侧栏图标：三列看板字形（owner 传 size/active）。 */
function BoardIcon(props: { readonly size?: number }): React.ReactElement {
  const size = typeof props.size === 'number' ? props.size : 16
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2.5" width="3.4" height="7.5" rx="1.1" fill="currentColor" />
      <rect x="6.8" y="2.5" width="3.4" height="11" rx="1.1" fill="currentColor" />
      <rect x="11.6" y="2.5" width="3.4" height="5.5" rx="1.1" fill="currentColor" />
    </svg>
  )
}

/** 行状态：等待你 > 运行中 > 已完成 > 空闲（dsh-board 同款判定顺序）。 */
type RowStatus = 'confirm' | 'running' | 'done' | 'idle'

function statusOf(row: BoardSessionRow, st: BoardStatus | undefined): RowStatus {
  if (st?.pendingInteraction != null) return 'confirm'
  if (st?.running === true || row.running === true) return 'running'
  if (st?.completionUnread === true) return 'done'
  return 'idle'
}

/** 时间戳 → 本地 "MM-DD HH:mm"（解析失败原样返回；与 CLI 视图同款、双语中性）。 */
function formatTime(ms: number): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 行状态 → 文案键与样式后缀（固定映射，避免动态键破坏类型与查表）。 */
const STATUS_KEYS: Readonly<Record<RowStatus, string>> = {
  confirm: 'board.stWaiting',
  running: 'board.stRunning',
  done: 'board.stDone',
  idle: 'board.stIdle',
}

/** 对话 tab 的一行。 */
interface ChatRow {
  readonly id: string
  readonly title: string
  readonly updatedAt: number
  readonly status: RowStatus
  readonly archived: boolean
}

/**
 * 看板主体：头部（标题/计数/搜索/新会话）+ 左工作区列 + 右 tab 内容。
 */
export function WorkspaceBoardPage(props: BoardPageProps): React.ReactElement {
  const { t } = props
  const sessions = props.useSessions((state: BoardSessionList) => state)
  const statuses = props.useSessionStatus((state: ReadonlyMap<string, BoardStatus>) => state)
  const workspaces = props.useWorkspaces((state: BoardWorkspaceSnapshot) => state)
  const snapshot = useSyncExternalStore(props.templateConfig.subscribe, props.templateConfig.getSnapshot)
  const agents = useMemo(() => readAgents(snapshot.value), [snapshot])

  const [selectedWsId, setSelectedWsId] = useState<string | null>(null)
  const [tab, setTab] = useState<'chat' | 'cli'>('chat')
  const [query, setQuery] = useState('')
  const [toast, setToast] = useState('')
  const toastTimer = useRef<number>(0)

  const showToast = (message: string): void => {
    setToast(message)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => { setToast('') }, 2400)
  }

  const ws = workspaces.items.find((item) => item.workspaceId === selectedWsId) ?? workspaces.items[0] ?? null
  const archived = useMemo(() => new Set(workspaces.archivedSessionIds), [workspaces.archivedSessionIds])

  // 对话行：当前工作区成员，过滤 blank（新会话占位）与 subagent 子会话，新→旧。
  const chatRows = useMemo<readonly ChatRow[]>(() => {
    if (ws === null) return []
    const out: ChatRow[] = []
    for (const id of ws.sessionIds) {
      const row = sessions.byId[id]
      if (row === undefined || row.blank || row.origin === 'subagent') continue
      out.push({
        id,
        title: row.displayTitle,
        updatedAt: row.updatedAt,
        status: statusOf(row, statuses.get(id)),
        archived: archived.has(id),
      })
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt)
    const q = query.trim().toLowerCase()
    return q === '' ? out : out.filter((row) => row.title.toLowerCase().includes(q))
  }, [ws, sessions, statuses, archived, query])

  const runningCount = useMemo(() => chatRows.filter((row) => row.status === 'running').length, [chatRows])

  // CLI tab：按当前工作区路径枚举各 agent 的历史（宿主 10s 缓存兜底）。
  const [cliMap, setCliMap] = useState<Readonly<Record<string, readonly CliSessionEntry[]>>>({})
  const [cliLoading, setCliLoading] = useState(false)
  const wsPath = ws?.path ?? ''
  const wsId = ws?.workspaceId ?? ''
  useEffect(() => {
    if (tab !== 'cli' || wsPath === '') return
    let alive = true
    setCliLoading(true)
    void Promise.all(agents.map(async (agent: AgentEntry) => {
      try {
        const items = await listSessions(agent.id, '', wsPath)
        return [agent.id, items] as const
      } catch {
        return [agent.id, [] as readonly CliSessionEntry[]] as const
      }
    })).then((pairs) => {
      if (!alive) return
      setCliMap(Object.fromEntries(pairs))
      setCliLoading(false)
    })
    return () => { alive = false }
  }, [tab, wsId, wsPath, agents])

  /** 打开一个 DSH 会话并切回主会话区。 */
  const openChatSession = (sessionId: string): void => {
    try {
      uiWorkspace?.openSession(sessionId)
      layout?.selectPanel('conversation')
    } catch {
      showToast(t('board.openFailed'))
    }
  }

  /** 在当前工作区新建一个 DSH 会话（空白，进主会话区）。 */
  const createChatSession = (): void => {
    if (ws === null || uiWorkspace === null) return
    void uiWorkspace.connectWorkspace(ws.workspaceId).catch(() => { showToast(t('board.createFailed')) })
  }

  /** 看板「恢复」：新 DSH 会话 + CLI tab 预置 + 一次性 resume 交接。 */
  const openCliSession = (agent: AgentEntry, entry: CliSessionEntry): void => {
    if (ws === null || uiWorkspace === null) return
    void uiWorkspace.connectWorkspace(ws.workspaceId).then((sessionId) => {
      try {
        localStorage.setItem(`dsh.conversation.${sessionId}`, JSON.stringify({ view: 'znacp-terminal' }))
        sessionStorage.setItem(
          `znacp.pendingCli.${sessionId}`,
          JSON.stringify({ agentId: agent.id, mode: 'resume', resumeTarget: entry.id } satisfies PendingCliHandoff),
        )
        showToast(t('board.cliOpened'))
      } catch { /* 存储不可用时退化：只开空白会话 */ }
    }).catch(() => { showToast(t('board.createFailed')) })
  }

  const archiveSession = (sessionId: string): void => {
    void uiWorkspace?.archiveSession(sessionId).catch(() => { showToast(t('board.openFailed')) })
  }

  if (workspaces.items.length === 0) {
    return <div className="znb-root"><p className="znb-empty">{t('board.noWorkspaces')}</p></div>
  }

  return (
    <div className="znb-root">
      <header className="znb-head">
        <div className="znb-head-text">
          <h1 className="znb-title">{t('board.title')}</h1>
          <p className="znb-sub">
            {chatRows.length} {t('board.sessionUnit')}
            {runningCount > 0 && <> · {runningCount} {t('board.runningUnit')}</>}
          </p>
        </div>
        <input
          className="znb-search"
          type="text"
          value={query}
          placeholder={t('board.searchHint')}
          onChange={(event) => { setQuery(event.target.value) }}
        />
        <button type="button" className="znb-new" onClick={() => { createChatSession() }}>＋ {t('board.newChat')}</button>
      </header>
      <div className="znb-body">
        <nav className="znb-rail" aria-label={t('board.title')}>
          {workspaces.items.map((item) => (
            <button
              key={item.workspaceId}
              type="button"
              className={item.workspaceId === ws?.workspaceId ? 'znb-ws znb-ws-on' : 'znb-ws'}
              onClick={() => { setSelectedWsId(item.workspaceId) }}
            >
              <span className="znb-ws-name">{item.title !== '' ? item.title : item.workspaceId}</span>
              <span className="znb-ws-path">{item.path}</span>
            </button>
          ))}
        </nav>
        <section className="znb-main">
          <div className="znb-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'znb-tab znb-tab-on' : 'znb-tab'} onClick={() => { setTab('chat') }}>{t('board.tabChat')}</button>
            <button type="button" role="tab" aria-selected={tab === 'cli'} className={tab === 'cli' ? 'znb-tab znb-tab-on' : 'znb-tab'} onClick={() => { setTab('cli') }}>{t('board.tabCli')}</button>
            <span className="znb-tab znb-tab-off" title="v2">{t('board.tabArtifacts')}</span>
            <span className="znb-tab znb-tab-off" title="v2">{t('board.tabConfig')}</span>
          </div>
          {tab === 'chat' ? (
            <div className="znb-list">
              {chatRows.length === 0 && <p className="znb-empty">{t('board.noSessions')}</p>}
              {chatRows.map((row) => (
                <div key={row.id} className="znb-row" onClick={() => { openChatSession(row.id) }}>
                  <span className={`znb-dot znb-dot-${row.status}`} title={t(STATUS_KEYS[row.status])} />
                  <span className="znb-row-title">{row.title}</span>
                  {row.archived && <span className="znb-badge">{t('board.archived')}</span>}
                  <span className="znb-row-time">{formatTime(row.updatedAt)}</span>
                  <button
                    type="button"
                    className="znb-row-act"
                    onClick={(event) => { event.stopPropagation(); archiveSession(row.id) }}
                  >
                    {t('board.archive')}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="znb-list">
              {ws === null && <p className="znb-empty">{t('board.noWorkspaces')}</p>}
              {ws !== null && cliLoading && <p className="znb-empty">{t('board.cliLoading')}</p>}
              {ws !== null && !cliLoading && agents.length === 0 && <p className="znb-empty">{t('board.noCliSessions')}</p>}
              {ws !== null && agents.map((agent: AgentEntry) => {
                const items = cliMap[agent.id] ?? []
                return (
                  <div key={agent.id} className="znb-agent">
                    <p className="znb-agent-name">
                      <span className="znb-chip">{agent.displayName.slice(0, 1).toUpperCase()}</span>
                      {agent.displayName}
                    </p>
                    {items.length === 0
                      ? <p className="znb-empty znb-empty-sub">{t('board.noCliSessions')}</p>
                      : items.map((entry) => (
                        <div key={entry.id} className="znb-row znb-row-cli">
                          <span className="znb-row-title">{entry.summary !== '' ? entry.summary : entry.id.slice(0, 8)}</span>
                          <span className="znb-row-time">{formatTime(Date.parse(entry.updatedAt))}</span>
                          <button type="button" className="znb-row-act" onClick={() => { openCliSession(agent, entry) }}>
                            {t('board.resume')}
                          </button>
                        </div>
                      ))}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
      {toast !== '' && <div className="znb-toast" role="status">{toast}</div>}
    </div>
  )
}
