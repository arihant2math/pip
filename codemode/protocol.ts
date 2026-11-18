/** Messages between the kernel host (pi's process) and the kernel process (child.ts), sent over fork()'s IPC channel. */

/** Who printed something or made a call: a cell, a background task, or code with no known origin. */
export type Owner = { kind: "cell"; cell: number } | { kind: "task"; name: string } | { kind: "none" };

/** `console` is anything written to stdout or stderr; `text` comes from `text()` or a returned value. */
export type OutputKind = "console" | "text";

/** Host functions a script reaches: tool calls, tool discovery, and `models.*`. */
export type RpcMethod = "callTool" | "callToolRaw" | "searchTools" | "describeTool" | "describeNamespace" | `models.${string}`;

export interface CatalogEntry {
  name: string;
  description: string;
}

export type HostMessage =
  | { t: "run"; cell: number; file: string; timeoutMs: number; catalog: CatalogEntry[]; store: Record<string, unknown> }
  | { t: "abort"; cell: number }
  | { t: "cancel"; name: string }
  | { t: "rpcResult"; id: number; ok: true; value: unknown }
  | { t: "rpcResult"; id: number; ok: false; error: string };

export type CellStatus = "ok" | "error" | "backgrounded" | "aborted";
export type TaskStatus = "ok" | "error" | "cancelled";

export type ChildMessage =
  | { t: "out"; owner: Owner; kind: OutputKind; text: string }
  | { t: "image"; owner: Owner; data: string; mimeType: string }
  | { t: "store"; key: string; value?: unknown }
  | { t: "cellDone"; cell: number; status: CellStatus; error?: string; task?: string }
  | { t: "taskStart"; name: string; cell?: number }
  | { t: "taskDone"; name: string; status: TaskStatus; value?: string; error?: string; durationMs: number }
  | { t: "rpc"; id: number; owner: Owner; method: RpcMethod; args: unknown };
