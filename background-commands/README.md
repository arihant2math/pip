# Background Commands

Claude Code-style background shell commands for pi. This replaces the built-in `bash` tool with
pi's own definition (same process handling, truncation and renderer) and adds a task layer on top.

```
pi install ./pip            # everything (recommended), or: pi install ./pip/background-commands
```

## What the model gets

- **`bash` with `run_in_background: true`**: returns at once with a task id (`b…`) and an output file.
  The model gets a `<task-notification>` when the command exits, so it never has to poll.
- **Auto-background on timeout**: a foreground command still running after its `timeout` (default
  120s) moves to the background instead of being killed. Commands starting with `sleep` are still killed.
  When `timeout` is used together with `run_in_background`, it is a kill deadline (max 2h).
- **`description`** (optional): a short label used in `/tasks` and in notifications.
- **`task_output`** and **`task_stop`** (from `../shared/task-core.ts`): read or wait for a task, or kill its process tree.

## What you get

- **Ctrl+B** moves the running foreground command (or subagent, or workflow) to the background.
  The widget below the editor shows a hint once a task has run for 3s.
  - pi binds Ctrl+B to "cursor left" by default, so startup prints a shortcut-conflict warning.
  - To silence it, add `"tui.editor.cursorLeft": ["left"]` to `~/.pi/agent/keybindings.json`.
  - To use a different key, set `PI_BACKGROUND_KEY`, e.g. `ctrl+shift+b`.
- **A widget below the editor** lists running and recently finished background tasks.
- **`/tasks`** lists the tasks. From there you can view a task's output or stop it.
  - `/tasks stop <id>` stops a task directly.
  - If you stop a task, the model is notified. If the model stopped it with `task_stop`, no notification is sent.

## Behavior

| Situation                                                    | What happens                                                                                                                                      |
|--------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| Background command exits (interactive)                       | `<task-notification>` (status, exit code, last 1.5KB of output, output path). Starts a turn when idle, or is steered into the current run         |
| Background command exits (`-p`/json, e.g. inside a subagent) | Added at the next turn boundary. Before the run settles, pi waits for running background tasks, like `claude -p`                                  |
| Time limits                                                  | Interactive: none, unless `timeout` was given. Non-interactive: 10 min for shells and 30 min for agents/workflows (`PI_BACKGROUND_TIME_LIMIT_MS`) |
| Output > 5GB                                                 | killed                                                                                                                                            |
| Esc during a foreground command                              | kills it (background tasks keep running)                                                                                                          |
| pi exits                                                     | every task is killed. `/reload` keeps tasks running and notifications still arrive                                                                |
| Called from codemode or `ctx.executeTool`                    | plain pi behavior: never auto-backgrounded, Ctrl+B doesn't detach it, and `timeout` kills it                                                      |

Foreground commands that finish normally are removed from the task list, and their output file is deleted.
pi's own truncated-output log still applies.

## Environment Variables

- `PI_BASH_AUTO_BACKGROUND_MS`: foreground timeout before auto-backgrounding. Default `120000`. `0` restores pi's plain behavior: no default timeout, and `timeout` kills.
- `PI_BACKGROUND_TIME_LIMIT_MS`: time limit for background tasks in non-interactive runs.
- `PI_BACKGROUND_KEY`: the shortcut. Default `ctrl+b`.
