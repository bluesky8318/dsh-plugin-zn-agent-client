/**
 * 客户端半边入口：唯一职责是注册文案字典、注入样式，并把各 UI 面的注册
 * 组装起来。
 *
 * 依赖纪律：浏览器半边不 import 任何宿主侧包。`react` 由浏览器模块表提供，
 * 其它 harness 客户端包只以 `import type` 出现（类型擦除，不产生模块请求）。
 * 样式的颜色一律用 `--dsw-alias-*` 主题令牌，不写字面色值。
 *
 * @module dsh-plugin-zn-agent-client/client
 */

// 类型引入：拉进各宿主包的 Context 与插槽表声明合并。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import { LOCALE_NAMESPACE } from './constants.ts'
import { en, zh, type ZnAgentClientLocaleKey } from './locales.ts'
import { registerShellOverlay } from './shell-overlay.tsx'
import { registerSidebarAction } from './sidebar-action.tsx'
import { injectStyles } from './styles.ts'

/** 声明本插件的 locale 字典命名空间，让 `PropsLocale` 给出带类型的 `t`。 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 本插件各 UI 面的文案。 */
    'settings.znAgentClient': ZnAgentClientLocaleKey
  }
}

/** 依赖的服务：slots 与 locale 就绪后本插件才会加载。 */
export const inject = ['slots', 'locale']

/**
 * 挂载本插件的浏览器半边。
 *
 * 当前里程碑只注册状态类 UI（侧栏开关 + 浮层提示）；配置表单、聊天行等
 * 面板按里程碑计划在后继版本补充（模板参考实现见 git 历史）。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: Context): void {
  // 字典随生命周期注册与撤销。
  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }),
    'dsh-plugin-zn-agent-client: dictionaries',
  )
  // 样式表同样挂 effect：返回的清理函数会在插件停用时移除样式节点。
  ctx.effect(() => injectStyles())

  registerSidebarAction(ctx)
  registerShellOverlay(ctx)
}
