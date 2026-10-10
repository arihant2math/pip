# Pi Improvement Plan (pip)

Claude Code-style features for pi. All three extensions share one task system: each long-running
piece of work is a task with an id and an output file. A task can block a tool call or run in the
background. When a background task finishes, the model receives a `<task-notification>`.

| Directory | What it adds |
|---|---|
| [`background-commands/`](background-commands/README.md) | `bash` gains `run_in_background`; long foreground commands are auto-backgrounded on timeout; Ctrl+B |
| [`subagents/`](subagents/README.md) | `agent` tool (types from `.pi/agents`, `.claude/agents` or bundled), `send_message` to resume, worktree isolation |
| [`dynamic-workflows/`](dynamic-workflows/README.md) | `workflow` tool: JS scripts that fan out to many subagents; can run in the background |
| [`shared/`](shared/README.md) | Task registry, notifications, `task_output`/`task_stop`, `/tasks`, the widget, the `pi -p` subagent runner |
| `subagent-guard.ts` | Older, standalone approach: tells the model to shell out to `pi -p` (does the same job as `subagents/`) |

```
pi install ./pip                 # all three (package.json lists them)
pi -e ./pip/background-commands -e ./pip/subagents -e ./pip/dynamic-workflows   # try for one run
```

You can also install the packages one at a time. Each one imports `../shared`, so keep the directory
layout as it is.

Typecheck everything with `npx -p typescript tsc -p .`.
