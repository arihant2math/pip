# Background Commands

Claude Code-style background shell commands for pi. Replaces the built-in `bash` tool with pi's own
definition (same process handling, truncation and renderer) plus a task layer.

```
pi install ./pip            # everything (recommended), or: pi install ./pip/background-commands
```

## Model-facing

- **`bash` with `run_in_background: true`**: returns a task id (`b…`) and output file immediately.
  A `<task-notification>` arrives when the command exits, so no polling.
- **Auto-background on timeout**: a foreground command still running after `timeout` (default 120s) is
  backgrounded instead of killed. Commands starting with `sleep` are still killed. With `run_in_background`,
  `timeout` is a kill deadline (max 2h).
- **`description`** (optional): short label for `/tasks` and notifications.
- **`task_output`** and **`task_stop`** (from `../shared/task-core.ts`): read or wait for a task, or kill its process tree.

## User-facing

- **Ctrl+B** backgrounds the running foreground command, subagent or workflow. A hint appears in the
  widget after 3s.
  - pi binds Ctrl+B to "cursor left" by default, so startup warns about a shortcut conflict.
    Silence it by adding `"tui.editor.cursorLeft": ["left"]` to `~/.pi/agent/keybindings.json`.
  - Change the key with `PI_BACKGROUND_KEY`, e.g. `ctrl+shift+b`.
- **Widget** below the editor lists running and recently finished background tasks.
- **`/tasks`** lists tasks and lets you view output or stop them; `/tasks stop <id>` stops one directly.
  The model is notified when you stop a task, but not when it stops one itself with `task_stop`.

## Behavior

| Situation                                                    | Result                                                                                                                                        |
|--------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------|
| Background command exits (interactive)                       | `<task-notification>` (status, exit code, last 1.5KB of output, output path). Starts a turn when idle, otherwise steered into the current run |
| Background command exits (`-p`/json, e.g. inside a subagent) | Added at the next turn boundary. Like `claude -p`, pi waits for running background tasks before the run settles                               |
| Time limits                                                  | Interactive: none unless `timeout` is set. Non-interactive: 10 min for shells, 30 min for agents/workflows (`PI_BACKGROUND_TIME_LIMIT_MS`)    |
| Output > 5GB                                                 | Killed                                                                                                                                        |
| Esc during a foreground command                              | Kills it; background tasks keep running                                                                                                       |
| pi exits                                                     | All tasks killed. `/reload` keeps them running and notifications still arrive                                                                 |
| Called from codemode or `ctx.executeTool`                    | Plain pi behavior: no auto-background, Ctrl+B doesn't detach, `timeout` kills                                                                 |

Foreground commands that finish normally are dropped from the task list and their output file deleted.
pi's own truncated-output log still applies.

## Environment variables

- `PI_BASH_AUTO_BACKGROUND_MS`: foreground timeout before auto-backgrounding. Default `120000`; `0` restores plain pi behavior (no default timeout, `timeout` kills).
- `PI_BACKGROUND_TIME_LIMIT_MS`: background task time limit in non-interactive runs.
- `PI_BACKGROUND_KEY`: the shortcut. Default `ctrl+b`.
