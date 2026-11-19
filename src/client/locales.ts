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
  | 'field.agent.cliArgs'
  | 'field.agent.env' | 'field.agent.invalidEnv'
  | 'field.agent.secretId' | 'field.agent.envVarName'
  | 'field.defaultAgent.label' | 'field.defaultAgent.hint'
  | 'field.autoAllow.label' | 'field.autoAllow.hint'
  | 'field.logEvents.label' | 'field.logEvents.hint'
  // agent picker 浮层
  | 'launcher.title' | 'launcher.close' | 'launcher.empty' | 'launcher.hint'
  | 'launcher.copy' | 'launcher.copied' | 'launcher.settings' | 'launcher.settingsHint'
  | 'launcher.terminal' | 'launcher.terminalOpening' | 'launcher.terminalOpened'
  | 'launcher.terminalNoSession' | 'launcher.terminalFailed'
  // 侧栏底栏按钮组
  | 'footer.launch' | 'footer.more'
  // 主会话区 CLI Agent 视图
  | 'view.label' | 'view.empty' | 'view.noService' | 'view.launching'
  | 'view.exited' | 'view.error' | 'view.restart'
  | 'view.sessions' | 'view.newSession' | 'view.history'
  | 'view.historyLoading' | 'view.historyFailed' | 'view.historyEmpty'
  | 'view.labelAttach' | 'view.labelNew' | 'view.labelResume'
  | 'view.agentPicker'
  | 'view.idleHint' | 'view.sessionLabel' | 'view.currentSession' | 'view.workspace'
  | 'view.switchedTo' | 'view.newCreated'
  | 'view.externalOpen' | 'view.externalOpening' | 'view.externalOpened' | 'view.externalFailed'
  // 工作区看板
  | 'board.title' | 'board.menuOpen' | 'board.newChat' | 'board.searchHint'
  | 'board.tabChat' | 'board.tabCli' | 'board.tabArtifacts' | 'board.tabConfig'
  | 'board.sessionUnit' | 'board.runningUnit'
  | 'board.noWorkspaces' | 'board.noSessions' | 'board.cliLoading' | 'board.noCliSessions'
  | 'board.resume' | 'board.archive' | 'board.archived'
  | 'board.stRunning' | 'board.stWaiting' | 'board.stDone' | 'board.stIdle'
  | 'board.openFailed' | 'board.createFailed' | 'board.cliOpened'

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
  'field.agent.args': 'ACP args (space separated)',
  'field.agent.cliArgs': 'CLI args (e.g. --dangerously-skip-permissions)',
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
  'launcher.hint': 'Paste a snippet into any DSH session. Calls auto-continue the agent\'s latest session; prefix with new for a fresh one (/znacp new qoder hi). Run /znacp sessions to browse history.',
  'launcher.copy': 'Copy /znacp snippet',
  'launcher.settings': 'Plugin settings',
  'launcher.settingsHint': 'Settings entry not found — use the app Settings → Plugins page and pick ACP Agent Client.',
  'launcher.copied': 'Copied',
  'launcher.terminal': 'Terminal',
  'launcher.terminalOpening': 'Opening terminal…',
  'launcher.terminalOpened': 'Opened in the terminal tab on the right.',
  'launcher.terminalNoSession': 'Open a session first — the terminal runs in that project.',
  'launcher.terminalFailed': 'Could not open the terminal.',
  'footer.launch': 'Launch',
  'footer.more': 'All agents',
  'view.label': 'CLI Agent',
  'view.empty': 'No ACP agents configured yet. Add one in Settings → Plugins → this bundle.',
  'view.noService': 'This deployment has no embedded-terminal service; use the /znacp command instead.',
  'view.launching': 'Starting the CLI…',
  'view.idleHint': 'No instance running. Pick ＋New session or a History entry above to open one.',
  'view.exited': 'Session ended.',
  'view.error': 'Error',
  'view.restart': 'Restart',
  'view.sessions': 'Session controls',
  'view.newSession': '＋ New session',
  'view.history': 'History',
  'view.historyLoading': 'Loading sessions…',
  'view.historyFailed': 'Failed to list sessions',
  'view.historyEmpty': 'No sessions in this workspace yet',
  'view.labelAttach': 'Attached session',
  'view.labelNew': 'New session',
  'view.labelResume': 'Resumed',
  'view.agentPicker': '选择 CLI agent',
  'view.sessionLabel': '会话',
  'view.currentSession': '当前会话',
  'view.workspace': '工作区',
  'view.switchedTo': '已切换到 ',
  'view.newCreated': '新会话已创建',
  'view.externalOpen': 'Open in external terminal',
  'view.externalOpening': 'Opening…',
  'view.externalOpened': 'Opened',
  'view.externalFailed': 'Open failed',
  'board.title': 'CLIAgents',
  'board.menuOpen': 'Open CLIAgents board',
  'board.newChat': 'New session',
  'board.searchHint': 'Search sessions',
  'board.tabChat': 'Sessions',
  'board.tabCli': 'CLI sessions',
  'board.tabArtifacts': 'Artifacts',
  'board.tabConfig': 'Setup',
  'board.sessionUnit': 'sessions',
  'board.runningUnit': 'running',
  'board.noWorkspaces': 'No workspaces yet',
  'board.noSessions': 'No sessions in this workspace',
  'board.cliLoading': 'Loading…',
  'board.noCliSessions': 'No CLI sessions in this workspace',
  'board.resume': 'Resume',
  'board.archive': 'Archive',
  'board.archived': 'Archived',
  'board.stRunning': 'Running',
  'board.stWaiting': 'Waiting for you',
  'board.stDone': 'Completed',
  'board.stIdle': 'Idle',
  'board.openFailed': 'Failed to open the session',
  'board.createFailed': 'Failed to create the session',
  'board.cliOpened': 'CLI resumed in a new session',
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
  'field.agent.args': 'ACP 参数(空格分隔)',
  'field.agent.cliArgs': 'CLI 参数(如 --dangerously-skip-permissions)',
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
  'launcher.hint': '把片段粘到任意 DSH 会话即可。对话会自动延续该 agent 最近的会话;想开新会话加 new 前缀(/znacp new qoder 你好)。输入 /znacp sessions 可查历史会话。',
  'launcher.copy': '复制 /znacp 片段',
  'launcher.settings': '插件设置',
  'launcher.settingsHint': '未找到设置入口，请在应用的「设置 → 插件」页里选择「ACP 智能体」。',
  'launcher.copied': '已复制',
  'launcher.terminal': '终端',
  'launcher.terminalOpening': '正在打开终端…',
  'launcher.terminalOpened': '已在右侧终端页签打开。',
  'launcher.terminalNoSession': '请先打开一个会话——终端会跑在当前项目目录。',
  'launcher.terminalFailed': '终端打开失败。',
  'footer.launch': '启动',
  'footer.more': '全部 agent',
  'view.label': 'CLI Agent',
  'view.empty': '还没有配置 ACP agent。到 设置 → 插件 → 本插件 添加。',
  'view.noService': '当前部署没有内嵌终端服务；请改用 /znacp 命令。',
  'view.launching': '正在启动 CLI…',
  'view.idleHint': '当前没有运行中的实例。用上方「＋新会话」或「历史」选择要打开的会话。',
  'view.exited': '会话已结束。',
  'view.error': '错误',
  'view.restart': '重启',
  'view.sessions': '会话控件',
  'view.newSession': '＋ 新会话',
  'view.history': '历史',
  'view.historyLoading': '正在加载会话…',
  'view.historyFailed': '会话列表加载失败',
  'view.historyEmpty': '当前工作区还没有会话',
  'view.labelAttach': '已接入会话',
  'view.labelNew': '新会话',
  'view.labelResume': '已还原',
  'view.externalOpen': '在外部终端打开',
  'view.agentPicker': '选择 CLI agent',
  'view.sessionLabel': '会话',
  'view.currentSession': '当前会话',
  'view.workspace': '工作区',
  'view.switchedTo': '已切换到 ',
  'view.newCreated': '新会话已创建',
  'view.externalOpening': '正在打开…',
  'view.externalOpened': '已打开',
  'view.externalFailed': '打开失败',
  'board.title': 'CLIAgents',
  'board.menuOpen': '打开 CLIAgents 看板',
  'board.newChat': '新会话',
  'board.searchHint': '搜索会话',
  'board.tabChat': '对话',
  'board.tabCli': 'CLI 会话',
  'board.tabArtifacts': '产物',
  'board.tabConfig': '配置',
  'board.sessionUnit': '个会话',
  'board.runningUnit': '运行中',
  'board.noWorkspaces': '暂无工作区',
  'board.noSessions': '该工作区还没有会话',
  'board.cliLoading': '加载中…',
  'board.noCliSessions': '该工作区还没有 CLI 会话',
  'board.resume': '恢复',
  'board.archive': '归档',
  'board.archived': '已归档',
  'board.stRunning': '运行中',
  'board.stWaiting': '等待你',
  'board.stDone': '已完成',
  'board.stIdle': '空闲',
  'board.openFailed': '打开会话失败',
  'board.createFailed': '创建会话失败',
  'board.cliOpened': '已在新会话中恢复 CLI',
}
