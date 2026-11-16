/**
 * 侧栏底部动作：`sidebar.footer.action`，打开 ACP agent picker 浮层的入口。
 *
 * root 级 list 插槽，一个条目一个按钮。owner 会传 `wide`：展开态为 true，
 * 收起态（rail）为 false，此时只剩图标——所以收起态必须另给一个无障碍名称。
 * 按钮与浮层没有共同父组件，打开经 document CustomEvent（见 shell-overlay.tsx）。
 * @module dsh-plugin-zn-agent-client/client/sidebar-action
 */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import React from 'react'
import { LOCALE_NAMESPACE, NAMESPACE } from './constants.ts'
import { OPEN_LAUNCHER_EVENT } from './shell-overlay.tsx'

/** 注册项的 props：owner 的 wide 状态加本插件的 `t` 席位。 */
type SidebarActionProps =
  & { readonly wide: boolean }
  & PropsLocale<typeof LOCALE_NAMESPACE>

/**
 * 注册 `sidebar.footer.action` 的 ACP 智能体入口按钮。
 * @param ctx - 客户端根上下文。
 */
export function registerSidebarAction(ctx: Context): void {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: NAMESPACE, order: 30, locale: LOCALE_NAMESPACE },
    SidebarAction,
  ))
}

/**
 * 侧栏底部按钮：展开态 42px 整宽行，收起态 36x36 居中方钮；
 * 收起时按钮仍要有无障碍名称。点击派发打开浮层的文档事件。
 */
export function SidebarAction(props: SidebarActionProps): React.ReactElement {
  const { t } = props
  return (
    <button
      type="button"
      className={props.wide ? 'znac-foot' : 'znac-foot znac-foot-rail'}
      aria-label={t('sidebar.label')}
      onClick={() => { document.dispatchEvent(new CustomEvent(OPEN_LAUNCHER_EVENT)) }}
    >
      <span className="znac-dot" data-on="true" />
      {props.wide && <span className="znac-foot-label">{t('sidebar.label')}</span>}
    </button>
  )
}
