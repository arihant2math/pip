/**
 * `/gui` test: a host pi (RPC, faux model) runs `/gui`; this process talks to the GUI server over HTTP
 * like the browser page would. No sharing/iroh involved.
 *
 *   node --experimental-strip-types --no-warnings pi-live/test/self-gui.ts
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "..");
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pilive-selfgui-"));

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
	["--mode", "rpc", "--no-session", "-ne", "--offline", "-e", path.join(here, "faux-model.ts"), "-e", root, "--model", "faux/echo"],
	{ cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_LIVE_NO_OPEN: "1" } },
);
let hostErr = "";
host.stderr.on("data", (d) => (hostErr += d));
const notices: string[] = [];
readline.createInterface({ input: host.stdout }).on("line", (line) => {
	try {
		const msg = JSON.parse(line);
		if (msg.type === "extension_ui_request" && msg.method === "notify") notices.push(msg.message);
	} catch {}
});
const rpc = (cmd: object) => host.stdin.write(`${JSON.stringify(cmd)}\n`);

const abort = new AbortController();
try {
	rpc({ type: "prompt", message: "before gui" });
	await new Promise((r) => setTimeout(r, 1500));
	rpc({ type: "prompt", message: "/gui" });
	const url = (await until(() => notices.map((n) => /GUI at (http\S+)/.exec(n)?.[1]).find(Boolean), "GUI url"))!;
	const base = new URL(url).origin;
	const token = new URL(url).searchParams.get("t")!;
	console.log(`gui: ${url}`);
	check(notices.every((n) => !n.includes("pilive1:")), "no share code was created");

	const page = await fetch(url).then((r) => r.text());
	check(page.includes('"local":true') && page.includes("<title>pi</title>"), "page is in local mode");

	const events: any[] = [];
	const res = await fetch(`${base}/events?t=${token}`, { signal: abort.signal });
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
	const has = (pred: (i: any) => boolean) => events.some((e) => e.ev === "state" && e.data.items?.some(pred));
	await until(() => events.find((e) => e.ev === "state" && e.data.full), "initial state");
	const first = events.find((e) => e.ev === "state" && e.data.full).data;
	check(first.items.some((i: any) => i.k === "assistant" && i.text === "echo: before gui"), "snapshot has the existing transcript");
	check(first.control === true && first.conn === "live", "in control without asking");

	const send = (body: object) =>
		fetch(`${base}/api/send`, { method: "POST", headers: { "x-pi-live-token": token }, body: JSON.stringify(body) }).then((r) => r.json());
	check((await send({ t: "prompt", text: "from the browser" })).ok, "prompt accepted");
	await until(() => has((i) => i.k === "assistant" && i.text === "echo: from the browser"), "reply");
	check(true, "browser prompt ran in the session");

	rpc({ type: "prompt", message: "from the terminal" });
	await until(() => has((i) => i.k === "assistant" && i.text === "echo: from the terminal"), "terminal reply");
	check(true, "terminal activity streams to the GUI");

	await until(() => events.at(-1)?.data.busy === false, "idle");
	check((await send({ t: "prompt", text: "slow please" })).ok, "slow prompt");
	await until(() => events.some((e) => e.ev === "state" && e.data.streaming?.text.length > 20), "streaming");
	check(true, "streaming text");
	check((await send({ t: "abort" })).ok, "abort accepted");
	await until(() => has((i) => i.k === "assistant" && i.error === "aborted"), "aborted", 30_000);
	check(true, "abort worked");

	rpc({ type: "new_session" });
	await until(() => events.some((e) => e.ev === "state" && e.data.full && e.data.items.every((i: any) => i.k === "info")), "reset");
	check(true, "/new resets the GUI");

	rpc({ type: "prompt", message: "/gui stop" });
	await until(() => notices.some((n) => n.includes("GUI stopped")), "stop");
	const after = await fetch(url).then(
		() => "up",
		() => "down",
	);
	check(after === "down", "/gui stop shuts the server down");
} catch (err) {
	failures++;
	console.log(`  ✗ ${(err as Error).message}`);
	console.log("host stderr:\n", hostErr.slice(-2000));
	console.log("notices:", notices.slice(-5));
} finally {
	abort.abort();
	host.kill();
	fs.rmSync(cwd, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
