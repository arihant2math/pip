# Dynamic Workflows

Claude Code's [dynamic workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code) for pi.
The model writes a short JavaScript script that fans work out to isolated `pi` subagents and returns one
result. The plan lives in code, not the context window, so every item gets the same treatment, verification
always runs, and scripts can be saved and rerun.

## Design

- **One tool, `workflow`.** No commands, modes, or settings. Its ~2 KB description lists the whole API.
- **Subagents are `pi -p --mode json --no-session`**, run by the shared runner (`../shared/pi-runner.ts`,
  also used by `agent`). They get your extensions, AGENTS.md, and the session's model and thinking level by default.
- **Agent types are reused.** `agent(prompt, { agent: "explore" })` takes that type's system prompt,
  tools and model as defaults (see `../subagents/README.md`).
- **A run is a task** in the shared registry. `run_in_background: true` returns a task id and later delivers a
  `<task-notification>` with the result. Ctrl+B, `/tasks`, `task_stop` and `task_output` all work on it.
  Progress is written to `progress.log` in the run dir.
- **Structured output uses pi's tool validation.** With `schema`, the subagent gets a `submit_result` tool
  (`../shared/submit-result.ts`) whose parameters are that schema. The parent accepts only a validated, executed
  `submit_result` call (its coerced params are echoed in `details`), then stops the subagent. If the subagent
  answers in text instead, JSON is parsed from it and validated against the schema; anything invalid becomes `null`.
- **Transient provider errors aren't failures.** An agent fails only if its last assistant message errored
  (pi auto-retries overloads/5xx), it timed out, or the process exited non-zero.
- **Scripts run in `node:vm`**: a clean scope, not a security boundary (pi tools already run with your permissions).
- **Context stays small.** Only the script's return value reaches the model, truncated at 12k chars.
  Agent prompts and outputs, the full result and the cache are written to a run directory whose path is in the
  result. Progress (phases, agent statuses, logs, cost) goes to the TUI via `onUpdate`, not the model's context.
- **Resume uses a content-addressed cache.** Run id = hash(script + args); each agent result is keyed by
  hash(prompt + opts) plus an occurrence count. Rerunning the same script in the same session after an abort or
  crash reuses finished agents. `fresh: true` disables this.
- **No recursion.** Workflow agents get `PI_WORKFLOW_CHILD=1` and all subagents get `PI_SUBAGENT_DEPTH>0`, so neither
  gets `workflow`. Workflow agents also lack `agent` and `send_message`, since the script does the fan-out.
  They keep background `bash`, `task_output` and `task_stop`.
- **No confirmation prompt**, per pi's no-popups default. Gate it with a `tool_call` hook if needed.

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

- `tools: ["read","grep","find","ls"]` makes a read-only agent; `tools: []` an agent with no tools.
- Concurrency defaults to `min(8, cpus)` (`PI_WORKFLOW_CONCURRENCY`). Runs are capped at 500 agents
  (`PI_WORKFLOW_MAX_AGENTS`); each agent times out after 30 minutes.
- By default the call blocks the turn, and Esc aborts it and kills all subagents. With `run_in_background: true`
  or after Ctrl+B it runs while you work; stop it with `task_stop <id>` or `/tasks`.

## Saved workflows

`workflow({ name, args })` looks for `<name>.js` in, in order:

1. `.pi/workflows/` (project; trusted projects only, like project extensions)
2. `~/.pi/agent/workflows/` (user)
3. `workflows/` in this package (bundled)

To save one, have the model write the script to one of these. The bundled [`workflows/review.js`](workflows/review.js)
(scope → review → adversarial verify) doubles as a template.

## Patterns

- **Fan-out and synthesize:** `parallel(items.map(i => () => agent(...)))`, then merge in JS or with one final agent.
- **Adversarial verification:** per finding, a skeptic `agent` with a `{real, reason}` schema; keep the survivors.
- **Generate and filter / tournament:** N agents attempt the task; pairwise judge agents pick a winner in a JS loop.
- **Loop until done:** `while (true) { const r = await agent(...); if (!r.new.length) break; }`.
- **Cheap models for cheap stages:** `{ model: "google/gemini-3.5-flash" }` for extraction, the session model for judgment.

## Files

- `index.ts`: the extension (tool, runtime, renderer)
- `../shared/`: subagent runner, `submit_result`, agent types, task registry (shared with background-commands and subagents)
- `workflows/review.js`: bundled example
- `tsconfig.json`: local typecheck only (`npx -p typescript tsc -p .`, or `-p ..` for all of pip); paths point at the Homebrew pi install
