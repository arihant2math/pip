# pi-live

Share a running pi session peer-to-peer over [iroh](https://iroh.computer). A friend on another
network can watch it live, and with your approval send prompts, steer or abort. Nothing to port-forward and
no server to run: iroh dials by public key, hole-punches through NATs and falls back to n0's public relays.
The connection is end-to-end encrypted (QUIC/TLS) either way.

## Use

Host (the session being shared):

```
/live                          start sharing; prints a share code and copies it to the clipboard
/live status                   viewers, who has control, the share code
/live kick <id>                disconnect a viewer
/live revoke [id]              take control back (all viewers, or one)
/live control ask|allow|deny   how control requests are handled (default: ask)
/live stop                     stop sharing, disconnect everyone
pi --live                      start sharing at startup
```

Viewer, inside pi:

```
/watch pilive1:…               open the live overlay
/watch                         reopen it after Esc (the connection stays up)
/watch stop                    disconnect
```

| Key in the overlay | |
|---|---|
| Ctrl+T | request control (host gets a confirm dialog) |
| Enter | send a prompt (queued as a follow-up if the host is busy) |
| Alt+Enter | steer the running turn |
| Ctrl+C | abort the remote run |
| ↑ ↓ PgUp PgDn / End | scroll / follow |
| Ctrl+O | show thinking |
| Esc | hide the overlay |

Viewer without pi (Node ≥ 22.6):

```
node --experimental-strip-types pi-live/watch-cli.ts pilive1:… [--name you] [--json]
```

It prints the transcript and streams output. Typed lines become prompts once control is granted; `/control`,
`/steer <text>`, `/abort`, `/quit`.

## Security model

- The share code is `pilive1:<iroh endpoint ticket>:<secret>`. The ticket only says how to reach the host. The
  144-bit secret is what authorizes, so treat the whole code like a password. `/live stop` then `/live`
  issues a new endpoint and secret.
- **Watching shows everything** in the session: prompts, replies, tool calls, and up to 2KB of each tool result
  (file contents, command output, possibly secrets).
- **Control is per viewer and needs explicit approval** (`/live control ask`, the default). Remote prompts run
  as if you typed them, with your tools and permissions. Permission extensions and tool confirmations still
  apply, and their dialogs appear on *your* screen. Remote text is never expanded as a `/command`, skill or
  prompt template. Commands are rate-limited (10 per 10s per viewer).
- Viewer names and remote text are stripped of terminal control sequences on both sides.
- Limits: 16 viewers, 256KB per viewer→host frame, slow viewers are dropped after a 16MB send backlog.

## How it works

```
host pi ── pi-live ext ── iroh Endpoint (ALPN pi-live/1) ◀── QUIC ──▶ viewer Endpoint ── /watch | watch-cli
```

One bidirectional stream per viewer, with JSON frames prefixed by a 4-byte length (see `protocol.ts`).

1. The viewer sends `hello {token}`.
2. The host replies with `welcome`, which carries the last 200 transcript items plus any in-flight output.
3. The host then streams `item` / `delta` (batched every 50ms) / `tool_start` / `tool_end` / `busy` / `needs_input`.
   It sends `reset` after `/new`, `/resume`, `/tree` or compaction.

Viewers send `prompt`, `steer`, `abort`, `control_request` and `ping`. Viewers reconnect with backoff after
network drops.

The host keeps its state on `globalThis`, so a share survives `/reload` and session switches. It ends when pi
exits.

| File | |
|---|---|
| `index.ts` | extension: `/live`, `/watch`, `--live`, event wiring |
| `host.ts` | iroh endpoint, viewer handshake, broadcast, control |
| `client.ts` | `LiveViewer`: connect, materialized view state, reconnect |
| `protocol.ts` | frames, framing, share codes |
| `transcript.ts` | pi messages → compact items, text rendering |
| `watch-view.ts` | TUI overlay |
| `watch-cli.ts` | standalone viewer |
| `test/e2e.ts` | end-to-end test over real iroh with a scripted model |

## Install

`@number0/iroh` is a native dependency. Prebuilt binaries exist for macOS arm64, Linux x64/arm64 (glibc and
musl) and Windows x64/arm64. There is no Intel macOS build. `pi install` runs `npm install` for you. For a
local checkout, run `npm install` in `pi-live/`.

## Test

```
node --experimental-strip-types --no-warnings pi-live/test/e2e.ts
```

This starts a host pi in RPC mode with a scripted model, then connects viewers over real iroh. It tests auth,
snapshot, streaming, tools, control approve/deny, prompt/steer/abort, multiple viewers, `/new` reset,
revoke and stop.
