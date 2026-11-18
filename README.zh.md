# dsh-plugin-zn-agent-client

[English](README.md) | 中文 | [更新日志](CHANGELOG.md)

DeepSeek Harness（`dsh`）插件，提供两种能力：

1. **ACP 客户端** —— 在 DSH 会话内通过 [Agent Client Protocol](https://agentclientprotocol.com) 调用本机 CLI Agent（Claude Code、Qoder CLI、Kimi、Codex、Gemini CLI 等）：提供工具、`/znacp` 斜杠命令和子代理提供方。
2. **CLI Agent 视图** —— 在 DSH 里直接运行这些 agent 的交互式 TUI：会话区的内嵌终端视图，带会话管理（新建 / 历史 / 还原），并可随时转入外部终端。每个 DSH 会话拥有独立的 CLI 实例；CLI 会话还可物化为真实 DSH 会话（「座位」），出现在工作区侧栏、带装饰、可被会话搜索找到。

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

## 使用

### 会话内（ACP）

- **`/znacp`** —— 列出 agent（★ 为默认）；**`/znacp <agent> <消息>`** —— 向 agent 发一轮消息，自动延续它在当前工作区的最近会话；**`/znacp new <消息>`** —— 强制开新会话；**`/znacp sessions`** —— 列出最近会话。
- **工具**（由模型调用）：`list_acp_agents`、`call_acp_agent {agentId, prompt, sessionId?, newSession?}`（返回回复、会话 id、stop reason、token 用量；`sessionId` 接受完整 id、唯一前缀或 `latest`）、`list_acp_sessions`。
- 委派类插件可通过 `acp` **子代理提供方** 路由工作。

### CLI Agent 视图

在会话区打开视图 tab，从下拉里选 agent（状态点实时：绿 = 运行中）。切换 agent 不会关掉已开的会话；`＋新会话` 开新的；历史弹层可以把过去的会话还原到它自己的工作区。终端是真 PTY：完整 TUI 交互、随尺寸自适应、WebGL 渲染。外部终端按钮可在 Terminal/iTerm2/Ghostty 里打开同一个 agent。

**按会话隔离。** 终端实例按「DSH 会话 × agent」为键：会话 A 和会话 B 各自驱动独立 CLI，切回 A 即恢复 A 的活终端（PTY 在宿主侧保活）。

**座位（`＋CLI 会话`）。** 该按钮为 CLI 工作创建一个真实 DSH 会话：像原生会话一样出现在工作区侧栏，打开即落在 CLI 标签页；标题由插件钉住（`CLI · <agent>`，随后 `CLI · <agent> · <首条消息>`），DSH 会话搜索可以找到。空闲座位行显示 leading agent 芯片，悬停可看 CLI 会话 id、工作区与 PTY 状态。在任何会话里启动 CLI 都会自动登记为座位。座位映射存于 `~/.dsh/plugin-data/dsh-plugin-zn-agent-client/seats.json`，可随时删除（仅展示元数据——CLI 自己的会话文件不受影响）。

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
