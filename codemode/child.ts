/**
 * The kernel process. Runs cells (TypeScript modules) one after another in one long-lived Node process, so
 * their exports, and anything they leave running, survive between cells. Everything a cell or background
 * task prints goes to the host tagged with its owner, found through AsyncLocalStorage.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import type { CatalogEntry, ChildMessage, HostMessage, OutputKind, Owner, RpcMethod, TaskStatus } from "./protocol.ts";

interface Scope {
  owner: Owner;
  signal: AbortSignal;
}

interface Task {
  name: string;
  status: "running" | TaskStatus;
  startedAt: number;
  controller: AbortController;
  value?: unknown;
  error?: unknown;
}

const PREVIEW_CHARS = 4_000;
const MAX_STORE_VALUE_CHARS = 256 * 1024;
const MAX_STORE_TOTAL_CHARS = 1024 * 1024;
/** Export that carries a top-level `return` value; see {@link wrapReturn}. */
const RETURN_EXPORT = "__codemodeReturn";

const scope = new AsyncLocalStorage<Scope>();
const tasks = new Map<string, Task>();
const cells = new Map<number, { state: "running" | "backgrounded" | "aborted" | "done"; controller: AbortController }>();
const pendingRpcs = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
/** `store()` values as JSON text. The host sends the branch's values with every cell. */
let storeValues = new Map<string, string>();
let catalog: readonly CatalogEntry[] = [];
let nextRpcId = 0;
let runningCell: number | undefined;
const NO_SIGNAL = new AbortController().signal;

/** Thrown by `exit()`; a cell or task that ends with it succeeded. */
class ExitSignal extends Error {
  constructor() {
    super("exit() was called");
  }
}

function send(message: ChildMessage) {
  if (process.connected) process.send!(message);
}

function currentOwner(): Owner {
  return scope.getStore()?.owner ?? (runningCell === undefined ? { kind: "none" } : { kind: "cell", cell: runningCell });
}

function write(kind: OutputKind, text: string, owner = currentOwner()) {
  send({ t: "out", owner, kind, text });
}

/** Like codemode's `text()`: strings as is, other values as compact JSON. */
function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return inspect(value);
  }
}

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : inspect(value, { depth: 4, maxStringLength: PREVIEW_CHARS, breakLength: 100 });
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}… (${text.length} chars)` : text;
}

function formatError(error: unknown): string {
  return error instanceof Error ? inspect(error) : `Thrown: ${preview(error)}`;
}

// Cells live in the extension's .runtime directory, so bare imports of this package's dependencies resolve.
// Relative imports, and bare imports this package lacks, resolve from the cwd.
function installResolveHooks(cellDir: string) {
  const cellUrlPrefix = pathToFileURL(cellDir + "/").href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!context.parentURL?.startsWith(cellUrlPrefix)) return nextResolve(specifier, context);
      const fromCwd = { ...context, parentURL: pathToFileURL(join(process.cwd(), "/")).href };
      if (/^\.\.?\//.test(specifier)) return nextResolve(specifier, fromCwd);
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        try {
          return nextResolve(specifier, fromCwd);
        } catch {
          throw error;
        }
      }
    },
  });
}

function installOutputCapture() {
  const capture = (chunk: unknown, encoding?: unknown, callback?: unknown) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString(typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
    write("console", text);
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") queueMicrotask(() => (done as () => void)());
    return true;
  };
  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;
  // Stray errors from background work must not take the kernel down with every global in it.
  process.on("uncaughtException", (error) => error instanceof ExitSignal || console.error("Uncaught exception:", error));
  process.on("unhandledRejection", (error) => error instanceof ExitSignal || console.error("Unhandled rejection:", error));
}

function rpc(method: RpcMethod, args: unknown): Promise<unknown> {
  const id = nextRpcId++;
  const owner = currentOwner();
  return new Promise((resolve, reject) => {
    pendingRpcs.set(id, { resolve, reject });
    try {
      send({ t: "rpc", id, owner, method, args });
    } catch (error) {
      pendingRpcs.delete(id);
      reject(error);
    }
  });
}

function startTask(name: string, controller: AbortController, cell?: number, startedAt = Date.now()): Task {
  const task: Task = { name, status: "running", startedAt, controller };
  tasks.set(name, task);
  send({ t: "taskStart", name, ...(cell === undefined ? {} : { cell }) });
  return task;
}

function finishTask(task: Task, status: TaskStatus, outcome?: unknown) {
  if (task.status !== "running") return;
  if (status === "error" && outcome instanceof ExitSignal) {
    status = "ok";
    outcome = undefined;
  }
  task.status = status;
  const durationMs = Date.now() - task.startedAt;
  if (status === "ok") {
    task.value = outcome;
    send({ t: "taskDone", name: task.name, status, durationMs, ...(outcome === undefined ? {} : { value: preview(outcome) }) });
  } else {
    task.error = outcome;
    send({ t: "taskDone", name: task.name, status, durationMs, ...(outcome === undefined ? {} : { error: formatError(outcome) }) });
  }
}

/** Images: a Buffer, a data: URL, a file path, base64, `{ image_url }`, or an `{ data, mimeType }` image block. */
function toImage(input: unknown, mimeType?: string): { data: string; mimeType: string } {
  const byExtension: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
  if (input instanceof Uint8Array) return { data: Buffer.from(input).toString("base64"), mimeType: mimeType ?? "image/png" };
  if (typeof input === "object" && input !== null) {
    const { data, mimeType: blockType, image_url: url } = input as { data?: unknown; mimeType?: unknown; image_url?: unknown };
    if (typeof data === "string") return { data, mimeType: typeof blockType === "string" ? blockType : (mimeType ?? "image/png") };
    if (typeof url === "string") return toImage(url, mimeType);
  }
  if (typeof input !== "string") throw new TypeError("image() takes a Buffer, a data: URL, a file path, base64, { image_url }, or { data, mimeType }");
  const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(input);
  if (dataUrl) return { data: dataUrl[2]!, mimeType: dataUrl[1]! };
  if (/^https?:\/\//.test(input)) throw new TypeError("image() does not fetch remote URLs; fetch the bytes and pass a Buffer");
  if (input.length < 4096 && existsSync(input)) {
    const type = mimeType ?? byExtension[extname(input).toLowerCase()];
    if (!type) throw new TypeError(`image(): unknown image type for ${input}; pass the mimeType`);
    return { data: readFileSync(input).toString("base64"), mimeType: type };
  }
  return { data: input, mimeType: mimeType ?? "image/png" };
}

const models = Object.freeze(
  Object.fromEntries(
    ["getModelsOfType", "getAvailableOfType", "getModelOfType", "classify", "generateImages"].map((name) => [
      name,
      (...args: unknown[]) => rpc(`models.${name}`, args),
    ]),
  ),
);

const globals = {
  /** `tools.<name>(args)` calls a pi tool: structuredContent for tools with an output schema, else the text. Rejects on errors. */
  tools: new Proxy({}, {
    get(_target, name) {
      if (typeof name !== "string" || name === "then") return undefined;
      return (args: unknown = {}) => rpc("callTool", { name, args });
    },
  }),
  /** The tool's full result, `{ content, structuredContent?, isError }`, including images. Never rejects for tool errors. */
  callTool: (name: string, args: unknown = {}) => rpc("callToolRaw", { name, args }),
  searchTools: (query: unknown, options?: unknown) => rpc("searchTools", [query, options]),
  describeTool: (name: unknown) => rpc("describeTool", [name]),
  describeNamespace: (name: unknown) => rpc("describeNamespace", [name]),
  models,

  text(value: unknown) {
    write("text", valueText(value));
  },
  /** Show an image to the agent, with the current cell's result or the current task's message. */
  image(input: unknown, mimeType?: string) {
    send({ t: "image", owner: currentOwner(), ...toImage(input, mimeType) });
  },
  exit(): never {
    throw new ExitSignal();
  },

  store(key: string, value: unknown) {
    if (typeof key !== "string") throw new TypeError("store(key, value): key must be a string");
    if (value === undefined) {
      storeValues.delete(key);
      send({ t: "store", key });
      return;
    }
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError("store(): value must be JSON-serializable");
    if (json.length > MAX_STORE_VALUE_CHARS) throw new RangeError(`store(): value is ${json.length} chars of JSON; the limit is ${MAX_STORE_VALUE_CHARS}`);
    let total = json.length;
    for (const [other, text] of storeValues) if (other !== key) total += text.length;
    if (total > MAX_STORE_TOTAL_CHARS) throw new RangeError(`store(): all values together would be ${total} chars of JSON; the limit is ${MAX_STORE_TOTAL_CHARS}`);
    storeValues.set(key, json);
    send({ t: "store", key, value: JSON.parse(json) });
  },
  load(key: string): unknown {
    const json = storeValues.get(key);
    return json === undefined ? undefined : JSON.parse(json);
  },

  /**
   * Track a promise, or a function `(signal) => promise`, as a named background task, and return its promise.
   * When it settles, the agent gets a message with the outcome and whatever the task printed.
   */
  background<T>(name: string, work: Promise<T> | ((signal: AbortSignal) => T | Promise<T>)): Promise<T> {
    if (typeof name !== "string" || !name) throw new TypeError("background(name, work): name must be a non-empty string");
    if (tasks.get(name)?.status === "running") throw new Error(`Background task "${name}" is already running`);
    const controller = new AbortController();
    const task = startTask(name, controller);
    const promise =
      typeof work === "function"
        ? scope.run({ owner: { kind: "task", name }, signal: controller.signal }, () => Promise.resolve().then(() => work(controller.signal)))
        : work;
    Promise.resolve(promise).then(
      (value) => finishTask(task, "ok", value),
      (error) => finishTask(task, "error", error),
    );
    return promise as Promise<T>;
  },
  /** Every task this kernel has run: `{ name, status, startedAt, value?, error? }`. */
  tasks: () => [...tasks.values()].map(({ controller: _controller, ...task }) => task),
  /** Abort a task's signal and report it cancelled. Work that ignores the signal keeps running unreported. */
  cancel(name: string): boolean {
    const task = tasks.get(name);
    if (!task || task.status !== "running") return false;
    task.controller.abort(new Error(`Task "${name}" cancelled`));
    finishTask(task, "cancelled");
    return true;
  },
};

/**
 * Modules cannot `return`, so a cell with a top-level `return` runs again as the body of an async function
 * whose value is exported. Static imports move after the body (imports are hoisted anyway), and every line
 * keeps its number, so stack traces still point at the right place. Top-level `export` declarations become
 * plain declarations that are copied to globals when the body ends, which is where a module's exports end up anyway.
 */
function wrapReturn(source: string): string {
  const imports: string[] = [];
  const exported: [local: string, name: string][] = [];
  const body = source
    .replace(/^[ \t]*import\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?["'][^"']+["'][ \t]*;?/gm, (statement) => {
      imports.push(statement.replace(/\n/g, " "));
      return statement.replace(/[^\n]/g, "");
    })
    .replace(/^export\s+((?:async\s+)?(?:const|let|var|function\*?|class)\s+)([A-Za-z_$][\w$]*)/gm, (_statement, keyword: string, name: string) => {
      exported.push([name, name]);
      return `${keyword}${name}`;
    })
    .replace(/^export\s*\{([^}]*)\}\s*;?/gm, (_statement, list: string) => {
      for (const item of list.split(",")) {
        const [local, name = local] = item.trim().split(/\s+as\s+/);
        if (local) exported.push([local, name!]);
      }
      return "";
    });
  // The copying function is declared inside the body, so it sees the body's declarations, and hoisted, so the
  // body's first line can hand it out. A declaration the return skipped is still in its temporal dead zone,
  // so each copy may throw.
  const copy = exported.map(([local, name]) => `try { globalThis[${JSON.stringify(name)}] = ${local}; } catch {}`).join(" ");
  return (
    `let copyExports; export const ${RETURN_EXPORT} = await (async () => { copyExports = __copyExports;${body}\n` +
    `function __copyExports() { ${copy} }\n})().finally(() => copyExports?.());\n${imports.join("\n")}\n`
  );
}

async function importCell(file: string, cell: number, signal: AbortSignal): Promise<Record<string, unknown>> {
  const load = (path: string) => scope.run({ owner: { kind: "cell", cell }, signal }, () => import(pathToFileURL(path).href));
  try {
    return await load(file);
  } catch (error) {
    // V8 says "Illegal return statement"; Node's TypeScript stripper says "Return statement is not allowed here".
    if (!(error instanceof SyntaxError) || !/Illegal return|Return statement is not allowed/.test(error.message)) throw error;
    const wrapped = file.replace(/\.ts$/, ".return.ts");
    writeFileSync(wrapped, wrapReturn(readFileSync(file, "utf8")));
    try {
      return await load(wrapped);
    } finally {
      rmSync(wrapped, { force: true });
    }
  }
}

async function runCell(cell: number, file: string, timeoutMs: number) {
  const controller = new AbortController();
  const state = { state: "running" as "running" | "backgrounded" | "aborted" | "done", controller };
  cells.set(cell, state);
  runningCell = cell;
  const startedAt = Date.now();
  let task: Task | undefined;
  const timer = setTimeout(() => {
    if (state.state !== "running") return;
    state.state = "backgrounded";
    runningCell = undefined;
    const name = `cell${cell}`;
    task = startTask(name, controller, cell, startedAt);
    send({ t: "cellDone", cell, status: "backgrounded", task: name });
  }, timeoutMs);

  let ok = true;
  let outcome: unknown;
  try {
    const { [RETURN_EXPORT]: returned, ...exports } = await importCell(file, cell, controller.signal);
    Object.assign(globalThis, exports);
    if (returned !== undefined) write("text", valueText(returned), { kind: "cell", cell });
    const names = Object.keys(exports);
    if (names.length > 0) outcome = `exports: ${names.join(", ")}`;
  } catch (error) {
    if (!(error instanceof ExitSignal)) {
      ok = false;
      outcome = error;
    }
  } finally {
    clearTimeout(timer);
    rmSync(file, { force: true });
  }

  if (state.state === "running") {
    runningCell = undefined;
    send({ t: "cellDone", cell, status: ok ? "ok" : "error", ...(ok ? {} : { error: formatError(outcome) }) });
  } else if (state.state === "backgrounded" && task) {
    finishTask(task, ok ? "ok" : "error", outcome);
  }
  // An aborted cell usually fails because of the abort itself, which would only be noise.
  state.state = "done";
  cells.delete(cell);
}

function handle(message: HostMessage) {
  switch (message.t) {
    case "run":
      catalog = Object.freeze(message.catalog.map((entry) => Object.freeze({ ...entry })));
      storeValues = new Map(Object.entries(message.store).map(([key, value]) => [key, JSON.stringify(value)]));
      void runCell(message.cell, message.file, message.timeoutMs);
      break;
    case "abort": {
      const cell = cells.get(message.cell);
      if (cell?.state !== "running") break;
      cell.state = "aborted";
      runningCell = undefined;
      cell.controller.abort(new Error("Script aborted"));
      send({ t: "cellDone", cell: message.cell, status: "aborted" });
      break;
    }
    case "rpcResult": {
      const pending = pendingRpcs.get(message.id);
      if (!pending) break;
      pendingRpcs.delete(message.id);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new Error(message.error));
      break;
    }
  }
}

const cellDir = process.argv[2];
if (!cellDir || !process.send) {
  console.error("child.ts is the radish-codemode kernel; the extension starts it with fork()");
  process.exit(1);
}
installResolveHooks(cellDir);
installOutputCapture();
Object.assign(globalThis, globals);
Object.defineProperties(globalThis, {
  // The signal of whatever cell or task is running the code that reads it.
  signal: { get: () => scope.getStore()?.signal ?? NO_SIGNAL, configurable: true },
  ALL_TOOLS: { get: () => catalog, configurable: true },
});
process.on("message", (message) => handle(message as HostMessage));
// The IPC channel closes when pi exits, however it exits.
process.on("disconnect", () => process.exit());
