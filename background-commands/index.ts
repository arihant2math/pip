/**
 * Background shell commands for pi, modeled on Claude Code's.
 *
 * Overrides the built-in `bash` tool (reusing pi's own definition, process handling and renderer)
 * and makes every command a task in the shared registry:
 *   - `run_in_background: true` starts it detached and returns a task id + output file immediately
 *   - a foreground command that hits its timeout (default 120s, PI_BASH_AUTO_BACKGROUND_MS) is
 *     moved to the background instead of killed, unless it starts with `sleep`
 *   - Ctrl+B moves running foreground commands to the background
 *   - when a background command exits, the model gets a <task-notification> (see shared/task-core.ts)
 * Nested calls (codemode scripts, ctx.executeTool) keep pi's plain semantics: they are never
 * auto-backgrounded, and `timeout` kills.
 */
import * as fs from "node:fs";
import { type BashOperations, createBashToolDefinition, createLocalBashOperations, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { backgroundedText, installTaskCore } from "../shared/task-core.ts";
import { BackgroundedError, isBackgrounded, type Task, taskRegistry } from "../shared/tasks.ts";
import { oneLine } from "../shared/util.ts";

const AUTO_BG_MS = process.env.PI_BASH_AUTO_BACKGROUND_MS !== undefined ? Number(process.env.PI_BASH_AUTO_BACKGROUND_MS) : 120_000;
const MAX_OUTPUT_BYTES = 5 * 1024 ** 3;
const MAX_BG_LIMIT_MS = 2 * 3600_000;

const DESCRIPTION = `Execute a bash command in the current working directory. Returns stdout and stderr (truncated to the last 2000 lines or 50KB; the full output is saved to a file). Optionally provide a timeout in seconds.
Long-running commands: set run_in_background: true for dev servers, watchers, long builds or test suites. It returns a task id and an output file at once; you get a <task-notification> when the command exits, so do not poll or sleep-wait. A foreground command still running after its timeout (default ${Math.round(AUTO_BG_MS / 1000) || "none"}s) is moved to the background instead of killed. Use task_output to read/wait, task_stop to stop.`;

const schema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds. Foreground: moved to the background after this long. Background: killed after this long." }),
	),
	run_in_background: Type.Optional(Type.Boolean({ description: "Run detached; you will be notified when it exits" })),
	description: Type.Optional(Type.String({ description: "Short (5-10 word) description of what the command does, shown in task lists and notifications" })),
});

const outputSchema = Type.Object({
	output: Type.String({ description: "Combined stdout and stderr, possibly truncated" }),
	truncated: Type.Boolean(),
	full_output_path: Type.Optional(Type.String()),
	exit_code: Type.Optional(Type.Number({ description: "Absent while the command runs in the background" })),
	wall_time_seconds: Type.Optional(Type.Number()),
	task_id: Type.Optional(Type.String({ description: "Background task id" })),
	output_file: Type.Optional(Type.String({ description: "File the background command writes to" })),
});

/** The command minus env exports other extensions prepend (e.g. `export PI_SUBAGENT=1`). */
function describe(command: string): string {
	const lines = command.split("\n").filter((l) => l.trim() && !/^\s*export\s+\w+=\S*\s*$/.test(l));
	return oneLine(lines.join("; ") || command, 80);
}

export default function (pi: ExtensionAPI) {
	installTaskCore(pi);
	const registry = taskRegistry();
	const base = createBashToolDefinition(process.cwd());

	pi.registerTool({
		...base,
		description: DESCRIPTION,
		parameters: schema,
		outputSchema,
		promptGuidelines: [
			...(base.promptGuidelines ?? []),
			"Run dev servers, watchers and other long-running commands with bash run_in_background: true; you will be notified when they exit, so never poll them with sleep loops.",
		],
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const settings = pi.getSettings() as { shellPath?: string; shellCommandPrefix?: string };
			const nested = toolCallId.includes("/");
			const local = createLocalBashOperations({ shellPath: settings.shellPath });
			let task: Task | undefined;

			const ops: BashOperations = {
				exec: (command, cwd, { onData, timeout, env }) => {
					const bgLimit = params.run_in_background && timeout ? Math.min(timeout * 1000, MAX_BG_LIMIT_MS) : undefined;
					const t = registry.create({
						kind: "bash",
						description: params.description ? oneLine(params.description, 80) : describe(params.command),
						limitMs: bgLimit,
						canBackground: !nested || !!params.run_in_background,
						meta: { command: params.command, cwd },
					});
					task = t;
					const fd = fs.openSync(t.outputFile, "a");
					let bytes = 0;
					let killedByTimeout = false;
					const run = local.exec(command, cwd, {
						env,
						signal: t.signal,
						onData: (d) => {
							try {
								fs.writeSync(fd, d);
							} catch {}
							bytes += d.length;
							if (bytes > MAX_OUTPUT_BYTES) t.stop("output exceeded 5GB");
							if (t.foreground) onData(d);
						},
					});
					run.then(
						({ exitCode }) => t.finish(exitCode === 0 ? "completed" : "failed", { exitCode: exitCode ?? 1 }),
						(e) => t.finish(t.stopReason ? "killed" : "failed", { error: String(e?.message ?? e) }),
					).finally(() => {
						try {
							fs.closeSync(fd);
						} catch {}
					});

					// Foreground limit: explicit timeout, else the auto-background default (top-level calls only).
					let fgTimer: NodeJS.Timeout | undefined;
					const fgLimit = timeout !== undefined ? timeout * 1000 : nested || !AUTO_BG_MS ? undefined : AUTO_BG_MS;
					if (params.run_in_background) t.moveToBackground("requested");
					else if (fgLimit) {
						fgTimer = setTimeout(() => {
							const killInstead = nested || !AUTO_BG_MS || /^\s*sleep\b/.test(params.command);
							if (killInstead || !t.moveToBackground("timeout")) {
								killedByTimeout = true;
								t.stop("timeout");
							}
						}, fgLimit);
					}

					return new Promise((resolve, reject) => {
						const finish = () => fgTimer && clearTimeout(fgTimer);
						t.whenBackgrounded().then((reason) => {
							finish();
							reject(new BackgroundedError(t, reason));
						});
						t.done.then(() => {
							if (!t.foreground) return;
							finish();
							if (killedByTimeout) reject(new Error(`timeout:${timeout ?? fgLimit! / 1000}`));
							else if (t.status === "killed") reject(new Error("aborted"));
							else if (t.exitCode === undefined) reject(new Error(t.error ?? "command failed"));
							else resolve({ exitCode: t.exitCode });
						});
					});
				},
			};

			const def = createBashToolDefinition(ctx.cwd, { operations: ops, shellPath: settings.shellPath, commandPrefix: settings.shellCommandPrefix });
			const onToolAbort = () => task?.foreground && task.stop("aborted");
			signal?.addEventListener("abort", onToolAbort, { once: true });
			try {
				const result = await def.execute(toolCallId, { command: params.command, timeout: params.timeout }, signal, onUpdate, ctx);
				return result;
			} catch (e) {
				if (!isBackgrounded(e)) throw e;
				const t = e.task;
				const text = backgroundedText(t, e.reason);
				return {
					content: [{ type: "text", text }],
					details: undefined,
					structuredContent: { output: text, truncated: false, task_id: t.id, output_file: t.outputFile },
				};
			} finally {
				signal?.removeEventListener("abort", onToolAbort);
				// Foreground commands that finished normally don't need to stay in the task list.
				if (task && !task.backgrounded && !task.running) {
					registry.remove(task);
					fs.rm(task.outputFile, { force: true }, () => {});
				}
			}
		},
	});
}
