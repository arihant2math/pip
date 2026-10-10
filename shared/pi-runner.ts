/**
 * Run one `pi --mode json -p` subprocess: the subagent runtime shared by the `agent` tool
 * (subagents/) and workflow `agent()` calls (dynamic-workflows/).
 *
 * - Plain mode resolves with the final assistant text.
 * - With `schema`, the child loads submit-result.ts and the result is the validated object passed to
 *   `submit_result` (or JSON parsed out of a final text reply and validated against the same schema).
 * - With `session`, the child persists its transcript (`--session-dir/--session-id`) so it can be
 *   resumed later by running again with the same session and a new prompt.
 * - A run fails only if its *last* assistant message errored (pi auto-retries transient provider
 *   errors), it timed out, it was aborted, or the process exited non-zero.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { toolParameters } from "./submit-result.ts";
import { SUBAGENT_DEPTH } from "./util.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUBMIT_EXT = path.join(HERE, "submit-result.ts");

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
	| { type: "tool_end"; toolName: string; isError: boolean; text?: string }
	| { type: "text"; text: string }
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
	/** JSON Schema for a structured result. */
	schema?: unknown;
	/** Persist the child session so it can be resumed; omitted = --no-session. */
	session?: { dir: string; id: string };
	env?: Record<string, string | undefined>;
	signal?: AbortSignal;
	timeoutMs?: number;
	onEvent?: (e: RunPiEvent) => void;
}

export interface RunPiResult {
	value: unknown;
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

/** Validate (and coerce) a candidate structured result against the submit_result parameters. */
function validateResult(parameters: any, args: unknown): { ok: true; value: any } | { ok: false; error: string } {
	try {
		return {
			ok: true,
			value: validateToolArguments({ name: "submit_result", description: "", parameters } as any, { type: "toolCall", id: "fallback", name: "submit_result", arguments: args } as any),
		};
	} catch (e: any) {
		return { ok: false, error: String(e?.message ?? e) };
	}
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
		...opts.env,
	};
	const structured = opts.schema !== undefined;
	const { parameters, wrapped } = toolParameters(opts.schema);
	let tools = opts.tools;
	if (structured) {
		args.push("-e", SUBMIT_EXT);
		env.PI_RESULT_SCHEMA = JSON.stringify(opts.schema);
		if (tools) tools = [...tools, "submit_result"];
	}
	if (tools) args.push(...(tools.length ? ["--tools", tools.join(",")] : ["--no-tools"]));
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
		let submitted: { value: unknown } | undefined;
		let submitError: string | undefined;
		// Error state of the LATEST assistant message only: a later success clears an earlier failed attempt.
		let error: string | undefined;
		let timedOut: string | undefined;

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
				if (text) {
					lastText = text;
					opts.onEvent?.({ type: "text", text });
				}
			} else if (ev.type === "auto_retry_end" && ev.success === false) {
				error = ev.finalError || error || "provider error (retries exhausted)";
			} else if (ev.type === "tool_execution_start" && !String(ev.toolCallId ?? "").includes("/")) {
				toolCalls++;
				opts.onEvent?.({ type: "tool_start", toolName: ev.toolName, args: ev.args });
			} else if (ev.type === "tool_execution_end") {
				if (!String(ev.toolCallId ?? "").includes("/")) {
					const text = ev.result?.content?.find((c: any) => c.type === "text")?.text;
					opts.onEvent?.({ type: "tool_end", toolName: ev.toolName, isError: !!ev.isError, text });
				}
				if (ev.toolName === "submit_result" && structured) {
					// Only a submission that passed pi's validation and ran counts. First one wins.
					if (ev.isError) {
						submitError = ev.result?.content?.find((c: any) => c.type === "text")?.text?.slice(0, 500) ?? "submit_result failed";
						return;
					}
					const r = ev.result?.details?.result;
					if (submitted || r === undefined) return;
					submitted = { value: wrapped ? r : r?.value };
					// `terminate` doesn't stop the turn when submit_result was batched with other calls.
					kill();
				}
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
		const timer = opts.timeoutMs
			? setTimeout(() => {
					timedOut = `timed out after ${Math.round(opts.timeoutMs! / 1000)}s`;
					kill();
				}, opts.timeoutMs)
			: undefined;
		signal?.addEventListener("abort", kill, { once: true });

		const cleanup = () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", kill);
		};
		proc.on("error", (e) => {
			cleanup();
			reject(e);
		});
		proc.on("close", (code) => {
			cleanup();
			if (buf) onLine(buf);
			const done = (value: unknown) => resolve({ value, text: lastText, usage, toolCalls });
			if (signal?.aborted) return reject(new Error(String(signal.reason?.message ?? "aborted")));
			if (structured && submitted) return done(submitted.value);
			const failure = timedOut ?? error ?? (code !== 0 ? `exit ${code}: ${stderr.trim().split("\n").pop()?.slice(-300)}` : undefined);
			if (failure) return reject(Object.assign(new Error(failure), { partialText: lastText }));
			if (!structured) return done(lastText);

			// The agent finished cleanly but answered in text: pull JSON out and hold it to the schema.
			const fence = lastText.match(/```(?:json)?\s*([\s\S]*?)```/);
			let parsed: unknown;
			try {
				parsed = JSON.parse(fence ? fence[1] : lastText);
			} catch {
				return reject(new Error(submitError ? `invalid submit_result: ${submitError}` : "agent did not call submit_result"));
			}
			const candidates: unknown[] = wrapped ? [parsed] : [{ value: parsed }];
			if (!wrapped && parsed && typeof parsed === "object" && "value" in parsed) candidates.push(parsed);
			let lastErr = "";
			for (const c of candidates) {
				const v = validateResult(parameters, c);
				if (v.ok) return done(wrapped ? v.value : v.value.value);
				lastErr = v.error;
			}
			reject(new Error(`text result does not match schema: ${lastErr.split("\n\nReceived")[0].slice(0, 500)}`));
		});
	});
}

/** One-line summary of a tool call for progress logs. */
export function describeToolCall(toolName: string, args: any): string {
	const a = args ?? {};
	const s =
		a.command ?? a.path ?? a.pattern ?? a.query ?? a.url ?? a.prompt ?? a.description ?? a.task_id ?? (Object.keys(a).length ? JSON.stringify(a) : "");
	return `${toolName} ${String(s).replace(/\s+/g, " ").slice(0, 120)}`.trim();
}
