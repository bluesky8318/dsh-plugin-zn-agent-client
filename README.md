# dsh-plugin-zn-agent-client

English | [中文](README.zh.md) | [Changelog](CHANGELOG.md)

DeepSeek Harness (`dsh`) plugin with three capabilities:

1. **ACP client** — call local CLI agents (Claude Code, Qoder CLI, Kimi, Codex, Gemini CLI, …) over the [Agent Client Protocol](https://agentclientprotocol.com) from inside a DSH session: tools, a `/znacp` slash command, and a subagent provider.
2. **Workspace board** — browse DSH and CLI sessions in the current workspace, preview conversations, and view or edit the workspace's `AGENTS.md`.
3. **CLI Agent views** — run interactive TUIs in an embedded terminal, manage isolated sessions (new / history / resume), open an external terminal, and hand off a DSH conversation to a new CLI session.

Current release: **0.3.0**. Requires DSH **>=0.2.2-rc.3** and Node.js **^22.19.0 or >=24.0.0**; local CLI agents must be installed and authenticated separately.

The ACP connection layer is ported from [obsidian-agent-client](https://github.com/rait-09/obsidian-agent-client) and keeps its hard-won behaviours: detached process-group spawn, NDJSON transport, initialize handshake, silent-failure detection with a rolling stderr buffer, and a replacement-safe process exit guard.

## Install

Three ways to install; pick one.

### From the Plugins page (manual)

1. Clone this repo, or note the Git URL `https://github.com/bluesky8318/dsh-plugin-zn-agent-client.git`.
2. Open **Settings → Plugins** and click **Add plugin** (the `＋` button) → **Install a third-party plugin**.
3. Enter the install spec — a local source directory, the Git URL above, or an npm package name — and confirm.
4. Enable the `dsh-plugin-zn-agent-client` row in the list.

### From the `dsh` CLI

```sh
git clone https://github.com/bluesky8318/dsh-plugin-zn-agent-client.git
dsh plugin --profile desktop add /path/to/dsh-plugin-zn-agent-client
# …or straight from Git:
dsh plugin --profile desktop add https://github.com/bluesky8318/dsh-plugin-zn-agent-client.git
```

This adds the package into the profile; enable it on the Plugins page afterwards.

### Ask the DSH agent

Say it in any DSH session — the agent runs the install for you:

```text
请安装并启用插件 dsh-plugin-zn-agent-client：
从 GitHub 仓库 bluesky8318/dsh-plugin-zn-agent-client 安装 bundle。
```

(or point it at a local clone: `从本地目录 /path/to/dsh-plugin-zn-agent-client 安装 bundle 并启用`.)

The agent uses the `plugin_manager` tool (`install_bundle`, then `set_plugin` to enable) and will ask for your approval before installing.

## Configure

Open **Settings → Plugins → dsh-plugin-zn-agent-client** (the launcher's ⚙ button deep-links straight to this page) and add agents, or patch `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-plugin-zn-agent-client
      config:
        agents:
          - id: qoder            # handle used by tools and /znacp
            displayName: Qoder CLI
            command: qodercli
            args: ["--acp"]      # ACP mode args (tools + /znacp)
          - id: kimi
            displayName: Kimi CLI
            command: kimi
            args: ["acp"]
          - id: claude-code
            displayName: Claude Code
            command: claude
            cliArgs: ["--dangerously-skip-permissions"]  # TUI args (CLI Agent view / external terminal)
        defaultAgent: qoder
        autoAllowPermissions: true   # auto-approve ACP permission requests
        logEvents: false             # verbose session-update logging
```

Per agent: `id`, `displayName`, `command`, `args` (ACP mode), optional `cliArgs` (TUI mode), `env` (JSON object), optional `apiKey` (`secretId` + `envVarName`, injected into the agent process env). The working directory is not configured per agent — it always follows the current DSH workspace.

Typical ACP entry points: `claude-agent-acp`, `codex-acp`, `gemini --experimental-acp`, `opencode acp`, `kiro-cli acp`, `pi-acp`, `agy acp`, `qodercli --acp`, `kimi acp`.

### Settings layout

The settings page has three collapsible sections, initially closed:

- **ACP + CLI configuration** — agent definitions, default agent, permission approval, and event logging.
- **Workspace project configuration** — directs you to the board's per-workspace configuration tab; `AGENTS.md` is not a global plugin setting.
- **CLI Agent view** — Handoff mode, handoff instructions, and LLM gateway settings. Built-in defaults are displayed in the fields.

### Handoff LLM settings and credentials

LLM summarization is optional and disabled by default. Configure these fields under **CLI Agent view**:

| Setting | Default |
|---|---|
| `handoffLlm` | `false` (extractive summary; no summarization API call) |
| `handoffTail` | Instructions asking the receiving agent to list unfinished work and confirm what to continue |
| `handoffLlmBaseUrl` | `http://127.0.0.1:3425/v1` |
| `handoffLlmModel` | `group/smart-split` |
| `handoffLlmApiKeyEnv` | `MAGPIE_GATEWAY_KEY` — an environment-variable **name**, not a key |
| `handoffLlmPrompt` | Chinese summary prompt covering goals, completed work, next steps, decisions, and lessons; fully visible and editable in settings |

The default address/model assumes a local Magpie gateway; the plugin does not install it. Replace them with your own OpenAI-compatible `/v1` endpoint and model if needed. The plugin reads the key from the named environment variable in the **DSH host process** and uses it as a Bearer token; if unset, the request is sent without an authorization header. Set the variable securely before starting DSH, and restart DSH after changing its environment.

Never put real API keys in README examples, `cordis.patch.yml`, tracked `env` configuration, or Git commits. Per-agent API keys can use the existing `secretId` reference plus `envVarName`; Handoff uses the environment-variable name above. LLM mode sends conversation text to the configured endpoint, which may forward it to a remote provider; review sensitive content and provider terms before confirming. Extractive summarization itself makes no LLM call, but the receiving CLI agent may still incur usage charges.

## Use

### In conversation (ACP)

- **`/znacp`** — list agents (★ = default); **`/znacp <agent> <message>`** — prompt an agent, automatically continuing its latest session in this workspace; **`/znacp new <message>`** — force a fresh session; **`/znacp sessions`** — list recent sessions.
- **Tools** (the model calls these): `list_acp_agents`, `call_acp_agent {agentId, prompt, sessionId?, newSession?}` (returns reply, session id, stop reason, token usage; `sessionId` accepts a full id, a unique prefix, or `latest`), `list_acp_sessions`.
- Delegation plugins can route work through the `acp` **subagent provider**.

### CLI Agent view

Open the view tab in the conversation area and pick an agent from the dropdown (live status dot: green = running). Sessions you started stay alive when you switch agents; `＋新会话` starts fresh; the history popover restores a past session in its own worktree. The terminal is a real PTY: full TUI interaction, resize-aware, WebGL-rendered. The external-terminal button opens the same agent in Terminal/iTerm2/Ghostty.

**Per-session isolation.** Terminal instances are keyed `DSH session × agent`: session A and session B each drive their own CLI, and switching back to A restores A's live terminal (the PTY stays alive host-side).

### Workspace board

Open **CLI Agent看板** from a workspace row's menu. The board follows the selected workspace and provides four tabs:

- **DSH sessions** — search, sort, and filter sessions; click a row for a native, read-only conversation preview. Use the explicit open button to switch to the actual session. The preview scrolls to the latest message and supports history pagination.
- **CLI sessions** — browse per-agent history, preview supported transcripts with Markdown assistant replies, copy a resume command, or open an external terminal. Paste the resume command into the CLI Agent view to resume there; the board does not automatically associate a CLI session with a DSH session.
- **Workspace configuration** — view, create, or edit `AGENTS.md`, with Markdown preview.
- **Analysis** — reserved placeholder; no analysis functionality yet.

The plugin does not modify DSH session logs or titles. The earlier experimental sidebar-seat integration has been removed.

### Handoff DSH

1. In the CLI Agent view, select the receiving agent and click **Handoff DSH**.
2. Review the generated document. Extractive mode includes the task goal, available goal/todo state, and up to 40 recent messages, with length limits. The default closing instructions ask the receiving agent to list unfinished work and confirm what to continue.
3. Optionally request an LLM summary. Every LLM request requires a second confirmation because it can cost money and take longer; failure falls back to the extractive summary.
4. Confirm the handoff to start a fresh CLI session with the document as its initial prompt. Kimi uses a two-stage create-and-resume flow.

The preview stays open when focus moves, when the backdrop is clicked, or when Escape is pressed; dismiss it explicitly with the close/cancel controls. Narrow toolbars wrap instead of compressing the agent selector.

## Architecture

- **Host** (`src/index.ts`, `src/acp/`): ACP client manager (spawn + NDJSON + handshake + sessions), permission/terminal managers, session index, `/znacp` command, tools, subagent provider, PTY controller + SSE routes under `/api/zn-agent-client/*`, TypertRemote service.
- **Client** (`src/client/`): settings form on the bundle page, agent launcher popup, CLI Agent conversation view (agent stream + embedded xterm + session UI), external-terminal bridge.

## Development

```sh
pnpm install --ignore-scripts
pnpm typecheck        # tsc --noEmit
pnpm test:unit        # vitest
pnpm build            # tsdown → lib/
pnpm smoke            # smoke over built lib
pnpm test             # typecheck + unit + build + smoke
```

E2E against real binaries lives in `test/e2e-qoder.mjs` (ACP) and `test/e2e-plan-c.mjs` (PTY routes).

Design notes: [docs/DESIGN.md](docs/DESIGN.md).

## License

MIT
