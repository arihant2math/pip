/**
 * Host side: an iroh endpoint that streams this pi session to authenticated viewers and, with the
 * host's per-viewer consent, accepts prompts / steering / abort from them.
 *
 * The LiveHost instance lives on globalThis (see index.ts) so a share survives /reload and session
 * switches; each extension runtime re-attaches its `pi` and `ctx` on session_start.
 */
import * as crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadIroh } from "./iroh.ts";
import {
	ALPN,
	type ClientFrame,
	errorMessage,
	FrameWriter,
	formatShare,
	type HostFrame,
	type Item,
	MAX_CLIENT_FRAME_BYTES,
	PROTOCOL_VERSION,
	readFrame,
	type SessionInfo,
} from "./protocol.ts";
import { argPreview, entriesToItems, tail } from "./transcript.ts";

export type ControlPolicy = "ask" | "deny" | "allow";

const MAX_VIEWERS = 16;
const HELLO_TIMEOUT_MS = 15_000;
const ONLINE_TIMEOUT_MS = 10_000;
const DELTA_FLUSH_MS = 50;
const MAX_PROMPT_CHARS = 64_000;
/** Command rate limit per viewer: at most N commands per window. */
const CMD_WINDOW_MS = 10_000;
const CMD_MAX = 10;

interface Viewer {
	id: string;
	short: string;
	name: string;
	writer: FrameWriter;
	conn: any;
	control: boolean;
	controlAsked: boolean;
	cmdTimes: number[];
	joinedAt: number;
}

export class LiveHost {
	private pi?: ExtensionAPI;
	private ctx?: ExtensionContext;
	private endpoint: any;
	private secret = "";
	private shareCode = "";
	private viewers = new Map<string, Viewer>();
	private stopping = false;
	private busy = false;
	private waitingForHost = false;
	private streaming = { text: "", thinking: "" };
	private pendingDelta = { text: "", thinking: "" };
	private deltaTimer?: NodeJS.Timeout;
	private running = new Map<string, { name: string; args: string }>();
	/** In-process listeners (the host's own browser GUI). They get every frame and work without sharing. */
	private locals = new Set<(frame: HostFrame) => void>();
	/** Serializes host-side confirm dialogs. */
	private dialogChain: Promise<unknown> = Promise.resolve();
	controlPolicy: ControlPolicy = "ask";

	get code(): string {
		return this.shareCode;
	}

	get active(): boolean {
		return !!this.endpoint && !this.stopping;
	}

	listViewers(): { id: string; name: string; control: boolean; since: number }[] {
		return [...this.viewers.values()].map((v) => ({ id: v.short, name: v.name, control: v.control, since: v.joinedAt }));
	}

	/** Re-binds to the current extension runtime and session. */
	attach(pi: ExtensionAPI, ctx: ExtensionContext) {
		this.pi = pi;
		this.ctx = ctx;
		this.updateStatus();
	}

	/** Drops references to a runtime that is going away (reload / session switch). */
	detach() {
		this.ctx = undefined;
		this.pi = undefined;
	}

	async start(): Promise<string> {
		if (this.endpoint) return this.shareCode;
		const iroh = await loadIroh();
		const ep = await iroh.Endpoint.bind({ alpns: [ALPN] });
		await Promise.race([ep.online(), new Promise((r) => setTimeout(r, ONLINE_TIMEOUT_MS))]);
		this.endpoint = ep;
		this.stopping = false;
		this.secret = crypto.randomBytes(18).toString("base64url");
		this.shareCode = formatShare(iroh.EndpointTicket.fromAddr(ep.addr()).toString(), this.secret);
		void this.acceptLoop(ep);
		this.updateStatus();
		return this.shareCode;
	}

	async stop(reason = "host stopped sharing"): Promise<void> {
		const ep = this.endpoint;
		if (!ep || this.stopping) return;
		this.stopping = true;
		const viewers = [...this.viewers.values()];
		for (const v of viewers) v.writer.write({ t: "bye", reason });
		await Promise.race([Promise.all(viewers.map((v) => v.writer.flush())), new Promise((r) => setTimeout(r, 1000))]);
		for (const v of viewers) this.closeViewer(v, reason, false);
		this.viewers.clear();
		clearTimeout(this.deltaTimer);
		this.deltaTimer = undefined;
		this.endpoint = undefined;
		this.secret = "";
		this.shareCode = "";
		try {
			await ep.close();
		} catch {}
		this.stopping = false;
		this.updateStatus();
	}

	kick(idPrefix: string): boolean {
		const v = this.findViewer(idPrefix);
		if (!v) return false;
		v.writer.write({ t: "bye", reason: "removed by host" });
		void v.writer.flush().finally(() => this.closeViewer(v, "kicked"));
		return true;
	}

	revokeControl(idPrefix?: string): number {
		let n = 0;
		for (const v of this.viewers.values()) {
			if (idPrefix && !v.short.startsWith(idPrefix) && !v.id.startsWith(idPrefix)) continue;
			if (!v.control) continue;
			v.control = false;
			v.controlAsked = false;
			v.writer.write({ t: "control", granted: false, reason: "revoked by host" });
			n++;
		}
		this.updateStatus();
		return n;
	}

	// -------------------------------------------------------------------------------------------
	// Local (in-process) views

	/** Subscribes an in-process view; it immediately gets a welcome snapshot. Returns an unsubscribe. */
	addLocal(fn: (frame: HostFrame) => void): () => void {
		this.locals.add(fn);
		const snap = this.snapshot();
		fn({
			t: "welcome",
			v: PROTOCOL_VERSION,
			viewerId: "local",
			session: this.sessionInfo(),
			items: snap.items,
			omitted: snap.omitted,
			busy: this.isBusy(),
			control: true,
			streaming: this.streaming.text || this.streaming.thinking ? { ...this.streaming } : undefined,
			running: [...this.running].map(([rid, r]) => ({ id: rid, ...r })),
		});
		if (this.waitingForHost) fn({ t: "needs_input", waiting: true });
		fn({ t: "viewers", count: this.viewers.size });
		return () => this.locals.delete(fn);
	}

	/** A prompt/steer/abort from the host's own local view. */
	localCommand(f: ClientFrame): { error?: string; info?: string } {
		if (f.t !== "prompt" && f.t !== "steer" && f.t !== "abort") return {};
		const r = this.deliver(f);
		return { error: r.error, info: r.info };
	}

	// -------------------------------------------------------------------------------------------
	// Session events (called from index.ts handlers)

	onAgentStart() {
		this.busy = true;
		this.broadcast({ t: "busy", busy: true });
	}

	onAgentSettled(aborted: boolean) {
		this.flushDeltas();
		this.busy = false;
		this.streaming = { text: "", thinking: "" };
		this.running.clear();
		this.broadcast({ t: "busy", busy: false, aborted });
	}

	onMessageStart(message: any) {
		if (message?.role === "assistant") this.streaming = { text: "", thinking: "" };
	}

	onDelta(kind: "text" | "thinking", text: string) {
		if (!text) return;
		this.streaming[kind] += text;
		if (!this.viewers.size && !this.locals.size) return;
		this.pendingDelta[kind] += text;
		this.deltaTimer ??= setTimeout(() => this.flushDeltas(), DELTA_FLUSH_MS);
	}

	onItem(item: Item | undefined) {
		this.flushDeltas();
		if (!item) return;
		if (item.k === "assistant") this.streaming = { text: "", thinking: "" };
		if (item.k === "tool" && item.id) this.running.delete(item.id);
		this.broadcast({ t: "item", item });
	}

	onToolStart(id: string, name: string, args: unknown) {
		const a = argPreview(args);
		this.running.set(id, { name, args: a });
		this.broadcast({ t: "tool_start", id, name, args: a });
	}

	onToolEnd(id: string, isError: boolean) {
		this.running.delete(id);
		this.broadcast({ t: "tool_end", id, isError });
	}

	onPrompt(waiting: boolean, title?: string) {
		this.waitingForHost = waiting;
		this.broadcast({ t: "needs_input", waiting, title });
	}

	/** Session replaced, tree navigated or compacted: resend the transcript. */
	resync() {
		if ((!this.viewers.size && !this.locals.size) || !this.ctx) return;
		this.flushDeltas();
		const snap = this.snapshot();
		this.broadcast({ t: "reset", session: this.sessionInfo(), items: snap.items, omitted: snap.omitted, busy: this.isBusy() });
	}

	// -------------------------------------------------------------------------------------------

	private async acceptLoop(ep: any) {
		for (;;) {
			let incoming: any;
			try {
				incoming = await ep.acceptNext();
			} catch {
				break;
			}
			if (!incoming || ep !== this.endpoint) break;
			void this.handleIncoming(incoming).catch(() => {});
		}
	}

	private async handleIncoming(incoming: any) {
		if (this.viewers.size >= MAX_VIEWERS) {
			await incoming.refuse().catch(() => {});
			return;
		}
		const conn = await (await incoming.accept()).connect();
		const id = conn.remoteId().toString();
		const short = conn.remoteId().fmtShort();
		let bi: any;
		let hello: ClientFrame;
		try {
			const result = await withTimeout(
				(async () => {
					const b = await conn.acceptBi();
					return { b, h: await readFrame<ClientFrame>(b.recv, MAX_CLIENT_FRAME_BYTES) };
				})(),
				HELLO_TIMEOUT_MS,
			);
			bi = result.b;
			hello = result.h;
		} catch {
			conn.close(1n, Array.from(Buffer.from("handshake failed")));
			return;
		}

		const writer = new FrameWriter(bi.send, () => {
			const v = this.viewers.get(id);
			if (v && v.writer === writer) this.closeViewer(v, "send failed");
		});

		const refuse = async (reason: string) => {
			writer.write({ t: "bye", reason });
			await Promise.race([writer.flush(), new Promise((r) => setTimeout(r, 1000))]);
			conn.close(1n, Array.from(Buffer.from(reason.slice(0, 100))));
		};

		if (hello.t !== "hello" || typeof hello.token !== "string" || !this.checkSecret(hello.token)) {
			return refuse("invalid share code");
		}
		if (hello.v !== PROTOCOL_VERSION) return refuse(`protocol mismatch (host v${PROTOCOL_VERSION}, viewer v${hello.v})`);
		if (!this.ctx) return refuse("host session is not ready");
		if (this.viewers.size >= MAX_VIEWERS) return refuse("too many viewers");

		// Same endpoint reconnecting: replace the old connection.
		const prev = this.viewers.get(id);
		if (prev) this.closeViewer(prev, "replaced by new connection", false);

		const name = sanitizeName(hello.name) || short;
		const viewer: Viewer = {
			id,
			short,
			name,
			writer,
			conn,
			control: prev?.control ?? this.controlPolicy === "allow",
			controlAsked: prev?.controlAsked ?? false,
			cmdTimes: [],
			joinedAt: Date.now(),
		};
		this.viewers.set(id, viewer);

		const snap = this.snapshot();
		writer.write({
			t: "welcome",
			v: PROTOCOL_VERSION,
			viewerId: short,
			session: this.sessionInfo(),
			items: snap.items,
			omitted: snap.omitted,
			busy: this.isBusy(),
			control: viewer.control,
			streaming: this.streaming.text || this.streaming.thinking ? { ...this.streaming } : undefined,
			running: [...this.running].map(([rid, r]) => ({ id: rid, ...r })),
		});
		if (this.waitingForHost) writer.write({ t: "needs_input", waiting: true });
		this.broadcastViewers();
		if (!prev) this.notifyHost(`${name} is now watching this session`, "info");
		this.updateStatus();

		void conn
			.closed()
			.then(() => {
				const v = this.viewers.get(id);
				if (v && v.conn === conn) this.closeViewer(v, "disconnected");
			})
			.catch(() => {});

		try {
			for (;;) {
				const frame = await readFrame<ClientFrame>(bi.recv, MAX_CLIENT_FRAME_BYTES);
				if (this.viewers.get(id) !== viewer) break;
				await this.handleCommand(viewer, frame);
			}
		} catch {
			// stream closed or protocol error
		} finally {
			if (this.viewers.get(id) === viewer) this.closeViewer(viewer, "disconnected");
		}
	}

	private async handleCommand(v: Viewer, f: ClientFrame) {
		switch (f.t) {
			case "ping":
				v.writer.write({ t: "pong", n: f.n });
				return;
			case "control_request":
				void this.requestControl(v);
				return;
			case "prompt":
			case "steer":
			case "abort":
				break;
			default:
				return;
		}
		if (!v.control) {
			v.writer.write({ t: "notice", level: "warning", text: "you don't have control; request it first" });
			return;
		}
		const now = Date.now();
		v.cmdTimes = v.cmdTimes.filter((t) => now - t < CMD_WINDOW_MS);
		if (v.cmdTimes.length >= CMD_MAX) {
			v.writer.write({ t: "notice", level: "warning", text: "slow down: too many commands" });
			return;
		}
		v.cmdTimes.push(now);

		const r = this.deliver(f);
		if (r.error) v.writer.write({ t: "notice", level: "error", text: r.error });
		else if (r.info) v.writer.write({ t: "notice", level: "info", text: r.info });
		if (r.aborted) this.notifyHost(`${v.name} aborted the run`, "warning");
		else if (r.delivered) this.notifyHost(`${v.name} sent a ${r.delivered}`, "info");
	}

	/** Runs a prompt/steer/abort in this session (no permission checks; callers do those). */
	private deliver(f: ClientFrame): { error?: string; info?: string; delivered?: string; aborted?: boolean } {
		const pi = this.pi;
		const ctx = this.ctx;
		if (!pi || !ctx) return { error: "host session is not ready" };
		if (f.t === "abort") {
			if (ctx.isIdle()) return {};
			ctx.abort();
			return { aborted: true };
		}
		if (f.t !== "prompt" && f.t !== "steer") return {};
		const text = typeof f.text === "string" ? f.text.trim() : "";
		if (!text) return {};
		if (text.length > MAX_PROMPT_CHARS) return { error: `message too long (max ${MAX_PROMPT_CHARS} chars)` };
		const idle = ctx.isIdle();
		const deliverAs = idle ? undefined : f.t === "steer" ? "steer" : "followUp";
		try {
			// expandPromptTemplates stays false: remote text is never run as a /command or template.
			pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined);
		} catch (err) {
			return { error: `could not deliver: ${errorMessage(err)}` };
		}
		return {
			delivered: deliverAs ?? "prompt",
			info: deliverAs ? (deliverAs === "steer" ? "steering message queued" : "queued as follow-up") : undefined,
		};
	}

	private async requestControl(v: Viewer) {
		if (v.control) {
			v.writer.write({ t: "control", granted: true });
			return;
		}
		if (this.controlPolicy === "deny") {
			v.writer.write({ t: "control", granted: false, reason: "disabled by host" });
			return;
		}
		if (this.controlPolicy === "allow") {
			v.control = true;
			v.writer.write({ t: "control", granted: true });
			this.updateStatus();
			return;
		}
		if (v.controlAsked) return; // a dialog is already pending for this viewer
		const ctx = this.ctx;
		if (!ctx?.hasUI) {
			v.writer.write({ t: "control", granted: false, reason: "host has no UI to approve requests" });
			return;
		}
		v.controlAsked = true;
		const ask = async () => {
			if (this.viewers.get(v.id) !== v) return false;
			return ctx.ui.confirm(
				"pi-live: control request",
				`${v.name} (${v.short}) wants to send prompts, steer and abort in this session.\n` +
					"Their prompts run with your tools and permissions. Allow?",
				{ timeout: 60_000 },
			);
		};
		const result = this.dialogChain.then(ask, ask);
		this.dialogChain = result.catch(() => false);
		let granted = false;
		try {
			granted = await result;
		} catch {}
		v.controlAsked = false;
		if (this.viewers.get(v.id) !== v) return;
		v.control = granted;
		v.writer.write({ t: "control", granted, reason: granted ? undefined : "declined by host" });
		this.updateStatus();
	}

	private closeViewer(v: Viewer, reason: string, announce = true) {
		if (this.viewers.get(v.id) === v) this.viewers.delete(v.id);
		try {
			v.conn.close(0n, Array.from(Buffer.from(reason.slice(0, 100))));
		} catch {}
		if (announce && !this.stopping) {
			this.notifyHost(`${v.name} stopped watching`, "info");
			this.broadcastViewers();
			this.updateStatus();
		}
	}

	private findViewer(prefix: string): Viewer | undefined {
		const p = prefix.trim();
		if (!p) return undefined;
		return [...this.viewers.values()].find((v) => v.short.startsWith(p) || v.id.startsWith(p) || v.name === p);
	}

	private checkSecret(token: string): boolean {
		const a = Buffer.from(token);
		const b = Buffer.from(this.secret);
		return a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b);
	}

	private snapshot(): { items: Item[]; omitted: number } {
		try {
			return tail(entriesToItems(this.ctx?.sessionManager.getBranch() ?? []));
		} catch {
			return { items: [], omitted: 0 };
		}
	}

	private sessionInfo(): SessionInfo {
		const ctx = this.ctx;
		if (!ctx) return { cwd: "" };
		let name: string | undefined;
		let sessionId: string | undefined;
		try {
			name = ctx.sessionManager.getSessionName();
			sessionId = ctx.sessionManager.getSessionId();
		} catch {}
		return { cwd: ctx.cwd, name, sessionId, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined };
	}

	private isBusy(): boolean {
		try {
			return this.busy || (this.ctx ? !this.ctx.isIdle() : false);
		} catch {
			return this.busy;
		}
	}

	private flushDeltas() {
		clearTimeout(this.deltaTimer);
		this.deltaTimer = undefined;
		const { text, thinking } = this.pendingDelta;
		this.pendingDelta = { text: "", thinking: "" };
		if (thinking) this.broadcast({ t: "delta", kind: "thinking", text: thinking });
		if (text) this.broadcast({ t: "delta", kind: "text", text });
	}

	private broadcast(frame: HostFrame) {
		for (const v of this.viewers.values()) v.writer.write(frame);
		for (const fn of this.locals) {
			try {
				fn(frame);
			} catch {}
		}
	}

	private broadcastViewers() {
		this.broadcast({ t: "viewers", count: this.viewers.size });
	}

	private notifyHost(text: string, level: "info" | "warning" | "error") {
		try {
			if (this.ctx?.hasUI) this.ctx.ui.notify(text, level);
		} catch {}
	}

	private updateStatus() {
		const ctx = this.ctx;
		if (!ctx?.hasUI) return;
		try {
			if (!this.endpoint) {
				ctx.ui.setStatus("pi-live", undefined);
				return;
			}
			const n = this.viewers.size;
			const ctl = [...this.viewers.values()].filter((v) => v.control).length;
			ctx.ui.setStatus("pi-live", `live · ${n} watching${ctl ? ` · ${ctl} in control` : ""}`);
		} catch {}
	}
}

function sanitizeName(name: unknown): string {
	if (typeof name !== "string") return "";
	// Strip control characters (incl. ANSI escapes) so viewers can't paint the host's terminal.
	return name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 32);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		p.finally(() => clearTimeout(timer)),
		new Promise<T>((_, reject) => {
			timer = setTimeout(() => reject(new Error("timeout")), ms);
		}),
	]);
}
