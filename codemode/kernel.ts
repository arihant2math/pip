/**
 * The host side of the kernel: starts child.ts with fork(), sends it cells, serves its calls, and sorts what
 * it prints into cell results, background task reports, and output that arrived after its cell finished.
 */
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CatalogEntry, ChildMessage, HostMessage, OutputKind, Owner, RpcMethod, TaskStatus } from "./protocol.ts";

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const CHILD_PATH = join(PACKAGE_DIR, "child.ts");
export const CELL_DIR = join(PACKAGE_DIR, ".runtime", "cells");
/** How long a cell may overrun its timeout, or ignore an abort, before its event loop counts as blocked. */
const BLOCKED_GRACE_MS = 3_000;
const MAX_BUFFER_CHARS = 2_000_000;

export interface Image {
  type: "image";
  data: string;
  mimeType: string;
}

export type OutputItem = { type: "text"; kind: OutputKind; text: string } | Image;

export interface CellResult {
  status: "ok" | "error" | "backgrounded" | "aborted" | "killed";
  output: OutputItem[];
  /** Output of earlier cells that arrived after those cells finished. */
  lateOutput: OutputItem[];
  error?: string;
  task?: string;
}

export interface TaskReport {
  name: string;
  status: TaskStatus | "killed";
  durationMs: number;
  value?: string;
  error?: string;
  output: OutputItem[];
}

export interface KernelHooks {
  rpc(method: RpcMethod, args: unknown, owner: Owner, signal: AbortSignal): Promise<unknown>;
  onTaskDone(report: TaskReport): void;
  onStoreWrite?(key: string, value: unknown): void;
  onTasksChanged?(running: string[]): void;
}

export interface RunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** `ALL_TOOLS` for this cell. */
  catalog?: CatalogEntry[];
  /** What `load()` sees. */
  store?: Record<string, unknown>;
  /** Called with the cell's number before it starts, so its calls can be told apart. */
  onStart?(cell: number): void;
}

/** Output in order. Consecutive console chunks merge into one item. */
class OutputBuffer {
  items: OutputItem[] = [];
  #chars = 0;
  #full = false;
  append(kind: OutputKind, text: string) {
    if (this.#full) return;
    if (this.#chars + text.length > MAX_BUFFER_CHARS) {
      text = `${text.slice(0, MAX_BUFFER_CHARS - this.#chars)}\n[output beyond ${MAX_BUFFER_CHARS} chars dropped]\n`;
      this.#full = true;
    }
    this.#chars += text.length;
    const last = this.items.at(-1);
    if (kind === "console" && last?.type === "text" && last.kind === "console") last.text += text;
    else this.items.push({ type: "text", kind, text });
  }
  image(image: Image) {
    if (!this.#full) this.items.push(image);
  }
}

interface RunningCell {
  cell: number;
  buffer: OutputBuffer;
  done(result: Omit<CellResult, "output" | "lateOutput">): void;
}

interface HostTask {
  buffer: OutputBuffer;
  startedAt: number;
  cell?: number;
}

export class Kernel {
  readonly #cwd: string;
  readonly #hooks: KernelHooks;
  #child?: ChildProcess;
  #nextCell = 1;
  #current?: RunningCell;
  #late = new OutputBuffer();
  #tasks = new Map<string, HostTask>();
  #cellTasks = new Map<number, string>();
  #rpcs = new Map<number, { owner: Owner; controller: AbortController }>();
  #queue: Promise<unknown> = Promise.resolve();
  #killReason?: string;

  constructor({ cwd, hooks }: { cwd: string; hooks: KernelHooks }) {
    this.#cwd = cwd;
    this.#hooks = hooks;
  }

  get alive(): boolean {
    return this.#child !== undefined;
  }

  get runningTasks(): string[] {
    return [...this.#tasks.keys()];
  }

  /** Runs `code` as the next cell. Cells run one at a time, in call order. */
  run(code: string, options: RunOptions): Promise<CellResult> {
    const result = this.#queue.then(() => this.#run(code, options));
    this.#queue = result.catch(() => {});
    return result;
  }

  /** Kill the process, and with it every global and background task. */
  kill(reason = "Kernel was reset") {
    if (!this.#child) return;
    this.#killReason ??= reason;
    this.#child.kill("SIGKILL");
  }

  #spawn(): ChildProcess {
    mkdirSync(CELL_DIR, { recursive: true });
    const child = fork(CHILD_PATH, [CELL_DIR], {
      cwd: this.#cwd,
      execArgv: ["--disable-warning=ExperimentalWarning"],
      serialization: "advanced",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    // Writes that bypass the patched process.stdout (native code, Node's own warnings) arrive here.
    const raw = (chunk: Uint8Array) => this.#route({ kind: "none" }).append("console", String(chunk));
    child.stdout!.on("data", raw);
    child.stderr!.on("data", raw);
    child.on("message", (message) => this.#handle(child, message as ChildMessage));
    child.once("exit", (code, signal) => this.#onExit(child, code, signal));
    child.on("error", () => {});
    return child;
  }

  #send(message: HostMessage) {
    if (this.#child?.connected) this.#child.send(message);
  }

  async #run(code: string, options: RunOptions): Promise<CellResult> {
    const { timeoutMs, signal } = options;
    if (signal?.aborted) throw new Error("Cancelled");
    this.#child ??= this.#spawn();
    const cell = this.#nextCell++;
    options.onStart?.(cell);
    const file = join(CELL_DIR, `cell${cell}-${randomUUID()}.ts`);
    writeFileSync(file, code);

    let watchdog: NodeJS.Timeout | undefined;
    let overrun: NodeJS.Timeout | undefined;
    const block = (why: string) => {
      watchdog = setTimeout(() => this.kill(why), BLOCKED_GRACE_MS);
    };
    const onAbort = () => {
      this.#send({ t: "abort", cell });
      this.#abortRpcs((owner) => owner.kind === "cell" && owner.cell === cell);
      clearTimeout(watchdog);
      block("The script ignored an abort, so its event loop is probably blocked by synchronous code");
    };

    try {
      return await new Promise<CellResult>((resolve) => {
        const buffer = new OutputBuffer();
        this.#current = {
          cell,
          buffer,
          done: (result) => {
            const lateOutput = this.#late.items;
            this.#late = new OutputBuffer();
            resolve({ ...result, output: buffer.items, lateOutput });
          },
        };
        overrun = setTimeout(() => {
          if (this.#current?.cell === cell) block(`The script did not yield within ${timeoutMs / 1000}s, so its event loop is probably blocked by synchronous code`);
        }, timeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        this.#send({ t: "run", cell, file, timeoutMs, catalog: options.catalog ?? [], store: options.store ?? {} });
      });
    } finally {
      clearTimeout(watchdog);
      clearTimeout(overrun);
      signal?.removeEventListener("abort", onAbort);
      if (this.#current?.cell === cell) this.#current = undefined;
    }
  }

  /** Where output of `owner` goes: its running cell, its task, or the late buffer. */
  #route(owner: Owner): OutputBuffer {
    if (owner.kind === "task") return this.#tasks.get(owner.name)?.buffer ?? this.#late;
    if (owner.kind === "cell") {
      const task = this.#cellTasks.get(owner.cell);
      if (task !== undefined) return this.#tasks.get(task)?.buffer ?? this.#late;
      return this.#current?.cell === owner.cell ? this.#current.buffer : this.#late;
    }
    return this.#current?.buffer ?? this.#late;
  }

  #abortRpcs(matches: (owner: Owner) => boolean) {
    for (const { owner, controller } of this.#rpcs.values()) if (matches(owner)) controller.abort();
  }

  #handle(child: ChildProcess, message: ChildMessage) {
    if (child !== this.#child) return;
    switch (message.t) {
      case "out":
        this.#route(message.owner).append(message.kind, message.text);
        break;
      case "image":
        this.#route(message.owner).image({ type: "image", data: message.data, mimeType: message.mimeType });
        break;
      case "store":
        this.#hooks.onStoreWrite?.(message.key, message.value);
        break;
      case "cellDone": {
        if (message.task !== undefined) this.#cellTasks.set(message.cell, message.task);
        const current = this.#current;
        if (current?.cell !== message.cell) break;
        // Output the cell printed before it was backgrounded stays with this result.
        this.#current = undefined;
        current.done({ status: message.status, ...(message.error ? { error: message.error } : {}), ...(message.task ? { task: message.task } : {}) });
        break;
      }
      case "taskStart":
        this.#tasks.set(message.name, { buffer: new OutputBuffer(), startedAt: Date.now(), ...(message.cell === undefined ? {} : { cell: message.cell }) });
        if (message.cell !== undefined) this.#cellTasks.set(message.cell, message.name);
        this.#hooks.onTasksChanged?.(this.runningTasks);
        break;
      case "taskDone": {
        const task = this.#tasks.get(message.name);
        this.#tasks.delete(message.name);
        if (message.status === "cancelled") {
          this.#abortRpcs((owner) => (owner.kind === "task" && owner.name === message.name) || (owner.kind === "cell" && owner.cell === task?.cell));
        }
        if (task?.cell !== undefined) this.#cellTasks.delete(task.cell);
        this.#hooks.onTasksChanged?.(this.runningTasks);
        this.#hooks.onTaskDone({
          name: message.name,
          status: message.status,
          durationMs: message.durationMs,
          ...(message.value === undefined ? {} : { value: message.value }),
          ...(message.error === undefined ? {} : { error: message.error }),
          output: task?.buffer.items ?? [],
        });
        break;
      }
      case "rpc": {
        const controller = new AbortController();
        this.#rpcs.set(message.id, { owner: message.owner, controller });
        Promise.resolve()
          .then(() => this.#hooks.rpc(message.method, message.args, message.owner, controller.signal))
          .then(
            (value) => child === this.#child && this.#send({ t: "rpcResult", id: message.id, ok: true, value }),
            (error: unknown) => child === this.#child && this.#send({ t: "rpcResult", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
          )
          .finally(() => this.#rpcs.delete(message.id));
        break;
      }
    }
  }

  #onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null) {
    if (child !== this.#child) return;
    this.#child = undefined;
    const reason = this.#killReason ?? (signal ? `Kernel was killed by ${signal}` : `Kernel exited with code ${code}`);
    this.#killReason = undefined;
    this.#abortRpcs(() => true);
    const lost = `${reason}; every global was reset`;
    const current = this.#current;
    this.#current = undefined;
    current?.done({ status: "killed", error: lost });
    // A killed cell's result already says so; tasks that die outside a cell are reported like finished ones.
    for (const [name, task] of this.#tasks) {
      this.#hooks.onTaskDone({ name, status: "killed", durationMs: Date.now() - task.startedAt, error: lost, output: task.buffer.items });
    }
    this.#tasks.clear();
    this.#cellTasks.clear();
    this.#hooks.onTasksChanged?.([]);
  }
}
