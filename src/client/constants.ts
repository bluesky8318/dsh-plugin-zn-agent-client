/**
 * 客户端半边共用的标识常量。
 * 改名时保持 package.json 的 `name`、src/index.ts 的 `name`、cordis.patch.yml 的
 * `id`/`name` 与此处一致（见 README）。
 * @module dsh-plugin-zn-agent-client/client/constants
 */

/**
 * 插件名：同时是 cordis.patch.yml 里的行 id（也就是宿主派生的 settings 命名空间）、
 * 插槽注册的 id、以及客户端模块加载器登记的 id。三处必须一致。
 */
export const NAMESPACE = 'dsh-plugin-zn-agent-client'

/** 客户端半边自己的 locale 字典命名空间。 */
export const LOCALE_NAMESPACE = 'settings.znAgentClient'

/** /znacp 命令名（复制到输入框的命令以此开头）。 */
export const ACP_COMMAND_BASE = '/znacp'
