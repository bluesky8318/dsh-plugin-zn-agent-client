/**
 * 主会话区的「CLI Agent」视图（dsh-agents-cli 同款架构）。
 *
 * 注册 `conversation.view` 槽位（billion-context 的上下文视图同款机制）。
 * 终端传输是插件自己的宿主路由（agent-stream.ts）：服务端持有 PTY 并负责
 * 「启动命令只敲一次」，浏览器侧 xterm 只管渲染/键击/拟合。会话按 agent
 * 全局复用——切换芯片/挂卸视图都不会杀进程或重复敲键。
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

  if (targets.length === 0) return <div className="znac-view"><p className="znac-view-empty">{t('view.empty')}</p></div>

  return (
    <div className="znac-view">
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

/** 方案C+ 会话区：agent 下拉（运行状态点）+ 会话控件条（新会话/继续最近/历史▾）+ 内嵌终端。 */
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
  const [session, setSession] = useState<AgentTerminalSession | null>(null)
  const [histOpen, setHistOpen] = useState(false)
  const [histState, setHistState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [histItems, setHistItems] = useState<readonly CliSessionEntry[]>([])
  const histRef = useRef<HTMLDivElement | null>(null)
  const [agentStates, setAgentStates] = useState<Record<string, string>>({})
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setSession(acquireSession(agentId, sessionId))
  }, [agentId, sessionId])

  // 轮询 /state：绿点=有实例运行，红点=无实例（含退出）。切 agent 不停轮询，
  // 让下拉列表里的其它 agent 状态保持新鲜（视图卸载才停）。
  useEffect(() => {
    let alive = true
    const poll = (): void => {
      void fetchStates().then((terminals) => {
        if (!alive) return
        const next: Record<string, string> = {}
        for (const [id, status] of Object.entries(terminals)) next[id] = status.state
        setAgentStates(next)
      }).catch(() => { /* 轮询失败保持上次状态 */ })
    }
    poll()
    const timer = window.setInterval(poll, 4000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])

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

  const runAction = (action: { mode: 'new' } | { mode: 'continue' } | { mode: 'resume'; resumeTarget: string }, label: string): void => {
    setHistOpen(false)
    void session?.openSession(action, label)
  }

  const shortId = (id: string): string => id.length > 8 ? id.slice(0, 8) : id
  // 在外部终端打开（特性探测：远端挂载失败时按钮不出现）。
  const externalOpener = getExternalOpener()
  const [externalState, setExternalState] = useState<'idle' | 'opening' | 'opened' | 'failed'>('idle')

  return (
    <div className="znac-view-sesarea">
      <div className="znac-view-sesbar" role="toolbar" aria-label={t('view.sessions')}>
        <AgentDropdown
          targets={targets}
          selectedId={selectedId}
          states={agentStates}
          pickerOpen={pickerOpen}
          setPickerOpen={setPickerOpen}
          pickerRef={pickerRef}
          onSelect={(id) => { setPickerOpen(false); onSelect(id) }}
          t={t}
        />
        <button
          type="button"
          className="znac-view-sbtn"
          data-kind="primary"
          disabled={session === null}
          onClick={() => { runAction({ mode: 'new' }, t('view.labelNew')) }}
        >
          {t('view.newSession')}
        </button>
        <button
          type="button"
          className="znac-view-sbtn"
          disabled={session === null}
          onClick={() => { runAction({ mode: 'continue' }, t('view.labelContinue')) }}
        >
          {t('view.continueLatest')}
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
            <div className="znac-view-hist" role="menu" aria-label={t('view.history')}>
              {histState === 'loading' && <div className="znac-view-hist-empty">{t('view.historyLoading')}</div>}
              {histState === 'failed' && <div className="znac-view-hist-empty">{t('view.historyFailed')}</div>}
              {histState === 'ready' && histItems.length === 0 && <div className="znac-view-hist-empty">{t('view.historyEmpty')}</div>}
              {histState === 'ready' && histItems.map((item: CliSessionEntry) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className="znac-view-hist-item"
                  onClick={() => { runAction({ mode: 'resume', resumeTarget: item.id }, `${t('view.labelResume')} ${shortId(item.id)}`) }}
                >
                  <span className="znac-view-hist-summary">{item.summary}</span>
                  <span className="znac-view-hist-meta">{item.updatedAt}</span>
                  <span className="znac-view-hist-id">{shortId(item.id)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
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
        <span className="znac-view-seslabel">
          {session?.lastAction !== undefined
            ? session.lastAction.label
            : state !== undefined && state.phase !== 'connecting' ? t('view.labelAttach') : ''}
        </span>
      </div>
      <EmbeddedTerminal
        session={session}
        displayName={displayName}
        launchingLabel={t('view.launching')}
        exitedLabel={t('view.exited')}
        errorLabel={t('view.error')}
        restartLabel={t('view.restart')}
      />
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
  displayName: string
  launchingLabel: string
  exitedLabel: string
  errorLabel: string
  restartLabel: string
}): React.ReactElement {
  const { session, displayName, launchingLabel, exitedLabel, errorLabel, restartLabel } = props
  const scheme = useColorScheme()

  const state = useSyncExternalStore(
    useMemo(() => (callback: () => void) => session?.subscribe(callback) ?? (() => {}), [session]),
    useMemo(() => () => session?.getSnapshot(), [session]),
  )

  // DOM 挂载 + 主题同步（暗/亮切换时重读 token 颜色）。
  const hostRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const node = hostRef.current
    if (session === null || node === null) return
    session.attach(node)
    session.syncTheme(node)
    return () => { session.detach() }
  }, [session, scheme])

  if (session === null) return <p className="znac-view-empty">{launchingLabel}</p>
  if (state === undefined || state.phase === 'connecting') {
    return <p className="znac-view-empty">{launchingLabel}</p>
  }

  return (
    <div className="znac-view-term" data-phase={state.phase}>
      <div ref={hostRef} className="znac-agent-term" aria-label={displayName} />
      {state.phase === 'exited' && (
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
