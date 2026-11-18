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

export function head(text: string, max: number, note = ""): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated${note ? `; ${note}` : ""}]`;
}

/** Subagent nesting depth of this process (0 = the user's session). */
export const SUBAGENT_DEPTH = Number(process.env.PI_SUBAGENT_DEPTH) || 0;
export const MAX_SUBAGENT_DEPTH = Number(process.env.PI_SUBAGENT_MAX_DEPTH) || 3;
