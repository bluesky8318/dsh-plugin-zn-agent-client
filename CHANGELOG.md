# Changelog

All notable changes to this project are documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

English | [中文](CHANGELOG.zh.md)

## [Unreleased]

### Added

- **Per-session CLI instances** — every DSH session gets its own CLI agent instance (PTY key `DSH-session:agent`); switching sessions restores that session's live terminal (the PTY stays alive host-side).

### Removed

- Experimental workspace-sidebar integration (real-DSH-session seats, `＋CLI 会话` button, sidebar decorations, session-title pinning). Appending turn-structured events to a live session log violates the session format invariants and can corrupt session loading; the plugin no longer touches DSH session logs or titles at all.

## [0.2.0] - 2026-11-17

### Added

- **CLI Agent conversation view** — an embedded terminal (xterm.js + WebGL addon) in the main conversation area that runs local CLI agents (`qodercli`, `kimi`, `claude`, `codex`, …) on a plugin-owned PTY (host `subprocess.spawnTerminal` → SSE routes → client xterm).
- **Session management in the view** — agent dropdown with live status dots (green = PTY running), `＋新会话` for a fresh session, history popover listing per-agent × current-workspace sessions with real first-message titles and local timestamps, resume with the session's own worktree.
- **`/znacp` slash command** — agent list (★ marks the default), one-shot prompts with automatic session continuation, `sessions` subcommand, `new` prefix to force a fresh session; session-id prefixes accepted anywhere a session is referenced.
- **ACP tools** — `list_acp_agents`, `call_acp_agent` (session resume by id/prefix/`latest`, `newSession` flag, stop reason + token usage), `list_acp_sessions`; auto-resume keeps per-agent × cwd session handles in the profile's plugin-data directory.
- **Subagent provider `acp`** — the ACP capability exposed on `ctx.subagents` for delegation-side routing.
- **External terminal** — host tool `open_agent_in_external_terminal` (macOS Terminal / iTerm2 / Ghostty via osascript) and an "open in external terminal" button in the CLI Agent view, driven by a hand-built TypertRemote bridge (`znAgentClient/openExternal`).
- **Settings deep-link** — the launcher's ⚙ button opens the plugin's own bundle page via the host `pluginNavigation.openBundle` API.
- **Settings UI** — agents CRUD form rendered on the bundle page (`plugins.bundle.config`): per-agent ACP args, CLI launch args (`cliArgs`), env JSON, optional API-key fields; `defaultAgent`, `autoAllowPermissions`, `logEvents` toggles.
- **Launcher popup** — bottom-left anchored ACP agent picker with copy-to-clipboard `/znacp <agent> ` snippets, focus-leave/Escape/outside-click dismissal, sticky header.

### Changed

- Working directory always follows the current workspace — per-agent `workingDirectory` was removed from the config schema (cwd resolves from the live session, falling back to the process cwd).
- CLI agents launch through a login shell (`<shell> -il -c '<launch line>'`); CLI exit takes the PTY down, so no dangling shells are left behind.
- The host's resident message composer is hidden while the CLI Agent view is active (restored on tab switch).
- Plugin-spawned processes are marked with `ZN_AGENT_CLIENT_OWNED=1` in their environment.

### Fixed

- Route and service wiring on the long-lived plugin context (reference pattern), with self-healing route re-registration across plugin reloads.
- Session resume failures: live session object resolution (`snapshotEvents` crash), inactive-context reads, resume spawning in the wrong worktree.
- History listing: real first-message titles, current-workspace filtering, empty (unresumable) sessions dropped.
- Terminal layout: fit before connect so the TUI fills the view; height reference uses the host viewport band var (no page-height runaway); host width handles hidden while the view is active.
- Connecting-state deadlock: the terminal container renders while snapshots are loading.

## [0.1.0] - 2026-11-17

### Added

- Initial ACP client release: `call_acp_agent` / `list_acp_agents` tools, `acp` subagent provider, session lifecycle (new / load / resume), permission manager with auto-allow, terminal manager, settings form and locale resources.
- ACP connection layer ported from [obsidian-agent-client](https://github.com/rait-09/obsidian-agent-client): detached process-group spawn, NDJSON transport, initialize handshake, silent-failure detection with a rolling stderr buffer, replacement-safe process exit guard.
- E2E suite driving real ACP binaries (`claude-agent-acp`, `qodercli --acp`, `kimi acp`).
