/**
 * End-to-end test over real iroh: a host pi (RPC mode, faux model, `--live`) and LiveViewer
 * clients in this process.
 *
 *   node --experimental-strip-types --no-warnings pi-live/test/e2e.ts
 *
 * Covers: share code, bad secret rejection, welcome snapshot, live deltas/items/tool events,
 * view-only enforcement, control request approve/deny via RPC confirm, remote prompt/steer/abort,
 * multiple viewers, session reset (/new), host /live stop → viewers get bye.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { LiveViewer } from "../client.ts";
import { parseShare } from "../protocol.ts";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "..");
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pilive-e2e-"));

let failures = 0;
function check(cond: unknown, msg: string) {
	if (cond) console.log(`  ✓ ${msg}`);
	else {
		failures++;
		console.log(`  ✗ ${msg}`);
	}
}

async function until<T>(fn: () => T | undefined | false, what: string, ms = 20_000): Promise<T> {
	const start = Date.now();
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

// ---- host ----------------------------------------------------------------------------------------
const host = spawn(
	"pi",
	["--mode", "rpc", "--no-session", "-ne", "--offline", "-e", path.join(here, "faux-model.ts"), "-e", root, "--model", "faux/echo", "--live"],
	{ cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_LIVE_NAME: "" } },
);
let hostErr = "";
host.stderr.on("data", (d) => (hostErr += d));
const notices: string[] = [];
let confirmAnswer = true;
const confirms: string[] = [];
let shareCode = "";
const rl = readline.createInterface({ input: host.stdout });
rl.on("line", (line) => {
	let msg: any;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	if (msg.type === "extension_ui_request") {
		if (msg.method === "notify") {
			notices.push(msg.message);
			const m = /pilive1:\S+/.exec(msg.message);
			if (m) shareCode = m[0];
		} else if (msg.method === "confirm") {
			confirms.push(`${msg.title}: ${msg.message}`);
			host.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: msg.id, confirmed: confirmAnswer })}\n`);
		}
	}
});
const rpc = (cmd: object) => host.stdin.write(`${JSON.stringify(cmd)}\n`);

const viewers: LiveViewer[] = [];
try {
	console.log("host: waiting for share code");
	await until(() => shareCode, "share code", 30_000);
	check(parseShare(shareCode).secret.length >= 20, "share code has a secret");

	// ---- bad secret
	console.log("bad secret");
	const bad = new LiveViewer(shareCode.replace(/:[^:]+$/, ":wrongsecretwrongsecret00"), "mallory");
	let badErr = "";
	await bad.start().catch((e) => (badErr = String(e.message)));
	check(/invalid share code/.test(badErr), `bad secret rejected (${badErr})`);
	await bad.close();

	// ---- some history before anyone watches
	console.log("history + join");
	rpc({ type: "prompt", message: "hello before join" });
	await new Promise((r) => setTimeout(r, 1500));

	const a = new LiveViewer(shareCode, "alice");
	viewers.push(a);
	await a.start();
	check(a.state.conn === "live", "viewer A connected");
	check(a.state.items.some((i) => i.k === "user" && i.text === "hello before join"), "snapshot has prior user message");
	check(a.state.items.some((i) => i.k === "assistant" && i.text.includes("echo: hello before join")), "snapshot has prior reply");
	check(a.state.control === false, "viewer starts view-only");
	await until(() => notices.some((n) => n.includes("alice is now watching")), "host join notice");
	check(true, "host was notified of viewer");

	// ---- live streaming + tools
	console.log("live stream");
	let sawDelta = false;
	const prevChange = a.onChange;
	a.onChange = (s) => {
		if (s.streaming.text.length > 0) sawDelta = true;
		prevChange?.(s);
	};
	rpc({ type: "prompt", message: "please run tool" });
	await until(() => a.state.items.some((i) => i.k === "tool" && i.text.includes("tool-output-42")), "tool result item");
	check(true, "tool result streamed to viewer");
	check(a.state.items.some((i) => i.k === "assistant" && i.calls?.some((c) => c.name === "bash" && c.args.includes("echo tool-output-42"))), "tool call summarized");
	await until(() => a.state.items.some((i) => i.k === "assistant" && i.text === "Tool finished."), "final reply");
	await until(() => !a.state.busy, "idle");
	check(sawDelta, "text deltas arrived before the final item");

	// ---- view-only enforcement
	console.log("control");
	const notesA: string[] = [];
	a.onNotice = (_l, t) => notesA.push(t);
	a.send({ t: "prompt", text: "sneaky" });
	await until(() => notesA.some((n) => n.includes("don't have control")), "view-only notice");
	check(true, "prompt without control refused");

	// deny
	confirmAnswer = false;
	a.requestControl();
	await until(() => notesA.some((n) => n.includes("declined")), "control declined");
	check(!a.state.control && confirms.length === 1, "control request denied via host confirm");

	// approve
	confirmAnswer = true;
	a.requestControl();
	await until(() => a.state.control, "control granted");
	check(confirms.length === 2, "host was asked again");

	// remote prompt
	a.send({ t: "prompt", text: "from alice" });
	await until(() => a.state.items.some((i) => i.k === "assistant" && i.text === "echo: from alice"), "reply to remote prompt");
	check(true, "remote prompt ran on host");
	await until(() => notices.some((n) => n.includes("alice sent a prompt")), "host notified of remote prompt");
	check(true, "host notified of remote prompt");
	await until(() => !a.state.busy, "idle");

	// second viewer joins mid-stream; abort
	console.log("multi viewer + abort");
	a.send({ t: "prompt", text: "slow please" });
	await until(() => a.state.busy && a.state.streaming.text.length > 20, "slow stream started");
	const b = new LiveViewer(shareCode, "bob");
	viewers.push(b);
	await b.start();
	check(b.state.busy, "late viewer sees busy");
	check(b.state.streaming.text.length > 0, "late viewer gets in-flight stream");
	await until(() => a.state.viewers === 2, "viewer count 2");
	check(true, "viewer count broadcast");
	a.send({ t: "abort" });
	await until(() => !a.state.busy && !b.state.busy, "abort settles", 15_000);
	check(a.state.items.at(-1)?.k === "assistant" && (a.state.items.at(-1) as any).error === "aborted", "aborted message shown");

	// steer while busy is delivered
	console.log("steer");
	a.send({ t: "prompt", text: "slow again" });
	await until(() => a.state.busy, "busy");
	a.send({ t: "steer", text: "steered" });
	await until(() => a.state.items.some((i) => i.k === "user" && i.text === "steered"), "steer message", 30_000);
	check(true, "steer message delivered");
	a.send({ t: "abort" });
	await until(() => !a.state.busy, "idle after steer", 30_000);

	// ---- session reset
	console.log("reset");
	rpc({ type: "new_session" });
	const noMessages = (v: LiveViewer) => v.state.items.every((i) => i.k === "info");
	await until(() => noMessages(a) && noMessages(b), "reset to empty");
	check(true, "viewers reset on /new");
	rpc({ type: "prompt", message: "after reset" });
	await until(() => b.state.items.some((i) => i.k === "assistant" && i.text === "echo: after reset"), "post-reset item");
	check(true, "streaming continues after reset");

	// ---- revoke + stop
	console.log("stop");
	rpc({ type: "prompt", message: "/live revoke" });
	await until(() => !a.state.control, "control revoked");
	check(true, "/live revoke");
	rpc({ type: "prompt", message: "/live stop" });
	await until(() => a.state.conn === "closed" && b.state.conn === "closed", "viewers closed");
	check(/host stopped sharing/.test(a.state.detail ?? ""), `viewer got bye (${a.state.detail})`);
} catch (err) {
	failures++;
	console.log(`  ✗ ${(err as Error).message}`);
	console.log("host stderr:\n", hostErr.slice(-2000));
	console.log("notices:", notices.slice(-5));
} finally {
	await Promise.allSettled(viewers.map((v) => v.close()));
	host.kill();
	fs.rmSync(cwd, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
