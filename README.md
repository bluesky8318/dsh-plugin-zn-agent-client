# dsh-plugin-zn-agent-client

English | [中文](README.zh.md) | [Changelog](CHANGELOG.md)

DeepSeek Harness (`dsh`) plugin with two capabilities:

1. **ACP client** — call local CLI agents (Claude Code, Qoder CLI, Kimi, Codex, Gemini CLI, …) over the [Agent Client Protocol](https://agentclientprotocol.com) from inside a DSH session: tools, a `/znacp` slash command, and a subagent provider.
2. **CLI Agent views** — run the same agents' interactive TUIs inside DSH: an embedded terminal view in the conversation area with session management (new / history / resume), plus an external-terminal escape hatch. Every DSH session gets its own CLI instance, and a CLI session can be materialized as a real DSH session (a "seat") that shows up in the workspace sidebar with decorations and is findable via session search.

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

## Use

### In conversation (ACP)

- **`/znacp`** — list agents (★ = default); **`/znacp <agent> <message>`** — prompt an agent, automatically continuing its latest session in this workspace; **`/znacp new <message>`** — force a fresh session; **`/znacp sessions`** — list recent sessions.
- **Tools** (the model calls these): `list_acp_agents`, `call_acp_agent {agentId, prompt, sessionId?, newSession?}` (returns reply, session id, stop reason, token usage; `sessionId` accepts a full id, a unique prefix, or `latest`), `list_acp_sessions`.
- Delegation plugins can route work through the `acp` **subagent provider**.

### CLI Agent view

Open the view tab in the conversation area and pick an agent from the dropdown (live status dot: green = running). Sessions you started stay alive when you switch agents; `＋新会话` starts fresh; the history popover restores a past session in its own worktree. The terminal is a real PTY: full TUI interaction, resize-aware, WebGL-rendered. The external-terminal button opens the same agent in Terminal/iTerm2/Ghostty.

**Per-session isolation.** Terminal instances are keyed `DSH session × agent`: session A and session B each drive their own CLI, and switching back to A restores A's live terminal (the PTY stays alive host-side).

**Seats (`＋CLI 会话`).** The button creates a real DSH session for the CLI work: it appears in the workspace sidebar like a native session, opens directly on the CLI tab, and its title is pinned by the plugin (`CLI · <agent>`, later `CLI · <agent> · <first message>`) so DSH session search finds it. Idle seat rows show a leading agent chip; hovering reveals the CLI session id, workspace, and PTY state. Launching a CLI in any session registers it as a seat automatically. Seat mappings live in `~/.dsh/plugin-data/dsh-plugin-zn-agent-client/seats.json` and are safe to delete (display metadata only — the CLI's own session files stay untouched).

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
