# Pi Improvement Plan (pip)

Claude Code-style features for pi.

| Extension                                 | Description                                                                                                         |
|-------------------------------------------|---------------------------------------------------------------------------------------------------------------------|
| [`codemode/`](codemode/README.md)         | Replaces pi's `codemode` with a persistent Node kernel; `background()` runs work as tasks that message the agent    |
| [`subagents/`](subagents/README.md)       | `agent` tool (types from `.pi/agents`, `.claude/agents` or bundled), `send_message` to resume, worktree isolation   |
| [`pi-live/`](pi-live/README.md)           | Share a live session peer-to-peer over iroh: `/live` to share, `/watch <code>` to watch and (with approval) steer   |

Background work goes through codemode: `background("name", () => tools.agent({...}))` or any long script.
When it settles, the agent gets a message with the result.

## Installation

Disable the built-in codemode in `~/.pi/agent/settings.json`:

```json
{ "extensions": ["-builtin:codemode"] }
```

From git:

```shell
pi install git:github.com/arihant2math/pip
```

From a local clone (run `pnpm install` first):

```shell
pi install ./pip
```

## Experimentation

```shell
pi -e ./pip/codemode -e ./pip/subagents -e ./pip/pi-live
```

## Development

`pnpm check` typechecks, `pnpm test` runs the codemode kernel tests.
