import assert from "node:assert/strict";
import { after, test } from "node:test";
import { tmpdir } from "node:os";
import { Kernel, type CellResult, type OutputItem, type TaskReport } from "../kernel.ts";

/** Everything printed to the console, in order. */
const out = (items: OutputItem[]) => items.flatMap((item) => (item.type === "text" && item.kind === "console" ? [item.text] : [])).join("");
const texts = (items: OutputItem[]) => items.flatMap((item) => (item.type === "text" && item.kind === "text" ? [item.text] : []));

const reports: TaskReport[] = [];
const waiters: (() => void)[] = [];
const calls: { method: string; args: unknown }[] = [];

const kernel = new Kernel({
  cwd: tmpdir(),
  hooks: {
    async rpc(method, args, _owner, signal) {
      calls.push({ method, args });
      const { name, args: toolArgs } = args as { name: string; args: { ms?: number; text?: string } };
      if (name === "fail") throw new Error("tool failed");
      if (name === "slow") {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, toolArgs.ms ?? 1000);
          signal.addEventListener("abort", () => (clearTimeout(timer), reject(new Error("aborted"))));
        });
      }
      return `echo:${toolArgs?.text ?? ""}`;
    },
    onTaskDone(report) {
      reports.push(report);
      waiters.splice(0).forEach((wake) => wake());
    },
  },
});

after(() => kernel.kill());

async function report(name: string): Promise<TaskReport> {
  for (;;) {
    const found = reports.find((r) => r.name === name);
    if (found) return found;
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
}

const run = async (code: string, timeoutMs = 5_000, signal?: AbortSignal, store?: Record<string, unknown>) => {
  const result = await kernel.run(code, { timeoutMs, ...(signal ? { signal } : {}), catalog: [{ name: "echo", description: "echoes" }], ...(store ? { store } : {}) });
  return { ...result, text: out(result.output), late: out(result.lateOutput) } as CellResult & { text: string; late: string };
};

test("exports persist across cells, plain consts don't", async () => {
  const first = await run(`export const kept = 41; const local = 1; console.log("hi")`);
  assert.equal(first.status, "ok");
  assert.equal(first.text, "hi\n");
  const second = await run(`console.log(kept + 1, typeof local)`);
  assert.equal(second.text, "42 undefined\n");
});

test("TypeScript and errors", async () => {
  const typed = await run(`const n: number = 2; console.log(n * 2)`);
  assert.equal(typed.text, "4\n");
  const failed = await run(`console.log("before"); throw new Error("boom")`);
  assert.equal(failed.status, "error");
  assert.equal(failed.text, "before\n");
  assert.match(failed.error!, /boom/);
});

test("tools calls go through the host", async () => {
  const result = await run(`console.log(await tools.echo({ text: "x" })); await tools.fail({}).catch((e) => console.log("caught", e.message))`);
  assert.equal(result.text, "echo:x\ncaught tool failed\n");
  assert.deepEqual(calls.at(-2), { method: "callTool", args: { name: "echo", args: { text: "x" } } });
});

test("background tasks report value and their own output", async () => {
  const result = await run(`export const p = background("job", async () => { console.log("from job"); await new Promise((r) => setTimeout(r, 200)); return { answer: 42 }; }); console.log("cell done")`);
  assert.equal(result.text, "cell done\n");
  const job = await report("job");
  assert.equal(job.status, "ok");
  assert.equal(out(job.output), "from job\n");
  assert.match(job.value!, /answer: 42/);
  assert.equal((await run(`console.log((await p).answer)`)).text, "42\n");
});

test("background with a plain promise returns the same promise", async () => {
  const result = await run(`const promise = new Promise((r) => setTimeout(() => r(7), 50)); console.log(background("same", promise) === promise)`);
  assert.equal(result.text, "true\n");
  assert.equal((await report("same")).value, "7");
});

test("cells past their timeout move to the background", async () => {
  const result = await run(`console.log("start"); await new Promise((r) => setTimeout(r, 600)); console.log("end"); export const late = "yes"`, 200);
  assert.equal(result.status, "backgrounded");
  assert.match(result.task!, /^cell\d+$/);
  assert.equal(result.text, "start\n");
  const task = await report(result.task!);
  assert.equal(task.status, "ok");
  assert.equal(out(task.output), "end\n");
  assert.equal((await run(`console.log(late)`)).text, "yes\n");
});

test("output after a cell ends shows up with the next cell", async () => {
  await run(`setTimeout(() => console.log("stray"), 100)`);
  await new Promise((r) => setTimeout(r, 300));
  const next = await run(`console.log("next")`);
  assert.equal(next.late, "stray\n");
  assert.equal(next.text, "next\n");
});

test("cancel aborts the task's signal and in-flight tool calls", async () => {
  await run(`background("long", (signal) => tools.slow({ ms: 10000 }))`);
  const result = await run(`console.log(cancel("long"))`);
  assert.equal(result.text, "true\n");
  assert.equal((await report("long")).status, "cancelled");
});

test("aborting a cell keeps the kernel", async () => {
  const controller = new AbortController();
  const pending = run(`export const before = 1; await tools.slow({ ms: 10000 })`, 20_000, controller.signal);
  setTimeout(() => controller.abort(), 200);
  const result = await pending;
  assert.equal(result.status, "aborted");
  assert.equal((await run(`console.log(typeof kept)`)).text, "number\n");
});

test("a blocked event loop gets the kernel killed, and the next cell starts fresh", async () => {
  await run(`background("doomed", () => new Promise(() => {}))`);
  const result = await run(`while (true) {}`, 200);
  assert.equal(result.status, "killed");
  assert.match(result.error!, /blocked/);
  assert.equal((await report("doomed")).status, "killed");
  assert.equal((await run(`console.log(typeof kept)`)).text, "undefined\n");
});

test("images", async () => {
  const result = await run(`image(Buffer.from("png"), "image/png")`);
  assert.deepEqual(result.output, [{ type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" }]);
});

test("text(), return, and exit()", async () => {
  const result = await run(`text("a"); text({ b: 1 }); console.log("log"); return [1, 2]`);
  assert.equal(result.status, "ok");
  assert.deepEqual(texts(result.output), ["a", '{"b":1}', "[1,2]"]);
  assert.equal(result.text, "log\n");
  const withImport = await run(`import { join } from "node:path";\nif (true) return join("a", "b");`);
  assert.deepEqual(texts(withImport.output), ["a/b"]);
  const exited = await run(`console.log("before"); exit(); console.log("after")`);
  assert.equal(exited.status, "ok");
  assert.equal(exited.text, "before\n");
});

test("store() and load()", async () => {
  const writes: [string, unknown][] = [];
  const storeKernel = new Kernel({ cwd: tmpdir(), hooks: { rpc: async () => null, onTaskDone() {}, onStoreWrite: (key, value) => writes.push([key, value]) } });
  try {
    const result = await storeKernel.run(`console.log(load("kept")); store("n", { x: 1 }); store("kept", undefined); console.log(load("n").x, load("kept"))`, { timeoutMs: 5000, store: { kept: "old" } });
    assert.equal(out(result.output), "old\n1 undefined\n");
    assert.deepEqual(writes, [["n", { x: 1 }], ["kept", undefined]]);
  } finally {
    storeKernel.kill();
  }
});

test("ALL_TOOLS comes from the host", async () => {
  assert.equal((await run(`console.log(ALL_TOOLS.map((t) => t.name).join())`)).text, "echo\n");
});

test("return works alongside exports", async () => {
  const result = await run(`export const both = 1;\nexport function twice(n: number) { return n * 2 }\nconst hidden = 3;\nexport { hidden as shown };\nreturn "done"`);
  assert.equal(result.status, "ok");
  assert.deepEqual(texts(result.output), ["done"]);
  assert.equal((await run(`console.log(both, twice(2), shown, typeof hidden)`)).text, "1 4 3 undefined\n");
});
