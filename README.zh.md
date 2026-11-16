# dsh-plugin-zn-agent-client

[English](README.md) | 中文

让 DeepSeek Harness（`dsh`）成为 **Agent Client Protocol (ACP) 客户端** 的插件：在 DSH 会话内通过 stdio 调用本机 CLI Agent——Claude Code、Codex、Gemini CLI、opencode 等。

- **工具 `list_acp_agents`** —— 列出插件设置里配置的 agent
- **工具 `call_acp_agent`** —— 向指定 agent 发送一轮 prompt 并取回回复（含会话 id、stop reason、token 用量）
- **子代理提供方 `acp`** —— 同一能力接到 `ctx.subagents`，委派侧插件可以把工作路由给 ACP agent

ACP 连接层移植自 [obsidian-agent-client](https://github.com/rait-09/obsidian-agent-client)（`src/acp/`），保留其关键行为：detached 进程组 spawn、NDJSON 传输、initialize 握手、带滚动 stderr 缓冲的静默失败检测、替换安全的进程退出守卫。

## 安装

```sh
dsh plugin add dsh-plugin-zn-agent-client
```

（或通过插件页 / `plugin_manager install_bundle` 从源码安装 bundle。）

## 配置

在 设置 → 插件（或 `cordis.patch.yml`）里添加 agent：

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
        autoAllowPermissions: true   # 自动允许 agent 的权限请求
```

agent 命令遵循 ACP 预设表：`claude-agent-acp`（Claude Code）、`codex-acp`（Codex）、`gemini --experimental-acp`（Gemini CLI）、`opencode acp`、`kiro-cli acp`、`pi-acp`、`agy acp`（Antigravity）等。

## 开发

```sh
pnpm install --ignore-scripts
pnpm typecheck        # tsc --noEmit
pnpm test:unit        # vitest
pnpm build            # tsdown → lib/
node test/smoke.mjs   # 构建产物冒烟
pnpm exec node test/e2e-acp.mjs   # 对接真实 claude-agent-acp 的 E2E（需二进制可用）
```

设计说明：[docs/DESIGN.md](docs/DESIGN.md)。

## 许可

MIT
