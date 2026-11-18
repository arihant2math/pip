/**
 * Run one `pi --mode json -p` subprocess: the subagent runtime behind `agent` and `send_message`.
 *
 * - Resolves with the final assistant text.
 * - With `session`, the child persists its transcript (`--session-dir/--session-id`) so it can be
 *   resumed later by running again with the same session and a new prompt.
 * - A run fails only if its *last* assistant message errored (pi auto-retries transient provider
 *   errors), it was aborted, or the process exited non-zero.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { SUBAGENT_DEPTH } from "./util.ts";

export type Usage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

export const emptyUsage = (): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export function addUsage(into: Usage, u: any) {
	into.input += u?.input ?? 0;
	into.output += u?.output ?? 0;
	into.cacheRead += u?.cacheRead ?? 0;
	into.cacheWrite += u?.cacheWrite ?? 0;
	into.totalTokens += u?.totalTokens ?? 0;
	for (const f of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) into.cost[f] += u?.cost?.[f] ?? 0;
}

export type RunPiEvent =
	| { type: "tool_start"; toolName: string; args: any }
	| { type: "usage"; usage: any };

export interface RunPiOptions {
	prompt: string;
	cwd: string;
	model?: string;
	thinking?: string;
	/** Allowlist passed to --tools. */
	tools?: string[];
	/** Passed to --exclude-tools. */
	excludeTools?: string[];
	appendSystemPrompt?: string[];
	/** Persist the child session so it can be resumed; omitted = --no-session. */
	session?: { dir: string; id: string };
	signal?: AbortSignal;
	onEvent?: (e: RunPiEvent) => void;
}

export interface RunPiResult {
	text: string;
	usage: Usage;
	toolCalls: number;
}

export function piCommand(): [string, string[]] {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/") && fs.existsSync(script)) return [process.execPath, [script]];
	if (!/^(node|bun)(\.exe)?$/i.test(path.basename(process.execPath))) return [process.execPath, []];
	return ["pi", []];
}

export function runPi(opts: RunPiOptions): Promise<RunPiResult> {
	const args = ["--mode", "json", "-p"];
	if (opts.session) {
		fs.mkdirSync(opts.session.dir, { recursive: true });
		args.push("--session-dir", opts.session.dir, "--session-id", opts.session.id);
	} else args.push("--no-session");
	for (const p of opts.appendSystemPrompt ?? []) if (p.trim()) args.push("--append-system-prompt", p);
	if (opts.model) args.push("--model", opts.model);
	if (opts.thinking) args.push("--thinking", opts.thinking);

	const env: Record<string, string | undefined> = {
		...process.env,
		PI_SUBAGENT: "1",
		PI_SUBAGENT_DEPTH: String(SUBAGENT_DEPTH + 1),
	};
	if (opts.tools) args.push(...(opts.tools.length ? ["--tools", opts.tools.join(",")] : ["--no-tools"]));
	if (opts.excludeTools?.length) args.push("--exclude-tools", opts.excludeTools.join(","));
	args.push("--", opts.prompt);

	const usage = emptyUsage();
	const [cmd, pre] = piCommand();
	return new Promise((resolve, reject) => {
		const signal = opts.signal;
		if (signal?.aborted) return reject(new Error(String(signal.reason?.message ?? "aborted")));
		const proc = spawn(cmd, [...pre, ...args], { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let buf = "";
		let stderr = "";
		let lastText = "";
		let toolCalls = 0;
		// Error state of the LATEST assistant message only: a later success clears an earlier failed attempt.
		let error: string | undefined;

		const onLine = (line: string) => {
			if (!line.trim()) return;
			let ev: any;
			try {
				ev = JSON.parse(line);
			} catch {
				return;
			}
			if (ev.type === "message_end" && ev.message?.role === "assistant") {
				const m = ev.message;
				if (m.usage) {
					addUsage(usage, m.usage);
					opts.onEvent?.({ type: "usage", usage: m.usage });
				}
				error = m.stopReason === "error" || m.stopReason === "aborted" ? m.errorMessage || m.stopReason : undefined;
				const text = (m.content ?? [])
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n")
					.trim();
				if (text) lastText = text;
			} else if (ev.type === "auto_retry_end" && ev.success === false) {
				error = ev.finalError || error || "provider error (retries exhausted)";
			} else if (ev.type === "tool_execution_start" && !String(ev.toolCallId ?? "").includes("/")) {
				toolCalls++;
				opts.onEvent?.({ type: "tool_start", toolName: ev.toolName, args: ev.args });
			}
		};

		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (d: string) => {
			buf += d;
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			lines.forEach(onLine);
		});
		proc.stderr.setEncoding("utf8");
		proc.stderr.on("data", (d: string) => {
			stderr = (stderr + d).slice(-4000);
		});

		const kill = () => {
			proc.kill("SIGTERM");
			setTimeout(() => proc.exitCode === null && proc.kill("SIGKILL"), 5000).unref();
		};
		signal?.addEventListener("abort", kill, { once: true });
		const cleanup = () => signal?.removeEventListener("abort", kill);
		proc.on("error", (e) => {
			cleanup();
			reject(e);
		});
		proc.on("close", (code) => {
			cleanup();
			if (buf) onLine(buf);
			if (signal?.aborted) return reject(new Error(String(signal.reason?.message ?? "aborted")));
			const failure = error ?? (code !== 0 ? `exit ${code}: ${stderr.trim().split("\n").pop()?.slice(-300)}` : undefined);
			if (failure) return reject(Object.assign(new Error(failure), { partialText: lastText }));
			resolve({ text: lastText, usage, toolCalls });
		});
	});
}

/** One-line summary of a tool call for progress logs. */
export function describeToolCall(toolName: string, args: any): string {
	const a = args ?? {};
	const s =
		a.command ?? a.path ?? a.pattern ?? a.query ?? a.url ?? a.prompt ?? a.description ?? (Object.keys(a).length ? JSON.stringify(a) : "");
	return `${toolName} ${String(s).replace(/\s+/g, " ").slice(0, 120)}`.trim();
}
