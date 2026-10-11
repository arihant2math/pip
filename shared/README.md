# pip-shared

This is a shared library for the task registry, background/foreground handling, and file handling.

Also it provides various shared tools.

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
