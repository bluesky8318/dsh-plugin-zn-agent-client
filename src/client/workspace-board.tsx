/**
 * 工作区看板 v2：`main` 主区面板；入口在侧栏工作区行的 …/右键菜单
 * （contextMenus 的 workspace 目标贡献，排在第一位），看板跟随该工作区。
 *
 * 布局：顶部工作区名 + 四个页签：
 * - DSH 会话：会话列表（搜索/排序/状态筛选），点击跳转会话窗口。
 * - CLI 会话：agent 下拉 + 平铺表格（搜索/排序），点击行 → 右侧人话预览
 *   （transcript 只读解析，见 acp/cli-transcript.ts）+ 复制恢复命令。
 *   故意不提供「恢复到 CLI 视图」入口（CLI 会话关联不上 DSH 会话）；
 *   恢复走剪贴板：用户拿命令到任意 shell 自行执行。
 * - 工作区配置：AGENTS.md 查看/编辑/创建（workspaceId → 宿主解析路径）。
 * - 工作区分析：占位（建设中）。
 *
 * 动作只用授权 API：openSession / connectWorkspace / archiveSession。
 * 不写任何 DSH 会话日志、不改侧栏结构（699ebb 教训：会话日志是宿主私有格式）。
 * @module dsh-plugin-zn-agent-client/client/workspace-board
 */

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
// SlotMap 的 'main' 键由 layout 包声明合并；不引入则 register('main') 编译不过。
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { LOCALE_NAMESPACE, GUARD_HEADER } from './constants.ts'
import type { CliSessionEntry } from './agent-stream.ts'
import { listSessions } from './agent-stream.ts'
import { readAgents, type AgentEntry, type TemplateFace } from './shell-overlay.tsx'
import type { ConfigSource } from './config-form.ts'

/** 主区面板 id（侧栏图标 ↔ 面板匹配键；conversation 是宿主保留键）。 */
export const BOARD_PANEL_ID = 'zn-agent-client-board'

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

/** 宿主 contextMenus 服务面（结构化子集；MenuContribution 的 workspace 目标）。 */
interface ZnContextMenus {
  register(contribution: {
    readonly id: string
    readonly target: 'workspace'
    readonly order: number
    resolve(
      target: { readonly workspaceId: string; readonly path: string; readonly displayTitle: string },
      signal: AbortSignal,
    ): readonly {
      readonly id: string
      readonly label: string
      readonly separatorBefore?: boolean
      run: () => void
    }[]
  }): () => void
}

/** registerWorkspaceBoard 捕获的服务（旧宿主缺失时为 null，动作降级禁用）。 */
let uiWorkspace: ZnUiWorkspace | null = null
let layout: ZnLayout | null = null
let contextMenus: ZnContextMenus | null = null

/** 看板聚焦状态：工作区菜单「打开看板」动作携带的工作区（seq 保证同值也能触发订阅）。 */
let focusState: { readonly wsId: string; readonly seq: number } | null = null
let focusSeq = 0
const focusListeners = new Set<() => void>()

/** 菜单动作调用：记录目标工作区并唤醒看板订阅者（selectPanel 之前调用，首帧即有值）。 */
function setBoardFocus(wsId: string): void {
  focusSeq += 1
  focusState = { wsId, seq: focusSeq }
  for (const notify of focusListeners) notify()
}

function subscribeBoardFocus(notify: () => void): () => void {
  focusListeners.add(notify)
  return () => focusListeners.delete(notify)
}

function getBoardFocus(): { readonly wsId: string; readonly seq: number } | null {
  return focusState
}

/**
 * 注册看板：main 面板 + 工作区菜单「打开看板」动作（菜单第一位，无独立侧栏图标）。
 * @param ctx - 客户端上下文。
 * @param controller - 配置表单控制器（inject 面带 useTemplateConfig 舱位）。
 */
export function registerWorkspaceBoard(ctx: Context, controller: { inject(): TemplateFace }): void {
  const tBind = ctx.locale.bind(LOCALE_NAMESPACE)
  // 声明依赖宿主的 uiWorkspace / layout / contextMenus 服务（授权 API：开/建/归档会话、切主区面板、菜单贡献）。
  // 注意：inject 回调在服务可用时才执行——菜单贡献必须在这里注册，
  // 不能放在外层同步判断（服务未捕获时 contextMenus 还是 null）。
  ctx.inject(['uiWorkspace', 'layout', 'contextMenus'], (scope: Context) => {
    const raw = scope as unknown as { get?(key: string): unknown }
    uiWorkspace = (raw.get?.('uiWorkspace') ?? null) as ZnUiWorkspace | null
    layout = (raw.get?.('layout') ?? null) as ZnLayout | null
    contextMenus = (raw.get?.('contextMenus') ?? null) as ZnContextMenus | null
    // 工作区菜单贡献（ui-workspace 自带的 重命名/删除 就是同一注册表注册的，
    // target:'workspace'；effect 返回注销函数，插件卸载时宿主自动调用）。
    // order:10 排在第一位（rename=100/delete=300），菜单首项不带分隔线。
    if (contextMenus !== null) {
      ctx.effect(() => contextMenus!.register({
        id: 'znacp.open-board',
        target: 'workspace',
        order: 10,
        resolve: (target) => [{
          id: 'znacp.open-board',
          label: tBind('board.menuOpen'),
          run: () => {
            setBoardFocus(target.workspaceId)
            layout?.selectPanel(BOARD_PANEL_ID)
          },
        }],
      }))
    }
  })
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

/** DSH 会话 tab 的一行。 */
interface ChatRow {
  readonly id: string
  readonly title: string
  readonly updatedAt: number
  readonly status: RowStatus
  readonly archived: boolean
}

/** CLI 会话详情（宿主 /cli-session-detail 的响应）。 */
interface CliDetail {
  readonly supported: boolean
  readonly messages: readonly { readonly role: string; readonly text: string; readonly time: string }[]
  readonly truncated: boolean
  readonly resumeCommand: string
}

/** 带插件 GUARD 头的 POST（与 agent-stream 同款约定）。 */
async function postBoard<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [GUARD_HEADER]: '1' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json() as T
}

/**
 * 看板主体：顶部（工作区名 + 路径）+ 四页签内容。
 */
export function WorkspaceBoardPage(props: BoardPageProps): React.ReactElement {
  const { t } = props
  const sessions = props.useSessions((state: BoardSessionList) => state)
  const statuses = props.useSessionStatus((state: ReadonlyMap<string, BoardStatus>) => state)
  const workspaces = props.useWorkspaces((state: BoardWorkspaceSnapshot) => state)
  const snapshot = useSyncExternalStore(props.templateConfig.subscribe, props.templateConfig.getSnapshot)
  const agents = useMemo(() => readAgents(snapshot.value), [snapshot])

  const [selectedWsId, setSelectedWsId] = useState<string | null>(null)
  const [tab, setTab] = useState<'dsh' | 'cli' | 'config' | 'analysis'>('dsh')
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<'updated' | 'title'>('updated')
  const [statusFilter, setStatusFilter] = useState<'all' | RowStatus>('all')
  const [toast, setToast] = useState('')
  const toastTimer = useRef<number>(0)

  // 工作区菜单「打开看板」→ 聚焦该工作区（seq 变化即触发，同值重复点击也生效）。
  const focus = useSyncExternalStore(subscribeBoardFocus, getBoardFocus)
  useEffect(() => {
    if (focus !== null) setSelectedWsId(focus.wsId)
  }, [focus])

  const showToast = (message: string): void => {
    setToast(message)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => { setToast('') }, 2400)
  }

  const ws = workspaces.items.find((item) => item.workspaceId === selectedWsId) ?? workspaces.items[0] ?? null
  const archived = useMemo(() => new Set(workspaces.archivedSessionIds), [workspaces.archivedSessionIds])

  // DSH 会话行：当前工作区成员，过滤 blank（新会话占位）与 subagent 子会话。
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
    return out
  }, [ws, sessions, statuses, archived])

  // 搜索 + 状态筛选 + 排序（页签内生效）。
  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    let rows = chatRows
    if (q !== '') rows = rows.filter((row) => row.title.toLowerCase().includes(q))
    if (statusFilter !== 'all') rows = rows.filter((row) => row.status === statusFilter)
    rows = [...rows].sort((a, b) => sortKey === 'title'
      ? a.title.localeCompare(b.title)
      : b.updatedAt - a.updatedAt)
    return rows
  }, [chatRows, query, statusFilter, sortKey])

  // ── CLI 会话 tab ────────────────────────────────────────────────
  const [cliAgentId, setCliAgentId] = useState<string>('')
  const [cliItems, setCliItems] = useState<readonly CliSessionEntry[]>([])
  const [cliLoading, setCliLoading] = useState(false)
  const [cliQuery, setCliQuery] = useState('')
  const [cliSortAsc, setCliSortAsc] = useState(false)
  const [detail, setDetail] = useState<CliDetail | null>(null)
  const [detailId, setDetailId] = useState<string>('')
  const [detailLoading, setDetailLoading] = useState(false)
  const wsPath = ws?.path ?? ''
  const wsId = ws?.workspaceId ?? ''
  const activeCliAgent = agents.find((agent: AgentEntry) => agent.id === cliAgentId) ?? agents[0] ?? null

  useEffect(() => {
    if (tab !== 'cli' || wsPath === '' || activeCliAgent === null) return
    let alive = true
    setCliLoading(true)
    void listSessions(activeCliAgent.id, '', wsPath).then((items) => {
      if (!alive) return
      setCliItems(items)
      setCliLoading(false)
    }).catch(() => {
      if (!alive) return
      setCliItems([])
      setCliLoading(false)
    })
    return () => { alive = false }
  }, [tab, wsId, wsPath, activeCliAgent])

  // 拉取会话详情（预览 + 恢复命令一起返回；恢复命令不依赖预览是否支持）。
  useEffect(() => {
    if (detailId === '' || activeCliAgent === null) return
    let alive = true
    setDetailLoading(true)
    setDetail(null)
    void postBoard<CliDetail>('/api/zn-agent-client/cli-session-detail', {
      agentId: activeCliAgent.id,
      resumeTarget: detailId,
      cwd: wsPath,
    }).then((data) => {
      if (!alive) return
      setDetail(data)
      setDetailLoading(false)
    }).catch(() => {
      if (!alive) return
      setDetailLoading(false)
      showToast(t('board.detailFailed'))
    })
    return () => { alive = false }
  }, [detailId, activeCliAgent, wsPath, t])

  const cliRows = useMemo(() => {
    const q = cliQuery.trim().toLowerCase()
    let rows = cliItems
    if (q !== '') rows = rows.filter((row) => row.summary.toLowerCase().includes(q) || row.id.toLowerCase().includes(q))
    rows = [...rows].sort((a, b) => {
      const diff = a.updatedAt.localeCompare(b.updatedAt)
      return cliSortAsc ? diff : -diff
    })
    return rows
  }, [cliItems, cliQuery, cliSortAsc])

  /** 复制恢复命令到剪贴板（用户拿去任意 shell 自行恢复；与 CLI 视图无联动）。 */
  const copyResumeCommand = (): void => {
    const command = detail?.resumeCommand ?? ''
    if (command === '') return
    void navigator.clipboard.writeText(command).then(() => {
      showToast(t('board.copyOk'))
    }).catch(() => {
      showToast(t('board.copyFailed'))
    })
  }

  // ── 工作区配置 tab（AGENTS.md）─────────────────────────────────
  const [configState, setConfigState] = useState<{ readonly exists: boolean; readonly content: string; readonly path: string } | null>(null)
  const [configDraft, setConfigDraft] = useState('')
  const [configLoading, setConfigLoading] = useState(false)

  useEffect(() => {
    if (tab !== 'config' || wsId === '') return
    let alive = true
    setConfigLoading(true)
    setConfigState(null)
    void postBoard<{ exists: boolean; content: string; path: string }>('/api/zn-agent-client/workspace-config', {
      op: 'read',
      workspaceId: wsId,
    }).then((data) => {
      if (!alive) return
      setConfigState(data)
      setConfigDraft(data.content)
      setConfigLoading(false)
    }).catch(() => {
      if (!alive) return
      setConfigLoading(false)
      showToast(t('board.configLoadFailed'))
    })
    return () => { alive = false }
  }, [tab, wsId, t])

  const saveConfig = (): void => {
    if (wsId === '') return
    void postBoard<{ path: string }>('/api/zn-agent-client/workspace-config', {
      op: 'write',
      workspaceId: wsId,
      content: configDraft,
    }).then(() => {
      setConfigState((prev) => prev === null ? prev : { ...prev, exists: true, content: configDraft })
      showToast(t('board.configSaved'))
    }).catch(() => {
      showToast(t('board.configSaveFailed'))
    })
  }

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
          <h1 className="znb-title">{ws !== null && ws.title !== '' ? ws.title : t('board.title')}</h1>
          <p className="znb-sub">{ws?.path ?? ''}</p>
        </div>
        <button type="button" className="znb-new" onClick={() => { createChatSession() }}>＋ {t('board.newChat')}</button>
      </header>
      <div className="znb-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'dsh'} className={tab === 'dsh' ? 'znb-tab znb-tab-on' : 'znb-tab'} onClick={() => { setTab('dsh') }}>{t('board.tabChat')}</button>
        <button type="button" role="tab" aria-selected={tab === 'cli'} className={tab === 'cli' ? 'znb-tab znb-tab-on' : 'znb-tab'} onClick={() => { setTab('cli') }}>{t('board.tabCli')}</button>
        <button type="button" role="tab" aria-selected={tab === 'config'} className={tab === 'config' ? 'znb-tab znb-tab-on' : 'znb-tab'} onClick={() => { setTab('config') }}>{t('board.tabConfig')}</button>
        <button type="button" role="tab" aria-selected={tab === 'analysis'} className={tab === 'analysis' ? 'znb-tab znb-tab-on' : 'znb-tab'} onClick={() => { setTab('analysis') }}>{t('board.tabAnalysis')}</button>
      </div>
      <section className="znb-main">
        {tab === 'dsh' && (
          <div className="znb-listwrap">
            <div className="znb-filters">
              <input className="znb-search" type="text" value={query} placeholder={t('board.searchHint')} onChange={(event) => { setQuery(event.target.value) }} />
              <select className="znb-select" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as typeof statusFilter) }} aria-label={t('board.filterStatus')}>
                <option value="all">{t('board.filterAll')}</option>
                <option value="running">{t('board.stRunning')}</option>
                <option value="confirm">{t('board.stWaiting')}</option>
                <option value="done">{t('board.stDone')}</option>
                <option value="idle">{t('board.stIdle')}</option>
              </select>
              <select className="znb-select" value={sortKey} onChange={(event) => { setSortKey(event.target.value as typeof sortKey) }} aria-label={t('board.sortLabel')}>
                <option value="updated">{t('board.sortUpdated')}</option>
                <option value="title">{t('board.sortTitle')}</option>
              </select>
            </div>
            <div className="znb-list">
              {filteredRows.length === 0 && <p className="znb-empty">{t('board.noSessions')}</p>}
              {filteredRows.map((row) => (
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
          </div>
        )}
        {tab === 'cli' && (
          <div className="znb-cliwrap">
            <div className="znb-filters">
              <select
                className="znb-select"
                value={activeCliAgent?.id ?? ''}
                onChange={(event) => { setCliAgentId(event.target.value); setDetailId(''); setDetail(null) }}
                aria-label={t('board.agentSelect')}
              >
                {agents.map((agent: AgentEntry) => (
                  <option key={agent.id} value={agent.id}>{agent.displayName}</option>
                ))}
              </select>
              <input className="znb-search" type="text" value={cliQuery} placeholder={t('board.searchHint')} onChange={(event) => { setCliQuery(event.target.value) }} />
              <button type="button" className="znb-row-act" onClick={() => { setCliSortAsc((prev) => !prev) }}>
                {cliSortAsc ? t('board.sortAsc') : t('board.sortDesc')}
              </button>
            </div>
            <div className="znb-clisplit">
              <div className="znb-clitable">
                <div className="znb-clihrow">
                  <span className="znb-clih">{t('board.colSummary')}</span>
                  <span className="znb-clih">{t('board.colUpdated')}</span>
                </div>
                {cliLoading && <p className="znb-empty">{t('board.cliLoading')}</p>}
                {!cliLoading && cliRows.length === 0 && <p className="znb-empty">{t('board.noCliSessions')}</p>}
                {!cliLoading && cliRows.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={entry.id === detailId ? 'znb-clirow znb-clirow-on' : 'znb-clirow'}
                    onClick={() => { setDetailId(entry.id) }}
                  >
                    <span className="znb-clirow-summary">{entry.summary !== '' ? entry.summary : entry.id.slice(0, 8)}</span>
                    <span className="znb-clirow-time">{formatTime(Date.parse(entry.updatedAt))}</span>
                  </button>
                ))}
              </div>
              <div className="znb-clidetail">
                {detailId === '' && <p className="znb-empty">{t('board.detailHint')}</p>}
                {detailId !== '' && detailLoading && <p className="znb-empty">{t('board.cliLoading')}</p>}
                {detailId !== '' && !detailLoading && detail !== null && (
                  <>
                    <div className="znb-detail-bar">
                      <span className="znb-detail-id">{detailId.slice(0, 8)}</span>
                      <span className="znb-detail-count">{detail.messages.length}{detail.truncated ? '+' : ''}</span>
                      <button type="button" className="znb-copybtn" onClick={() => { copyResumeCommand() }}>
                        {t('board.copyResume')}
                      </button>
                    </div>
                    {!detail.supported && <p className="znb-empty">{t('board.previewUnsupported')}</p>}
                    {detail.supported && detail.messages.length === 0 && <p className="znb-empty">{t('board.previewEmpty')}</p>}
                    <div className="znb-msgs">
                      {detail.messages.map((message, index) => (
                        <div key={`${detailId}:${index}`} className={`znb-msg znb-msg-${message.role}`}>
                          <span className="znb-msg-role">{message.role === 'user' ? t('board.roleUser') : t('board.roleAssistant')}</span>
                          <p className="znb-msg-text">{message.text}</p>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
        {tab === 'config' && (
          <div className="znb-config">
            {configLoading && <p className="znb-empty">{t('board.cliLoading')}</p>}
            {!configLoading && configState !== null && (
              <>
                <div className="znb-config-bar">
                  <span className="znb-config-path">{configState.exists ? configState.path : t('board.configMissing')}</span>
                  <button type="button" className="znb-copybtn" onClick={() => { saveConfig() }}>{t('board.configSave')}</button>
                </div>
                <textarea
                  className="znb-editor"
                  value={configDraft}
                  spellCheck={false}
                  onChange={(event) => { setConfigDraft(event.target.value) }}
                  aria-label={t('board.tabConfig')}
                />
              </>
            )}
          </div>
        )}
        {tab === 'analysis' && (
          <div className="znb-wip"><p>{t('board.analysisWip')}</p></div>
        )}
      </section>
      {toast !== '' && <div className="znb-toast" role="status">{toast}</div>}
    </div>
  )
}
