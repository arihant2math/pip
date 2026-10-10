import * as fs from "node:fs";

export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function oneLine(s: string, max = 60): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Keep the end of `text` within `max` chars, cutting at a line boundary when possible. */
export function tail(text: string, max: number): string {
	if (text.length <= max) return text;
	let cut = text.slice(-max);
	const nl = cut.indexOf("\n");
	if (nl >= 0 && nl < cut.length - 1) cut = cut.slice(nl + 1);
	return `…\n${cut}`;
}

export function head(text: string, max: number, note = ""): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated${note ? `; ${note}` : ""}]`;
}

/** Read at most the last `maxBytes` of a file. */
export function readTail(file: string, maxBytes: number): string {
	try {
		const fd = fs.openSync(file, "r");
		try {
			const size = fs.fstatSync(fd).size;
			const len = Math.min(size, maxBytes);
			const buf = Buffer.alloc(len);
			fs.readSync(fd, buf, 0, len, size - len);
			const s = buf.toString("utf8");
			return size > len ? tail(s, len) : s;
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return "";
	}
}

export function appendLine(file: string, line: string) {
	try {
		fs.appendFileSync(file, line.endsWith("\n") ? line : `${line}\n`);
	} catch {
		// output logs are best effort
	}
}

export function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Subagent nesting depth of this process (0 = the user's session). */
export const SUBAGENT_DEPTH = Number(process.env.PI_SUBAGENT_DEPTH) || 0;
export const MAX_SUBAGENT_DEPTH = Number(process.env.PI_SUBAGENT_MAX_DEPTH) || 3;
