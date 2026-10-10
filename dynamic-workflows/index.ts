/**
 * Dynamic workflows for pi.
 *
 * One tool, `workflow`. The model writes a small JavaScript orchestration script; the script fans
 * work out to isolated `pi` subprocesses with agent()/parallel()/pipeline() and plain JS in between.
 * Only the script's return value reaches the model's context. Everything else (agent outputs,
 * cache, full result) goes to a run directory on disk that the model can read on demand.
 *
 * A run is a task in the shared registry (../shared): it can run in the background
 * (`run_in_background`, Ctrl+B), shows up in /tasks, can be stopped with task_stop, and delivers a
 * <task-notification> with its result when it finishes in the background. Subagents come from the
 * shared runner, and `agent(prompt, { agent: "explore" })` uses the subagent type definitions.
 */
import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { findAgent } from "../shared/agents.ts";
import { addUsage, emptyUsage, runPi } from "../shared/pi-runner.ts";
import { backgroundedText, installTaskCore } from "../shared/task-core.ts";
import { awaitForeground, taskRegistry } from "../shared/tasks.ts";
import { appendLine, SUBAGENT_DEPTH } from "../shared/util.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONCURRENCY = Number(process.env.PI_WORKFLOW_CONCURRENCY) || Math.max(2, Math.min(8, os.cpus().length));
const MAX_AGENTS = Number(process.env.PI_WORKFLOW_MAX_AGENTS) || 500;
const RESULT_CAP = 12_000; // chars of return value sent to the model
const AGENT_TIMEOUT = 30 * 60_000;

const SUBAGENT_PROMPT = `You are a subagent inside an automated workflow. Nobody will reply to you. Do the task, then end with a final message containing only the result the orchestrator asked for: self-contained, concise, no preamble.`;

const DESCRIPTION = `Run a dynamic workflow: a JavaScript orchestration script that fans work out to isolated pi subagents and returns one result. Only the script's return value enters your context.
Use when the user asks for a workflow, or the task has many independent items (~10+), needs enforced verification (adversarial review, fact-checking, refuting findings), or is a repeatable process. Costs many tokens; do not use for small tasks (use the agent tool for one or a few subagents).

Script: async function body (top-level await/return). \`export const meta = {name, description}\` is allowed. Globals:
- agent(prompt, opts?) -> Promise<string|object|null>. Fresh subagent with a clean context: it sees ONLY prompt, so include paths, criteria and output format. Returns its final message, or null on failure. opts: label, agent (subagent type, e.g. "explore": its system prompt, tools and model become the defaults), schema (JSON Schema; returns a validated object), model ("provider/id"), thinking, tools (allowlist, e.g. ["read","grep","find","ls"] for read-only), cwd, timeout (ms).
- parallel(items) -> Promise.all over promises or thunks; failures become null.
- pipeline(items, ...stages) -> each item flows through stages independently: stage(prev, item, i). An item stops (null) at the first stage that fails or returns null.
- phase(name), log(...args): progress display only.
- sh(cmd) -> stdout string, throws on non-zero exit. For cheap deterministic work (git ls-files, running tests).
- args: the args parameter (any JSON value; pass objects as objects).
Agents beyond the concurrency limit queue. Filter/dedupe/loop in plain JS. Return compact data; per-agent outputs are saved in the run dir if you need them later.
run_in_background: true returns a task id at once and sends a <task-notification> with the result when the workflow finishes.
Re-running the identical script+args reuses finished agent results (resume after abort); fresh:true disables that.
Saved workflows live in .pi/workflows/<name>.js or ~/.pi/agent/workflows/<name>.js; run one with {name}. To save a workflow, write the script there. Bundled: review (adversarially verified code review; args: what to review as text, or {task, cwd}).`;

type AgentOpts = {
	label?: string;
	agent?: string;
	schema?: unknown;
	model?: string;
	thinking?: string;
	tools?: string[];
	cwd?: string;
	timeout?: number;
};
type AgentRow = { n: number; label: string; phase: string; status: "queued" | "running" | "done" | "failed" | "cached"; cost: number; error?: string };
type Details = { name: string; runDir: string; phase: string; agents: AgentRow[]; logs: string[]; cost: number; done?: boolean; taskId?: string; background?: boolean };

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const slug = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 40);
const short = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * Project workflows are executable code supplied by the working folder, so like project extensions
 * they are only used when the project is trusted. Untrusted projects fall through to user/bundled.
 */
function findSaved(name: string, cwd: string, projectTrusted: boolean): string {
	const file = name.endsWith(".js") ? name : `${name}.js`;
	const projectFile = path.join(cwd, ".pi", "workflows", file);
	const dirs = [path.join(os.homedir(), ".pi", "agent", "workflows"), path.join(HERE, "workflows")];
	if (projectTrusted) dirs.unshift(path.dirname(projectFile));
	for (const dir of dirs) {
		const p = path.join(dir, file);
		if (fs.existsSync(p)) return p;
	}
	const hint = !projectTrusted && fs.existsSync(projectFile) ? ` (${projectFile} exists but the project is not trusted; use /trust)` : "";
	throw new Error(`Saved workflow "${name}" not found in .pi/workflows or ~/.pi/agent/workflows${hint}`);
}

/**
 * `args` is an untyped parameter, so models often send objects JSON-encoded as a string. Decode a
 * string that parses to an object/array; leave every other string (including "123") alone.
 */
function normalizeArgs(a: unknown): unknown {
	if (typeof a !== "string") return a;
	try {
		const v = JSON.parse(a);
		return v !== null && typeof v === "object" ? v : a;
	} catch {
		return a;
	}
}

/** Tiny semaphore. */
function limiter(n: number) {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async <T>(fn: () => Promise<T>): Promise<T> => {
		if (active >= n) await new Promise<void>((r) => waiting.push(r));
		active++;
		try {
			return await fn();
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
}

export default function (pi: ExtensionAPI) {
	// Workflow subagents and agent-tool subagents never get the workflow tool: no recursive fan-out.
	if (process.env.PI_WORKFLOW_CHILD || SUBAGENT_DEPTH > 0) return;
	installTaskCore(pi);
	const registry = taskRegistry();

	pi.registerTool({
		name: "workflow",
		label: "Workflow",
		description: DESCRIPTION,
		promptSnippet: "Run a JS orchestration script that fans out to many isolated subagents",
		parameters: Type.Object({
			script: Type.Optional(Type.String({ description: "Orchestration script (JavaScript)" })),
			name: Type.Optional(Type.String({ description: "Run a saved workflow by name instead of script" })),
			args: Type.Optional(Type.Any({ description: "Value exposed to the script as `args`" })),
			fresh: Type.Optional(Type.Boolean({ description: "Ignore cached agent results from a previous identical run" })),
			run_in_background: Type.Optional(Type.Boolean({ description: "Return at once; get a <task-notification> with the result later" })),
		}),

		async execute(_id, params, signal, onUpdate, ctx) {
			let source = params.script;
			if (params.name) source = fs.readFileSync(findSaved(params.name, ctx.cwd, ctx.isProjectTrusted()), "utf8");
			if (!source) throw new Error("Provide script or name");
			// Before hashing, so string and object forms of the same args share a run id (and cache).
			const scriptArgs = normalizeArgs(params.args);

			const name = source.match(/meta\s*=\s*{[\s\S]*?name\s*:\s*["'`]([^"'`]+)/)?.[1] ?? params.name ?? "workflow";
			const runId = `${slug(name)}-${sha(source + JSON.stringify(scriptArgs ?? null))}`;
			const runDir = path.join(os.tmpdir(), "pi-workflows", ctx.sessionManager.getSessionId(), runId);
			fs.mkdirSync(path.join(runDir, "agents"), { recursive: true });
			fs.writeFileSync(path.join(runDir, "script.js"), source);

			const task = registry.create({
				kind: "workflow",
				description: name,
				outputFile: path.join(runDir, "progress.log"),
				meta: { phase: "", progress: "0 agents", cost: 0, runDir },
			});
			fs.writeFileSync(task.outputFile, `# workflow ${name} (${task.id})\nrun dir: ${runDir}\n\n`);
			const runSignal = task.signal;

			const cacheFile = path.join(runDir, "cache.json");
			const cache: Record<string, unknown> = !params.fresh && fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};
			const seen = new Map<string, number>();

			const usage = emptyUsage();
			const details: Details = { name, runDir, phase: "", agents: [], logs: [], cost: 0, taskId: task.id };
			let pending = false;
			const update = () => {
				if (pending) return;
				pending = true;
				setTimeout(() => {
					pending = false;
					details.cost = usage.cost.total;
					const finished = details.agents.filter((a) => a.status === "done" || a.status === "cached").length;
					const running = details.agents.filter((a) => a.status === "running").length;
					Object.assign(task.meta, { phase: details.phase, progress: `${finished}/${details.agents.length} agents, ${running} running`, cost: usage.cost.total });
					task.touch();
					if (task.foreground) onUpdate?.({ content: [{ type: "text", text: "running" }], details: { ...details, agents: [...details.agents] } });
				}, 100);
			};

			const defaults = {
				cwd: ctx.cwd,
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinking: pi.getThinkingLevel() as string | undefined,
			};
			const projectTrusted = ctx.isProjectTrusted();
			const limit = limiter(CONCURRENCY);

			const agent = async (prompt: string, opts: AgentOpts = {}) => {
				if (typeof prompt !== "string") throw new Error("agent(prompt): prompt must be a string");
				if (details.agents.length >= MAX_AGENTS) throw new Error(`workflow exceeded ${MAX_AGENTS} agents`);
				const def = opts.agent ? findAgent(opts.agent, ctx.cwd, projectTrusted) : undefined;
				if (opts.agent && !def) throw new Error(`agent(): unknown agent type "${opts.agent}"`);
				const row: AgentRow = { n: details.agents.length + 1, label: opts.label ?? prompt.slice(0, 50).replace(/\s+/g, " "), phase: details.phase, status: "queued", cost: 0 };
				details.agents.push(row);
				const base = sha(prompt + JSON.stringify(opts));
				const k = (seen.get(base) ?? 0) + 1;
				seen.set(base, k);
				const key = `${base}:${k}`;
				const outFile = path.join(runDir, "agents", `${String(row.n).padStart(3, "0")}-${slug(row.label)}.md`);

				if (key in cache) {
					row.status = "cached";
					update();
					return cache[key];
				}
				update();
				return limit(async () => {
					if (runSignal.aborted) throw new Error("aborted");
					row.status = "running";
					appendLine(task.outputFile, `◐ #${row.n} ${row.label}`);
					update();
					try {
						const model = opts.model ?? def?.model ?? defaults.model;
						const thinking = opts.thinking ?? def?.thinking ?? (opts.model || def?.model ? undefined : defaults.thinking);
						const { value: out } = await runPi({
							prompt,
							cwd: opts.cwd ?? defaults.cwd,
							model,
							thinking,
							tools: opts.tools ?? def?.tools,
							excludeTools: def?.disallowedTools,
							appendSystemPrompt: [def?.prompt ?? "", SUBAGENT_PROMPT],
							schema: opts.schema,
							env: { PI_WORKFLOW_CHILD: "1" },
							signal: runSignal,
							timeoutMs: opts.timeout ?? AGENT_TIMEOUT,
							onEvent: (e) => {
								if (e.type !== "usage") return;
								row.cost += e.usage?.cost?.total ?? 0;
								addUsage(usage, e.usage);
								update();
							},
						});
						cache[key] = out;
						fs.writeFileSync(cacheFile, JSON.stringify(cache));
						fs.writeFileSync(outFile, `# ${row.label}\n\n## Prompt\n\n${prompt}\n\n## Result\n\n${typeof out === "string" ? out : "```json\n" + JSON.stringify(out, null, 2) + "\n```"}\n`);
						row.status = "done";
						appendLine(task.outputFile, `✓ #${row.n} ${row.label}`);
						return out;
					} catch (e: any) {
						row.status = "failed";
						row.error = String(e?.message ?? e).slice(0, 200);
						appendLine(task.outputFile, `✗ #${row.n} ${row.label}: ${row.error}`);
						fs.writeFileSync(outFile, `# ${row.label} (FAILED)\n\n## Prompt\n\n${prompt}\n\n## Error\n\n${e?.message ?? e}\n`);
						if (runSignal.aborted) throw e;
						return null;
					} finally {
						update();
					}
				});
			};

			// Failures become null, except aborts, which must stop the whole script.
			const settle = (p: any) =>
				Promise.resolve()
					.then(() => (typeof p === "function" ? p() : p))
					.catch((e) => {
						if (runSignal.aborted) throw e;
						log(`error: ${e?.message ?? e}`);
						return null;
					});
			const parallel = (items: any[]) => Promise.all(items.map(settle));
			// An item stops at the first stage that fails or returns null/undefined.
			const pipeline = (items: any[], ...stages: ((prev: any, item: any, i: number) => any)[]) =>
				Promise.all(
					items.map(async (item, i) => {
						let prev: any = item;
						for (const stage of stages) {
							prev = await settle(() => stage(prev, item, i));
							if (prev == null) return null;
						}
						return prev;
					}),
				);
			const log = (...a: unknown[]) => {
				const line = a.map(short).join(" ");
				details.logs.push(line);
				if (details.logs.length > 50) details.logs.shift();
				appendLine(task.outputFile, line);
				update();
			};
			const phase = (p: string) => {
				details.phase = String(p);
				log(`── ${p}`);
			};
			const sh = (cmd: string) =>
				new Promise<string>((resolve, reject) =>
					exec(cmd, { cwd: ctx.cwd, maxBuffer: 32 * 1024 * 1024, signal: runSignal, shell: "/bin/bash" }, (err, stdout, stderr) =>
						err ? reject(new Error(`${cmd}: ${err.message}\n${stderr}`.slice(0, 2000))) : resolve(stdout),
					),
				);

			const work = (async () => {
				// Not a security sandbox (pi runs tools with full permissions anyway); just a clean scope.
				const sandbox = vm.createContext({ agent, parallel, pipeline, phase, log, sh, args: scriptArgs, console: { log, info: log, warn: log, error: log } });
				const body = source.replace(/^\s*export\s+(?=const|let|var|function|async)/gm, "").replace(/^\s*export\s+default\s+/gm, "return ");

				let value: unknown;
				let failure: string | undefined;
				try {
					value = await new vm.Script(`(async () => {\n${body}\n})()`, { filename: `${name}.js`, lineOffset: -1 }).runInContext(sandbox);
				} catch (e: any) {
					// Keep only the script's own frames; pi's internals are noise for the model.
					const stack = String(e?.stack ?? e).split("\n");
					failure = [stack[0], ...stack.slice(1).filter((l) => l.includes(`${name}.js`))].join("\n");
				}
				details.done = true;
				details.cost = usage.cost.total;
				details.background = task.backgrounded;

				let text = value === undefined ? "(workflow returned nothing)" : typeof value === "string" ? value : JSON.stringify(value, null, 1);
				fs.writeFileSync(path.join(runDir, "result.md"), text);
				if (text.length > RESULT_CAP) text = `${text.slice(0, RESULT_CAP)}\n…[truncated; full result in ${path.join(runDir, "result.md")}]`;
				const failed = details.agents.filter((a) => a.status === "failed").length;
				const cached = details.agents.filter((a) => a.status === "cached").length;
				const errors = details.agents
					.filter((a) => a.error)
					.slice(0, 3)
					.map((a) => `\n  #${a.n} ${a.label}: ${a.error}`)
					.join("");
				const stats = `[workflow ${name} (${task.id}): ${details.agents.length} agents${failed ? `, ${failed} failed` : ""}${cached ? `, ${cached} cached` : ""}, $${usage.cost.total.toFixed(2)}; run dir ${runDir}]${errors}`;

				if (failure) {
					const msg = `Workflow script failed:\n${failure.slice(0, 3000)}\n${stats}\nRe-run the same script to resume from cached agent results.`;
					return { content: [{ type: "text" as const, text: msg }], details, usage, isError: true };
				}
				return { content: [{ type: "text" as const, text: `${text}\n\n${stats}` }], details, usage };
			})();

			work.then(
				(r) => {
					appendLine(task.outputFile, `\n## ${r.isError ? "Failed" : "Result"}\n\n${r.content[0].text}`);
					task.finish(r.isError ? "failed" : "completed", { result: r.content[0].text, error: r.isError ? "workflow script failed" : undefined });
				},
				(e) => task.finish("failed", { error: String(e?.message ?? e) }),
			);

			if (params.run_in_background) task.moveToBackground("requested");
			if ((await awaitForeground(task, signal)) === "background") {
				const text = backgroundedText(task, task.backgroundReason ?? "requested", `Run dir: ${runDir}`);
				return { content: [{ type: "text", text }], details: { ...details, agents: [...details.agents], background: true } };
			}
			return work;
		},

		renderCall(args, theme) {
			const name = args.name ?? args.script?.match(/meta\s*=\s*{[\s\S]*?name\s*:\s*["'`]([^"'`]+)/)?.[1] ?? "script";
			const lines = args.script ? args.script.split("\n").length : 0;
			return new Text(
				theme.fg("toolTitle", theme.bold("workflow ")) +
					theme.fg("accent", name) +
					(lines ? theme.fg("dim", ` (${lines} lines)`) : "") +
					(args.run_in_background ? theme.fg("dim", " (background)") : ""),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const d = result.details as Details | undefined;
			if (!d?.agents || (d.background && !d.done)) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? theme.fg("muted", t.text.split("\n")[0]) : "", 0, 0);
			}
			const count = (s: AgentRow["status"]) => d.agents.filter((a) => a.status === s).length;
			const icon = { queued: theme.fg("dim", "·"), running: theme.fg("warning", "◐"), done: theme.fg("success", "✓"), cached: theme.fg("muted", "↺"), failed: theme.fg("error", "✗") };
			let out = theme.fg(result.isError ? "error" : "muted", `${d.done ? (result.isError ? "failed" : "done") : "running"}`);
			if (d.phase) out += theme.fg("accent", ` · ${d.phase}`);
			out += theme.fg("dim", ` · ${count("done") + count("cached")}/${d.agents.length} agents · ${count("running")} running`);
			if (count("failed")) out += theme.fg("error", ` · ${count("failed")} failed`);
			out += theme.fg("dim", ` · $${d.cost.toFixed(2)}`);

			const rows = expanded ? d.agents : d.agents.filter((a) => a.status === "running" || a.status === "failed").slice(-6);
			for (const a of rows) {
				out += `\n${icon[a.status]} ${theme.fg("dim", `#${a.n}`)} ${a.label}${a.phase && expanded ? theme.fg("dim", ` [${a.phase}]`) : ""}${a.error ? theme.fg("error", ` ${a.error}`) : ""}`;
			}
			for (const l of d.logs.slice(expanded ? -50 : -3)) out += `\n${theme.fg("dim", l)}`;
			if (expanded || d.done) out += `\n${theme.fg("dim", d.runDir)}`;
			if (expanded && d.done) {
				const t = result.content[0];
				if (t?.type === "text") out += `\n\n${t.text}`;
			}
			return new Text(out, 0, 0);
		},
	});
}
