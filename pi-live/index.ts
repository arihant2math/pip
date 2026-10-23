/**
 * pi-live: share a running pi session peer-to-peer over iroh.
 *
 *   /live                 start sharing (prints + copies a share code)
 *   /live stop            stop sharing and disconnect everyone
 *   /live status          list viewers
 *   /live kick <id>       disconnect a viewer
 *   /live revoke [id]     take control back from one or all viewers
 *   /live control ask|allow|deny   how control requests are handled (default ask)
 *
 *   /watch <share code>   watch someone else's session (overlay; Esc hides it)
 *   /watch                reopen the overlay
 *   /watch gui            open the browser GUI for the current watch
 *   /watch <code> --gui   connect and open the browser GUI instead of the overlay
 *   /watch stop           disconnect
 *
 *   /gui                  open this session in the browser GUI (no sharing involved)
 *   /gui stop             stop the GUI server
 *
 * `pi --live` starts sharing at startup (prints the code to stderr in non-interactive modes).
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LiveViewer } from "./client.ts";
import { LocalView } from "./local.ts";
import { openBrowser, resolveGuiTheme, WatchGui } from "./gui.ts";
import { type ControlPolicy, LiveHost } from "./host.ts";
import { errorMessage } from "./protocol.ts";
import { messageToItem } from "./transcript.ts";
import { WatchView } from "./watch-view.ts";

// One host and one viewer per pi process, shared across extension runtimes (/reload, /new, …).
const KEY = Symbol.for("pi-live.state.v1");
interface GlobalState {
	host: LiveHost;
	viewer?: LiveViewer;
	gui?: WatchGui;
	/** `/gui`: browser view of this session. */
	selfGui?: { gui: WatchGui; view: LocalView };
	view?: WatchView;
	/** Resolves the open overlay, if any. */
	closeView?: () => void;
}
function globalState(): GlobalState {
	const g = globalThis as any;
	g[KEY] ??= { host: new LiveHost() } satisfies GlobalState;
	return g[KEY] as GlobalState;
}

function copyToClipboard(text: string) {
	const cmds: [string, string[]][] =
		process.platform === "darwin"
			? [["pbcopy", []]]
			: process.platform === "win32"
				? [["clip", []]]
				: [
						["wl-copy", []],
						["xclip", ["-selection", "clipboard"]],
					];
	const tryNext = (i: number) => {
		if (i >= cmds.length) return;
		try {
			const [cmd, args] = cmds[i]!;
			const p = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
			p.on("error", () => tryNext(i + 1));
			p.stdin.end(text);
		} catch {
			tryNext(i + 1);
		}
	};
	tryNext(0);
}

export default function (pi: ExtensionAPI) {
	const st = globalState();
	const host = st.host;

	pi.registerFlag("live", { description: "Start sharing this session over pi-live at startup", type: "boolean", default: false });

	const announce = (ctx: ExtensionContext, code: string) => {
		const copy = ctx.mode === "tui";
		const msg = `pi-live: sharing this session. Give this code to a friend${copy ? " (copied to clipboard)" : ""}:\n\n  ${code}\n\nThey run: /watch <code>   (or, without pi: node --experimental-strip-types pi-live/watch-cli.ts <code>)\nAnyone with the code can watch everything in this session. Control needs your approval.`;
		if (ctx.hasUI) {
			ctx.ui.notify(msg, "info");
			if (copy) copyToClipboard(code);
		} else process.stderr.write(`${msg}\n`);
	};

	// ---- lifecycle ------------------------------------------------------------------------------

	pi.on("session_start", async (event, ctx) => {
		host.attach(pi, ctx);
		if (event.reason !== "startup") host.resync();
		if (event.reason === "startup" && pi.getFlag("live") === true && !host.active) {
			try {
				announce(ctx, await host.start());
			} catch (err) {
				const msg = `pi-live: could not start sharing: ${errorMessage(err)}`;
				if (ctx.hasUI) ctx.ui.notify(msg, "error");
				else process.stderr.write(`${msg}\n`);
			}
		}
		if (st.viewer && ctx.hasUI) updateWatchStatus(ctx);
	});

	pi.on("session_shutdown", async (event) => {
		if (event.reason === "quit") {
			st.closeView?.();
			closeSelfGui();
			closeGui();
			await Promise.allSettled([host.stop("host exited pi"), st.viewer?.close()]);
			st.viewer = undefined;
		} else {
			host.detach();
		}
	});

	pi.on("session_tree", () => host.resync());
	pi.on("session_compact", () => host.resync());

	pi.on("agent_start", () => host.onAgentStart());
	pi.on("agent_settled", (e) => host.onAgentSettled(e.aborted));
	pi.on("message_start", (e) => host.onMessageStart(e.message));
	pi.on("message_update", (e) => {
		const ev = e.assistantMessageEvent;
		if (ev.type === "text_delta") host.onDelta("text", ev.delta);
		else if (ev.type === "thinking_delta") host.onDelta("thinking", ev.delta);
	});
	pi.on("message_end", (e) => host.onItem(messageToItem(e.message)));
	pi.on("tool_execution_start", (e) => {
		if (!e.parentToolCallId) host.onToolStart(e.toolCallId, e.toolName, e.args);
	});
	pi.on("tool_execution_end", (e) => {
		if (!e.parentToolCallId) host.onToolEnd(e.toolCallId, e.isError);
	});
	pi.on("ui_prompt_start", (e) => host.onPrompt(true, e.title));
	pi.on("ui_prompt_end", () => host.onPrompt(false));

	// ---- /live ----------------------------------------------------------------------------------

	pi.registerCommand("live", {
		description: "Share this session live over iroh (/live stop|status|kick|revoke|control)",
		getArgumentCompletions: (prefix) =>
			["stop", "status", "kick", "revoke", "control ask", "control allow", "control deny"]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			host.attach(pi, ctx);
			const [sub = "", ...rest] = args.trim().split(/\s+/);
			const arg = rest.join(" ");
			const say = (m: string, level: "info" | "warning" | "error" = "info"): void => {
				if (ctx.hasUI) ctx.ui.notify(m, level);
				else process.stderr.write(`${m}\n`);
			};
			switch (sub) {
				case "":
				case "start":
				case "share": {
					try {
						announce(ctx, await host.start());
					} catch (err) {
						say(`pi-live: could not start sharing: ${errorMessage(err)}`, "error");
					}
					return;
				}
				case "stop":
					if (!host.active) return say("pi-live: not sharing");
					await host.stop();
					return say("pi-live: stopped sharing");
				case "status": {
					if (!host.active) return say("pi-live: not sharing");
					const vs = host.listViewers();
					const lines = vs.map((v) => `  ${v.id}  ${v.name}${v.control ? "  [control]" : ""}  since ${new Date(v.since).toLocaleTimeString()}`);
					return say(`pi-live: sharing (control: ${host.controlPolicy}), ${vs.length} viewer(s)\n${lines.join("\n")}\n\ncode: ${host.code}`);
				}
				case "kick":
					if (!arg) return say("usage: /live kick <viewer id>", "warning");
					return say(host.kick(arg) ? `pi-live: removed ${arg}` : `pi-live: no viewer '${arg}'`);
				case "revoke": {
					const n = host.revokeControl(arg || undefined);
					return say(`pi-live: revoked control from ${n} viewer(s)`);
				}
				case "control": {
					if (!["ask", "allow", "deny"].includes(arg)) return say(`usage: /live control ask|allow|deny (now: ${host.controlPolicy})`, "warning");
					host.controlPolicy = arg as ControlPolicy;
					if (arg === "deny") host.revokeControl();
					return say(`pi-live: control requests → ${arg}`);
				}
				default:
					return say("usage: /live [stop|status|kick <id>|revoke [id]|control ask|allow|deny]", "warning");
			}
		},
	});

	// ---- /gui -----------------------------------------------------------------------------------

	function closeSelfGui() {
		const g = st.selfGui;
		st.selfGui = undefined;
		g?.gui.close();
		void g?.view.close();
	}

	pi.registerCommand("gui", {
		description: "Open this session in the browser (live, with a prompt box). /gui stop to close",
		getArgumentCompletions: (prefix) => (["stop"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }))),
		handler: async (args, ctx) => {
			host.attach(pi, ctx);
			const say = (m: string, level: "info" | "warning" | "error" = "info"): void => {
				if (ctx.hasUI) ctx.ui.notify(m, level);
				else process.stderr.write(`${m}\n`);
			};
			if (args.trim() === "stop") {
				if (!st.selfGui) return say("pi-live: GUI is not running");
				closeSelfGui();
				return say("pi-live: GUI stopped");
			}
			if (!st.selfGui) {
				const view = new LocalView(host);
				try {
					const theme = await resolveGuiTheme(ctx.hasUI ? { theme: ctx.ui.theme as any } : {});
					const gui = new WatchGui(view, theme, { local: true });
					await gui.start();
					st.selfGui = { gui, view };
				} catch (err) {
					await view.close();
					return say(`pi-live: could not start the GUI: ${errorMessage(err)}`, "error");
				}
			}
			openBrowser(st.selfGui.gui.url);
			say(`pi-live: GUI at ${st.selfGui.gui.url}`);
		},
	});

	// ---- /watch ---------------------------------------------------------------------------------

	function updateWatchStatus(ctx: ExtensionContext) {
		const v = st.viewer;
		if (!ctx.hasUI) return;
		if (!v || v.state.conn === "closed") return ctx.ui.setStatus("pi-live-watch", undefined);
		const s = v.state;
		ctx.ui.setStatus("pi-live-watch", `watching ${s.session?.name || s.session?.cwd || "remote"} · ${s.conn}${s.busy ? " · working" : ""} (/watch)`);
	}

	async function openView(ctx: ExtensionContext) {
		const viewer = st.viewer;
		if (!viewer) return;
		if (st.view) return; // already open
		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				const view = new WatchView(viewer, tui, theme, () => done(undefined));
				st.view = view;
				st.closeView = () => done(undefined);
				return view;
			},
			{ overlay: true, overlayOptions: { width: "92%", maxHeight: "92%", anchor: "center" } },
		);
		(st.view as WatchView | undefined)?.dispose();
		st.view = undefined;
		st.closeView = undefined;
		updateWatchStatus(ctx);
	}

	async function openGui(ctx: ExtensionContext) {
		const viewer = st.viewer;
		if (!viewer) return;
		try {
			if (!st.gui) {
				const gui = new WatchGui(viewer, await resolveGuiTheme({ theme: ctx.ui.theme as any }));
				await gui.start();
				st.gui = gui;
			}
			openBrowser(st.gui.url);
			ctx.ui.notify(`pi-live: GUI at ${st.gui.url}`, "info");
		} catch (err) {
			ctx.ui.notify(`pi-live: could not start the GUI: ${errorMessage(err)}`, "error");
		}
	}

	function closeGui() {
		st.gui?.close();
		st.gui = undefined;
	}

	pi.registerCommand("watch", {
		description: "Watch a pi-live session: /watch <share code> [--gui] (or /watch to reopen, /watch gui, /watch stop)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/watch needs the interactive TUI; use pi-live/watch-cli.ts outside the TUI", "error");
				return;
			}
			let arg = args.trim();
			const wantGui = /(^|\s)--gui(\s|$)/.test(arg);
			arg = arg.replace(/(^|\s)--gui(?=\s|$)/g, " ").trim();
			if (arg === "gui") {
				if (st.viewer && st.viewer.state.conn !== "closed") return openGui(ctx);
				ctx.ui.notify("pi-live: not watching anything; /watch <share code> --gui", "warning");
				return;
			}
			if (arg === "stop") {
				st.closeView?.();
				closeGui();
				await st.viewer?.close();
				st.viewer = undefined;
				updateWatchStatus(ctx);
				ctx.ui.notify("pi-live: stopped watching", "info");
				return;
			}
			if (!arg) {
				if (st.viewer && st.viewer.state.conn !== "closed") return openView(ctx);
				ctx.ui.notify("usage: /watch <share code>", "warning");
				return;
			}
			if (st.viewer) {
				st.closeView?.();
				closeGui();
				await st.viewer.close();
				st.viewer = undefined;
			}
			let viewer: LiveViewer;
			try {
				viewer = new LiveViewer(arg, process.env.PI_LIVE_NAME || process.env.USER || undefined);
			} catch (err) {
				ctx.ui.notify(`pi-live: ${errorMessage(err)}`, "error");
				return;
			}
			st.viewer = viewer;
			let lastConn = viewer.state.conn;
			viewer.onChange = (s) => {
				if (s.conn !== lastConn) {
					lastConn = s.conn;
					updateWatchStatus(ctx);
				}
				st.view?.refresh();
			};
			viewer.onNotice = (level, text) => {
				if (st.view) st.view.showFlash(text);
				else ctx.ui.notify(`pi-live: ${text}`, level);
			};
			ctx.ui.setStatus("pi-live-watch", "connecting…");
			try {
				await viewer.start();
			} catch (err) {
				await viewer.close();
				if (st.viewer === viewer) st.viewer = undefined;
				updateWatchStatus(ctx);
				ctx.ui.notify(`pi-live: could not connect: ${errorMessage(err)}`, "error");
				return;
			}
			updateWatchStatus(ctx);
			if (wantGui) return openGui(ctx);
			await openView(ctx);
		},
	});
}
