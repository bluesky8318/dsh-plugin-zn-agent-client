# dsh-plugin-zn-agent-client

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) plugin that turns DSH into an **Agent Client Protocol (ACP) client**: call local CLI agents — Claude Code, Codex, Gemini CLI, opencode, Kiro, and more — over stdio, from inside a DSH session.

- **Tool `list_acp_agents`** — lists the agents configured in plugin settings
- **Tool `call_acp_agent`** — sends a prompt to one agent and returns its reply (session id, stop reason, token usage included)
- **Subagent provider `acp`** — the same capability exposed on `ctx.subagents`, so delegation-side plugins can route work to ACP agents

The ACP connection layer is ported from [obsidian-agent-client](https://github.com/rait-09/obsidian-agent-client) (`src/acp/`), keeping its hard-won behaviours: detached process-group spawn, NDJSON transport, initialize handshake, silent-failure detection with a rolling stderr buffer, and a replacement-safe process exit guard.

## Install

```sh
dsh plugin add dsh-plugin-zn-agent-client
```

(or install the bundle from source via the Plugins page / `plugin_manager install_bundle`.)

## Configure

Add agents in Settings → Plugins (or in `cordis.patch.yml`):

```yaml
- insert:
    - id: dsh-plugin-zn-agent-client
      config:
        agents:
          - id: claude-code
            displayName: Claude Code
            command: claude-agent-acp
            args: []
            workingDirectory: /path/to/workdir
        defaultAgent: claude-code
        autoAllowPermissions: true   # auto-approve agent permission requests
```

Agent commands follow the ACP preset table: `claude-agent-acp` (Claude Code), `codex-acp` (Codex), `gemini --experimental-acp` (Gemini CLI), `opencode acp`, `kiro-cli acp`, `pi-acp`, `agy acp` (Antigravity), etc.

## Development

```sh
pnpm install --ignore-scripts
pnpm typecheck        # tsc --noEmit
pnpm test:unit        # vitest
pnpm build            # tsdown → lib/
node test/smoke.mjs   # smoke over built lib
pnpm exec node test/e2e-acp.mjs   # real E2E against claude-agent-acp (needs the binary)
```

Design notes: [docs/DESIGN.md](docs/DESIGN.md).

## License

MIT
