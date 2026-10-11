# Subagents

Claude Code-style subagents for pi. A subagent is a separate `pi --mode json -p` process with a fresh
context, running an agent type's prompt, tools and model; only its final report comes back. Each subagent
is a task in the shared registry: it runs in the foreground or background, can be backgrounded with Ctrl+B,
shows in `/tasks`, and can be stopped with `task_stop`.

```
pi install ./pip            # everything (recommended), or: pi install ./pip/subagents
```

## Tools

- **`agent`**: `{ description, prompt, subagent_type?, run_in_background?, model?, thinking?, isolation?: "worktree", cwd? }`
  - **Foreground (default):** blocks until done. Multiple `agent` calls in one message run in parallel.
  - **Background:** returns an agent id (`a…`) immediately; the report arrives as a `<task-notification>`.
  - **`isolation: "worktree"`:** runs in a `git worktree add --detach` under the temp directory. The worktree is removed if unchanged; otherwise the result says where the changes are.
  - **Result:** the final message plus a footer with agent id, tool-call count, duration and cost, and a note that the text is from the subagent, not the user. Usage counts toward session totals.
- **`send_message`**: `{ to, message, run_in_background? }` resumes a finished agent with its full history, type, tools, model and cwd.
  Sessions are stored under `~/.pi/agent/subagents/<parent-session-id>/` (`--session-id <agent id>` plus `<id>.meta.json`), so resuming survives a pi restart if you resume the same parent session.
- **`task_output`, `task_stop`**: shared with background-commands.
- **`/agents`**: lists agent types and where each is defined.

## Agent types

Markdown with YAML frontmatter. Only `name` and `description` are required:

```markdown
---
name: code-reviewer
description: Reviews diffs for bugs. Use after making changes.
tools: read, grep, find, bash          # allowlist; omit to inherit the default tools
disallowedTools: write                 # denylist (--exclude-tools)
model: anthropic/claude-sonnet-5       # omit or "inherit" for the caller's model
thinking: low
background: true                       # always run in the background
isolation: worktree
---
System prompt, appended to pi's own (so AGENTS.md and skills still load).
```

Loaded from, later overriding earlier:

1. bundled `agents/`: `general-purpose`, `explore`, `plan`
2. `~/.claude/agents/`
3. `~/.pi/agent/agents/`
4. project `.claude/agents/` and `.pi/agents/`, searched upward from the cwd (nearest wins; trusted projects only)

Claude Code tool names (`Read`, `Grep`, `Glob`, `Bash`, `WebFetch`, …) map to pi's. Agents with `bash` also get
`task_output` and `task_stop`. Agents whose allowlist omits `agent` can't spawn subagents.

## Limits

| Setting | Default | Notes |
|---|---|---|
| `PI_SUBAGENT_MAX_DEPTH` | 3 | Children get `PI_SUBAGENT_DEPTH`; at the limit, `agent` isn't registered |
| `PI_MAX_CONCURRENT_SUBAGENTS` | 20 | The error tells the model not to retry |

Background agents in non-interactive runs time out after 30 minutes (`PI_BACKGROUND_TIME_LIMIT_MS`).
Subagents never get `workflow`; workflow agents (`PI_WORKFLOW_CHILD=1`) never get `agent` or `send_message`.

## Notes

- Children are plain `pi` processes and load your installed packages and AGENTS.md.
- Install with `pi install` rather than `-e` so subagents also get background commands and can nest.
