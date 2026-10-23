/**
 * GUI smoke test: a host pi (RPC, faux model, `--live`), a LiveViewer in this process, and the
 * WatchGui HTTP server. Checks the page, auth, SSE state and that POSTed prompts reach the host.
 *
 *   node --experimental-strip-types --no-warnings pi-live/test/gui.ts [--keep]
 *
 * With --keep it leaves everything running and prints the GUI URL, for poking at it in a browser.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { LiveViewer } from "../client.ts";
import { resolveGuiTheme, WatchGui } from "../gui.ts";

const keep = process.argv.includes("--keep");
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "..");
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pilive-gui-"));

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

const host = spawn(
	"pi",
	["--mode", "rpc", "--no-session", "-ne", "--offline", "-e", path.join(here, "faux-model.ts"), "-e", root, "--model", "faux/echo", "--live"],
	{ cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_LIVE_NAME: "" } },
);
let hostErr = "";
host.stderr.on("data", (d) => (hostErr += d));
let shareCode = "";
readline.createInterface({ input: host.stdout }).on("line", (line) => {
	let msg: any;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	if (msg.type !== "extension_ui_request") return;
	if (msg.method === "notify") shareCode ||= /pilive1:\S+/.exec(msg.message)?.[0] ?? "";
	else if (msg.method === "confirm") host.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: msg.id, confirmed: true })}\n`);
});
const rpc = (cmd: object) => host.stdin.write(`${JSON.stringify(cmd)}\n`);

let viewer: LiveViewer | undefined;
let gui: WatchGui | undefined;
const abort = new AbortController();
try {
	await until(() => shareCode, "share code", 30_000);
	rpc({ type: "prompt", message: "hello **markdown** with `code`" });
	await new Promise((r) => setTimeout(r, 1500));

	viewer = new LiveViewer(shareCode, "gui-test");
	await viewer.start();
	gui = new WatchGui(viewer, await resolveGuiTheme({ name: "dark" }));
	const url = await gui.start();
	const base = new URL(url).origin;
	console.log(`gui: ${url}`);

	const page = await fetch(url).then((r) => r.text());
	check(page.includes("--userMessageBg") && page.includes(".user-message"), "page has export CSS with theme vars");
	check(page.includes("marked") && page.includes("hljs"), "page bundles marked + highlight.js");
	check(!page.includes("{{"), "no unreplaced template placeholders");
	check((await fetch(base + "/")).status === 403, "page without token refused");
	check((await fetch(`${base}/events`)).status === 403, "events without token refused");
	const u = new URL(url);
	const rebindStatus = await new Promise<number>((resolve, reject) => {
		http.get({ host: "127.0.0.1", port: u.port, path: u.pathname + u.search, headers: { host: `evil.example:${u.port}` } }, (r) => {
			r.resume();
			resolve(r.statusCode ?? 0);
		}).on("error", reject);
	});
	check(rebindStatus === 403, "foreign Host header refused (DNS rebinding)");
	const noTok = await fetch(`${base}/api/send`, { method: "POST", body: JSON.stringify({ t: "abort" }) });
	check(noTok.status === 403, "POST without token header refused");

	// SSE
	const events: any[] = [];
	const res = await fetch(`${base}/events?t=${gui.token}`, { signal: abort.signal });
	void (async () => {
		const dec = new TextDecoder();
		let buf = "";
		try {
			for await (const chunk of res.body as any) {
				buf += dec.decode(chunk, { stream: true });
				let i: number;
				while ((i = buf.indexOf("\n\n")) >= 0) {
					const block = buf.slice(0, i);
					buf = buf.slice(i + 2);
					const ev = /^event: (.*)$/m.exec(block)?.[1];
					const data = /^data: (.*)$/m.exec(block)?.[1];
					if (ev && data) events.push({ ev, data: JSON.parse(data) });
				}
			}
		} catch {}
	})();
	await until(() => events.find((e) => e.ev === "state" && e.data.full), "initial full state");
	const first = events.find((e) => e.ev === "state" && e.data.full).data;
	check(first.items.some((i: any) => i.k === "user" && i.text.includes("hello **markdown**")), "initial state has the transcript");

	const send = (body: object) =>
		fetch(`${base}/api/send`, { method: "POST", headers: { "x-pi-live-token": gui!.token, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
	const refused = await send({ t: "prompt", text: "nope" });
	check(!refused.ok && /control/.test(refused.error), "prompt without control refused");
	check((await send({ t: "control_request" })).ok, "control request accepted");
	await until(() => events.some((e) => e.ev === "state" && e.data.control), "control granted over SSE");
	check(true, "control granted over SSE");
	check((await send({ t: "prompt", text: "please run tool" })).ok, "prompt sent");
	await until(() => events.some((e) => e.ev === "state" && e.data.items?.some((i: any) => i.k === "tool" && i.text.includes("tool-output-42"))), "tool result over SSE");
	check(true, "incremental items over SSE");
	await until(() => events.some((e) => e.ev === "state" && e.data.items?.some((i: any) => i.text === "Tool finished.")), "final reply");
	check(true, "final reply over SSE");
	await until(() => events.at(-1)?.data.busy === false, "idle");
	check((await send({ t: "prompt", text: "slow please" })).ok, "slow prompt sent");
	await until(() => events.some((e) => e.ev === "state" && e.data.streaming?.text.length > 20), "streaming text over SSE");
	check(true, "streaming text over SSE");
	check((await send({ t: "steer", text: "steered" })).ok, "steer sent");
	await until(() => events.some((e) => e.ev === "state" && e.data.items?.some((i: any) => i.k === "user" && i.text === "steered")), "steer item", 30_000);
	check(true, "steer delivered");
	check((await send({ t: "abort" })).ok, "abort sent");
	await until(() => events.at(-1)?.data.busy === false, "idle after abort", 30_000);
	check(true, "abort settled");

	if (keep) {
		console.log(`\nleaving it running: open ${url}\nCtrl+C to stop`);
		await new Promise(() => {});
	}
} catch (err) {
	failures++;
	console.log(`  ✗ ${(err as Error).message}`);
	console.log("host stderr:\n", hostErr.slice(-2000));
} finally {
	abort.abort();
	gui?.close();
	await viewer?.close();
	host.kill();
	fs.rmSync(cwd, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
