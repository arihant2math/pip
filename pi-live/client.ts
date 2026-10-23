/**
 * Viewer side: connects to a pi-live host over iroh, keeps a materialized view of the host's
 * transcript, and reconnects after unexpected drops. Shared by `/watch` and the CLI viewer.
 */
import { loadIroh } from "./iroh.ts";
import {
	ALPN,
	type ClientFrame,
	errorMessage,
	FrameWriter,
	type HostFrame,
	type Item,
	PROTOCOL_VERSION,
	parseShare,
	readFrame,
	type SessionInfo,
	type ShareCode,
} from "./protocol.ts";

export type ConnState = "connecting" | "live" | "reconnecting" | "closed";

export interface ViewState {
	conn: ConnState;
	/** Why the connection is closed or reconnecting. */
	detail?: string;
	session?: SessionInfo;
	items: Item[];
	omitted: number;
	busy: boolean;
	waitingForHost: boolean;
	control: boolean;
	controlPending: boolean;
	viewers: number;
	streaming: { text: string; thinking: string };
	running: Map<string, { name: string; args: string }>;
	/** Bumped on every change; renderers use it as a cache key. */
	version: number;
	/** Bumped whenever the transcript is replaced wholesale (welcome / reset). */
	syncs: number;
}

const MAX_ITEMS = 2000;
const PING_MS = 10_000;
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000];
const CONNECT_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		p.finally(() => clearTimeout(timer)),
		new Promise<T>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
		}),
	]);
}

export class LiveViewer {
	readonly share: ShareCode;
	readonly state: ViewState = {
		conn: "connecting",
		items: [],
		omitted: 0,
		busy: false,
		waitingForHost: false,
		control: false,
		controlPending: false,
		viewers: 0,
		streaming: { text: "", thinking: "" },
		running: new Map(),
		version: 0,
		syncs: 0,
	};
	/** Called after every state change. */
	onChange?: (state: ViewState) => void;
	/** Called for host notices and connection events worth surfacing. */
	onNotice?: (level: "info" | "warning" | "error", text: string) => void;

	private readonly changeListeners = new Set<(state: ViewState) => void>();
	private readonly noticeListeners = new Set<(level: "info" | "warning" | "error", text: string) => void>();

	/** Extra observers besides `onChange` (e.g. the browser GUI). Returns an unsubscribe function. */
	subscribe(onChange: (state: ViewState) => void, onNotice?: (level: "info" | "warning" | "error", text: string) => void): () => void {
		this.changeListeners.add(onChange);
		if (onNotice) this.noticeListeners.add(onNotice);
		return () => {
			this.changeListeners.delete(onChange);
			if (onNotice) this.noticeListeners.delete(onNotice);
		};
	}

	private notice(level: "info" | "warning" | "error", text: string) {
		try {
			this.onNotice?.(level, text);
		} catch {}
		for (const fn of this.noticeListeners) {
			try {
				fn(level, text);
			} catch {}
		}
	}

	private endpoint: any;
	private conn: any;
	private writer?: FrameWriter;
	private stopped = false;
	private pingTimer?: NodeJS.Timeout;
	private attempt = 0;
	private everConnected = false;

	private readonly displayName?: string;

	constructor(shareCode: string, displayName?: string) {
		this.share = parseShare(shareCode);
		this.displayName = displayName;
	}

	/** Connects; resolves after the first welcome, rejects if the first attempt fails. */
	async start(): Promise<void> {
		const iroh = await loadIroh();
		this.endpoint = await iroh.Endpoint.bind();
		await this.connectOnce();
	}

	send(frame: ClientFrame): boolean {
		if (this.state.conn !== "live" || !this.writer) return false;
		return this.writer.write(frame);
	}

	requestControl(): boolean {
		if (this.state.control || this.state.controlPending) return true;
		if (!this.send({ t: "control_request" })) return false;
		this.state.controlPending = true;
		this.changed();
		return true;
	}

	async close(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		clearInterval(this.pingTimer);
		this.setConn("closed", "disconnected");
		try {
			this.conn?.close(0n, Array.from(Buffer.from("viewer left")));
		} catch {}
		try {
			await this.endpoint?.close();
		} catch {}
	}

	// -------------------------------------------------------------------------------------------

	private async connectOnce(): Promise<void> {
		const iroh = await loadIroh();
		const addr = iroh.EndpointTicket.fromString(this.share.ticket).endpointAddr();
		this.setConn(this.everConnected ? "reconnecting" : "connecting", this.state.detail);
		const conn = await withTimeout<any>(this.endpoint.connect(addr, ALPN), CONNECT_TIMEOUT_MS, "connecting to host");
		if (this.stopped) {
			conn.close(0n, []);
			return;
		}
		this.conn = conn;
		const bi = await conn.openBi();
		const writer = new FrameWriter(bi.send, (err) => this.dropped(conn, err));
		this.writer = writer;
		writer.write({ t: "hello", v: PROTOCOL_VERSION, token: this.share.secret, name: this.displayName });

		const first = await withTimeout(readFrame<HostFrame>(bi.recv), CONNECT_TIMEOUT_MS, "waiting for host welcome");
		if (first.t === "bye") throw new FatalError(first.reason);
		if (first.t !== "welcome") throw new Error(`unexpected first frame '${first.t}'`);
		this.apply(first);
		this.attempt = 0;
		this.everConnected = true;
		this.setConn("live");

		clearInterval(this.pingTimer);
		let n = 0;
		this.pingTimer = setInterval(() => writer.write({ t: "ping", n: n++ }), PING_MS);

		// Read loop (not awaited by start()).
		void (async () => {
			try {
				for (;;) {
					const frame = await readFrame<HostFrame>(bi.recv);
					if (frame.t === "bye") {
						this.notice("warning", `host ended the share: ${frame.reason}`);
						this.stopped = true;
						clearInterval(this.pingTimer);
						this.setConn("closed", frame.reason);
						try {
							conn.close(0n, []);
						} catch {}
						await this.endpoint?.close().catch(() => {});
						return;
					}
					this.apply(frame);
				}
			} catch (err) {
				this.dropped(conn, err);
			}
		})();
	}

	private dropped(conn: any, err: unknown) {
		if (this.stopped || conn !== this.conn) return;
		this.conn = undefined;
		this.writer = undefined;
		clearInterval(this.pingTimer);
		try {
			conn.close(0n, []);
		} catch {}
		this.state.controlPending = false;
		this.reconnect(errorMessage(err));
	}

	private reconnect(reason: string) {
		if (this.stopped) return;
		if (this.attempt >= RECONNECT_DELAYS.length) {
			this.stopped = true;
			this.setConn("closed", `connection lost: ${reason}`);
			this.notice("error", `pi-live: gave up reconnecting (${reason})`);
			void this.endpoint?.close().catch(() => {});
			return;
		}
		const delay = RECONNECT_DELAYS[this.attempt++]!;
		this.setConn("reconnecting", `${reason}; retrying in ${Math.round(delay / 1000)}s`);
		setTimeout(() => {
			if (this.stopped) return;
			this.connectOnce().catch((e) => {
				if (e instanceof FatalError) {
					this.stopped = true;
					this.setConn("closed", e.message);
					this.notice("error", `pi-live: ${e.message}`);
					void this.endpoint?.close().catch(() => {});
				} else this.reconnect(errorMessage(e));
			});
		}, delay);
	}

	private apply(f: HostFrame) {
		if (process.env.PI_LIVE_DEBUG) process.stderr.write(`[frame ${Date.now() % 100000}] ${JSON.stringify(f).slice(0, 160)}\n`);
		const s = this.state;
		switch (f.t) {
			case "welcome":
			case "reset":
				s.session = f.session;
				s.items = f.items.slice();
				s.omitted = f.omitted;
				s.syncs++;
				s.busy = f.busy;
				s.streaming = { text: "", thinking: "" };
				s.running = new Map();
				if (f.t === "welcome") {
					s.control = f.control;
					if (f.streaming) s.streaming = { ...f.streaming };
					for (const r of f.running ?? []) s.running.set(r.id, { name: r.name, args: r.args });
				}
				break;
			case "item":
				s.items.push(f.item);
				if (s.items.length > MAX_ITEMS) {
					const drop = s.items.length - MAX_ITEMS;
					s.items.splice(0, drop);
					s.omitted += drop;
				}
				if (f.item.k === "assistant") s.streaming = { text: "", thinking: "" };
				if (f.item.k === "tool" && f.item.id) s.running.delete(f.item.id);
				break;
			case "delta":
				if (f.kind === "text") s.streaming.text += f.text;
				else s.streaming.thinking += f.text;
				break;
			case "tool_start":
				s.running.set(f.id, { name: f.name, args: f.args });
				break;
			case "tool_end":
				s.running.delete(f.id);
				break;
			case "busy":
				s.busy = f.busy;
				if (!f.busy) {
					s.running.clear();
					s.streaming = { text: "", thinking: "" };
				}
				break;
			case "needs_input":
				s.waitingForHost = f.waiting;
				break;
			case "control":
				s.control = f.granted;
				s.controlPending = false;
				this.notice(f.granted ? "info" : "warning", f.granted ? "control granted" : `control ${f.reason ?? "denied"}`);
				break;
			case "viewers":
				s.viewers = f.count;
				break;
			case "notice":
				this.notice(f.level, f.text);
				break;
			case "pong":
				return; // no visible change
		}
		this.changed();
	}

	private setConn(conn: ConnState, detail?: string) {
		this.state.conn = conn;
		this.state.detail = detail;
		this.changed();
	}

	private changed() {
		this.state.version++;
		try {
			this.onChange?.(this.state);
		} catch {}
		for (const fn of this.changeListeners) {
			try {
				fn(this.state);
			} catch {}
		}
	}
}

/** Errors that should not trigger a reconnect (e.g. bad secret, host refused). */
class FatalError extends Error {}
