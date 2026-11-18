/**
 * 客户端半边入口：唯一职责是注册文案字典、注入样式、创建配置模型控制器，
 * 并把各 UI 面（配置卡片 / agent picker 浮层 / 侧栏入口）的注册组装起来。
 *
 * 依赖纪律：浏览器半边不 import 任何宿主侧包。`react` 由浏览器模块表提供，
 * 其它 harness 客户端包只以 `import type` 出现（类型擦除，不产生模块请求）。
 * 样式的颜色一律用 `--dsw-alias-*` 主题令牌，不写字面色值。
 *
 * @module dsh-plugin-zn-agent-client/client
 */

// 类型引入：拉进各宿主包的 Context 与插槽表声明合并。
// chat / sidebar / conversation 三个包的 contract 各自向 SlotMap 合并自家槽位名
// （shell.overlay、sidebar.footer.action、conversation.view），必须显式引入，
// 否则类型表里没有这些键，register/inject 的调用点过不了编译。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import { createConfigForm } from './config-form.ts'
import { registerConfigCard } from './config-card.tsx'
import { LOCALE_NAMESPACE } from './constants.ts'
import { en, zh, type ZnAgentClientLocaleKey } from './locales.ts'
import { registerShellOverlay } from './shell-overlay.tsx'
import { registerSidebarAction } from './sidebar-action.tsx'
import { registerConversationView } from './conversation-view.tsx'
import { registerSidebarDecorations } from './sidebar-decorations.tsx'
import { registerSeatsInfrastructure } from './seats.ts'
import { mountExternalLauncher } from './remote-external.ts'
import { disposeAllSessions } from './agent-stream.ts'
import { injectStyles } from './styles.ts'

/** 声明本插件的 locale 字典命名空间，让 `PropsLocale` 给出带类型的 `t`。 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 本插件各 UI 面的文案。 */
    'settings.znAgentClient': ZnAgentClientLocaleKey
  }
}

/** 依赖的服务：slots、locale、configForms 就绪后本插件才会加载。 */
export const inject = ['slots', 'locale', 'configForms']

/**
 * 挂载本插件的浏览器半边。
 *
 * 配置模型控制器在入口创建一次，同时供两处消费：
 * - `plugins.bundle.config` 卡片（读快照 + 提交修改）
 * - agent picker 浮层（只读快照，展示当前 agent 清单）
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
  // 终端会话（xterm + SSE）随插件卸载统一回收；进程由宿主半边回收。
  ctx.effect(() => () => { disposeAllSessions() })

  // 配置模型：一次创建，多处注入。
  const controller = createConfigForm(ctx)

  registerConfigCard(ctx, controller)
  registerShellOverlay(ctx, controller)
  registerSidebarAction(ctx)
  registerConversationView(ctx, controller)
  // 座位（方案A）：uiWorkspace 捕获（建座）+ 侧栏行装饰（芯片/悬停卡）。
  registerSeatsInfrastructure(ctx)
  registerSidebarDecorations(ctx)

  // 远端挂载是异步的；失败安静降级（按钮隐藏），不阻塞其余 UI 面。
  void mountExternalLauncher(ctx)
}
