# Pi Improvement Plan (pip)

Claude Code-style tasks for pi: background commands, subagents, and dynamic workflows
Each long-running piece of work is a task with an id and an output file.
A task can block a tool call or run in the background. When a background task finishes, the model receives a `<task-notification>`.

| Directory                                               | What it adds                                                                                                                                                                                      |
|---------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| [`background-commands/`](background-commands/README.md) | `bash` gains `run_in_background`; long foreground commands are auto-backgrounded on timeout; Ctrl+B                                                                                               |
| [`subagents/`](subagents/README.md)                     | `agent` tool (types from `.pi/agents`, `.claude/agents` or bundled), `send_message` to resume, worktree isolation                                                                                 |
| [`dynamic-workflows/`](dynamic-workflows/README.md)     | `workflow` tool: JS scripts that fan out to many subagents; can run in the background                                                                                                             |
| [`shared/`](shared/README.md)                           | Task registry, notifications, `task_output`/`task_stop`, `/tasks`, the widget, the `pi -p` subagent runner                                                                                        |
| [`pi-claude-code-use/`](pi-claude-code-use/README.md)   | Vendored [@benvargas/pi-claude-code-use](https://github.com/ben-vargas/pi-packages): patches Anthropic OAuth payloads and aliases extension tools as `mcp__*` (standalone, doesn't use `shared/`) |

## Installation

From git:

```shell
pi install git:github.com/arihant2math/pip
```

From a local clone:

```shell
pi install ./pip
```

## Experimentation

```shell
pi -e ./pip/background-commands -e ./pip/subagents -e ./pip/dynamic-workflows -e ./pip/pi-claude-code-use
```

## Development

Typecheck: `npx -p typescript tsc -p .`.
