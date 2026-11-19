# 更新日志

本项目的所有显著变更都记录在此文件中。
格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。

[English](CHANGELOG.md) | 中文

## [Unreleased]

## [0.3.0] - 2026-11-19

### 新增

- **工作区看板** —— 从工作区菜单进入，包含 DSH 会话、CLI 会话、工作区配置和预留的分析页签，跟随所选工作区。
- **原生 DSH 对话预览** —— 通过 `SessionProvider` 使用宿主只读渲染，提供显式打开会话按钮、历史分页及最新消息定位。
- **CLI 历史预览与恢复** —— 支持的对话记录可预览，助手回复以 Markdown 渲染；可复制恢复命令、打开外部终端，并在 CLI Agent 视图粘贴命令恢复。
- **工作区 `AGENTS.md` 编辑器** —— 在看板查看、创建、编辑文件，并预览 Markdown。
- **Handoff DSH** —— 预览 DSH 会话快照，并作为首条提示词交给新建的 CLI 会话；提取式摘要包含目标、待办与最近消息，Kimi 使用先创建再恢复的流程。
- **可选 LLM 交接摘要** —— 可配置 OpenAI 兼容网关、模型、API Key 环境变量名、系统提示词与接手说明；每次请求前明确确认费用和耗时，失败时回落提取式。
- **按会话隔离的 CLI 实例** —— 每个 DSH 会话拥有独立的 CLI agent 实例（PTY 键 `DSH会话:agent`）；切回会话即恢复它的活终端（PTY 在宿主侧保活）。

### 变更

- 设置页分为默认收起的三块：ACP + CLI 配置、工作区项目配置、CLI Agent 视图；Handoff 默认配置直接显示在表单中。
- 默认接手说明要求接手 Agent 先列出未竟工作，再确认继续哪些任务。
- 声明 DSH 兼容范围 `>=0.2.2-rc.3`，客户端开发依赖更新到 `0.2.2-rc.5`（locale 保持 `0.1.7-rc.2`）。
- 中英文 README 补充看板与交接用法、环境要求、配置默认值及凭据管理说明。

### 修复

- Handoff 预览不再因失焦、点击遮罩或按 Escape 而关闭，需显式关闭或取消。
- 窄屏 CLI 工具栏自动换行，不再挤压 Agent 选择器；恢复命令输入框改用弹性宽度。
- 限定看板预览高度，恢复滚动和分页；修复工作区菜单注册时机及宿主工作区注册表注入。

### 移除

- 实验性的工作区侧栏集成（真实 DSH 会话座位、`＋CLI 会话` 按钮、侧栏装饰、会话标题钉住）。向活会话日志追加 turn 结构事件违反会话格式不变量，会导致会话加载损坏；插件不再触碰 DSH 会话日志与标题。

## [0.2.0] - 2026-11-17

### 新增

- **CLI Agent 会话视图** —— 会话区的内嵌终端（xterm.js + WebGL addon），在插件自有的 PTY 上运行本机 CLI agent（`qodercli`、`kimi`、`claude`、`codex` 等）（宿主 `subprocess.spawnTerminal` → SSE 路由 → 客户端 xterm）。
- **视图内的会话管理** —— agent 下拉框带实时状态点（绿 = PTY 运行中）、`＋新会话` 开新会话、历史弹层按 agent × 当前工作区列出会话（真实首条消息标题 + 本地时间戳），可把会话还原到它自己的工作区。
- **`/znacp` 斜杠命令** —— agent 列表（★ 标记默认）、单轮 prompt 自动延续会话、`sessions` 子命令、`new` 前缀强制新会话；任何引用会话的地方都接受会话 id 前缀。
- **ACP 工具** —— `list_acp_agents`、`call_acp_agent`（按 id/前缀/`latest` 续会话、`newSession` 标记、返回 stop reason + token 用量）、`list_acp_sessions`；自动续会话把每个 agent × 工作区的会话句柄保存在 profile 的 plugin-data 目录。
- **子代理提供方 `acp`** —— ACP 能力接入 `ctx.subagents`，供委派侧路由。
- **外部终端** —— 宿主工具 `open_agent_in_external_terminal`（macOS Terminal / iTerm2 / Ghostty，经 osascript）和 CLI Agent 视图里的「在外部终端打开」按钮，由手写 TypertRemote 桥（`znAgentClient/openExternal`）驱动。
- **设置直达** —— 启动弹框的 ⚙ 按钮经宿主 `pluginNavigation.openBundle` API 直达本插件的 bundle 页。
- **设置界面** —— bundle 页（`plugins.bundle.config`）上的 agents 增删改表单：每 agent 的 ACP 参数、CLI 启动参数（`cliArgs`）、env JSON、可选 API-key 字段；`defaultAgent`、`autoAllowPermissions`、`logEvents` 开关。
- **启动弹框** —— 左下角锚定的 ACP agent 选择器，带复制到剪贴板的 `/znacp <agent> ` 片段，焦点离开/Escape/点击外部收起，头部固定。

### 变更

- 工作目录始终跟随当前工作区——配置 schema 移除了每 agent 的 `workingDirectory`（cwd 从活动会话解析，退回进程 cwd）。
- CLI agent 经登录 shell 启动（`<shell> -il -c '<启动行>'`）；CLI 退出即带走 PTY，不遗留悬挂 shell。
- CLI Agent 视图激活时隐藏宿主的常驻消息输入框（切回时恢复）。
- 插件派生的进程在环境中标记 `ZN_AGENT_CLIENT_OWNED=1`。

### 修复

- 长生命周期插件上下文上的路由与服务接线（reference 模式），插件重载时路由重注册自愈。
- 会话还原失败：活动会话对象解析（`snapshotEvents` 崩溃）、inactive-context 读取、还原时起错工作区。
- 历史列表：真实首条消息标题、当前工作区过滤、剔除空（不可还原）会话。
- 终端布局：连接前先 fit 使 TUI 充满视图；高度参照改用宿主视口带变量（不再页面高度失控）；视图激活时隐藏宿主宽度拖柄。
- 连接态死锁：快照加载中就渲染终端容器。

## [0.1.0] - 2026-11-17

### 新增

- ACP 客户端初始版本：`call_acp_agent` / `list_acp_agents` 工具、`acp` 子代理提供方、会话生命周期（新建 / 加载 / 还原）、带自动同意的权限管理器、终端管理器、设置表单与语言资源。
- ACP 连接层移植自 [obsidian-agent-client](https://github.com/rait-09/obsidian-agent-client)：detached 进程组 spawn、NDJSON 传输、initialize 握手、带滚动 stderr 缓冲的静默失败检测、替换安全的进程退出守卫。
- 驱动真实 ACP 二进制（`claude-agent-acp`、`qodercli --acp`、`kimi acp`）的 E2E 套件。
