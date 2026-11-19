# dsh-plugin-zn-agent-client

[English](README.md) | 中文 | [更新日志](CHANGELOG.zh.md)

DeepSeek Harness（`dsh`）插件，提供三种能力：

1. **ACP 客户端** —— 在 DSH 会话内通过 [Agent Client Protocol](https://agentclientprotocol.com) 调用本机 CLI Agent（Claude Code、Qoder CLI、Kimi、Codex、Gemini CLI 等）：提供工具、`/znacp` 斜杠命令和子代理提供方。
2. **工作区看板** —— 浏览当前工作区的 DSH 与 CLI 会话、预览对话，查看或编辑工作区的 `AGENTS.md`。
3. **CLI Agent 视图** —— 在内嵌终端运行交互式 TUI，管理独立会话（新建 / 历史 / 还原），打开外部终端，并把 DSH 对话交接给新的 CLI 会话。

当前版本：**0.3.0**。要求 DSH **>=0.2.2-rc.3**、Node.js **^22.19.0 或 >=24.0.0**；各 CLI Agent 需在本机单独安装并完成认证。

ACP 连接层移植自 [obsidian-agent-client](https://github.com/rait-09/obsidian-agent-client)，保留其关键行为：detached 进程组 spawn、NDJSON 传输、initialize 握手、带滚动 stderr 缓冲的静默失败检测、替换安全的进程退出守卫。

## 安装

三种方式任选其一。

### 插件页手动安装

1. Clone 本仓库，或记住 Git 地址 `https://github.com/bluesky8318/dsh-plugin-zn-agent-client.git`。
2. 打开 **设置 → 插件**，点 **添加插件**（`＋` 按钮）→ **安装第三方插件**。
3. 输入安装 spec —— 本地源码目录、上面的 Git 地址、或 npm 包名 —— 确认安装。
4. 在列表里启用 `dsh-plugin-zn-agent-client` 行。

### `dsh` 命令行安装

```sh
git clone https://github.com/bluesky8318/dsh-plugin-zn-agent-client.git
dsh plugin --profile desktop add /path/to/dsh-plugin-zn-agent-client
# 也可以直接从 Git 装：
dsh plugin --profile desktop add https://github.com/bluesky8318/dsh-plugin-zn-agent-client.git
```

这只把包装进 profile；装完还需在插件页启用。

### 让 DSH 智能体安装

在任意 DSH 会话里说一句即可，智能体会代为执行：

```text
请安装并启用插件 dsh-plugin-zn-agent-client：
从 GitHub 仓库 bluesky8318/dsh-plugin-zn-agent-client 安装 bundle。
```

（或指向本地 clone：`从本地目录 /path/to/dsh-plugin-zn-agent-client 安装 bundle 并启用`。）

智能体会使用 `plugin_manager` 工具（先 `install_bundle` 安装、再 `set_plugin` 启用），安装前会向你请求批准。

## 配置

打开 **设置 → 插件 → dsh-plugin-zn-agent-client**（启动弹框的 ⚙ 按钮可直达本页）添加 agent，或修改 `cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-plugin-zn-agent-client
      config:
        agents:
          - id: qoder            # 工具与 /znacp 使用的句柄
            displayName: Qoder CLI
            command: qodercli
            args: ["--acp"]      # ACP 模式参数（工具 + /znacp）
          - id: kimi
            displayName: Kimi CLI
            command: kimi
            args: ["acp"]
          - id: claude-code
            displayName: Claude Code
            command: claude
            cliArgs: ["--dangerously-skip-permissions"]  # TUI 参数（CLI Agent 视图 / 外部终端）
        defaultAgent: qoder
        autoAllowPermissions: true   # 自动同意 ACP 权限请求
        logEvents: false             # 会话事件详细日志
```

每个 agent 可配：`id`、`displayName`、`command`、`args`（ACP 模式）、可选 `cliArgs`（TUI 模式）、`env`（JSON 对象）、可选 `apiKey`（`secretId` + `envVarName`，注入 agent 进程环境）。工作目录不按 agent 配置——始终跟随当前 DSH 工作区。

常见 ACP 入口：`claude-agent-acp`、`codex-acp`、`gemini --experimental-acp`、`opencode acp`、`kiro-cli acp`、`pi-acp`、`agy acp`、`qodercli --acp`、`kimi acp`。

### 设置页布局

设置页按三块折叠展示，默认收起：

- **ACP + CLI 配置**：Agent 名册、默认 Agent、权限自动批准与事件日志。
- **工作区项目配置**：指向看板内按工作区维护的配置页签；`AGENTS.md` 不是全局插件设置。
- **CLI Agent 视图**：Handoff 模式、接手说明和 LLM 网关配置，字段直接显示内置默认值。

### Handoff LLM 配置与凭据

LLM 摘要可选，默认关闭。在 **CLI Agent 视图** 分区配置：

| 设置 | 默认值 |
|---|---|
| `handoffLlm` | `false`（提取式摘要，不调用摘要 API） |
| `handoffTail` | 要求接手 Agent 列出未竟工作，并确认需要继续哪些工作的接手说明 |
| `handoffLlmBaseUrl` | `http://127.0.0.1:3425/v1` |
| `handoffLlmModel` | `group/smart-split` |
| `handoffLlmApiKeyEnv` | `MAGPIE_GATEWAY_KEY`，这是环境变量**名称**，不是密钥 |
| `handoffLlmPrompt` | 按任务目标、已完成、未完成与下一步、关键决定与原因、失败与教训组织的中文摘要提示词；设置页完整显示并可编辑 |

默认地址和模型适用于本机 Magpie 网关，插件不会安装该网关；也可替换为自己的 OpenAI 兼容 `/v1` 地址与模型。插件从 **DSH 宿主进程**的指定环境变量读取密钥，作为 Bearer Token；未设置时不发送鉴权头。请在启动 DSH 前安全注入环境变量，改变进程环境后重启 DSH。

不要把真实 API Key 写入 README 示例、`cordis.patch.yml`、被 Git 跟踪的 `env` 配置或提交记录。各 Agent 的 API Key 可通过已有的 `secretId` 引用与 `envVarName` 注入；Handoff 使用上面的环境变量名。LLM 模式会把对话文本发送到所配置的端点，该端点可能转发给远程服务商，确认前请留意敏感信息及服务条款。提取式摘要本身不调用 LLM，但接手的 CLI Agent 仍可能产生模型费用。

## 使用

### 会话内（ACP）

- **`/znacp`** —— 列出 agent（★ 为默认）；**`/znacp <agent> <消息>`** —— 向 agent 发一轮消息，自动延续它在当前工作区的最近会话；**`/znacp new <消息>`** —— 强制开新会话；**`/znacp sessions`** —— 列出最近会话。
- **工具**（由模型调用）：`list_acp_agents`、`call_acp_agent {agentId, prompt, sessionId?, newSession?}`（返回回复、会话 id、stop reason、token 用量；`sessionId` 接受完整 id、唯一前缀或 `latest`）、`list_acp_sessions`。
- 委派类插件可通过 `acp` **子代理提供方** 路由工作。

### CLI Agent 视图

在会话区打开视图 tab，从下拉里选 agent（状态点实时：绿 = 运行中）。切换 agent 不会关掉已开的会话；`＋新会话` 开新的；历史弹层可以把过去的会话还原到它自己的工作区。终端是真 PTY：完整 TUI 交互、随尺寸自适应、WebGL 渲染。外部终端按钮可在 Terminal/iTerm2/Ghostty 里打开同一个 agent。

**按会话隔离。** 终端实例按「DSH 会话 × agent」为键：会话 A 和会话 B 各自驱动独立 CLI，切回 A 即恢复 A 的活终端（PTY 在宿主侧保活）。

### 工作区看板

在工作区行菜单中打开 **CLI Agent看板**。看板跟随所选工作区，提供四个页签：

- **DSH 会话**：搜索、排序、按状态筛选；点击行查看原生只读对话预览，用显式打开按钮进入真实会话。预览定位到最新消息，并支持历史分页。
- **CLI 会话**：按 Agent 浏览历史，预览支持的对话记录（助手回复以 Markdown 渲染），复制恢复命令或打开外部终端。要在 CLI Agent 视图恢复，可把命令粘贴到该视图；看板不会自动把 CLI 会话关联到 DSH 会话。
- **工作区配置**：查看、创建或编辑 `AGENTS.md`，并提供 Markdown 预览。
- **分析**：预留占位，尚未实现分析功能。

插件不修改 DSH 会话日志或标题；早期实验性的侧栏会话座位集成已移除。

### Handoff DSH

1. 在 CLI Agent 视图选择接手 Agent，点击 **Handoff DSH**。
2. 查看生成的交接文档。提取式包含任务目标、可用的 goal/todo 状态及最多 40 条最近消息，并做长度限制。默认接手说明要求先列出未竟工作，再确认继续哪些任务。
3. 可选择 LLM 摘要。每次 LLM 请求前都会二次确认，提示费用与耗时；失败时回落提取式。
4. 确认交接后，新建 CLI 会话，并将文档作为首条提示词。Kimi 使用先创建、再恢复的两阶段流程。

预览弹窗不会因失去焦点、点击遮罩或按 Escape 而关闭，需使用关闭或取消控件显式关闭。窄屏工具栏会自动换行，不再挤压 Agent 选择器。

## 架构

- **宿主侧**（`src/index.ts`、`src/acp/`）：ACP 客户端管理（spawn + NDJSON + 握手 + 会话）、权限/终端管理器、会话索引、`/znacp` 命令、工具、子代理提供方、PTY 控制器 + `/api/zn-agent-client/*` SSE 路由、TypertRemote 服务。
- **客户端**（`src/client/`）：bundle 页配置表单、agent 启动弹框、CLI Agent 会话视图（agent 流 + 内嵌 xterm + 会话 UI）、外部终端桥。

## 开发

```sh
pnpm install --ignore-scripts
pnpm typecheck        # tsc --noEmit
pnpm test:unit        # vitest
pnpm build            # tsdown → lib/
pnpm smoke            # 对构建产物跑冒烟
pnpm test             # typecheck + 单测 + 构建 + 冒烟
```

真实二进制的 E2E 在 `test/e2e-qoder.mjs`（ACP）与 `test/e2e-plan-c.mjs`（PTY 路由）。

设计文档：[docs/DESIGN.md](docs/DESIGN.md)。

## 许可

MIT
