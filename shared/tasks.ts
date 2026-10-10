/**
 * The task registry: one process-wide list of long-running work (background shell commands,
 * subagents, workflows). Claude Code treats all three as "tasks" with the same lifecycle:
 *
 *   running (foreground: a tool call is blocked on it)
 *     └─ moveToBackground()  -> the tool call returns early; the work keeps going
 *   finish() -> completed | failed | killed
 *     └─ if it was backgrounded, task-core.ts delivers a <task-notification> to the model
 *
 * Several extensions (background-commands, subagents, dynamic-workflows) import this file, and
 * pi gives each package its own module root, so the registry lives on globalThis. Never use
 * `instanceof Task`: two copies of this module can exist side by side.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type TaskKind = "bash" | "agent" | "workflow";
export type TaskStatus = "running" | "completed" | "failed" | "killed";

export interface TaskInit {
	kind: TaskKind;
	description: string;
	/** Reuse an id (resuming a subagent keeps its agent id). */
	id?: string;
	/** Defaults to <tmp>/pi-tasks/<pid>/<id>.output (created empty). */
	outputFile?: string;
	/**
	 * Time limit once the task is in the background. Interactive sessions only enforce an explicit
	 * limit; non-interactive runs (print/json, i.e. subagents) always get one so they can exit.
	 */
	limitMs?: number;
	/** Whether Ctrl+B / auto-backgrounding may detach it from its tool call. Default true. */
	canBackground?: boolean;
	meta?: Record<string, any>;
}

export interface TaskSnapshot {
	id: string;
	kind: TaskKind;
	description: string;
	status: TaskStatus;
	startedAt: number;
	endedAt?: number;
	outputFile: string;
	backgrounded: boolean;
	exitCode?: number;
	error?: string;
	stopReason?: string;
	meta: Record<string, any>;
}

type Listener = (event: "changed" | "finished" | "removed", task: Task) => void;

export interface Task extends TaskSnapshot {
	foreground: boolean;
	backgroundReason?: string;
	result?: string;
	/** Don't notify the model when it finishes (it stopped the task itself, or already read the result). */
	silent: boolean;
	notified: boolean;
	limitMs?: number;
	canBackground: boolean;
	readonly signal: AbortSignal;
	readonly done: Promise<Task>;
	readonly running: boolean;
	moveToBackground(reason: string): boolean;
	whenBackgrounded(): Promise<string>;
	stop(reason?: string): boolean;
	finish(status: Exclude<TaskStatus, "running">, info?: { exitCode?: number; error?: string; result?: string }): void;
	touch(): void;
	snapshot(): TaskSnapshot;
}

const PREFIX: Record<TaskKind, string> = { bash: "b", agent: "a", workflow: "w" };

export function newTaskId(kind: TaskKind): string {
	return PREFIX[kind] + Math.random().toString(36).slice(2, 8).padEnd(6, "0");
}

class TaskImpl implements Task {
	id: string;
	kind: TaskKind;
	description: string;
	status: TaskStatus = "running";
	startedAt = Date.now();
	endedAt?: number;
	outputFile: string;
	foreground = true;
	backgrounded = false;
	backgroundReason?: string;
	exitCode?: number;
	error?: string;
	stopReason?: string;
	result?: string;
	silent = false;
	notified = false;
	limitMs?: number;
	canBackground: boolean;
	meta: Record<string, any>;
	readonly done: Promise<Task>;

	private controller = new AbortController();
	private resolveDone!: (t: Task) => void;
	private bgWaiters: ((reason: string) => void)[] = [];
	private limitTimer?: NodeJS.Timeout;

	constructor(
		private registry: TaskRegistry,
		init: TaskInit,
	) {
		this.id = init.id ?? newTaskId(init.kind);
		this.kind = init.kind;
		this.description = init.description;
		this.limitMs = init.limitMs;
		this.canBackground = init.canBackground ?? true;
		this.meta = { ...(init.meta ?? {}) };
		this.outputFile = init.outputFile ?? path.join(registry.outputDir, `${this.id}.output`);
		fs.mkdirSync(path.dirname(this.outputFile), { recursive: true });
		if (!init.outputFile) fs.writeFileSync(this.outputFile, "");
		this.done = new Promise((r) => (this.resolveDone = r));
	}

	get signal() {
		return this.controller.signal;
	}
	get running() {
		return this.status === "running";
	}

	moveToBackground(reason: string): boolean {
		if (!this.running || !this.foreground || !this.canBackground) return false;
		this.foreground = false;
		this.backgrounded = true;
		this.backgroundReason = reason;
		const limit = this.limitMs ?? (this.registry.interactive ? undefined : this.registry.defaultLimitMs(this.kind));
		if (limit) {
			this.limitTimer = setTimeout(() => this.stop("time limit"), limit);
			this.limitTimer.unref?.();
		}
		for (const w of this.bgWaiters.splice(0)) w(reason);
		this.registry.emit("changed", this);
		return true;
	}

	whenBackgrounded(): Promise<string> {
		if (this.backgrounded) return Promise.resolve(this.backgroundReason ?? "");
		return new Promise((r) => this.bgWaiters.push(r));
	}

	stop(reason = "stopped"): boolean {
		if (!this.running) return false;
		this.stopReason ??= reason;
		this.controller.abort(new Error(reason));
		return true;
	}

	finish(status: Exclude<TaskStatus, "running">, info: { exitCode?: number; error?: string; result?: string } = {}) {
		if (!this.running) return;
		this.status = this.stopReason && status !== "completed" ? "killed" : status;
		this.exitCode = info.exitCode;
		this.error = info.error;
		if (info.result !== undefined) this.result = info.result;
		this.endedAt = Date.now();
		if (this.limitTimer) clearTimeout(this.limitTimer);
		this.bgWaiters = [];
		this.resolveDone(this);
		this.registry.emit("finished", this);
	}

	touch() {
		this.registry.emit("changed", this);
	}

	snapshot(): TaskSnapshot {
		const { id, kind, description, status, startedAt, endedAt, outputFile, backgrounded, exitCode, error, stopReason, meta } = this;
		return { id, kind, description, status, startedAt, endedAt, outputFile, backgrounded, exitCode, error, stopReason, meta: { ...meta } };
	}
}

export class TaskRegistry {
	readonly tasks = new Map<string, Task>();
	readonly outputDir = path.join(os.tmpdir(), "pi-tasks", String(process.pid));
	/** Set by task-core from ctx.mode. Non-interactive runs give every background task a time limit. */
	interactive = true;
	/** Finished background tasks whose notification hasn't reached the model yet. Survives /reload. */
	readonly pending: Task[] = [];
	private listeners = new Set<Listener>();

	create(init: TaskInit): Task {
		const old = init.id ? this.tasks.get(init.id) : undefined;
		if (old?.running) throw new Error(`Task ${init.id} is still running`);
		const task = new TaskImpl(this, init);
		this.tasks.set(task.id, task);
		this.emit("changed", task);
		return task;
	}

	get(id: string): Task | undefined {
		return this.tasks.get(id.trim());
	}

	list(): Task[] {
		return [...this.tasks.values()];
	}

	remove(task: Task) {
		if (this.tasks.get(task.id) === task) {
			this.tasks.delete(task.id);
			this.emit("removed", task);
		}
	}

	/** Detach every foreground task from its tool call (Ctrl+B). */
	backgroundAll(reason: string): Task[] {
		return this.list().filter((t) => t.moveToBackground(reason));
	}

	defaultLimitMs(kind: TaskKind): number {
		const env = Number(process.env.PI_BACKGROUND_TIME_LIMIT_MS);
		if (env > 0) return env;
		return kind === "bash" ? 10 * 60_000 : 30 * 60_000;
	}

	on(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: "changed" | "finished" | "removed", task: Task) {
		for (const l of this.listeners) {
			try {
				l(event, task);
			} catch (e) {
				console.error("[pip tasks] listener error", e);
			}
		}
	}

	stopAll(reason: string) {
		for (const t of this.list()) t.stop(reason);
	}
}

const KEY = Symbol.for("pip.task-registry.v1");

export function taskRegistry(): TaskRegistry {
	const g = globalThis as any;
	return (g[KEY] ??= new TaskRegistry());
}

/** Thrown out of a foreground run when its task moves to the background. */
export class BackgroundedError extends Error {
	readonly pipBackgrounded = true;
	constructor(
		readonly task: Task,
		readonly reason: string,
	) {
		super(`task ${task.id} moved to background (${reason})`);
	}
}

export function isBackgrounded(e: unknown): e is BackgroundedError {
	return !!(e && typeof e === "object" && (e as any).pipBackgrounded);
}

/**
 * Wait for a foreground task: resolves "done" when it finishes, "background" when it gets detached.
 * Aborting the tool call (Esc) stops the task while it is still in the foreground.
 */
export function awaitForeground(task: Task, toolSignal: AbortSignal | undefined): Promise<"done" | "background"> {
	const onAbort = () => {
		if (task.foreground) task.stop("aborted");
	};
	if (toolSignal?.aborted) onAbort();
	else toolSignal?.addEventListener("abort", onAbort, { once: true });
	return Promise.race([task.done.then(() => "done" as const), task.whenBackgrounded().then(() => "background" as const)]).finally(() =>
		toolSignal?.removeEventListener("abort", onAbort),
	);
}
