# pip-shared

This is a library used by `background-commands/`, `subagents/` and `dynamic-workflows/`. It is not a
pi package. Each of those extensions imports it through a relative path.

| File | What it does |
|---|---|
| `tasks.ts` | The task registry. Tasks are `bash`, `agent` or `workflow`. Each task can be foreground or background, can be finished, stopped or given a time limit, and writes to an output file. The registry is stored on `globalThis` under `Symbol.for("pip.task-registry.v1")` because pi loads every package with its own module root. Use `awaitForeground(task, toolSignal)` to wait for either `"done"` or `"background"`. |
| `task-core.ts` | `installTaskCore(pi)`. The first call in a runtime wins; later calls are detected over `pi.events`. It sets up `<task-notification>` delivery, the settle wait for non-interactive runs, `task_output`/`task_stop`, `/tasks`, Ctrl+B, and the widget. |
| `pi-runner.ts` | `runPi()` starts a `pi --mode json -p` child. Options cover model, thinking, tools, appended prompts, a JSON-schema result through `submit_result`, a persisted session for resuming, progress events, usage, abort and timeout. |
| `submit-result.ts` | The child-side extension that registers `submit_result`. It is loaded with `-e` when a schema is requested. |
| `agents.ts` | Discovers agent type definitions (`.pi/agents`, `.claude/agents`, bundled). |
| `util.ts` | Small helpers, plus `SUBAGENT_DEPTH` and `MAX_SUBAGENT_DEPTH`. |

## The task lifecycle

```
registry.create({kind, description})        status=running, foreground=true
  ├─ task.moveToBackground(reason)          the tool call returns early: "requested" | "timeout" | "user" (Ctrl+B)
  ├─ task.stop(reason)                      aborts task.signal; the owner kills its process
  └─ task.finish(status, {exitCode,result}) completed | failed | killed
        └─ if it was backgrounded: a <task-notification> custom message
             interactive:      pi.sendMessage(…, {triggerTurn: true, deliverAs: "steer"})
             print/json mode:  turn_end / agent_before_settle boundary entries; settling waits for running tasks
```

To add a new kind of long-running work, follow these steps:

1. Call `installTaskCore(pi)`.
2. Create a task.
3. Start the work with `task.signal`.
4. Call `task.finish()` when the work ends.
5. Call `await awaitForeground(task, signal)` and return `backgroundedText(task, reason)` if the task went to the background.
