# Dynamic Workflows

Pi's version of Claude Code's [dynamic workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code).
The model writes a short JavaScript orchestration script. The script sends work to isolated `pi`
subagents and returns one result. The plan lives in code instead of the context window, so every
item gets the same treatment, verification always runs, and you can save the script and run it again.

```
pi install ./pip                        # with background-commands and subagents (recommended)
pi install ./pip/dynamic-workflows      # or just this; it still needs ../shared next to it
```

Then ask for one: *"use a workflow to audit every route handler for missing auth checks, and have
a second agent try to refute each finding"*.

## Design

- **One tool, `workflow`, and no commands, modes, or settings.** Its description is about 2 KB and lists the whole API.
- **The subagent is `pi -p --mode json --no-session`**, run by the shared runner (`../shared/pi-runner.ts`,
  also used by the `agent` tool). No new agent runtime: subagents get your extensions, AGENTS.md, and the
  session's model and thinking level by default.
- **Agent types are reused.** `agent(prompt, { agent: "explore" })` uses that subagent type's system prompt,
  tools and model as defaults (see `../subagents/README.md`).
- **A run is a task.** It goes into the shared task registry, so `run_in_background: true` returns a task id at once
  and delivers a `<task-notification>` with the result when the run finishes. Ctrl+B backgrounds a running
  workflow, `/tasks` lists and stops it, and `task_stop`/`task_output` work on it. Progress is written to
  `progress.log` in the run dir.
- **Structured output uses pi's own tool validation.** With `schema`, the subagent gets one extra tool
  (`../shared/submit-result.ts` → `submit_result`) whose parameters *are* that schema. The parent takes the result only from a
  `submit_result` call that passed validation and ran (the tool echoes its coerced params in `details`), then
  stops the subagent. If the subagent finishes cleanly but replies in text, the extension parses JSON out of it
  and validates it against the same schema; anything that doesn't match becomes `null`.
- **Transient provider errors are not failures.** An agent fails only if its *last* assistant message errored
  (pi auto-retries overloads/5xx), it timed out, or the process exited non-zero.
- **The script runs in `node:vm`.** It gets a clean scope, not a security boundary; pi already runs tools with your permissions.
- **Context stays small.** Only the script's return value reaches the model, truncated at 12k chars.
  Each agent's prompt and output, the full result, and the cache go to a run directory on disk, and its path
  appears in the result so the model can `read` it when needed. Progress (phases, agent statuses, logs, cost)
  goes to the TUI through `onUpdate` and never enters the model's context.
- **Resume is a content-addressed cache.** Run id = hash(script + args). Each agent result is keyed by
  hash(prompt + opts) plus an occurrence count. After an abort or crash, running the same script again in the same session
  reuses finished agents. `fresh: true` turns this off.
- **No recursion.** Workflow agents get `PI_WORKFLOW_CHILD=1` and every subagent gets `PI_SUBAGENT_DEPTH>0`, so neither
  gets the `workflow` tool. Workflow agents also don't get `agent` or `send_message`: the script does the fan-out.
  They still get background `bash` with `task_output`/`task_stop`.
- **No confirmation prompt.** That follows pi's no-permission-popups default. Gate the tool with a `tool_call` hook if you want one.

## Script API

```js
export const meta = { name: "audit", description: "..." }   // optional; name shown in UI and run dir

agent(prompt, { label, agent, schema, model, thinking, tools, cwd, timeout })  // -> string | object | null
parallel([promiseOrThunk, ...])          // Promise.all; failures -> null
pipeline(items, stage1, stage2, ...)     // stage(prev, item, i); item stops at first null/failure
phase("verify"); log("found", n)         // progress display only
await sh("git ls-files '*.ts'")          // stdout; throws on non-zero exit
args                                     // the tool's `args` parameter (a JSON-encoded object string is decoded)
return value                             // the only thing the model sees
```

- `tools: ["read","grep","find","ls"]` gives a read-only agent. `tools: []` gives an agent with no tools.
- Concurrency defaults to `min(8, cpus)` (`PI_WORKFLOW_CONCURRENCY`). A run is capped at 500 agents
  (`PI_WORKFLOW_MAX_AGENTS`), and each agent times out after 30 minutes.
- By default the tool call blocks the turn while the workflow runs, and Esc aborts it and kills every subagent.
  With `run_in_background: true`, or after Ctrl+B, it keeps running while you keep working. Use `task_stop <id>` or
  `/tasks` to stop it.

## Saved workflows

`workflow({ name, args })` looks up `<name>.js` in these directories, in order:

1. `.pi/workflows/` (project; only when the project is trusted, like project extensions)
2. `~/.pi/agent/workflows/` (user)
3. `workflows/` in this package (bundled)

To save one, ask the model to write the script to one of those directories. The bundled
[`workflows/review.js`](workflows/review.js) runs a scope → review → adversarial verify pipeline.
It works as a template for other workflows.

## Patterns

- **Fan-out and synthesize:** `parallel(items.map(i => () => agent(...)))`, then merge in JS or with one final agent.
- **Adversarial verification:** for each finding, a skeptic `agent` with a `{real, reason}` schema. Keep only the findings that survive.
- **Generate and filter / tournament:** N agents attempt the task, and pairwise judge agents pick the winner in a JS loop.
- **Loop until done:** `while (true) { const r = await agent(...); if (!r.new.length) break; }`.
- **Cheap stages on cheap models:** `{ model: "google/gemini-3.5-flash" }` for extraction, and the session model for judgment.

## Files

- `index.ts`: the extension (tool, runtime, renderer)
- `../shared/`: the subagent runner, `submit_result`, agent types and the task registry (shared with background-commands and subagents)
- `workflows/review.js`: the bundled example
- `tsconfig.json`: local typecheck only (`npx -p typescript tsc -p .`, or `-p ..` for all of pip). Its paths point at the Homebrew pi install
