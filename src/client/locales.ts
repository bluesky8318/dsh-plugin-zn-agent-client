/**
 * 客户端半边的文案字典。
 *
 * 约定：所有用户可见文字都在这里，组件通过注册项的 `locale` 选项拿到 `t`
 * 席位后读取，不在代码里写死。改语言只改这里，不需要重新注册插槽。
 * @module dsh-plugin-zn-agent-client/client/locales
 */

/** 本插件渲染时用到的全部 locale 键。 */
export type ZnAgentClientLocaleKey =
  // 侧栏
  | 'sidebar.label'
  // 浮层
  | 'overlay.text' | 'overlay.close'

/** 英文文案。 */
export const en: Record<ZnAgentClientLocaleKey, string> = {
  'sidebar.label': 'ACP agents',
  'overlay.text': 'ACP agent client is active',
  'overlay.close': 'Dismiss',
}

/** 中文文案。 */
export const zh: Record<ZnAgentClientLocaleKey, string> = {
  'sidebar.label': 'ACP 智能体',
  'overlay.text': 'ACP 智能体客户端已启用',
  'overlay.close': '关闭',
}
