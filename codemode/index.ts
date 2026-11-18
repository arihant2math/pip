/**
 * Replaces pi's `codemode` tool with one that runs scripts in a persistent Node kernel instead of a fresh
 * QuickJS sandbox. Everything the model sees (the catalog of nested tools, namespaces, `codemode.mode`, the
 * declared tools' "Codemode:" notes, the script globals, the result format, the renderer) comes from or
 * matches the built-in tool; only the runtime differs, plus `background()` and friends.
 */
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";
import { parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import { Catalog, CODEMODE_TOOL_NAME, findTool } from "./catalog.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS, finishOutput, layoutOutput, type ContentItem } from "./format.ts";
import { Kernel, type CellResult, type TaskReport } from "./kernel.ts";
import type { Owner, RpcMethod } from "./protocol.ts";

const STORE_ENTRY_TYPE = "codemode-store";
const MESSAGE_TYPE = "codemode-task";
const STATUS_KEY = "codemode";
/** How long a script runs before it moves to the background, unless `timeout_ms` says otherwise. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Tasks that finish this close together are reported in one message. */
const REPORT_BATCH_MS = 500;
/** How long a print or json run stays open for its background tasks once the agent has nothing left to do. */
const SETTLE_WAIT_MS = Number(process.env.PI_BACKGROUND_TIME_LIMIT_MS) || 30 * 60_000;
/** Status line updates closer together than this are merged. */
const STATUS_THROTTLE_MS = 100;
const ACTIVITY_PREVIEW_CHARS = 80;
const TASK_OUTPUT_TOKENS = 4_000;
const ARGS_PREVIEW_CHARS = 200;
const ERROR_PREVIEW_CHARS = 500;
const MODEL_TYPES = new Set(["chat", "image", "classifier"]);

const INTRO = `Run TypeScript that calls other tools. The input is raw source (not JSON, no code fence), run as an ES module in a persistent Node process: top-level \`await\` and \`return\` work, and so do imports, the file system, network, and timers.
- \`await tools.<name>({ ...args })\` resolves to a string, or an object if the tool's declaration says so, and rejects with an Error on failure. A tool whose declaration returns an object resolves on failure too when it returned that object; check its fields.
- Optional first line: \`// @options: {"max_output_tokens": 10000, "timeout_ms": 30000}\`. A script still running at \`timeout_ms\` keeps running as background task \`cell<N>\`.`;

const EXTRA_GLOBALS = `- \`export\`ed names become globals for later scripts, and anything left running keeps running, until a crash, \`process.exit()\`, or \`/codemode-reset\` restarts the process.
- \`background(name, (signal) => work)\` runs work as a task and messages you when it settles; \`tasks()\` lists tasks, \`cancel(name)\` aborts one.`;

const BACKGROUND_GUIDELINE =
  "For long work you don't need to wait on (builds, servers), make the tool call in codemode as background(name, () => tools.bash({...})), then keep working or end your turn. A message arrives when it finishes, so don't sleep or poll for it.";

/** Swap the built-in intro for ours and add our globals after its own. */
function patchDescription(description: string): string {
  const globalsAt = description.indexOf("\n\nGlobals:\n");
  if (globalsAt === -1) return `${INTRO}\n\n${description}`;
  const rest = description.slice(globalsAt);
  const nestedAt = rest.indexOf("\n\nNested tools:");
  const globals = nestedAt === -1 ? rest : rest.slice(0, nestedAt);
  const after = nestedAt === -1 ? "" : rest.slice(nestedAt);
  return `${INTRO}${globals}\n${EXTRA_GLOBALS}${after}`;
}

/** The built-in codemode tool definition, captured by running its extension factory against a stand-in API. */
function builtinCodemode(pi: ExtensionAPI): ToolDefinition {
  let definition: ToolDefinition | undefined;
  const capture = new Proxy(pi, {
    get(target, key) {
      if (key === "registerTool") return (tool: ToolDefinition) => void (definition = tool);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  createCodemodeExtension()(capture);
  if (!definition) throw new Error("pi's codemode extension did not register a tool");
  return definition;
}

interface NestedCall {
  id: string;
  name: string;
  args: string;
  status: "running" | "ok" | "error" | "cancelled";
  durationMs?: number;
  error?: string;
  cost?: number;
}

interface CodemodeDetails {
  calls: NestedCall[];
  fullOutputPath?: string;
}

function preview(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function previewArgs(args: unknown): string {
  try {
    return preview(JSON.stringify(args) ?? "", ARGS_PREVIEW_CHARS);
  } catch {
    return "";
  }
}

function textOf(result: AgentToolResult<unknown>): string {
  return (result.content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function withoutHeaders<T>(model: T): T {
  if (typeof model !== "object" || model === null) return model;
  const { headers: _headers, ...rest } = model as T & { headers?: unknown };
  return rest as T;
}

/** `load()` values: the branch's `codemode-store` entries applied from the root, as pi's codemode reads them. */
function readStore(ctx: ExtensionContext): Record<string, unknown> {
  const store = new Map<string, unknown>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== STORE_ENTRY_TYPE) continue;
    const data = entry.data as { set?: Record<string, unknown>; delete?: string[] } | undefined;
    if (!data || typeof data.set !== "object" || !Array.isArray(data.delete)) continue;
    for (const key of data.delete) store.delete(key);
    for (const [key, value] of Object.entries(data.set)) store.set(key, value);
  }
  return Object.fromEntries(store);
}

function age(startedAt: number): string {
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function callSummary(calls: NestedCall[]): string {
  if (calls.length === 0) return "No tool calls were made.";
  return `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}`;
}

function formatReport(report: TaskReport): ContentItem[] {
  const verb = { ok: "finished", error: "failed", cancelled: "was cancelled", killed: "was lost" }[report.status];
  const lines = [`Background task \`${report.name}\` ${verb} after ${(report.durationMs / 1000).toFixed(1)} seconds.`];
  if (report.value !== undefined) lines.push(`Value:\n${report.value}`);
  if (report.error !== undefined) lines.push(`Error:\n${report.error}`);
  const output = layoutOutput(report.output);
  if (output.length > 0) lines.push("Output:");
  return finishOutput([{ type: "text", text: lines.join("\n") }, ...output], TASK_OUTPUT_TOKENS).items;
}

export default function radishCodemode(pi: ExtensionAPI) {
  const builtin = builtinCodemode(pi);
  let kernel: Kernel | undefined;
  // Calls from background work outlive the script that started them, so they use the latest script's context.
  let toolContext: ExtensionToolContext | undefined;
  let uiContext: ExtensionContext | undefined;
  let pendingReports: TaskReport[] = [];
  let reportTimer: NodeJS.Timeout | undefined;
  /** Set while a run is held open for its background tasks; see `agent_before_settle`. */
  let wake: (() => void) | undefined;
  let statusTimer: NodeJS.Timeout | undefined;
  /** What each background task's tool call last reported, most recent last. */
  const activity = new Map<string, string>();
  const cancelledByUser = new Set<string>();
  let shuttingDown = false;
  let storeWrites: { set: Record<string, unknown>; delete: Set<string> } = { set: {}, delete: new Set() };
  /** Nested call rows of the scripts still running in the foreground, by cell. */
  const cellCalls = new Map<number, { calls: NestedCall[]; publish(): void; toolCallId: string }>();

  const catalog = (ctx: ExtensionToolContext) => {
    const tools = pi.getAllTools();
    return new Catalog(ctx.tools, {
      guidelines: (name) => tools.find((tool) => tool.name === name)?.promptGuidelines ?? [],
      namespace: (name) => tools.find((tool) => tool.name === name)?.namespace,
    });
  };

  const flushStore = () => {
    if (Object.keys(storeWrites.set).length === 0 && storeWrites.delete.size === 0) return;
    pi.appendEntry(STORE_ENTRY_TYPE, { set: storeWrites.set, delete: [...storeWrites.delete] });
    storeWrites = { set: {}, delete: new Set() };
  };

  /** A row in the running script's call list, if `owner` is a script still in the foreground. */
  const track = (owner: Owner, name: string, args: string) => {
    const cell = owner.kind === "cell" ? cellCalls.get(owner.cell) : undefined;
    if (!cell) return undefined;
    const record: NestedCall = { id: `${cell.toolCallId}/${cell.calls.length + 1}`, name, args, status: "running" };
    cell.calls.push(record);
    cell.publish();
    const startedAt = performance.now();
    return (update: Partial<NestedCall>) => {
      Object.assign(record, { durationMs: performance.now() - startedAt }, update);
      cell.publish();
    };
  };

  const callModel = async (ctx: ExtensionToolContext, name: string, args: unknown[], owner: Owner, signal: AbortSignal) => {
    const registry = ctx.modelRegistry;
    const type = (value: unknown) => {
      if (typeof value === "string" && MODEL_TYPES.has(value)) return value as "chat" | "image" | "classifier";
      throw new Error(`Unknown model type ${JSON.stringify(value)}. Use "chat", "image", or "classifier".`);
    };
    const provider = (value: unknown) => (typeof value === "string" ? value : undefined);
    switch (name) {
      case "getModelsOfType":
        return registry.getModelsOfType(type(args[0]), provider(args[1])).map(withoutHeaders);
      case "getAvailableOfType":
        return (await registry.getAvailableOfType(type(args[0]), provider(args[1]), { signal })).map(withoutHeaders);
      case "getModelOfType": {
        if (typeof args[1] !== "string" || typeof args[2] !== "string") throw new Error("models.getModelOfType(type, provider, id) expects three strings");
        return withoutHeaders(registry.getModelOfType(type(args[0]), args[1], args[2]));
      }
      case "classify":
      case "generateImages": {
        const kind = name === "classify" ? "classifier" : "image";
        const given = args[0] as { provider?: unknown; id?: unknown } | undefined;
        if (typeof given?.provider !== "string" || typeof given.id !== "string") {
          throw new Error(`models.${name}() expects a ${kind} model as its first argument. List them with models.getAvailableOfType("${kind}").`);
        }
        // Resolve by provider and id only, so a script-supplied baseUrl or headers never receive credentials.
        const model = registry.getModelOfType(kind, given.provider, given.id);
        if (!model) throw new Error(`Unknown ${kind} model "${given.provider}/${given.id}". List them with models.getAvailableOfType("${kind}").`);
        const done = track(owner, `models.${name}`, `${model.provider}/${model.id}`);
        const result =
          name === "classify"
            ? await registry.classify(model as never, args[1] as never, { signal })
            : await registry.generateImages(model as never, args[1] as never, { signal });
        const { stopReason, errorMessage, usage } = result as { stopReason?: string; errorMessage?: string; usage?: { cost?: { total?: number } } };
        done?.({
          status: stopReason === "stop" ? "ok" : stopReason === "aborted" ? "cancelled" : "error",
          ...(errorMessage ? { error: preview(errorMessage, ERROR_PREVIEW_CHARS) } : {}),
          ...(usage?.cost?.total ? { cost: usage.cost.total } : {}),
        });
        return result;
      }
    }
    throw new Error(`models.${name} is not a function`);
  };

  const rpc = async (method: RpcMethod, args: unknown, owner: Owner, signal: AbortSignal): Promise<unknown> => {
    const ctx = toolContext;
    if (!ctx) throw new Error("No session context yet");
    if (method.startsWith("models.")) return callModel(ctx, method.slice("models.".length), args as unknown[], owner, signal);
    const tools = catalog(ctx);
    if (method === "searchTools") return tools.search(...(args as [unknown, unknown]));
    if (method === "describeTool") return tools.describeTool((args as unknown[])[0]);
    if (method === "describeNamespace") return tools.describeNamespace((args as unknown[])[0]);

    const { name, args: toolArgs } = (args ?? {}) as { name?: unknown; args?: unknown };
    const tool = findTool(tools.tools, name);
    if (!tool) throw new Error(`Unknown tool ${JSON.stringify(name)}. Find tools with searchTools() or ALL_TOOLS.`);
    const done = track(owner, tool.name, previewArgs(toolArgs));
    note(owner, `${tool.name} ${previewArgs(toolArgs)}`);
    const outcome = await ctx.executeTool(tool.name, toolArgs ?? {}, {
      signal,
      onUpdate(partial) {
        const last = textOf(partial).trimEnd().split("\n").at(-1);
        if (last) note(owner, `${tool.name}: ${last}`);
      },
    });
    const { result } = outcome;
    done?.(
      outcome.isError
        ? { id: outcome.toolCall.id, status: signal.aborted ? "cancelled" : "error", error: preview(textOf(result) || `Tool "${tool.name}" failed`, ERROR_PREVIEW_CHARS) }
        : { id: outcome.toolCall.id, status: "ok" },
    );
    if (method === "callToolRaw") {
      return { content: result.content, isError: outcome.isError, ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }) };
    }
    if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;
    const text = textOf(result);
    if (outcome.isError) throw new Error(text || `Tool "${tool.name}" failed`);
    return text;
  };

  const takeReports = () => {
    clearTimeout(reportTimer);
    reportTimer = undefined;
    const reports = pendingReports;
    pendingReports = [];
    if (reports.length === 0) return undefined;
    return {
      customType: MESSAGE_TYPE,
      content: reports.flatMap(formatReport),
      display: true,
      details: { tasks: reports.map(({ name, status, durationMs }) => ({ name, status, durationMs })) },
    };
  };

  const flushReports = () => {
    const message = takeReports();
    if (message) pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
  };

  const showStatus = () => {
    clearTimeout(statusTimer);
    statusTimer = undefined;
    const tasks = kernel?.tasks ?? [];
    for (const name of activity.keys()) if (!tasks.some((task) => task.name === name)) activity.delete(name);
    const count = `${tasks.length} bg task${tasks.length === 1 ? "" : "s"}`;
    const latest = [...activity].at(-1);
    uiContext?.ui.setStatus(STATUS_KEY, tasks.length === 0 ? undefined : latest ? `${count} · ${latest.join(": ")}` : `${count}: ${tasks.map((task) => task.name).join(", ")}`);
  };

  /** Record what a background task is doing, for the status line and /bg. */
  const note = (owner: Owner, text: string) => {
    const task = kernel?.taskOf(owner);
    if (task === undefined) return;
    activity.delete(task);
    activity.set(task, preview(text.replace(/\s+/g, " "), ACTIVITY_PREVIEW_CHARS));
    statusTimer ??= setTimeout(showStatus, STATUS_THROTTLE_MS);
  };

  const getKernel = (ctx: ExtensionToolContext) =>
    (kernel ??= new Kernel({
      cwd: ctx.cwd,
      hooks: {
        rpc,
        onTaskDone(report) {
          if (shuttingDown) return;
          flushStore();
          const byUser = cancelledByUser.delete(report.name) && report.status === "cancelled";
          pendingReports.push(byUser ? { ...report, error: "Cancelled by the user with /bg" } : report);
          if (wake) wake();
          else reportTimer ??= setTimeout(flushReports, REPORT_BATCH_MS);
        },
        onStoreWrite(key, value) {
          if (value === undefined) {
            delete storeWrites.set[key];
            storeWrites.delete.add(key);
          } else {
            storeWrites.set[key] = value;
            storeWrites.delete.delete(key);
          }
        },
        onTasksChanged() {
          if (!shuttingDown) showStatus();
        },
      },
    }));

  const formatResult = (result: CellResult, calls: NestedCall[], startedAt: number, maxTokens: number) => {
    const failed = result.status === "error" || result.status === "aborted" || result.status === "killed";
    const items: ContentItem[] = [];
    const late = layoutOutput(result.lateOutput);
    if (late.length > 0) items.push({ type: "text", text: "[Printed by earlier scripts after they finished:]" }, ...late, { type: "text", text: "[This script:]" });
    items.push(...layoutOutput(result.output));
    if (result.status === "backgrounded") {
      items.push({ type: "text", text: `[Still running; it continues as background task "${result.task}". A message arrives when it finishes, so don't sleep or poll for it; its exports become globals then. cancel("${result.task}") aborts its signal.]` });
    } else if (failed) {
      const error = result.status === "aborted" ? "Script aborted: Execution aborted" : (result.error ?? "Script failed");
      items.push({ type: "text", text: `Script error:\n${error}\n\n${callSummary(calls)}` });
    }
    const { items: output, fullOutputPath } = finishOutput(items, maxTokens);
    const state = result.status === "backgrounded" ? "Script moved to the background" : failed ? "Script failed" : "Script completed";
    const header = `${state}\nWall time ${((performance.now() - startedAt) / 1000).toFixed(1)} seconds\nOutput:\n`;
    const details: CodemodeDetails = { calls: calls.map((call) => ({ ...call })), ...(fullOutputPath ? { fullOutputPath } : {}) };
    return { content: [{ type: "text" as const, text: header }, ...output], details, ...(failed ? { isError: true } : {}) };
  };

  const definition: ToolDefinition = {
    ...builtin,
    description: patchDescription(builtin.description),
    promptGuidelines: [...(builtin.promptGuidelines ?? []), BACKGROUND_GUIDELINE],
    prepareLoadout(loadout) {
      const changes = builtin.prepareLoadout?.(loadout);
      const description = changes?.descriptions?.[CODEMODE_TOOL_NAME];
      if (!changes || description === undefined) return changes;
      return { ...changes, descriptions: { ...changes.descriptions, [CODEMODE_TOOL_NAME]: patchDescription(description) } };
    },
    // Always available, not just once an MCP server activates it.
    defaultActive: true,
    async execute(toolCallId, params: { code: string }, signal, onUpdate, ctx) {
      const startedAt = performance.now();
      const { code, options } = parseCodemodeSource(params.code);
      toolContext = ctx;
      uiContext = ctx;
      flushStore();
      const calls: NestedCall[] = [];
      const publish = () => onUpdate?.({ content: [], details: { calls: calls.map((call) => ({ ...call })) } });
      publish();
      let cell: number | undefined;
      try {
        const result = await getKernel(ctx).run(code, {
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
          catalog: catalog(ctx).all(),
          store: readStore(ctx),
          onStart(started) {
            cell = started;
            cellCalls.set(started, { calls, publish, toolCallId });
          },
        });
        flushStore();
        if (result.status !== "backgrounded") for (const call of calls) if (call.status === "running") call.status = "cancelled";
        return formatResult(result, calls, startedAt, options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
      } finally {
        if (cell !== undefined) cellCalls.delete(cell);
      }
    },
  };
  pi.registerTool(definition);

  pi.registerCommand("codemode-reset", {
    description: "Kill the codemode kernel, resetting its globals and background tasks",
    handler: async (_args, ctx) => {
      if (!kernel?.alive) return ctx.ui.notify("The codemode kernel isn't running", "info");
      kernel.kill("Kernel was reset with /codemode-reset");
      ctx.ui.notify("codemode kernel killed", "info");
    },
  });

  pi.registerCommand("bg", {
    description: "List codemode background tasks and cancel one; /bg cancel <name> cancels directly",
    handler: async (args, ctx) => {
      const cancel = (name: string) => {
        if (!kernel?.cancel(name)) return ctx.ui.notify(`No running background task "${name}"`, "warning");
        cancelledByUser.add(name);
        ctx.ui.notify(`Cancelling ${name}`, "info");
      };
      const named = /^cancel\s+(.+)$/.exec(args.trim());
      if (named) return cancel(named[1]!);
      const tasks = kernel?.tasks ?? [];
      if (tasks.length === 0) return ctx.ui.notify("No background tasks", "info");
      const rows = tasks.map((task) => [task.name, age(task.startedAt), ...(activity.has(task.name) ? [activity.get(task.name)] : [])].join(" · "));
      if (!ctx.hasUI) return ctx.ui.notify(rows.join("\n"), "info");
      const picked = await ctx.ui.select("Background tasks (select one to cancel)", rows);
      if (picked !== undefined) cancel(tasks[rows.indexOf(picked)]!.name);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    uiContext = ctx;
  });

  // A print or json run ends when the agent settles, taking the tasks still running with it. Hold the run
  // open until one reports, and hand the report over as the reason to continue.
  pi.on("agent_before_settle", async (event, ctx) => {
    if (ctx.mode === "tui" || ctx.mode === "rpc" || event.outcome === "aborted") return;
    if (pendingReports.length === 0 && kernel?.tasks.length) {
      await new Promise<void>((resolve) => {
        const limit = setTimeout(resolve, SETTLE_WAIT_MS);
        wake = () => {
          clearTimeout(limit);
          setTimeout(resolve, REPORT_BATCH_MS);
        };
      });
      wake = undefined;
    }
    const message = takeReports();
    if (message) return { entries: [...event.entries, { type: "custom_message" as const, ...message }], continue: true };
  });

  // The kernel doesn't follow /tree navigation, so say so instead of letting the model trust stale globals.
  pi.on("session_tree", async () => {
    if (!kernel?.alive) return;
    pi.sendMessage(
      {
        customType: MESSAGE_TYPE,
        content: "Note: the codemode kernel kept its globals and background tasks from before this /tree navigation; they may not match this branch. store() values do follow the branch. /codemode-reset clears the kernel.",
        display: true,
      },
      { deliverAs: "nextTurn" },
    );
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    shuttingDown = true;
    clearTimeout(reportTimer);
    clearTimeout(statusTimer);
    reportTimer = statusTimer = undefined;
    pendingReports = [];
    wake?.();
    flushStore();
    const old = kernel;
    kernel = undefined;
    old?.kill("Session ended");
    toolContext = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
