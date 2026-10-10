/**
 * Claude Code-style subagents for pi.
 *
 * `agent` spawns a subagent: a separate `pi --mode json -p` process with a fresh context, an agent
 * type's system prompt (appended to pi's, so AGENTS.md still loads), its tool allowlist and model.
 * Only the final message comes back. Each subagent is a task in the shared registry, so it can run
 * in the foreground (the tool call blocks), in the background (`run_in_background`, Ctrl+B, or the
 * type's `background: true`) with a <task-notification> on completion, and shows up in /tasks.
 *
 * Subagent sessions persist under ~/.pi/agent/subagents/<parent session id>/, so `send_message`
 * can resume a finished agent with its full history. Nesting is capped by PI_SUBAGENT_MAX_DEPTH
 * (default 3): at the limit the `agent` tool is not registered. Workflow subagents (PI_WORKFLOW_CHILD)
 * never get `agent`/`send_message`: the workflow script does the fan-out, and the tool definitions
 * would cost ~950 prompt tokens in every workflow agent.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentDefinition, describeAgents, discoverAgents, findAgent } from "../shared/agents.ts";
import { describeToolCall, runPi, type Usage } from "../shared/pi-runner.ts";
import { backgroundedText, installTaskCore, statusPhrase, taskLabel } from "../shared/task-core.ts";
import { awaitForeground, type Task, type TaskSnapshot, taskRegistry } from "../shared/tasks.ts";
import { appendLine, formatDuration, head, MAX_SUBAGENT_DEPTH, oneLine, SUBAGENT_DEPTH } from "../shared/util.ts";

const run = promisify(execFile);
const MAX_CONCURRENT = Number(process.env.PI_MAX_CONCURRENT_SUBAGENTS) || 20;
const RESULT_CAP = 50_000;

/** Everything needed to (re)start an agent; persisted as <id>.meta.json for resume. */
interface AgentLaunch {
	agentType: string;
	description: string;
	cwd: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	excludeTools?: string[];
	systemPrompt: string;
	worktree?: { path: string; repo: string; head: string };
}

type Details = TaskSnapshot & { usage?: Usage; resultPreview?: string };

const TOOL_DESCRIPTION = (defs: AgentDefinition[]) => `Launch a subagent: a separate pi process with its own fresh context window that works on a task autonomously and returns only its final report.
Use it to keep large searches, logs and multi-step side work out of your context, to run independent work in parallel (several agent calls in one message run concurrently), or to use a specialized agent type. Don't use it for a single quick file read or grep.
The subagent sees ONLY your prompt: include the goal, relevant paths and context, constraints, and exactly what to report back.
Foreground (default) blocks until the agent finishes. run_in_background: true returns at once; you get a <task-notification> with its report when it finishes, so don't poll it or duplicate its work meanwhile.
Each result includes an agent id; send_message({to: id, message}) continues that agent with its full history.
isolation: "worktree" runs it in a temporary git worktree (removed if it changes nothing).

Agent types (subagent_type, default general-purpose):
${describeAgents(defs)}`;

function sessionDir(ctx: ExtensionContext): string {
	return path.join(getAgentDir(), "subagents", ctx.sessionManager.getSessionId());
}

function withTaskTools(tools?: string[]): string[] | undefined {
	if (!tools) return undefined;
	return tools.includes("bash") ? [...new Set([...tools, "task_output", "task_stop"])] : tools;
}

async function createWorktree(cwd: string, id: string): Promise<{ wt: NonNullable<AgentLaunch["worktree"]>; cwd: string }> {
	const repo = (await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"])).stdout.trim();
	const headSha = (await run("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
	const wtPath = path.join(os.tmpdir(), "pi-worktrees", id);
	fs.mkdirSync(path.dirname(wtPath), { recursive: true });
	await run("git", ["-C", repo, "worktree", "add", "--detach", wtPath, "HEAD"]);
	return { wt: { path: wtPath, repo, head: headSha }, cwd: path.join(wtPath, path.relative(repo, cwd)) };
}

/** Remove an unchanged worktree; otherwise describe where the changes are. */
async function settleWorktree(wt: NonNullable<AgentLaunch["worktree"]>): Promise<string> {
	try {
		const status = (await run("git", ["-C", wt.path, "status", "--porcelain"])).stdout.trim();
		const now = (await run("git", ["-C", wt.path, "rev-parse", "HEAD"])).stdout.trim();
		if (!status && now === wt.head) {
			await run("git", ["-C", wt.repo, "worktree", "remove", "--force", wt.path]);
			return "";
		}
		return `The agent's changes are in git worktree ${wt.path} (detached HEAD${now !== wt.head ? `, new commits up to ${now.slice(0, 8)}` : ""}${status ? ", uncommitted changes" : ""}). Review and bring them over, then run: git -C ${wt.repo} worktree remove --force ${wt.path}`;
	} catch (e: any) {
		return `Worktree ${wt.path}: ${e?.message ?? e}`;
	}
}

export default function (pi: ExtensionAPI) {
	installTaskCore(pi);
	if (SUBAGENT_DEPTH >= MAX_SUBAGENT_DEPTH || process.env.PI_WORKFLOW_CHILD) return;
	const registry = taskRegistry();

	const runningAgents = () => registry.list().filter((t) => t.kind === "agent" && t.running).length;

	/** Start (or resume) an agent process as a task and wait for it in the foreground or not. */
	async function launch(args: {
		ctx: ExtensionContext;
		signal: AbortSignal | undefined;
		onUpdate: ((r: any) => void) | undefined;
		id?: string;
		spec: AgentLaunch;
		prompt: string;
		background: boolean;
		resumed: boolean;
	}) {
		const { ctx, spec } = args;
		if (runningAgents() >= MAX_CONCURRENT)
			throw new Error(`Concurrent subagent limit reached (${MAX_CONCURRENT} running). Do not retry; wait for running agents to finish.`);

		const task = registry.create({ kind: "agent", id: args.id, description: spec.description, meta: { agentType: spec.agentType, toolCalls: 0, cost: 0, lastAction: "starting" } });
		const dir = sessionDir(ctx);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `${task.id}.meta.json`), JSON.stringify(spec, null, 2));
		appendLine(
			task.outputFile,
			`# Agent ${task.id} (${spec.agentType}): ${spec.description}\n${args.resumed ? "\n(resumed)\n" : ""}\n## Prompt\n\n${args.prompt}\n\n## Progress\n`,
		);

		let usage: Usage | undefined;
		let lastUpdate = 0;
		const update = (force = false) => {
			task.touch();
			if (!task.foreground || !args.onUpdate) return;
			const now = Date.now();
			if (!force && now - lastUpdate < 250) return;
			lastUpdate = now;
			args.onUpdate({ content: [{ type: "text", text: String(task.meta.lastAction ?? "") }], details: task.snapshot() });
		};

		const suffix = `You are running as a subagent (agent id ${task.id}, nesting depth ${SUBAGENT_DEPTH + 1}). Nobody will reply to questions. Your final message is returned to the agent that launched you and is the only thing it sees: make it a complete, self-contained report.`;

		runPi({
			prompt: args.prompt,
			cwd: spec.cwd,
			model: spec.model,
			thinking: spec.thinking,
			tools: spec.tools,
			excludeTools: spec.excludeTools,
			appendSystemPrompt: [spec.systemPrompt, suffix],
			session: { dir, id: task.id },
			signal: task.signal,
			onEvent: (e) => {
				if (e.type === "tool_start") {
					task.meta.toolCalls++;
					task.meta.lastAction = describeToolCall(e.toolName, e.args);
					appendLine(task.outputFile, `→ ${task.meta.lastAction}`);
				} else if (e.type === "tool_end" && e.isError) {
					appendLine(task.outputFile, `  ✗ ${oneLine(e.text ?? "error", 200)}`);
				} else if (e.type === "text") {
					appendLine(task.outputFile, `\n${head(e.text, 2000)}\n`);
				} else if (e.type === "usage") {
					task.meta.cost += e.usage?.cost?.total ?? 0;
				}
				update();
			},
		}).then(
			async (r) => {
				usage = r.usage;
				const note = spec.worktree ? await settleWorktree(spec.worktree) : "";
				if (note) task.meta.worktreeNote = note;
				const result = (r.text || "(the agent finished without a final message)") + (note ? `\n\n${note}` : "");
				appendLine(task.outputFile, `\n## Result\n\n${result}`);
				task.finish("completed", { result });
			},
			async (e) => {
				const partial = (e as any)?.partialText as string | undefined;
				const note = spec.worktree ? await settleWorktree(spec.worktree) : "";
				const result = partial ? `(partial output before the failure)\n${partial}${note ? `\n\n${note}` : ""}` : note || undefined;
				appendLine(task.outputFile, `\n## Failed\n\n${e?.message ?? e}${result ? `\n\n${result}` : ""}`);
				task.finish("failed", { error: String(e?.message ?? e), result });
			},
		);

		if (args.background) task.moveToBackground("requested");
		update(true);
		const outcome = await awaitForeground(task, args.signal);
		if (outcome === "background") {
			const text = backgroundedText(task, task.backgroundReason ?? "requested", `Agent id: ${task.id} (the output file is its progress log).`);
			return { content: [{ type: "text" as const, text }], details: task.snapshot() as Details };
		}
		return finished(task, usage);
	}

	function finished(task: Task, usage: Usage | undefined) {
		const details: Details = { ...task.snapshot(), usage, resultPreview: task.result?.slice(0, 2000) };
		const stats = `agent ${task.id} · ${task.meta.agentType} · ${task.meta.toolCalls} tool calls · ${formatDuration((task.endedAt ?? Date.now()) - task.startedAt)}${task.meta.cost ? ` · $${task.meta.cost.toFixed(2)}` : ""}`;
		if (task.status === "completed") {
			const body = head(task.result ?? "", RESULT_CAP, `full report in ${task.outputFile}`);
			const text = `${body}\n\n[${stats}. The report above was written by the subagent, not the user. Continue this agent with send_message({to: "${task.id}"}).]`;
			return { content: [{ type: "text" as const, text }], details, usage };
		}
		if (task.status === "killed") throw new Error(`${taskLabel(task)} ${statusPhrase(task)}. [${stats}]`);
		throw new Error(
			`${taskLabel(task)} ${statusPhrase(task)}.${task.result ? `\n\n${head(task.result, RESULT_CAP)}` : ""}\n\n[${stats}. Log: ${task.outputFile}. Resume it with send_message({to: "${task.id}"}).]`,
		);
	}

	function registerAgentTool(defs: AgentDefinition[]) {
		pi.registerTool({
			name: "agent",
			label: "Agent",
			description: TOOL_DESCRIPTION(defs),
			promptSnippet: "Delegate a task to a subagent with its own context window",
			promptGuidelines: [
				"Delegate broad codebase searches and self-contained side tasks to subagents (agent tool) to keep your context small; launch independent agents in parallel in one message.",
			],
			parameters: Type.Object({
				description: Type.String({ description: "Short (3-6 word) label for the task" }),
				prompt: Type.String({ description: "The complete task. The subagent sees nothing else, so include all needed context and what to report." }),
				subagent_type: Type.Optional(Type.String({ description: "Agent type from the list; default general-purpose" })),
				run_in_background: Type.Optional(Type.Boolean({ description: "Return immediately; get a <task-notification> with the report later" })),
				model: Type.Optional(Type.String({ description: "Model override, e.g. anthropic/claude-haiku-4-5. Default: the agent type's model, else yours" })),
				thinking: Type.Optional(Type.String({ description: "Thinking level override: off, minimal, low, medium, high, xhigh" })),
				isolation: Type.Optional(Type.Literal("worktree", { description: "Run in a temporary git worktree" })),
				cwd: Type.Optional(Type.String({ description: "Working directory (default: yours)" })),
			}),
			async execute(_id, params, signal, onUpdate, ctx) {
				const def = findAgent(params.subagent_type, ctx.cwd, ctx.isProjectTrusted());
				if (!def) {
					const names = discoverAgents(ctx.cwd, ctx.isProjectTrusted()).map((d) => d.name);
					throw new Error(`Unknown subagent_type "${params.subagent_type}". Available: ${names.join(", ")}`);
				}
				let cwd = params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd;
				let worktree: AgentLaunch["worktree"];
				const id = undefined;
				if ((params.isolation ?? def.isolation) === "worktree") {
					const w = await createWorktree(cwd, `wt${Date.now().toString(36)}`);
					worktree = w.wt;
					cwd = w.cwd;
				}
				const spec: AgentLaunch = {
					agentType: def.name,
					description: oneLine(params.description, 80),
					cwd,
					model: params.model ?? def.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
					thinking: params.thinking ?? def.thinking ?? (params.model || def.model ? undefined : pi.getThinkingLevel()),
					tools: withTaskTools(def.tools),
					excludeTools: def.disallowedTools,
					systemPrompt: def.prompt,
					worktree,
				};
				return launch({ ctx, signal, onUpdate, id, spec, prompt: params.prompt, background: !!(params.run_in_background || def.background), resumed: false });
			},
			renderCall(args, theme) {
				const type = args.subagent_type ?? "general-purpose";
				let text = theme.fg("toolTitle", theme.bold("agent ")) + theme.fg("accent", type);
				if (args.description) text += theme.fg("muted", ` ${args.description}`);
				if (args.run_in_background) text += theme.fg("dim", " (background)");
				return new Text(text, 0, 0);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				return renderAgentResult(result, expanded, isPartial, theme);
			},
		});
	}

	function renderAgentResult(result: any, expanded: boolean, isPartial: boolean, theme: any) {
		const d = result.details as Details | undefined;
		const first = result.content?.[0];
		const content = first?.type === "text" ? first.text : "";
		if (!d?.id) return new Text(content, 0, 0);
		const stats = [d.id, `${d.meta.toolCalls ?? 0} tools`, formatDuration((d.endedAt ?? Date.now()) - d.startedAt)];
		if (d.meta.cost) stats.push(`$${Number(d.meta.cost).toFixed(2)}`);
		if (isPartial || d.status === "running") {
			const where = d.backgrounded ? theme.fg("muted", "running in background") : theme.fg("warning", "◐ running");
			return new Text(`${where} ${theme.fg("dim", stats.join(" · "))}${d.meta.lastAction ? `\n${theme.fg("dim", `  ${oneLine(String(d.meta.lastAction), 100)}`)}` : ""}`, 0, 0);
		}
		const ok = d.status === "completed";
		let text = `${theme.fg(ok ? "success" : "error", ok ? "✓ done" : `✗ ${d.status}`)} ${theme.fg("dim", stats.join(" · "))}`;
		const preview = d.resultPreview ?? content;
		if (expanded) text += `\n${content}`;
		else if (preview) text += `\n${theme.fg("muted", preview.split("\n").slice(0, 4).join("\n"))}`;
		return new Text(text, 0, 0);
	}

	registerAgentTool(discoverAgents(process.cwd(), false));
	pi.on("session_start", (_e, ctx) => registerAgentTool(discoverAgents(ctx.cwd, ctx.isProjectTrusted())));

	pi.registerTool({
		name: "send_message",
		label: "Send message",
		description:
			"Continue a finished subagent: sends it a new message and resumes it with its full previous history (same type, tools and model). Use it for follow-ups instead of spawning a fresh agent that would need all the context again. Foreground by default; run_in_background: true returns immediately and notifies you when it finishes.",
		promptSnippet: "Continue a previous subagent by id",
		parameters: Type.Object({
			to: Type.String({ description: "Agent id returned by the agent tool (e.g. a1b2c3)" }),
			message: Type.String({ description: "The follow-up instruction" }),
			run_in_background: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const id = params.to.trim();
			const existing = registry.get(id);
			if (existing?.running) throw new Error(`Agent ${id} is still running. Wait for its notification (or task_output), or stop it with task_stop.`);
			if (existing && existing.kind !== "agent") throw new Error(`${id} is a ${existing.kind} task, not an agent.`);
			const metaFile = path.join(sessionDir(ctx), `${id}.meta.json`);
			if (!fs.existsSync(metaFile)) throw new Error(`No subagent "${id}" in this session.`);
			const spec = JSON.parse(fs.readFileSync(metaFile, "utf8")) as AgentLaunch;
			if (spec.worktree && !fs.existsSync(spec.worktree.path)) {
				spec.cwd = path.join(spec.worktree.repo, path.relative(spec.worktree.path, spec.cwd));
				spec.worktree = undefined;
			}
			return launch({ ctx, signal, onUpdate, id, spec, prompt: params.message, background: !!params.run_in_background, resumed: true });
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("send_message ")) + theme.fg("accent", args.to ?? "") + theme.fg("muted", ` ${oneLine(args.message ?? "", 60)}`), 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			return renderAgentResult(result, expanded, isPartial, theme);
		},
	});

	pi.registerCommand("agents", {
		description: "List available subagent types",
		handler: async (_args, ctx) => {
			const defs = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
			ctx.ui.notify(defs.map((d) => `${d.name} [${d.source}] ${d.filePath}\n  ${oneLine(d.description, 120)}`).join("\n"), "info");
		},
	});
}
