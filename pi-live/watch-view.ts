/**
 * `/watch` overlay: a scrollable live transcript of a remote pi session plus an input line for
 * prompts once the host grants control.
 *
 * Keys: Enter send (prompt when idle, follow-up when busy) · Alt+Enter steer · Ctrl+C abort remote
 * run (if in control) · Ctrl+T request control · ↑/↓/PgUp/PgDn scroll · End follow · Ctrl+O toggle
 * thinking · Esc close.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { LiveViewer, ViewState } from "./client.ts";
import { renderItem, type Style } from "./transcript.ts";

/** Strip terminal control sequences from remote text so a host can't drive the viewer's terminal. */
function sanitize(s: string): string {
	return s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export class WatchView implements Component, Focusable {
	private readonly input: Input;
	private scrollOffset = 0; // lines from bottom; 0 = following
	private showThinking = false;
	private flash = "";
	private flashTimer?: NodeJS.Timeout;
	private cache?: { width: number; version: number; thinking: boolean; lines: string[] };
	private _focused = false;
	private readonly viewer: LiveViewer;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly onClose: () => void;

	constructor(viewer: LiveViewer, tui: TUI, theme: Theme, onClose: () => void) {
		this.viewer = viewer;
		this.tui = tui;
		this.theme = theme;
		this.onClose = onClose;
		this.input = new Input({ prompt: "› " });
		this.input.onSubmit = (value) => this.submit(value, false);
		this.input.onEscape = () => this.onClose();
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(v: boolean) {
		this._focused = v;
		this.input.focused = v;
	}

	showFlash(text: string) {
		this.flash = sanitize(text);
		clearTimeout(this.flashTimer);
		this.flashTimer = setTimeout(() => {
			this.flash = "";
			this.tui.requestRender();
		}, 4000);
		this.tui.requestRender();
	}

	/** Called when the viewer state changes. */
	refresh() {
		this.cache = undefined;
		this.tui.requestRender();
	}

	dispose() {
		clearTimeout(this.flashTimer);
	}

	invalidate() {
		this.cache = undefined;
		this.input.invalidate();
	}

	handleInput(data: string) {
		const s = this.viewer.state;
		if (matchesKey(data, Key.escape)) return this.onClose();
		if (matchesKey(data, Key.alt("enter"))) {
			this.submit(this.input.getValue(), true);
			return;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			if (!s.control) return this.showFlash("no control: Ctrl+T to request it");
			if (!s.busy) return this.showFlash("remote session is idle");
			this.viewer.send({ t: "abort" });
			return this.showFlash("abort sent");
		}
		if (matchesKey(data, Key.ctrl("t"))) {
			if (s.control) return this.showFlash("you already have control");
			if (!this.viewer.requestControl()) return this.showFlash("not connected");
			return this.showFlash("control requested; waiting for host…");
		}
		if (matchesKey(data, Key.ctrl("o"))) {
			this.showThinking = !this.showThinking;
			this.tui.requestRender();
			return;
		}
		const page = Math.max(5, this.bodyHeight() - 2);
		if (matchesKey(data, Key.pageUp)) return this.scroll(page);
		if (matchesKey(data, Key.pageDown)) return this.scroll(-page);
		if (matchesKey(data, Key.up)) return this.scroll(1);
		if (matchesKey(data, Key.down)) return this.scroll(-1);
		if (matchesKey(data, Key.end) && !this.input.getValue()) return this.scroll(-Infinity);
		this.input.handleInput(data);
		this.tui.requestRender();
	}

	private scroll(delta: number) {
		this.scrollOffset = Math.max(0, this.scrollOffset + delta);
		this.tui.requestRender();
	}

	private submit(value: string, steer: boolean) {
		const text = value.trim();
		if (!text) return;
		const s = this.viewer.state;
		if (s.conn !== "live") return this.showFlash("not connected");
		if (!s.control) return this.showFlash("no control yet: press Ctrl+T to ask the host");
		const kind = steer && s.busy ? "steer" : "prompt";
		if (!this.viewer.send({ t: kind, text })) return this.showFlash("send failed");
		this.input.setValue("");
		this.scrollOffset = 0;
		this.tui.requestRender();
	}

	private bodyHeight(): number {
		const rows = (this.tui as any).terminal?.rows ?? 40;
		return Math.max(6, Math.floor(rows * 0.9) - 7);
	}

	private style(): Style {
		const t = this.theme;
		return {
			user: (s) => t.fg("accent", s),
			assistant: (s) => t.fg("text", s),
			thinking: (s) => t.fg("thinkingText", s),
			tool: (s) => t.fg("toolTitle", s),
			error: (s) => t.fg("error", s),
			muted: (s) => t.fg("muted", s),
			accent: (s) => t.fg("customMessageLabel", s),
		};
	}

	private transcriptLines(width: number, s: ViewState): string[] {
		const c = this.cache;
		if (c && c.width === width && c.version === s.version && c.thinking === this.showThinking) return c.lines;
		const st = this.style();
		const out: string[] = [];
		const push = (logical: string[]) => {
			for (const l of logical) out.push(...wrapTextWithAnsi(l, width));
		};
		if (s.omitted) push([st.muted(`… ${s.omitted} earlier messages not shown`)]);
		for (const item of s.items) {
			push(renderItem(sanitizeItem(item), st, { showThinking: this.showThinking }));
			out.push("");
		}
		if (s.streaming.thinking && this.showThinking) push(sanitize(s.streaming.thinking).split("\n").map((l) => st.thinking(`  ┆ ${l}`)));
		else if (s.streaming.thinking && !s.streaming.text) push([st.thinking("  ┆ thinking…")]);
		if (s.streaming.text) push(sanitize(s.streaming.text).split("\n").map(st.assistant));
		for (const r of s.running.values()) push([st.tool(`  ⚙ ${sanitize(r.name)}`) + st.muted(` ${sanitize(r.args)} …`)]);
		this.cache = { width, version: s.version, thinking: this.showThinking, lines: out };
		return out;
	}

	render(width: number): string[] {
		const t = this.theme;
		const s = this.viewer.state;
		const inner = Math.max(10, width - 4);
		const border = (str: string) => t.fg("borderAccent", str);
		const row = (content: string) => {
			const clipped = truncateToWidth(content, inner);
			return `${border("│")} ${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))} ${border("│")}`;
		};

		const connLabel =
			s.conn === "live"
				? t.fg("success", "● live")
				: s.conn === "closed"
					? t.fg("error", "● closed")
					: t.fg("warning", `● ${s.conn}`);
		const title = sanitize(s.session?.name || s.session?.cwd || "remote session");
		const header = ` ${title} `;
		const top = border("╭") + border(truncateToWidth(`─${header}`, inner + 2, "…", false)) + border("─".repeat(Math.max(0, inner + 2 - visibleWidth(`─${header}`)))) + border("╮");

		const info = [
			connLabel,
			s.busy ? t.fg("warning", "working") : t.fg("muted", "idle"),
			s.control ? t.fg("success", "control ✓") : s.controlPending ? t.fg("warning", "control requested…") : t.fg("muted", "view only"),
			t.fg("muted", `${s.viewers || 1} watching`),
			s.session?.model ? t.fg("muted", sanitize(s.session.model)) : "",
		].filter(Boolean);
		const lines: string[] = [top, row(info.join(t.fg("muted", " · ")))];
		if (s.waitingForHost) lines.push(row(t.fg("warning", "⏸ host is answering a prompt in their terminal")));
		if (s.conn !== "live" && s.detail) lines.push(row(t.fg("warning", sanitize(s.detail))));
		lines.push(border(`├${"─".repeat(inner + 2)}┤`));

		const body = this.transcriptLines(inner, s);
		const h = this.bodyHeight() - (lines.length - 3);
		const maxOffset = Math.max(0, body.length - h);
		if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;
		const end = body.length - this.scrollOffset;
		const visible = body.slice(Math.max(0, end - h), end);
		while (visible.length < h) visible.unshift("");
		for (const l of visible) lines.push(row(l));

		lines.push(border(`├${"─".repeat(inner + 2)}┤`));
		const inputLine = this.input.render(inner)[0] ?? "";
		lines.push(row(s.control ? inputLine : t.fg("muted", "view only · Ctrl+T to request control")));
		const hint = this.flash
			? t.fg("accent", this.flash)
			: t.fg(
					"dim",
					`Enter send · Alt+Enter steer · Ctrl+C abort · ↑↓ PgUp/PgDn scroll${this.scrollOffset ? ` (${this.scrollOffset} up, End to follow)` : ""} · Ctrl+O thinking · Esc close`,
				);
		lines.push(row(hint));
		lines.push(border(`╰${"─".repeat(inner + 2)}╯`));
		return lines;
	}
}

function sanitizeItem<T extends { k: string }>(item: T): T {
	const out: any = { ...item };
	for (const key of ["text", "thinking", "name", "error"]) if (typeof out[key] === "string") out[key] = sanitize(out[key]);
	if (Array.isArray(out.calls)) out.calls = out.calls.map((c: any) => ({ ...c, name: sanitize(String(c.name)), args: sanitize(String(c.args)) }));
	return out;
}
