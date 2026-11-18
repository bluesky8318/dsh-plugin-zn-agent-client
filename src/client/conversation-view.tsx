/**
 * 主会话区的「CLI Agent」视图（dsh-agents-cli 同款架构）。
 *
 * 注册 `conversation.view` 槽位（billion-context 的上下文视图同款机制）。
 * 终端传输是插件自己的宿主路由（agent-stream.ts）：服务端持有 PTY 并负责
 * 「启动命令只敲一次」，浏览器侧 xterm 只管渲染/键击/拟合。终端实例按
 * 「DSH会话×agent」复合键隔离：同一 agent 在不同 DSH 会话里
 * 是完全独立的实例，切芯片/挂卸视图都不会杀进程或重复敲键。
 * @module dsh-plugin-zn-agent-client/client/conversation-view
 */

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsRuntime, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigFormController, ConfigSnapshot } from './config-form.ts'
import { acquireSession, fetchStates, listSessions, type AgentTerminalSession, type CliSessionEntry } from './agent-stream.ts'
import { readAgents } from './shell-overlay.tsx'
import type { AgentEntry } from './shell-overlay.tsx'
import type { TemplateFace } from './shell-overlay.tsx'
import { getExternalOpener } from './remote-external.ts'
import { compositeTerminalId } from './agent-stream.ts'

/** 读页面明暗方案（只用于在切换时触发主题重读）。 */
function useColorScheme(): 'dark' | 'light' {
  const [scheme, setScheme] = useState<'dark' | 'light'>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  )
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent): void => { setScheme(event.matches ? 'dark' : 'light') }
    query.addEventListener('change', onChange)
    return () => { query.removeEventListener('change', onChange) }
  }, [])
  return scheme
}

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

/** 一个终端目标：agent TUI。 */
interface TermTarget {
  readonly id: string
  readonly displayName: string
}

/**
 * 视图主体：芯片行 + 内嵌 xterm。会话未就绪或无 agent 时给占位文案。
 */
export function AgentTerminalView(props: ViewProps): React.ReactElement {
  const { t, useTemplateConfig, sessionId } = props
  // 注入面的 hooks 舱位以 use<Name> 选择器钩子到达（见 InjectFace 契约）。
  const agents = useTemplateConfig((state: ConfigSnapshot) => readAgents(state.value))

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const targets = useMemo<TermTarget[]>(() => agents.map((agent: AgentEntry) => ({
    id: agent.id,
    displayName: agent.displayName,
  })), [agents])

  const active = targets.find((target: TermTarget) => target.id === selectedId) ?? targets[0]

  if (targets.length === 0) return <div className="znac-view" data-znacp-cli-view="true"><p className="znac-view-empty">{t('view.empty')}</p></div>

  return (
    <div className="znac-view" data-znacp-cli-view="true">
      {active !== undefined && (
        <SessionArea
          key={active.id}
          agentId={active.id}
          sessionId={sessionId}
          displayName={active.displayName}
          t={t}
          targets={targets}
          selectedId={active.id}
          onSelect={(id) => { setSelectedId(id) }}
        />
      )}
    </div>
  )
}

/** 方案C+ 会话区：agent 下拉（运行状态点）+ 会话控件条（新会话/历史▾）+ 内嵌终端。 */
function SessionArea(props: {
  agentId: string
  sessionId: string
  displayName: string
  t: (key: never) => string
  targets: readonly TermTarget[]
  selectedId: string
  onSelect: (agentId: string) => void
}): React.ReactElement {
  const { agentId, sessionId, displayName, targets, selectedId, onSelect } = props
  // t 的键类型由 LocaleNamespaceMap 推导，运行时只是查表函数。
  const t = props.t as (key: string) => string

/** ISO 时间 → 本地 "MM-DD HH:mm"（解析失败原样返回）。 */
function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

  const [session, setSession] = useState<AgentTerminalSession | null>(null)
  const [histOpen, setHistOpen] = useState(false)
  const [histState, setHistState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [histItems, setHistItems] = useState<readonly CliSessionEntry[]>([])
  const histRef = useRef<HTMLDivElement | null>(null)
  const [agentStates, setAgentStates] = useState<Record<string, string>>({})
  // 显式启动记录：只有人点过「＋新会话/历史/继续」或实例确实在跑，才挂终端；
  // 防止首次打开视图就静默 spawn 一个 PTY 新会话（会话膨胀的根源）。
  const [launchedIds, setLaunchedIds] = useState<ReadonlySet<string>>(new Set())
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setSession(acquireSession(agentId, sessionId))
  }, [agentId, sessionId])

  // 轮询 /state：绿点=有实例运行，红点=无实例（含退出）。切 agent 不停轮询，
  // 让下拉列表里的其它 agent 状态保持新鲜（视图卸载才停）。sessionKey 随
  // sessionId 变化重建轮询：工作区 cwd 立刻跟随当前会话刷新。
  const [workspaceCwd, setWorkspaceCwd] = useState('')
  useEffect(() => {
    let alive = true
    const poll = (): void => {
      void fetchStates(sessionId).then(({ terminals, cwd }) => {
        if (!alive) return
        const next: Record<string, string> = {}
        for (const [id, status] of Object.entries(terminals)) next[id] = status.state
        setAgentStates(next)
        if (cwd !== '') setWorkspaceCwd(cwd)
      }).catch(() => { /* 轮询失败保持上次状态 */ })
    }
    poll()
    const timer = window.setInterval(poll, 4000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [sessionId])

  // 历史菜单/agent 下拉打开时点外部/按 Esc 都关闭（与 ACP 弹框同一套交互约定）。
  useEffect(() => {
    if (!histOpen && !pickerOpen) return
    const onDown = (event: MouseEvent): void => {
      const node = event.target
      if (!(node instanceof Node)) return
      if (histOpen && histRef.current !== null && !histRef.current.contains(node)) setHistOpen(false)
      if (pickerOpen && pickerRef.current !== null && !pickerRef.current.contains(node)) setPickerOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { setHistOpen(false); setPickerOpen(false) }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [histOpen, pickerOpen])

  const state = useSyncExternalStore(
    useMemo(() => (callback: () => void) => session?.subscribe(callback) ?? (() => {}), [session]),
    useMemo(() => () => session?.getSnapshot(), [session]),
  )

  const loadHistory = (): void => {
    setHistOpen(true)
    if (histState === 'loading') return
    setHistState('loading')
    void listSessions(agentId, sessionId).then((items) => {
      setHistItems(items)
      setHistState('ready')
    }).catch(() => { setHistState('failed') })
  }

  // 历史弹层用 Popover API 渲染到顶层：会话视图所在 tab 面板有 overflow 裁剪，
  // absolute 弹层会被截断（见过 「Qoder CL…」 被切）。不支持时回落 absolute 定位。
  const histPopRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = histPopRef.current
    if (el === null) return
    if (!histOpen) {
      if (typeof el.hidePopover === 'function') { try { el.hidePopover() } catch { /* 本来就没开 */ } }
      return
    }
    el.setAttribute('popover', 'manual')
    if (typeof el.showPopover !== 'function') return
    const position = (): void => {
      const btn = histRef.current?.querySelector('button')
      const rect = btn?.getBoundingClientRect()
      if (rect === undefined) return
      const width = Math.max(320, Math.min(480, Math.round(rect.width) + 40))
      el.style.width = `${width}px`
      el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`
      el.style.top = `${rect.bottom + 4}px`
    }
    position()
    try { el.showPopover() } catch { /* 重复打开等情况忽略 */ }
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      try { el.hidePopover() } catch { /* 本来就没开 */ }
    }
  }, [histOpen])

  const runAction = (action: { mode: 'new' } | { mode: 'continue' } | { mode: 'resume'; resumeTarget: string }, label: string): void => {
    setHistOpen(false)
    setLaunchedIds((prev) => { const next = new Set(prev); next.add(agentId); return next })
    showToast(action.mode === 'new' ? t('view.newCreated') : label)
    void session?.openSession(action, label)
  }

  const shortId = (id: string): string => id.length > 8 ? id.slice(0, 8) : id
  const last = session?.lastAction
  const curId = last?.resumeTarget !== undefined ? shortId(last.resumeTarget) : undefined
  const statusText = last !== undefined
    ? last.label
    : state !== undefined && state.phase !== 'connecting' ? t('view.labelAttach') : ''
  // 工作区标签优先显示当前会话的工作区（/state 实时解析、跟随切换）；
  // 拿不到时退回已挂载 PTY 实例的启动目录。
  const cwd = workspaceCwd !== '' ? workspaceCwd : state?.info?.cwd ?? ''
  // 在外部终端打开（特性探测：远端挂载失败时按钮不出现）。
  const externalOpener = getExternalOpener()
  const [externalState, setExternalState] = useState<'idle' | 'opening' | 'opened' | 'failed'>('idle')
  // 操作反馈 toast（示意图方案C 的右下角轻提示，2.2s 自动消失）。
  const [toast, setToast] = useState('')
  const toastTimer = useRef<number | undefined>(undefined)
  const showToast = (message: string): void => {
    setToast(message)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => { setToast('') }, 2200)
  }

  return (
    <div className="znac-view-sesarea">
      <div className="znac-view-topbar" role="toolbar" aria-label={t('view.sessions')}>
        <AgentDropdown
          targets={targets}
          selectedId={selectedId}
          states={Object.fromEntries(targets.map((target: TermTarget) => [target.id, agentStates[compositeTerminalId(sessionId, target.id)] ?? 'none']))}
          pickerOpen={pickerOpen}
          setPickerOpen={setPickerOpen}
          pickerRef={pickerRef}
          onSelect={(id) => {
            setPickerOpen(false)
            if (id !== selectedId) showToast(t('view.switchedTo') + (targets.find((target: TermTarget) => target.id === id)?.displayName ?? ''))
            onSelect(id)
          }}
          t={t}
        />
        <span className="znac-view-spacer" />
        <span className="znac-view-seslabel">{t('view.sessionLabel')}</span>
        <button
          type="button"
          className="znac-view-sbtn"
          data-kind="primary"
          disabled={session === null}
          onClick={() => { runAction({ mode: 'new' }, t('view.labelNew')) }}
        >
          {t('view.newSession')}
        </button>
        <div className="znac-view-histwrap" ref={histRef}>
          <button
            type="button"
            className="znac-view-sbtn"
            aria-expanded={histOpen}
            onClick={() => { if (histOpen) setHistOpen(false); else loadHistory() }}
          >
            {t('view.history')} ▾
          </button>
          {histOpen && (
            <div className="znac-view-hist" role="menu" aria-label={t('view.history')} ref={histPopRef}>
              {histState === 'loading' && <div className="znac-view-hist-empty">{t('view.historyLoading')}</div>}
              {histState === 'failed' && <div className="znac-view-hist-empty">{t('view.historyFailed')}</div>}
              {histState === 'ready' && histItems.length === 0 && <div className="znac-view-hist-empty">{t('view.historyEmpty')}</div>}
              {histState === 'ready' && histItems.map((item: CliSessionEntry) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className="znac-view-hist-item"
                  onClick={() => { runAction({ mode: 'resume', resumeTarget: item.id, ...(item.cwd !== undefined && item.cwd !== '' ? { cwd: item.cwd } : {}) }, `${t('view.labelResume')} ${shortId(item.id)}`) }}
                >
                  <span className="znac-view-hist-summary">{item.summary}</span>
                  <span className="znac-view-hist-meta">{formatTime(item.updatedAt)}</span>
                  <span className="znac-view-hist-id">{shortId(item.id)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="znac-view-sesbar">
        <span className="znac-view-seslabel">{t('view.currentSession')}</span>
        <span className="znac-view-sesid">{curId ?? '—'}{statusText !== '' ? ` · ${statusText}` : ''}</span>
        {cwd !== '' && <span className="znac-view-sescwd">{t('view.workspace')}: {cwd}</span>}
        <span className="znac-view-spacer" />
        {externalOpener !== undefined && (
          <button
            type="button"
            className="znac-view-external"
            data-state={externalState}
            disabled={externalState === 'opening'}
            aria-label={t('view.externalOpen')}
            onClick={() => {
              const open = getExternalOpener()
              if (open === undefined) return
              setExternalState('opening')
              void open(sessionId, agentId).then((result) => {
                setExternalState(result?.opened === true ? 'opened' : 'failed')
              }).catch(() => { setExternalState('failed') })
            }}
          >
            {t(externalState === 'opening' ? 'view.externalOpening' : externalState === 'opened' ? 'view.externalOpened' : externalState === 'failed' ? 'view.externalFailed' : 'view.externalOpen')}
          </button>
        )}
      </div>
      <EmbeddedTerminal
        session={session}
        active={agentStates[compositeTerminalId(sessionId, agentId)] === 'running' || launchedIds.has(agentId)}
        idleHint={t('view.idleHint')}
        displayName={displayName}
        launchingLabel={t('view.launching')}
        exitedLabel={t('view.exited')}
        errorLabel={t('view.error')}
        restartLabel={t('view.restart')}
      />
      {toast !== '' && <div className="znac-view-toast" role="status">{toast}</div>}
    </div>
  )
}

/** agent 下拉按钮 + 菜单：绿点=实例运行中，红点=无实例。切换不杀其它 agent 的会话。 */
function AgentDropdown(props: {
  targets: readonly TermTarget[]
  selectedId: string
  states: Record<string, string>
  pickerOpen: boolean
  setPickerOpen: (open: boolean) => void
  pickerRef: React.RefObject<HTMLDivElement | null>
  onSelect: (agentId: string) => void
  t: (key: string) => string
}): React.ReactElement {
  const { targets, selectedId, states, pickerOpen, setPickerOpen, pickerRef, onSelect, t } = props
  const active = targets.find((target: TermTarget) => target.id === selectedId)
  const dotFor = (id: string): string => states[id] === 'running' ? 'running' : 'none'
  return (
    <div className="znac-view-agentwrap" ref={pickerRef as React.RefObject<HTMLDivElement>}>
      <button
        type="button"
        className="znac-view-agentbtn"
        aria-haspopup="menu"
        aria-expanded={pickerOpen}
        aria-label={t('view.agentPicker')}
        onClick={() => { setPickerOpen(!pickerOpen) }}
      >
        <span className="znac-view-dot" data-state={active === undefined ? 'none' : dotFor(active.id)} />
        {active?.displayName ?? ''}
        <span className="znac-view-caret">▾</span>
      </button>
      {pickerOpen && (
        <div className="znac-view-agentmenu" role="menu" aria-label={t('view.agentPicker')}>
          {targets.map((target: TermTarget) => (
            <button
              key={target.id}
              type="button"
              role="menuitem"
              className="znac-view-agentitem"
              data-active={target.id === selectedId}
              onClick={() => { onSelect(target.id) }}
            >
              <span className="znac-view-dot" data-state={dotFor(target.id)} />
              <span className="znac-view-agentname">{target.displayName}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 内嵌终端：DOM 挂载 + 状态订阅；会话对象由 SessionArea 持有并传入。 */
function EmbeddedTerminal(props: {
  session: AgentTerminalSession | null
  /** 实例在跑或人显式点过启动动作时才为 true——false 时只渲染空态，不连 /open。 */
  active: boolean
  idleHint: string
  displayName: string
  launchingLabel: string
  exitedLabel: string
  errorLabel: string
  restartLabel: string
}): React.ReactElement {
  const { session, active, idleHint, displayName, launchingLabel, exitedLabel, errorLabel, restartLabel } = props
  const scheme = useColorScheme()

  const state = useSyncExternalStore(
    useMemo(() => (callback: () => void) => session?.subscribe(callback) ?? (() => {}), [session]),
    useMemo(() => () => session?.getSnapshot(), [session]),
  )

  // DOM 挂载 + 主题同步（暗/亮切换时重读 token 颜色）。
  const hostRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!active) return
    const node = hostRef.current
    if (session === null || node === null) return
    session.attach(node)
    session.syncTheme(node)
    return () => { session.detach() }
  }, [session, scheme, active])

  // 连接中也要渲染终端容器：attach 才会创建 xterm（惰性），若整个容器被
  // 占位文案替代，snapshot 会因终端不存在而被丢弃——phase 永远停在
  // connecting（点开新会话一直「正在启动 CLI」的死锁根源）。
  // 空态：实例没跑、人也没点过启动动作——不 spawn，等人在顶栏明确选择。
  if (!active) {
    return (
      <div className="znac-view-idle" role="status">
        <p>{idleHint}</p>
      </div>
    )
  }
  if (session === null) return <p className="znac-view-empty">{launchingLabel}</p>

  return (
    <div className="znac-view-term" data-phase={state?.phase ?? 'connecting'}>
      <div ref={hostRef} className="znac-agent-term" aria-label={displayName} />
      {(state === undefined || state.phase === 'connecting') && (
        <div className="znac-view-switching" role="status">
          <span className="znac-view-spin" aria-hidden="true" />
          <span>{launchingLabel}</span>
        </div>
      )}
      {state?.phase === 'exited' && (
        <div className="znac-view-term-note" role="status">
          <span>{state.error !== '' ? `${errorLabel}: ${state.error}` : exitedLabel}</span>
          <button type="button" className="znac-view-restart" onClick={() => { void session.restart() }}>
            {restartLabel}
          </button>
        </div>
      )}
    </div>
  )
}
