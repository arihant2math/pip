/**
 * Browser GUI for a pi-live viewer.
 *
 * Serves a page on 127.0.0.1 that looks like pi's `/export` HTML: it reuses pi's export template CSS
 * (with the viewer's theme colors), the vendored marked + highlight.js, and the export's markup classes.
 * Only the viewer side is involved, so hosts don't need to update.
 *
 * The page gets state over Server-Sent Events and sends prompts/steer/abort/control requests back with
 * POST. Every request needs a random per-session token; the server checks the Host header against
 * DNS rebinding and sends a strict CSP.
 */
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LiveViewer, ViewState } from "./client.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------------------------
// Export template assets (from the viewer's own pi install)

interface ExportAssets {
	css: string;
	marked: string;
	markedCjk: string;
	hljs: string;
}

/** Candidate pi package dirs: the running pi first, then pi-live's own node_modules copy. */
async function piPackageDirs(): Promise<string[]> {
	const dirs: string[] = [];
	try {
		const pi: any = await import("@earendil-works/pi-coding-agent");
		if (typeof pi.getPackageDir === "function") dirs.push(pi.getPackageDir());
	} catch {}
	try {
		const require = createRequire(path.join(here, "package.json"));
		dirs.push(path.dirname(require.resolve("@earendil-works/pi-coding-agent/package.json")));
	} catch {}
	dirs.push(path.join(here, "node_modules", "@earendil-works", "pi-coding-agent"));
	return [...new Set(dirs)];
}

let assetsPromise: Promise<ExportAssets> | undefined;
function loadAssets(): Promise<ExportAssets> {
	assetsPromise ??= (async () => {
		const tried: string[] = [];
		for (const pkg of await piPackageDirs()) {
			for (const dir of [path.join(pkg, "dist", "core", "export-html"), path.join(pkg, "src", "core", "export-html"), path.join(pkg, "export-html")]) {
				tried.push(dir);
				const css = path.join(dir, "template.css");
				const vendor = path.join(dir, "vendor");
				if (!fs.existsSync(css) || !fs.existsSync(path.join(vendor, "marked.min.js"))) continue;
				const read = (f: string) => fs.readFileSync(f, "utf8");
				return {
					css: read(css),
					marked: read(path.join(vendor, "marked.min.js")),
					markedCjk: fs.existsSync(path.join(vendor, "marked-cjk-friendly.min.js")) ? read(path.join(vendor, "marked-cjk-friendly.min.js")) : "",
					hljs: read(path.join(vendor, "highlight.min.js")),
				};
			}
		}
		assetsPromise = undefined;
		throw new Error(`could not find pi's export-html template (tried ${tried.join(", ") || "nothing"}); run \`npm install\` in pi-live`);
	})();
	return assetsPromise;
}

// ---------------------------------------------------------------------------------------------
// Theme → CSS variables (mirrors pi's export-html/index.ts)

export interface GuiTheme {
	/** Theme token → CSS color. */
	colors: Record<string, string>;
	pageBg: string;
	cardBg: string;
	infoBg: string;
}

function parseRgb(color: string): { r: number; g: number; b: number } | undefined {
	const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
	if (hex) return { r: Number.parseInt(hex[1]!, 16), g: Number.parseInt(hex[2]!, 16), b: Number.parseInt(hex[3]!, 16) };
	const rgb = /^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(color);
	if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
	return undefined;
}

function deriveExportColors(base: string): { pageBg: string; cardBg: string; infoBg: string } {
	const c = parseRgb(base);
	if (!c) return { pageBg: "rgb(24, 24, 30)", cardBg: "rgb(30, 30, 36)", infoBg: "rgb(60, 55, 40)" };
	const lin = (v: number) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	const lum = 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
	const adj = (f: number) => {
		const a = (v: number) => Math.min(255, Math.max(0, Math.round(v * f)));
		return `rgb(${a(c.r)}, ${a(c.g)}, ${a(c.b)})`;
	};
	if (lum > 0.5) {
		return { pageBg: adj(0.96), cardBg: base, infoBg: `rgb(${Math.min(255, c.r + 10)}, ${Math.min(255, c.g + 5)}, ${Math.max(0, c.b - 20)})` };
	}
	return { pageBg: adj(0.7), cardBg: adj(0.85), infoBg: `rgb(${Math.min(255, c.r + 20)}, ${Math.min(255, c.g + 15)}, ${c.b})` };
}

/** pi's internal theme module (not part of the public API), for named themes outside the TUI. */
async function loadThemeModule(): Promise<any | undefined> {
	for (const pkg of await piPackageDirs()) {
		const file = path.join(pkg, "dist", "modes", "interactive", "theme", "theme.js");
		if (!fs.existsSync(file)) continue;
		try {
			return await import(pathToFileURL(file).href);
		} catch {}
	}
	return undefined;
}

/**
 * Builds GUI colors. Pass the TUI's live `Theme` when available (inside pi), otherwise a theme name
 * (standalone CLI; defaults to "dark").
 */
export async function resolveGuiTheme(opts: { theme?: { name?: string; colors?: Record<string, unknown> }; name?: string } = {}): Promise<GuiTheme> {
	let colors: Record<string, string> | undefined;
	let exp: { pageBg?: string; cardBg?: string; infoBg?: string } = {};
	const name = opts.theme?.name ?? opts.name ?? "dark";
	const themeMod = await loadThemeModule();

	const live = opts.theme?.colors;
	if (live && typeof live === "object") {
		try {
			const tui: any = await import("@earendil-works/pi-tui");
			colors = Object.fromEntries(Object.entries(live).map(([k, v]) => [k, tui.colorToHex(v)]));
		} catch {}
	}
	if (!colors && themeMod?.getResolvedThemeColors) {
		try {
			colors = themeMod.getResolvedThemeColors(name);
		} catch {
			try {
				colors = themeMod.getResolvedThemeColors("dark");
			} catch {}
		}
	}
	try {
		exp = themeMod?.getThemeExportColors?.(name) ?? {};
	} catch {}
	colors ??= {};
	const derived = deriveExportColors(colors.userMessageBg || "#343541");
	return {
		colors,
		pageBg: exp.pageBg ?? derived.pageBg,
		cardBg: exp.cardBg ?? derived.cardBg,
		infoBg: exp.infoBg ?? derived.infoBg,
	};
}

// ---------------------------------------------------------------------------------------------
// Page

const scriptSafe = (s: string) => s.replace(/<\/(script)/gi, "<\\/$1");

function buildPage(assets: ExportAssets, theme: GuiTheme, token: string): string {
	const themeVars = Object.entries(theme.colors)
		.filter(([k, v]) => /^[a-zA-Z0-9_-]+$/.test(k) && typeof v === "string" && !/[;{}<]/.test(v))
		.map(([k, v]) => `--${k}: ${v};`)
		.join("\n      ");
	const css = assets.css
		.replace("{{THEME_VARS}}", themeVars)
		.replace("{{BODY_BG}}", theme.pageBg)
		.replace("{{CONTAINER_BG}}", theme.cardBg)
		.replace("{{INFO_BG}}", theme.infoBg);
	const app = fs.readFileSync(path.join(here, "gui", "app.js"), "utf8");
	const config = JSON.stringify({ token }).replace(/</g, "\\u003c");
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>pi-live</title>
  <style>
${css}
  </style>
</head>
<body>
  <div id="app">
    <main id="content">
      <div id="header-container"></div>
      <div id="messages"><div id="transcript" style="display: contents"></div><div id="composer-container" style="display: contents"></div></div>
    </main>
  </div>
  <script id="pi-live-config" type="application/json">${config}</script>
  <script>${scriptSafe(assets.marked)}</script>
  <script>${scriptSafe(assets.markedCjk)}</script>
  <script>${scriptSafe(assets.hljs)}</script>
  <script>
${scriptSafe(app)}
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------------------------
// Server

interface SseClient {
	res: http.ServerResponse;
	sentSyncs: number;
	sentLen: number;
	sentOmitted: number;
	timer?: NodeJS.Timeout;
}

const FLUSH_MS = 40;
const MAX_BODY = 256 * 1024;

export class WatchGui {
	readonly token = crypto.randomBytes(18).toString("base64url");
	private server?: http.Server;
	private port = 0;
	private readonly clients = new Set<SseClient>();
	private unsubscribe?: () => void;
	private heartbeat?: NodeJS.Timeout;
	private page?: string;
	private readonly viewer: LiveViewer;
	private readonly theme: GuiTheme;

	constructor(viewer: LiveViewer, theme: GuiTheme) {
		this.viewer = viewer;
		this.theme = theme;
	}

	get url(): string {
		return `http://127.0.0.1:${this.port}/?t=${this.token}`;
	}

	get running(): boolean {
		return !!this.server;
	}

	/** Starts the local server; resolves to the page URL. */
	async start(): Promise<string> {
		if (this.server) return this.url;
		this.page = buildPage(await loadAssets(), this.theme, this.token);
		const server = http.createServer((req, res) => this.handle(req, res));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		server.unref();
		this.server = server;
		this.port = (server.address() as { port: number }).port;
		this.unsubscribe = this.viewer.subscribe(
			() => this.scheduleAll(),
			(level, text) => this.broadcast("notice", { level, text }),
		);
		this.heartbeat = setInterval(() => {
			for (const c of this.clients) c.res.write(": ping\n\n");
		}, 15_000);
		this.heartbeat.unref();
		return this.url;
	}

	close() {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		clearInterval(this.heartbeat);
		for (const c of this.clients) {
			clearTimeout(c.timer);
			this.flush(c);
			c.res.end();
		}
		this.clients.clear();
		this.server?.close();
		this.server?.closeAllConnections?.();
		this.server = undefined;
	}

	private handle(req: http.IncomingMessage, res: http.ServerResponse) {
		const host = req.headers.host ?? "";
		if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return this.reply(res, 403, "bad host");
		const url = new URL(req.url ?? "/", `http://${host}`);
		const queryOk = url.searchParams.get("t") === this.token;

		if (req.method === "GET" && url.pathname === "/") {
			if (!queryOk) return this.reply(res, 403, "missing or wrong token");
			res.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
				"x-content-type-options": "nosniff",
				"content-security-policy":
					"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
			});
			return res.end(this.page);
		}
		if (req.method === "GET" && url.pathname === "/events") {
			if (!queryOk) return this.reply(res, 403, "missing or wrong token");
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
			res.write("retry: 2000\n\n");
			const client: SseClient = { res, sentSyncs: -1, sentLen: 0, sentOmitted: 0 };
			this.clients.add(client);
			req.on("close", () => {
				clearTimeout(client.timer);
				this.clients.delete(client);
			});
			this.flush(client);
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/send") {
			// A custom header forces a CORS preflight, which this server never approves.
			if (req.headers["x-pi-live-token"] !== this.token) return this.reply(res, 403, "missing or wrong token");
			let body = "";
			let tooBig = false;
			req.setEncoding("utf8");
			req.on("data", (chunk: string) => {
				body += chunk;
				if (body.length > MAX_BODY) {
					tooBig = true;
					req.destroy();
				}
			});
			req.on("end", () => {
				if (tooBig) return;
				let msg: any;
				try {
					msg = JSON.parse(body);
				} catch {
					return this.reply(res, 400, "bad json");
				}
				return this.json(res, this.command(msg));
			});
			return;
		}
		this.reply(res, 404, "not found");
	}

	private command(msg: any): { ok: boolean; error?: string } {
		const v = this.viewer;
		const text = typeof msg?.text === "string" ? msg.text.trim() : "";
		switch (msg?.t) {
			case "control_request":
				if (v.state.control) return { ok: true };
				return v.requestControl() ? { ok: true } : { ok: false, error: "not connected" };
			case "abort":
				return v.send({ t: "abort" }) ? { ok: true } : { ok: false, error: "not connected" };
			case "prompt":
			case "steer":
				if (!text) return { ok: false, error: "empty message" };
				if (!v.state.control) return { ok: false, error: "you don't have control yet" };
				return v.send({ t: msg.t, text }) ? { ok: true } : { ok: false, error: "not connected" };
			default:
				return { ok: false, error: "unknown command" };
		}
	}

	private reply(res: http.ServerResponse, status: number, text: string) {
		res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
		res.end(text);
	}

	private json(res: http.ServerResponse, body: unknown) {
		res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
		res.end(JSON.stringify(body));
	}

	private broadcast(event: string, data: unknown) {
		const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const c of this.clients) c.res.write(payload);
	}

	private scheduleAll() {
		for (const c of this.clients) {
			c.timer ??= setTimeout(() => {
				c.timer = undefined;
				this.flush(c);
			}, FLUSH_MS);
		}
	}

	/** Sends the state, with only the transcript items the client doesn't have yet. */
	private flush(c: SseClient) {
		const s: ViewState = this.viewer.state;
		const full = c.sentSyncs !== s.syncs || c.sentOmitted !== s.omitted || s.items.length < c.sentLen;
		const payload: Record<string, unknown> = {
			conn: s.conn,
			detail: s.detail,
			session: s.session,
			omitted: s.omitted,
			busy: s.busy,
			waitingForHost: s.waitingForHost,
			control: s.control,
			controlPending: s.controlPending,
			viewers: s.viewers,
			streaming: s.streaming,
			running: [...s.running.entries()].map(([id, r]) => ({ id, name: r.name, args: r.args })),
		};
		if (full) {
			payload.full = true;
			payload.items = s.items;
		} else if (s.items.length > c.sentLen) {
			payload.from = c.sentLen;
			payload.items = s.items.slice(c.sentLen);
		}
		c.sentSyncs = s.syncs;
		c.sentLen = s.items.length;
		c.sentOmitted = s.omitted;
		c.res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);
	}
}

/** Opens a URL in the default browser (best effort). */
export function openBrowser(url: string) {
	const [cmd, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
				: ["xdg-open", [url]];
	try {
		const p = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
		p.on("error", () => {});
		p.unref();
	} catch {}
}
