#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * Standalone pi-live viewer, no pi needed:
 *
 *   node --experimental-strip-types watch-cli.ts <share code> [--name you] [--json] [--gui [--theme name] [--no-open]]
 *
 * Prints the transcript and live output. With --gui, serves a browser view (styled like pi's
 * /export HTML) on 127.0.0.1 and opens it instead. Lines typed on stdin are sent as prompts once the host
 * grants control:  /control  request control · /steer <text>  steer · /abort  abort · /quit
 * With --json, every host frame is printed as one JSON line instead (useful for scripting/tests).
 */
import * as readline from "node:readline";
import { LiveViewer, type ViewState } from "./client.ts";
import { openBrowser, resolveGuiTheme, WatchGui } from "./gui.ts";
import type { Item } from "./protocol.ts";
import { renderItem, type Style } from "./transcript.ts";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const guiMode = argv.includes("--gui");
const noOpen = argv.includes("--no-open");
const valueOf = (flag: string) => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};
const name = valueOf("--name") ?? (process.env.PI_LIVE_NAME || process.env.USER);
const themeName = valueOf("--theme");
const code = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--name" && argv[i - 1] !== "--theme");
if (!code) {
	process.stderr.write("usage: pi-live-watch <share code> [--name you] [--json] [--gui [--theme dark|light|<name>] [--no-open]]\n");
	process.exit(2);
}

const tty = process.stdout.isTTY && !json;
const c = (n: number) => (s: string) => (tty ? `\x1b[${n}m${s}\x1b[0m` : s);
const style: Style = {
	user: c(36),
	assistant: (s) => s,
	thinking: c(2),
	tool: c(33),
	error: c(31),
	muted: c(90),
	accent: c(35),
};
const sanitize = (s: string) =>
	s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
const out = (s: string) => process.stdout.write(s);

let viewer: LiveViewer;
try {
	viewer = new LiveViewer(code, name);
} catch (err: any) {
	process.stderr.write(`${err.message}\n`);
	process.exit(2);
}

// Incremental printer: tracks what has already been printed so live updates append cleanly.
let printed: string[] = []; // JSON of printed items, to detect whether a resync changed history
let printedItems = 0;
let seenSyncs = 0;
let streamedText = 0;
let streamedThinking = 0;
let lastBusy = false;
let lastConn = "";
let lastControl = false;

function printItem(item: Item) {
	const s = { ...item } as any;
	for (const k of ["text", "thinking", "name", "error"]) if (typeof s[k] === "string") s[k] = sanitize(s[k]);
	out(`${renderItem(s, style).join("\n")}\n\n`);
}

function onState(s: ViewState) {
	if (s.conn !== lastConn) {
		lastConn = s.conn;
		process.stderr.write(style.muted(`[${s.conn}${s.detail ? `: ${sanitize(s.detail)}` : ""}]\n`));
		if (s.conn === "closed") process.exit(0);
	}
	if (s.syncs !== seenSyncs) {
		const first = seenSyncs === 0;
		seenSyncs = s.syncs;
		const incoming = s.items.map((i) => JSON.stringify(i));
		// Unchanged history (reconnect, /reload): keep going. Otherwise reprint from scratch.
		const isPrefix = printed.length <= incoming.length && printed.every((p, i) => p === incoming[i]);
		if (first || !isPrefix) {
			if (!first) out(style.accent("\n──── transcript reset ────\n\n"));
			out(style.accent(`pi-live: ${sanitize(s.session?.name || s.session?.cwd || "remote session")}${s.session?.model ? ` (${sanitize(s.session.model)})` : ""}\n`));
			if (s.omitted) out(style.muted(`… ${s.omitted} earlier messages not shown\n\n`));
			printed = [];
			printedItems = 0;
			streamedText = streamedThinking = 0;
		}
	}
	if (!seenSyncs) return;
	if (s.items.length > printedItems) {
		if (streamedText || streamedThinking) out("\n");
		// Skip re-printing the assistant message we just streamed token by token.
		const fresh = s.items.slice(printedItems);
		for (const item of fresh) {
			if (item.k === "assistant" && (streamedText || streamedThinking)) {
				for (const call of item.calls ?? []) out(`${style.tool(`  ⚙ ${sanitize(call.name)}`)}${style.muted(` ${sanitize(call.args)}`)}\n`);
				if (item.error) out(`${style.error(`  ✗ ${sanitize(item.error)}`)}\n`);
				out("\n");
				streamedText = streamedThinking = 0;
				continue;
			}
			printItem(item);
		}
		printed.push(...fresh.map((i) => JSON.stringify(i)));
		printedItems = s.items.length;
	}
	if (s.streaming.thinking.length > streamedThinking && !streamedText) {
		out(style.thinking(sanitize(s.streaming.thinking.slice(streamedThinking))));
		streamedThinking = s.streaming.thinking.length;
	}
	if (s.streaming.text.length > streamedText) {
		if (!streamedText && streamedThinking) out("\n\n");
		out(sanitize(s.streaming.text.slice(streamedText)));
		streamedText = s.streaming.text.length;
	}
	if (!s.streaming.text && !s.streaming.thinking && (streamedText || streamedThinking)) {
		// Streaming was cleared without a final item (abort / reset).
		out("\n");
		streamedText = streamedThinking = 0;
	}
	if (s.busy !== lastBusy) {
		lastBusy = s.busy;
		if (!s.busy) process.stderr.write(style.muted("[idle]\n"));
	}
	if (s.control !== lastControl) {
		lastControl = s.control;
		process.stderr.write(style.accent(s.control ? "[control granted: type to prompt]\n" : "[control revoked]\n"));
	}
}

if (guiMode) {
	// The browser shows the transcript; the terminal only reports connection changes and notices.
	viewer.onChange = (s) => {
		if (s.conn === lastConn) return;
		lastConn = s.conn;
		process.stderr.write(style.muted(`[${s.conn}${s.detail ? `: ${sanitize(s.detail)}` : ""}]\n`));
		if (s.conn === "closed") setTimeout(() => process.exit(0), 500); // let the page see "closed"
	};
	viewer.onNotice = (level, text) => process.stderr.write(`${level === "error" ? style.error("!") : style.muted("·")} ${sanitize(text)}\n`);
} else if (!json) {
	viewer.onChange = onState;
	viewer.onNotice = (level, text) => process.stderr.write(`${level === "error" ? style.error("!") : style.muted("·")} ${sanitize(text)}\n`);
} else {
	// Raw mode: wrap apply() by observing state snapshots as JSON lines.
	viewer.onChange = (s) =>
		out(
			`${JSON.stringify({
				conn: s.conn,
				detail: s.detail,
				busy: s.busy,
				control: s.control,
				items: s.items.length,
				last: s.items.at(-1),
				streaming: s.streaming.text.length,
				running: [...s.running.values()].map((r) => r.name),
				viewers: s.viewers,
			})}\n`,
		);
	viewer.onNotice = (level, text) => out(`${JSON.stringify({ notice: text, level })}\n`);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let gui: WatchGui | undefined;
rl.on("line", (line) => {
	const text = line.trim();
	if (!text) return;
	if (text === "/quit" || text === "/exit") return void viewer.close().then(() => process.exit(0));
	if (text === "/control") return void viewer.requestControl();
	if (text === "/abort") return void viewer.send({ t: "abort" });
	if (text.startsWith("/steer ")) return void viewer.send({ t: "steer", text: text.slice(7) });
	if (!viewer.state.control) {
		process.stderr.write(style.muted("· no control yet; type /control to ask the host\n"));
		return;
	}
	viewer.send({ t: "prompt", text });
});
rl.on("close", () => {
	if (!process.stdin.isTTY) return; // piped stdin ended: keep watching
	void viewer.close().then(() => process.exit(0));
});
process.on("SIGINT", () => void viewer.close().then(() => process.exit(0)));

viewer
	.start()
	.then(async () => {
		if (!guiMode) return;
		gui = new WatchGui(viewer, await resolveGuiTheme({ name: themeName }));
		const url = await gui.start();
		process.stderr.write(`${style.accent("pi-live GUI:")} ${url}\n`);
		if (!noOpen) openBrowser(url);
	})
	.catch((err) => {
		process.stderr.write(`could not connect: ${err.message}\n`);
		process.exit(1);
	});
