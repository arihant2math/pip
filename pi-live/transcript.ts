/**
 * Projects pi session messages into compact pi-live transcript items, and renders items as plain
 * text lines (shared by the TUI viewer and the CLI viewer).
 */
import type { Item, ToolCallSummary } from "./protocol.ts";

/** Per-item caps keep snapshots small and stop one huge tool result from flooding viewers. */
export const LIMITS = {
	userText: 8_000,
	assistantText: 16_000,
	thinking: 4_000,
	toolText: 2_000,
	argPreview: 200,
	/** Items included in a snapshot (older ones are counted in `omitted`). */
	snapshotItems: 200,
};

export function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.7);
	const tail = max - head;
	return `${text.slice(0, head)}\n… [${text.length - max} chars omitted] …\n${text.slice(text.length - tail)}`;
}

function oneLine(text: string, max: number): string {
	const s = text.replace(/\s+/g, " ").trim();
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function argPreview(args: unknown): string {
	if (args == null) return "";
	if (typeof args === "string") return oneLine(args, LIMITS.argPreview);
	if (typeof args === "object") {
		const o = args as Record<string, unknown>;
		// Prefer the field that usually carries the meaning.
		for (const key of ["command", "path", "file_path", "pattern", "query", "url", "prompt", "description"]) {
			if (typeof o[key] === "string") return oneLine(o[key] as string, LIMITS.argPreview);
		}
		try {
			return oneLine(JSON.stringify(args), LIMITS.argPreview);
		} catch {
			return "";
		}
	}
	return oneLine(String(args), LIMITS.argPreview);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const c of content) {
		if (!c || typeof c !== "object") continue;
		const block = c as { type?: string; text?: string };
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

/** Converts one pi message (AgentMessage) into a transcript item, or undefined to skip it. */
export function messageToItem(message: any): Item | undefined {
	if (!message || typeof message !== "object") return undefined;
	switch (message.role) {
		case "user": {
			const text = contentText(message.content);
			return { k: "user", text: clip(text, LIMITS.userText) };
		}
		case "assistant": {
			const texts: string[] = [];
			const thinking: string[] = [];
			const calls: ToolCallSummary[] = [];
			for (const c of Array.isArray(message.content) ? message.content : []) {
				if (c?.type === "text" && c.text) texts.push(c.text);
				else if (c?.type === "thinking" && c.thinking) thinking.push(c.thinking);
				else if (c?.type === "toolCall") calls.push({ id: c.id, name: c.name, args: argPreview(c.arguments) });
			}
			const item: Item = { k: "assistant", text: clip(texts.join("\n\n"), LIMITS.assistantText) };
			if (thinking.length) item.thinking = clip(thinking.join("\n\n"), LIMITS.thinking);
			if (calls.length) item.calls = calls;
			if (message.stopReason === "error" && message.errorMessage) item.error = oneLine(message.errorMessage, 500);
			else if (message.stopReason === "aborted") item.error = "aborted";
			if (!item.text && !item.thinking && !item.calls && !item.error) return undefined;
			return item;
		}
		case "toolResult":
			return {
				k: "tool",
				id: message.toolCallId,
				name: String(message.toolName ?? "tool"),
				text: clip(contentText(message.content), LIMITS.toolText),
				isError: !!message.isError,
			};
		case "bashExecution":
			return {
				k: "tool",
				name: "!bash",
				text: clip(`$ ${message.command}\n${message.output ?? ""}`, LIMITS.toolText),
				isError: typeof message.exitCode === "number" && message.exitCode !== 0,
			};
		case "custom":
			if (message.display === false) return undefined;
			return { k: "info", text: clip(`[${message.customType}] ${contentText(message.content)}`, LIMITS.toolText) };
		case "compactionSummary":
			return { k: "info", text: "[context compacted]" };
		case "branchSummary":
			return { k: "info", text: clip(`[branch summary] ${message.summary ?? ""}`, LIMITS.toolText) };
		default:
			return undefined;
	}
}

/** Projects a session branch (from `sessionManager.getBranch()`) into items. */
export function entriesToItems(entries: readonly any[]): Item[] {
	const items: Item[] = [];
	for (const e of entries) {
		if (!e || typeof e !== "object") continue;
		if (e.type === "message") {
			const item = messageToItem(e.message);
			if (item) items.push(item);
		} else if (e.type === "custom_message") {
			if (e.display === false) continue;
			items.push({ k: "info", text: clip(`[${e.customType}] ${contentText(e.content)}`, LIMITS.toolText) });
		} else if (e.type === "compaction") {
			items.push({ k: "info", text: "[context compacted]" });
		} else if (e.type === "model_change") {
			items.push({ k: "info", text: `[model → ${e.provider}/${e.modelId}]` });
		}
	}
	return items;
}

export function tail<T>(items: T[], max = LIMITS.snapshotItems): { items: T[]; omitted: number } {
	if (items.length <= max) return { items, omitted: 0 };
	return { items: items.slice(items.length - max), omitted: items.length - max };
}

// ---------------------------------------------------------------------------------------------
// Plain-text rendering (styling is applied by the caller via `Style`).

export interface Style {
	user(s: string): string;
	assistant(s: string): string;
	thinking(s: string): string;
	tool(s: string): string;
	error(s: string): string;
	muted(s: string): string;
	accent(s: string): string;
}

export const plainStyle: Style = {
	user: (s) => s,
	assistant: (s) => s,
	thinking: (s) => s,
	tool: (s) => s,
	error: (s) => s,
	muted: (s) => s,
	accent: (s) => s,
};

function indent(text: string, prefix: string): string[] {
	return text.split("\n").map((l) => prefix + l);
}

/** Renders one item to unwrapped logical lines (callers wrap to width). */
export function renderItem(item: Item, st: Style, opts: { showThinking?: boolean } = {}): string[] {
	switch (item.k) {
		case "user":
			return [st.user("▌ you/host"), ...indent(item.text, st.user("▌ "))];
		case "assistant": {
			const out: string[] = [];
			if (item.thinking && opts.showThinking) out.push(...indent(item.thinking, st.thinking("  ┆ ")).map(st.thinking));
			if (item.text) out.push(...item.text.split("\n").map(st.assistant));
			for (const c of item.calls ?? []) out.push(st.tool(`  ⚙ ${c.name}`) + st.muted(c.args ? ` ${c.args}` : ""));
			if (item.error) out.push(st.error(`  ✗ ${item.error}`));
			return out;
		}
		case "tool": {
			const lines = item.text.split("\n");
			const shown = lines.slice(0, 8);
			const out = [st.muted(`  ↳ ${item.name}${item.isError ? " (error)" : ""}`)];
			out.push(...shown.map((l) => (item.isError ? st.error(`    ${l}`) : st.muted(`    ${l}`))));
			if (lines.length > shown.length) out.push(st.muted(`    … ${lines.length - shown.length} more lines`));
			return out;
		}
		case "info":
			return item.text.split("\n").map((l) => st.accent(l));
	}
}
