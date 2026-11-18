/**
 * 侧栏会话行装饰（方案A）：座位会话在 DSH 工作区树里「可识别、可悬停」。
 *
 * - `sidebar.session.row.leading`：标题前的 16px agent 芯片（[Q]/[K]/[C]，
 *   取 displayName 首字母）。行处于活跃/新消息等主状态时宿主自己的圆点
 *   会替代本槽位——空闲行才显示，符合宿主契约。
 * - `sidebar.session.row.hover`：悬停卡片里的座位详情段（agent、CLI 会话
 *   短 id、工作目录、宿主终端状态）。仅悬停时挂载。
 * - `sidebar.session.row.trailing` 不注册：契约写明空白会话（座位恒为空白）
 *   不挂该槽位。
 * @module dsh-plugin-zn-agent-client/client/sidebar-decorations
 */

import React, { useSyncExternalStore } from 'react'
import type { PropsRuntime, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// 引入 workspace 包 client 入口的类型（其 .d.ts 里的 declare module 会把
// sidebar.session.row.* 槽位键并入 SlotMap —— 不 import 则 TS2344）。
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { Context } from '@deepseek-ai/cordis'
import type { ZnAgentClientLocaleKey } from './locales.ts'
import { getSeatsSnapshot, seatForSession, subscribeSeats, type SeatRecord } from './seats.ts'

/** 装饰占位的 props：owner 的 sessionId + locale 键席（注册时声明）。 */
type RowProps = PropsRuntime<'sidebar.session.row.leading'> &
  PropsLocale<'settings.znAgentClient'> & { readonly sessionId: string }

/** 座位行状态钩子：订阅模块级轮询缓存（5s 刷新，引用计数启停）。 */
function useSeat(sessionId: string): SeatRecord | undefined {
  useSyncExternalStore(subscribeSeats, getSeatsSnapshot)
  return seatForSession(sessionId)
}

/** agent 首字母芯片（displayName 空则退 id 首字母）。 */
function seatChipLetter(seat: SeatRecord): string {
  const source = seat.agentDisplayName !== '' ? seat.agentDisplayName : seat.agentId
  return source.charAt(0).toUpperCase()
}

/** leading 占位：座位行的 agent 芯片。非座位行返回 null（宿主跳过）。 */
export function SeatLeadingChip(props: RowProps): React.ReactElement | null {
  const seat = useSeat(props.sessionId)
  if (seat === undefined) return null
  return (
    <span
      className="znac-row-chip"
      data-state={seat.terminalState}
      title={`${seat.agentDisplayName} · CLI`}
      aria-label={`${seat.agentDisplayName} CLI`}
    >
      {seatChipLetter(seat)}
    </span>
  )
}

/** hover 占位：座位详情段。非座位行返回 null。 */
export function SeatHoverCard(props: RowProps): React.ReactElement | null {
  const { t } = props
  const seat = useSeat(props.sessionId)
  if (seat === undefined) return null
  const cliId = seat.cliSessionId !== undefined ? seat.cliSessionId.slice(0, 8) : '—'
  const stateText = seat.terminalState === 'running'
    ? t('seat.stateRunning')
    : seat.terminalState === 'exited' ? t('seat.stateExited') : t('seat.stateNone')
  return (
    <div className="znac-row-hover" data-state={seat.terminalState}>
      <div className="znac-row-hover-line"><span className="znac-row-hover-k">{t('seat.hoverAgent')}</span><span>{seat.agentDisplayName}</span></div>
      <div className="znac-row-hover-line"><span className="znac-row-hover-k">{t('seat.hoverCli')}</span><span>{cliId}{seat.cliTitle !== undefined && seat.cliTitle !== '' ? ` · ${seat.cliTitle}` : ''}</span></div>
      <div className="znac-row-hover-line"><span className="znac-row-hover-k">{t('seat.hoverWorkspace')}</span><span>{seat.cwd}</span></div>
      <div className="znac-row-hover-line"><span className="znac-row-hover-k">{t('seat.hoverState')}</span><span>{stateText}</span></div>
    </div>
  )
}

/**
 * 注册两个侧栏装饰槽位。
 * @param ctx - 客户端上下文。
 */
export function registerSidebarDecorations(ctx: Context): void {
  ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
    name: 'sidebar.session.row.leading',
    id: 'znacp-seat-chip',
    order: 100,
    locale: 'settings.znAgentClient',
  }, (props) => <SeatLeadingChip {...(props as RowProps)} />))
  ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({
    name: 'sidebar.session.row.hover',
    id: 'znacp-seat-hover',
    order: 100,
    locale: 'settings.znAgentClient',
  }, (props) => <SeatHoverCard {...(props as RowProps)} />))
}

/** 供类型检查引用（避免未使用 import 报错）。 */
export type SeatLocaleKey = ZnAgentClientLocaleKey
