/**
 * pi-live wire protocol.
 *
 * One QUIC bi-stream per viewer, opened by the viewer. Every frame is a 4-byte big-endian length
 * followed by that many bytes of UTF-8 JSON. The viewer's first frame must be `hello` with the
 * share secret; the host answers with `welcome` (or `bye`) and then streams live frames.
 */

export const PROTOCOL_VERSION = 1;
export const ALPN_STRING = `pi-live/${PROTOCOL_VERSION}`;
export const ALPN = Array.from(Buffer.from(ALPN_STRING));
/** Hard cap for one frame in either direction. Snapshots are trimmed well below this. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** Viewer → host frames are small; anything bigger is a protocol violation. */
export const MAX_CLIENT_FRAME_BYTES = 256 * 1024;
const SHARE_PREFIX = "pilive1";

// ---------------------------------------------------------------------------------------------
// Transcript items: a compact, render-oriented projection of pi messages (never raw entries).

export interface ToolCallSummary {
	id: string;
	name: string;
	/** One-line argument preview. */
	args: string;
}

export type Item =
	| { k: "user"; text: string }
	| { k: "assistant"; text: string; thinking?: string; calls?: ToolCallSummary[]; error?: string }
	| { k: "tool"; id?: string; name: string; text: string; isError: boolean }
	| { k: "info"; text: string };

export interface SessionInfo {
	/** Host's display name for the session, if any. */
	name?: string;
	cwd: string;
	model?: string;
	sessionId?: string;
}

// ---------------------------------------------------------------------------------------------
// Frames

export type ClientFrame =
	| { t: "hello"; v: number; token: string; name?: string }
	| { t: "prompt"; text: string }
	| { t: "steer"; text: string }
	| { t: "abort" }
	| { t: "control_request" }
	| { t: "ping"; n: number };

export type HostFrame =
	| {
			t: "welcome";
			v: number;
			viewerId: string;
			session: SessionInfo;
			items: Item[];
			/** Number of older items omitted from `items`. */
			omitted: number;
			busy: boolean;
			control: boolean;
			/** In-flight assistant output when joining mid-stream. */
			streaming?: { text: string; thinking: string };
			running?: { id: string; name: string; args: string }[];
	  }
	| { t: "reset"; session: SessionInfo; items: Item[]; omitted: number; busy: boolean }
	| { t: "item"; item: Item }
	| { t: "delta"; kind: "text" | "thinking"; text: string }
	| { t: "tool_start"; id: string; name: string; args: string }
	| { t: "tool_end"; id: string; isError: boolean }
	| { t: "busy"; busy: boolean; aborted?: boolean }
	| { t: "needs_input"; waiting: boolean; title?: string }
	| { t: "control"; granted: boolean; reason?: string }
	| { t: "viewers"; count: number }
	| { t: "notice"; level: "info" | "warning" | "error"; text: string }
	| { t: "pong"; n: number }
	| { t: "bye"; reason: string };

// ---------------------------------------------------------------------------------------------
// Framing over iroh streams (the napi bindings take and return number[]).

/** Minimal structural types for the iroh stream halves, so this file has no runtime iroh import. */
export interface RecvLike {
	readExact(size: number): Promise<number[]>;
}
export interface SendLike {
	writeAll(buf: number[]): Promise<void>;
}

export function encodeFrame(frame: unknown): number[] {
	const body = Buffer.from(JSON.stringify(frame), "utf8");
	if (body.length > MAX_FRAME_BYTES) throw new Error(`frame too large (${body.length} bytes)`);
	const out = Buffer.allocUnsafe(4 + body.length);
	out.writeUInt32BE(body.length, 0);
	body.copy(out, 4);
	return Array.from(out);
}

export async function readFrame<T = unknown>(recv: RecvLike, maxBytes = MAX_FRAME_BYTES): Promise<T> {
	const header = Buffer.from(await recv.readExact(4));
	const len = header.readUInt32BE(0);
	if (len > maxBytes) throw new Error(`frame too large (${len} > ${maxBytes} bytes)`);
	const body = len === 0 ? Buffer.alloc(0) : Buffer.from(await recv.readExact(len));
	const parsed = JSON.parse(body.toString("utf8"));
	if (!parsed || typeof parsed !== "object" || typeof parsed.t !== "string") throw new Error("malformed frame");
	return parsed as T;
}

/**
 * Serializes writes to one stream and tracks backlog so a slow or stalled peer can be dropped
 * instead of buffering the host's whole session in memory.
 */
export class FrameWriter {
	private chain: Promise<void> = Promise.resolve();
	private pendingBytes = 0;
	private failed = false;
	private readonly send: SendLike;
	private readonly onError: (err: unknown) => void;
	private readonly maxBacklogBytes: number;

	constructor(send: SendLike, onError: (err: unknown) => void, maxBacklogBytes = 16 * 1024 * 1024) {
		this.send = send;
		this.onError = onError;
		this.maxBacklogBytes = maxBacklogBytes;
	}

	get backlog(): number {
		return this.pendingBytes;
	}

	write(frame: unknown): boolean {
		if (this.failed) return false;
		let bytes: number[];
		try {
			bytes = encodeFrame(frame);
		} catch (err) {
			this.fail(err);
			return false;
		}
		if (this.pendingBytes + bytes.length > this.maxBacklogBytes) {
			this.fail(new Error("viewer is too slow (send backlog exceeded)"));
			return false;
		}
		this.pendingBytes += bytes.length;
		this.chain = this.chain.then(async () => {
			if (this.failed) return;
			try {
				await this.send.writeAll(bytes);
			} catch (err) {
				this.fail(err);
			} finally {
				this.pendingBytes -= bytes.length;
			}
		});
		return true;
	}

	/** Resolves once everything queued so far has been written (or failed). */
	flush(): Promise<void> {
		return this.chain;
	}

	private fail(err: unknown) {
		if (this.failed) return;
		this.failed = true;
		this.onError(err);
	}
}

// ---------------------------------------------------------------------------------------------
// Share strings: `pilive1:<endpoint ticket>:<secret>`

export interface ShareCode {
	ticket: string;
	secret: string;
}

export function formatShare(ticket: string, secret: string): string {
	return `${SHARE_PREFIX}:${ticket}:${secret}`;
}

export function parseShare(input: string): ShareCode {
	const s = input.trim().replace(/^["'<]+|[">']+$/g, "");
	const parts = s.split(":");
	if (parts.length !== 3 || parts[0] !== SHARE_PREFIX || !parts[1] || !parts[2]) {
		throw new Error(`not a pi-live share code (expected ${SHARE_PREFIX}:<ticket>:<secret>)`);
	}
	return { ticket: parts[1], secret: parts[2] };
}

export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
