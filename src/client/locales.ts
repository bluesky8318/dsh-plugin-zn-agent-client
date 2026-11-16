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
  // 配置卡片
  | 'card.title' | 'card.description' | 'card.loading' | 'card.unavailable'
  | 'card.readOnly' | 'card.saveFailed' | 'card.save' | 'card.saving'
  | 'card.reset' | 'card.overridden'
  | 'field.agents.label' | 'field.agents.hint' | 'field.agents.add' | 'field.agents.remove'
  | 'field.agents.unnamed'
  | 'field.agent.id' | 'field.agent.displayName' | 'field.agent.command' | 'field.agent.args'
  | 'field.agent.workingDirectory' | 'field.agent.env' | 'field.agent.invalidEnv'
  | 'field.agent.secretId' | 'field.agent.envVarName'
  | 'field.defaultAgent.label' | 'field.defaultAgent.hint'
  | 'field.autoAllow.label' | 'field.autoAllow.hint'
  | 'field.logEvents.label' | 'field.logEvents.hint'
  // agent picker 浮层
  | 'launcher.title' | 'launcher.close' | 'launcher.empty' | 'launcher.hint'
  | 'launcher.copy' | 'launcher.copied'

/** 英文文案。 */
export const en: Record<ZnAgentClientLocaleKey, string> = {
  'sidebar.label': 'ACP agents',
  'card.title': 'ACP agent client',
  'card.description': 'Call local CLI agents (Claude Code, Qoder CLI, Codex, ...) over ACP from any DSH session.',
  'card.loading': 'Loading settings…',
  'card.unavailable': 'Settings are not served yet; configure agents via cordis.patch.yml for now.',
  'card.readOnly': 'Settings are read-only in this deployment; changes must go through cordis.patch.yml.',
  'card.saveFailed': 'Saving failed. Your draft is kept — try again.',
  'card.save': 'Save',
  'card.saving': 'Saving…',
  'card.reset': 'Reset',
  'card.overridden': 'overridden',
  'field.agents.label': 'Agents',
  'field.agents.hint': 'Each agent is one ACP-speaking CLI. The command must accept an ACP stdio mode (e.g. qodercli --acp).',
  'field.agents.add': '+ Add agent',
  'field.agents.remove': 'Remove',
  'field.agents.unnamed': 'unnamed',
  'field.agent.id': 'ID',
  'field.agent.displayName': 'Display name',
  'field.agent.command': 'Command',
  'field.agent.args': 'Arguments (space separated)',
  'field.agent.workingDirectory': 'Working directory',
  'field.agent.env': 'Extra env (JSON)',
  'field.agent.invalidEnv': 'Extra env must be a valid JSON object.',
  'field.agent.secretId': 'Secret ID (optional)',
  'field.agent.envVarName': 'Env var name (optional)',
  'field.defaultAgent.label': 'Default agent ID',
  'field.defaultAgent.hint': 'Used when no agentId is given (call_acp_agent, /znacp, subagent provider).',
  'field.autoAllow.label': 'Auto-allow permissions',
  'field.autoAllow.hint': 'Automatically approve the agent\u2019s tool-permission requests.',
  'field.logEvents.label': 'Diagnostic logging',
  'field.logEvents.hint': 'Log process lifecycle and stderr summaries to the host console.',
  'launcher.title': 'ACP agents',
  'launcher.close': 'Close',
  'launcher.empty': 'No ACP agents configured yet. Add one in Settings → Plugins → this bundle.',
  'launcher.hint': 'Paste the copied snippet into any DSH session, or just run /znacp to list agents. Session history lives on the agent side; list_acp_sessions shows reusable handles.',
  'launcher.copy': 'Copy /znacp snippet',
  'launcher.copied': 'Copied',
}

/** 中文文案。 */
export const zh: Record<ZnAgentClientLocaleKey, string> = {
  'sidebar.label': 'ACP 智能体',
  'card.title': 'ACP 智能体客户端',
  'card.description': '在任意 DSH 会话里通过 ACP 调用本机 CLI agent(Claude Code、Qoder CLI、Codex 等)。',
  'card.loading': '设置读取中…',
  'card.unavailable': '设置命名空间尚未生效;暂时请通过 cordis.patch.yml 配置 agent。',
  'card.readOnly': '当前部署下设置只读;修改需走 cordis.patch.yml。',
  'card.saveFailed': '保存失败。草稿已保留,可重试。',
  'card.save': '保存',
  'card.saving': '保存中…',
  'card.reset': '还原',
  'card.overridden': '已覆盖',
  'field.agents.label': 'Agent 清单',
  'field.agents.hint': '每个 agent 是一个支持 ACP 的 CLI,命令需带 ACP stdio 模式(如 qodercli --acp)。',
  'field.agents.add': '+ 添加 agent',
  'field.agents.remove': '删除',
  'field.agents.unnamed': '未命名',
  'field.agent.id': 'ID',
  'field.agent.displayName': '显示名',
  'field.agent.command': '命令',
  'field.agent.args': '参数(空格分隔)',
  'field.agent.workingDirectory': '工作目录',
  'field.agent.env': '额外环境变量(JSON)',
  'field.agent.invalidEnv': '额外环境变量必须是合法的 JSON 对象。',
  'field.agent.secretId': 'Secret ID(可选)',
  'field.agent.envVarName': '环境变量名(可选)',
  'field.defaultAgent.label': '默认 agent ID',
  'field.defaultAgent.hint': '未指定 agentId 时使用(call_acp_agent、/znacp、子代理提供方)。',
  'field.autoAllow.label': '自动允许权限请求',
  'field.autoAllow.hint': '自动批准 agent 的工具权限请求,不再逐条确认。',
  'field.logEvents.label': '诊断日志',
  'field.logEvents.hint': '把进程生命周期与 stderr 摘要输出到宿主控制台。',
  'launcher.title': 'ACP 智能体',
  'launcher.close': '关闭',
  'launcher.empty': '还没有配置 ACP agent。到 设置 → 插件 → 本插件 添加。',
  'launcher.hint': '把复制好的片段粘到任意 DSH 会话,或直接输入 /znacp 查看清单。会话历史保存在 agent 侧;list_acp_sessions 可查可续聊的句柄。',
  'launcher.copy': '复制 /znacp 片段',
  'launcher.copied': '已复制',
}
