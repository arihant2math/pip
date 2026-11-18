# Codemode

A drop-in replacement for pi's built-in `codemode` tool that runs scripts in a persistent Node process instead of a fresh QuickJS sandbox. Disable the built-in with `"extensions": ["-builtin:codemode"]` in settings (pi warns otherwise).

Everything the model sees is the built-in's: the tool definition comes from pi's own `createCodemodeExtension()`, so the nested-tool catalog, namespaces, `codemode.mode`, the declared tools' "Codemode:" notes, the grammar, and the renderer are unchanged. Only the description intro is swapped and two globals are added. Scripts get the same globals (`tools`, `ALL_TOOLS`, `searchTools`, `describeTool`, `describeNamespace`, `text`, `image`, `exit`, `store`/`load` on the same `codemode-store` session entries, `models`, `return`, `// @options:`), and results use the same format.

On top of that, scripts are TypeScript ES modules in one long-lived child process (`child.ts`). Exports become globals, anything left running keeps running, and `background(name, work)` reports a task to the agent with a steer message when it settles. A script still running at `timeout_ms` (default 30s) is not killed but becomes background task `cell<N>`. The process only dies on a crash, `process.exit()`, a sync loop that blocks past the timeout, `/codemode-reset`, or session end.

This is pip's only background mechanism: long commands, subagents, and fan-out all run as `background()` tasks, e.g. `background("review", () => tools.agent({ description, prompt }))`.

The status line shows the running tasks and what the most recently active one is doing (its tool call, then that tool's progress updates). `/bg` lists tasks with their age and activity and cancels the one you pick; `/bg cancel <name>` cancels directly, and the agent is told the user cancelled it.

In print and json runs (`pi -p`, every subagent) the run stays open while background tasks are running, and each report continues it, so a result is never lost to the process exiting. `PI_BACKGROUND_TIME_LIMIT_MS` caps the wait (default 30 minutes).

`pnpm test` runs the kernel tests.
