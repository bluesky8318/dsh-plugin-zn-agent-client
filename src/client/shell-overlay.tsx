/**
 * Agent 选择浮层：列出配置里的所有 agent，复制 /znacp 命令。
 *
 * 左下角锚定的小弹框（不是全屏遮罩）；不含开终端入口——终端走主会话
 * 的 CLI Agent 视图，这里只做 ACP 相关（选 agent / 复制命令）。
 * @module dsh-plugin-zn-agent-client/client/shell-overlay
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsRuntime, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigFormController, ConfigSnapshot } from './config-form.ts'
import { ACP_COMMAND_BASE } from './constants.ts'

/** 触发浮层打开的 document 事件名。 */
export const OPEN_LAUNCHER_EVENT = 'znac:open-launcher'

/** 宿主 pluginNavigation 服务面（dsh-client-ui-plugin-manager reflect.provide 提供）。 */
interface PluginNavigation {
  /** 打开插件管理页列表视图。 */
  openList(): void
  /** 打开指定 bundle 的详情页（selectPanel('plugins') + installed tab + package 视图）。 */
  openBundle(packageName: string): void
}

/** registerShellOverlay 捕获的 pluginNavigation 服务（旧宿主缺失时为 null）。 */
let pluginNavigation: PluginNavigation | null = null

/** 本 bundle 的包名（openBundle 的目标页面）。 */
const BUNDLE_PACKAGE_NAME = 'dsh-plugin-zn-agent-client'

/**
 * 打开本插件自己的详情页：宿主的 pluginNavigation.openBundle 就是为此而设的
 * 授权 API（同款消费方式见 dsh-client-ui-entry-customization）。服务缺失时
 * 退回 selectPanel('plugins')（至少到插件列表页），再不行返回 false。
 */
function openOurBundlePage(ctx: Context): boolean {
  try {
    if (pluginNavigation !== null && typeof pluginNavigation.openBundle === 'function') {
      pluginNavigation.openBundle(BUNDLE_PACKAGE_NAME)
      return true
    }
    const layout = (ctx as unknown as { get?(key: string): unknown }).get?.('layout') as
      | { selectPanel?: (panelId: string) => void }
      | undefined
    if (layout !== null && typeof layout?.selectPanel === 'function') {
      layout.selectPanel('plugins')
      return true
    }
  } catch { /* 服务缺失（旧宿主） */ }
  return false
}

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
  // 声明依赖宿主的 pluginNavigation 服务（设置按钮深链到本插件页的授权 API）；
  // 服务由 dsh-client-ui-plugin-manager reflect.provide，缺失时 openOurBundlePage 走兜底。
  ctx.inject(['pluginNavigation'], (scope: Context) => {
    pluginNavigation = (scope as unknown as { get?(key: string): unknown }).get?.('pluginNavigation') as
      | PluginNavigation
      | null
      ?? null
  })
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
  const { t, useTemplateConfig } = props
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [settingsNote, setSettingsNote] = useState(false)
  const cardRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    // 触发按钮是开关：再点一次收起（与焦点离开逻辑互不打架）。
    const onOpen = (): void => { setSettingsNote(false); setOpen((current) => !current) }
    document.addEventListener(OPEN_LAUNCHER_EVENT, onOpen)
    return () => { document.removeEventListener(OPEN_LAUNCHER_EVENT, onOpen) }
  }, [])

  // 注入面的 hooks 舱位以 use<Name> 选择器钩子到达（见 InjectFace 契约）。
  const agents = useTemplateConfig((state: ConfigSnapshot) => readAgents(state.value))

  const close = useCallback(() => { setOpen(false) }, [])
  const openSettings = useCallback(() => {
    if (openOurBundlePage(props.pluginCtx)) {
      setSettingsNote(false)
      close()
      return
    }
    setSettingsNote(true)
  }, [close, props.pluginCtx])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    // 焦点离开卡片（Tab 走出去/点外面可聚焦元素）即收起；relatedTarget 为空
    // 表示焦点落回 body（点空白处也是这种感觉）——交给 mousedown 判定。
    const outside = (target: EventTarget | null): boolean =>
      target instanceof Node && cardRef.current !== null && !cardRef.current.contains(target)
    const onFocusOut = (event: FocusEvent): void => {
      if (event.relatedTarget !== null && outside(event.relatedTarget)) close()
    }
    // 点卡片与页脚开关之外即收起（开关自己走 toggle）。
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      const onSwitch = target instanceof Element && target.closest('.znac-foot') !== null
      if (!onSwitch && outside(target)) close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('mousedown', onMouseDown)
    }
  }, [open, close])

  if (!open) return null

  const copyCommand = (agent: AgentEntry): void => {
    void navigator.clipboard?.writeText(`${ACP_COMMAND_BASE} ${agent.id} `).then(() => {
      setCopied(agent.id)
      window.setTimeout(() => { setCopied((current) => (current === agent.id ? null : current)) }, 1500)
    })
  }

  return (
    <div className="znac-overlay znac-overlay-launcher" role="presentation">
      <div ref={cardRef} className="znac-launcher" role="dialog" aria-label={t('launcher.title')}>
        <div className="znac-overlay-head">
          <span className="znac-launcher-title">{t('launcher.title')}</span>
          <span className="znac-overlay-headbtns">
            <button type="button" className="znac-overlay-close" aria-label={t('launcher.settings')} title={t('launcher.settings')} onClick={openSettings}>⚙</button>
            <button type="button" className="znac-overlay-close" aria-label={t('launcher.close')} onClick={close}>×</button>
          </span>
        </div>
        {settingsNote && <p className="znac-launcher-setnote" role="status">{t('launcher.settingsHint')}</p>}
        <div className="znac-launcher-body">
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
                </div>
              </li>
            ))}
          </ul>
        )}
        </div>
      </div>
    </div>
  )
}
