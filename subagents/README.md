# Subagents

Claude Code-style subagents for pi. A subagent is a separate `pi --mode json -p` process with a
fresh context window. It runs an agent type's prompt, tools and model, and only its final report
comes back. Each subagent is a task in the shared registry, so it can run in the foreground or the
background, be moved there with Ctrl+B, appear in `/tasks`, and be stopped with `task_stop`.

```
pi install ./pip            # everything (recommended), or: pi install ./pip/subagents
```

## Tools

- **`agent`**: `{ description, prompt, subagent_type?, run_in_background?, model?, thinking?, isolation?: "worktree", cwd? }`
  - **Foreground (default):** blocks until the subagent finishes. Several `agent` calls in one message run in parallel, because pi runs tool calls concurrently.
  - **Background:** returns an agent id (`a…`) at once. The report arrives later as a `<task-notification>`.
  - **`isolation: "worktree"`:** runs the agent in `git worktree add --detach` under the temp directory. If the agent changed nothing, the worktree is removed. Otherwise the result tells the model where the changes are.
  - **Result:** the agent's final message, a footer with the agent id, tool-call count, duration and cost, and a reminder that the text comes from the subagent and not the user. Usage is added to the session totals.
- **`send_message`**: `{ to, message, run_in_background? }` resumes a finished agent with its full history.
  - The agent keeps its type, tools, model and cwd.
  - Subagent sessions are saved under `~/.pi/agent/subagents/<parent-session-id>/` as `--session-id <agent id>`, together with `<id>.meta.json`, so resuming also works after restarting pi, as long as you resume the same parent session.
- **`task_output`, `task_stop`**: shared with background-commands.
- **`/agents`**: lists the available agent types and where each definition comes from.

## Agent types

Each type is a Markdown file with YAML frontmatter. Only `name` and `description` are required:

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

Definitions are loaded from these locations, later ones overriding earlier ones:

1. bundled `agents/` in this package: `general-purpose`, `explore` and `plan`
2. `~/.claude/agents/`
3. `~/.pi/agent/agents/`
4. project `.claude/agents/` and `.pi/agents/`, searched upward from the cwd. The nearest directory wins, and these are only loaded for trusted projects.

Claude Code tool names (`Read`, `Grep`, `Glob`, `Bash`, `WebFetch`, …) are translated to pi's tool names.
If an agent has `bash`, it also gets `task_output` and `task_stop`.
If an allowlist doesn't include `agent`, that agent can't spawn subagents of its own.

## Limits

| Setting | Default | Notes |
|---|---|---|
| `PI_SUBAGENT_MAX_DEPTH` | 3 | Children get `PI_SUBAGENT_DEPTH`. At the limit, the `agent` tool isn't registered |
| `PI_MAX_CONCURRENT_SUBAGENTS` | 20 | The error message tells the model not to retry |

Background agents in non-interactive runs have a 30-minute time limit (`PI_BACKGROUND_TIME_LIMIT_MS`).
Subagents never get the `workflow` tool, and workflow agents (`PI_WORKFLOW_CHILD=1`) never get `agent` or `send_message`.

## Notes

- Children are plain `pi` processes, so they load your installed packages and AGENTS.md.
- Install this package with `pi install` instead of loading it with `-e`. Then subagents also get background commands and can nest.
