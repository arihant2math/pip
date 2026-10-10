import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Resolve renderer/config imports to test doubles without requiring a global Pi install.
const dependencyURL = new URL("./fixtures/pi-dependencies.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent" || specifier === "@earendil-works/pi-tui") {
      return { url: dependencyURL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

let instance = 0;
const source = (name, sourcePath = "/project/subagents/index.ts") => ({
  name, label: name, description: `Tool ${name}`,
  parameters: { type: "object", properties: {}, additionalProperties: false },
  sourceInfo: { path: sourcePath },
});

async function harness(t, provider = "openai-codex", oauth = false, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-alias-test-"));
  const previousAgentDir = process.env.PI_CLAUDE_CODE_USE_TEST_AGENT_DIR;
  process.env.PI_CLAUDE_CODE_USE_TEST_AGENT_DIR = root;
  const savedFlags = new Map();
  for (const flag of ["PI_CLAUDE_CODE_USE_DISABLE_AUTO_ALIAS", "PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER", "PI_CLAUDE_CODE_USE_DEBUG_LOG"]) {
    savedFlags.set(flag, process.env[flag]);
    delete process.env[flag];
  }
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    if (previousAgentDir === undefined) delete process.env.PI_CLAUDE_CODE_USE_TEST_AGENT_DIR;
    else process.env.PI_CLAUDE_CODE_USE_TEST_AGENT_DIR = previousAgentDir;
    for (const [flag, value] of savedFlags) {
      if (value === undefined) delete process.env[flag];
      else process.env[flag] = value;
    }
  });
  const module = extra.module ?? await import(`../extensions/index.ts?test=${++instance}`);
  const registry = new Map((extra.tools ?? [source("read"), source("agent"), source("mcp__foreign__lookup")]).map(tool => [tool.name, tool]));
  let active = extra.active ?? [...registry.keys()];
  let pending = [];
  const handlers = new Map();
  const registrations = [];
  let selectionChanges = 0;
  const excluded = new Set(extra.excluded ?? []);
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    getAllTools() { return [...registry.values()]; },
    getActiveTools() { return [...active]; },
    setActiveTools(names) {
      selectionChanges++;
      pending = [];
      active = [...new Set(names)].filter(name => registry.has(name) && registry.get(name).exposure !== "hidden" && !excluded.has(name));
    },
    registerTool(tool) {
      const isNew = !registry.has(tool.name);
      registry.set(tool.name, tool);
      registrations.push(tool);
      if (tool.exposure === "hidden") active = active.filter(name => name !== tool.name);
      else if ((pending.includes(tool.name) || (isNew && tool.defaultActive !== false)) && !excluded.has(tool.name)) {
        active = [...new Set([...active, tool.name])];
        pending = pending.filter(name => name !== tool.name);
      }
    },
  };
  const auth = { oauth };
  const ctx = {
    cwd: root,
    model: { provider, id: "test-model" },
    modelRegistry: { isUsingOAuth: () => auth.oauth },
  };
  await module.default(pi);
  const emit = async (name, event = {}) => handlers.get(name)?.(event, ctx);
  const owned = () => [...registry.keys()].filter(name => name.startsWith("mcp__") && name !== "mcp__foreign__lookup");
  return {
    module, registry, registrations, pi, ctx, auth, root, emit, owned,
    changes: () => selectionChanges,
    // Mimic a loadout restored from a transcript, including stale owned aliases.
    restore: names => {
      active = names.filter(name => registry.has(name));
      pending = names.filter(name => !registry.has(name));
    },
  };
}

for (const [provider, oauth] of [["openai-codex", false], ["google", false], ["anthropic", false]]) {
  test(`fresh ${provider}, OAuth=${oauth}: no compatibility aliases`, async t => {
    const h = await harness(t, provider, oauth);
    await h.emit("session_start");
    await h.emit("before_agent_start");
    assert.deepEqual(h.pi.getActiveTools(), ["read", "agent", "mcp__foreign__lookup"]);
    assert.equal(h.owned().length, 0);
    const payload = { tools: [{ name: "agent", input_schema: {} }] };
    assert.equal(await h.emit("before_provider_request", { payload }), undefined);
    assert.equal(payload.tools[0].name, "agent");
  });
}

test("OAuth aliases are inactive at registration, model-only, and wire-deduplicated", async t => {
  const h = await harness(t, "anthropic", true);
  await h.emit("session_start");
  const [alias] = h.owned();
  assert.ok(alias);
  assert.ok(h.pi.getActiveTools().includes(alias));
  for (const tool of h.registrations) {
    assert.equal(tool.defaultActive, false);
    assert.equal(tool.exposure, "model-only");
  }
  const schema = { type: "object", properties: {} };
  const transformed = await h.emit("before_provider_request", { payload: {
    tools: [{ name: "agent", input_schema: schema }, { name: alias, input_schema: schema }],
    tool_choice: { type: "tool", name: "agent" },
    messages: [{ role: "assistant", content: [{ type: "tool_use", id: "call", name: "agent", input: {} }] }],
  } });
  assert.deepEqual(transformed.tools.map(tool => tool.name), [alias]);
  assert.equal(transformed.tool_choice.name, alias);
  assert.equal(transformed.messages[0].content[0].name, alias);
});

test("OAuth → Codex → OAuth hides all owned aliases and preserves foreign tools", async t => {
  const h = await harness(t, "anthropic", true);
  await h.emit("session_start");
  const [alias] = h.owned();
  // Provider switch notifications may arrive before ctx.model is updated.
  await h.emit("model_select", { model: { provider: "openai-codex", id: "codex" } });
  assert.equal(h.registry.get(alias).exposure, "hidden");
  assert.deepEqual(h.pi.getActiveTools(), ["read", "agent", "mcp__foreign__lookup"]);
  h.ctx.model = { provider: "openai-codex", id: "codex" };
  h.ctx.model = { provider: "anthropic", id: "claude" };
  await h.emit("model_select", { model: h.ctx.model });
  assert.equal(h.registry.get(alias).exposure, "model-only");
  assert.ok(h.pi.getActiveTools().includes(alias));
});

test("auth changes on the same model remove even explicitly selected aliases", async t => {
  const h = await harness(t, "anthropic", true);
  await h.emit("session_start");
  const [alias] = h.owned();
  h.restore(["read", "mcp__foreign__lookup", alias]);
  h.auth.oauth = false;
  await h.emit("before_agent_start");
  assert.equal(h.registry.get(alias).exposure, "hidden");
  assert.ok(!h.pi.getActiveTools().includes(alias));
  assert.ok(h.pi.getActiveTools().includes("mcp__foreign__lookup"));
  assert.ok(h.pi.getActiveTools().includes("agent"), "explicit alias-only selections normalize to the canonical source");
});

for (const hook of ["session_start", "session_tree", "before_agent_start"]) {
  test(`${hook} cleans restored alias selections off-provider`, async t => {
    const h = await harness(t, "anthropic", true);
    await h.emit("session_start");
    const aliases = h.owned();
    h.ctx.model = { provider: "openai-codex", id: "codex" };
    h.restore(["read", "agent", "mcp__foreign__lookup", ...aliases]);
    await h.emit(hook);
    assert.deepEqual(h.pi.getActiveTools(), ["read", "agent", "mcp__foreign__lookup"]);
    for (const alias of aliases) assert.equal(h.registry.get(alias).exposure, "hidden");
  });
}

test("reconciliation is idempotent, but refreshes changed source schemas", async t => {
  const h = await harness(t, "anthropic", true);
  await h.emit("session_start");
  const [alias] = h.owned();
  const changes = h.changes();
  const registrations = h.registrations.length;
  await h.emit("before_agent_start");
  assert.equal(h.changes(), changes);
  assert.equal(h.registrations.length, registrations);
  const schema = { type: "object", properties: { text: { type: "string" } } };
  h.registry.get("agent").parameters = schema;
  await h.emit("before_agent_start");
  assert.equal(h.registry.get(alias).parameters, schema);
});

test("late request-time registrations are remapped without activating aliases", async t => {
  const h = await harness(t, "anthropic", true);
  await h.emit("session_start");
  h.registry.set("late_tool", source("late_tool", "/project/late/index.ts"));
  const before = h.pi.getActiveTools();
  const result = await h.emit("before_provider_request", { payload: {
    tools: [{ name: "late_tool", input_schema: {} }],
  } });
  assert.match(result.tools[0].name, /^mcp__/);
  assert.deepEqual(h.pi.getActiveTools(), before);
  assert.equal(h.registry.get(result.tools[0].name).defaultActive, false);
});

test("managed calls still canonicalize after leaving OAuth; foreign calls do not", async t => {
  const h = await harness(t, "anthropic", true);
  await h.emit("session_start");
  const [alias] = h.owned();
  h.ctx.model = { provider: "openai-codex", id: "codex" };
  await h.emit("before_agent_start");
  const result = await h.emit("message_end", { message: {
    role: "assistant", content: [
      { type: "toolCall", id: "owned", name: alias, arguments: {} },
      { type: "toolCall", id: "foreign", name: "mcp__foreign__lookup", arguments: {} },
    ],
  } });
  assert.deepEqual(result.message.content.map(call => call.name), ["agent", "mcp__foreign__lookup"]);
});

test("manual alias overrides work with automatic aliasing disabled", async t => {
  const h = await harness(t, "anthropic", true);
  const dir = join(h.root, ".pi", "extensions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pi-claude-code-use.json"), JSON.stringify({ toolAliases: [["agent", "mcp__custom__run"]] }));
  process.env.PI_CLAUDE_CODE_USE_DISABLE_AUTO_ALIAS = "1";
  await h.emit("session_start");
  assert.deepEqual(h.owned(), ["mcp__custom__run"]);
  h.auth.oauth = false;
  await h.emit("before_agent_start");
  assert.equal(h.registry.get("mcp__custom__run").exposure, "hidden");
  assert.ok(!h.pi.getActiveTools().includes("mcp__custom__run"));
});

test("alias-only normalization does not resurrect excluded or hidden sources", async t => {
  const h = await harness(t, "anthropic", true, { excluded: ["agent"] });
  await h.emit("session_start");
  const [alias] = h.owned();
  h.restore(["read", "mcp__foreign__lookup", alias]);
  h.auth.oauth = false;
  await h.emit("before_agent_start");
  assert.deepEqual(h.pi.getActiveTools(), ["read", "mcp__foreign__lookup"]);
  h.auth.oauth = true;
  await h.emit("before_agent_start");
  h.registry.get("agent").exposure = "hidden";
  h.restore(["read", "mcp__foreign__lookup", alias]);
  h.auth.oauth = false;
  await h.emit("before_agent_start");
  assert.deepEqual(h.pi.getActiveTools(), ["read", "mcp__foreign__lookup"]);
});

test("hidden source tools are never given compatibility aliases", async t => {
  const h = await harness(t, "anthropic", true);
  h.registry.get("agent").exposure = "hidden";
  h.restore(["read", "mcp__foreign__lookup"]);
  await h.emit("session_start");
  assert.deepEqual(h.owned(), []);
  assert.deepEqual(h.pi.getActiveTools(), ["read", "mcp__foreign__lookup"]);
});

test("case-changed and obsolete aliases are hidden but keep reverse routes", async t => {
  const h = await harness(t, "anthropic", true);
  const dir = join(h.root, ".pi", "extensions");
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "pi-claude-code-use.json");
  const first = "mcp__custom__run";
  const second = "mcp__CUSTOM__RUN";
  writeFileSync(config, JSON.stringify({ toolAliases: [["agent", first]] }));
  await h.emit("session_start");
  writeFileSync(config, JSON.stringify({ toolAliases: [["agent", second]] }));
  await h.emit("before_agent_start");
  assert.equal(h.registry.get(first).exposure, "hidden");
  assert.equal(h.registry.get(second).exposure, "model-only");
  assert.ok(!h.pi.getActiveTools().includes(first));
  assert.ok(h.pi.getActiveTools().includes(second));
  const message = { role: "assistant", content: [{ type: "toolCall", id: "old", name: first, arguments: {} }] };
  assert.equal((await h.emit("message_end", { message })).message.content[0].name, "agent");
  writeFileSync(config, JSON.stringify({ toolAliases: [] }));
  await h.emit("before_agent_start");
  assert.equal(h.registry.get(second).exposure, "hidden");
  h.auth.oauth = false;
  await h.emit("before_agent_start");
  for (const alias of h.owned()) assert.equal(h.registry.get(alias).exposure, "hidden");
});

test("disabling payload filtering preserves its existing debugging semantics", async t => {
  const h = await harness(t, "anthropic", true);
  await h.emit("session_start");
  process.env.PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER = "1";
  const result = await h.emit("before_provider_request", { payload: {
    system: [{ type: "text", text: "Read pi .md files about pi itself and pi packages.", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "unknown_flat", input_schema: {} }],
  } });
  assert.equal(result.tools[0].name, "unknown_flat");
  assert.equal(result.system[0].text, "Read cli .md files about the cli itself and cli packages.");
  assert.deepEqual(result.system[0].cache_control, { type: "ephemeral" });
});

test("pending alias-only transcript selections survive OAuth registration", async t => {
  const h = await harness(t, "anthropic", true, {
    tools: [source("read"), source("agent"), source("task_tool"), source("mcp__foreign__lookup")],
  });
  h.restore(["read", "agent", "mcp__foreign__lookup", "mcp__subagents__task_tool"]);
  await h.emit("session_start");
  assert.ok(h.pi.getActiveTools().includes("mcp__subagents__task_tool"));
  assert.ok(h.pi.getActiveTools().includes("mcp__subagents__agent"));
  assert.ok(!h.pi.getActiveTools().includes("task_tool"));
});

test("cached extension factories do not carry aliases into a fresh Codex registry", async t => {
  const oauth = await harness(t, "anthropic", true);
  await oauth.emit("session_start");
  const codex = await harness(t, "openai-codex", false, { module: oauth.module });
  await codex.emit("session_start");
  assert.deepEqual(codex.owned(), []);
  assert.deepEqual(codex.pi.getActiveTools(), ["read", "agent", "mcp__foreign__lookup"]);
});

test("cached factories preserve real tools whose names match aliases in another runtime", async t => {
  const oauth = await harness(t, "anthropic", true);
  await oauth.emit("session_start");
  const [alias] = oauth.owned();
  const foreign = source(alias, "/project/real-mcp/index.ts");
  const codex = await harness(t, "openai-codex", false, {
    module: oauth.module,
    tools: [source("read"), source("agent"), foreign],
    active: ["read", alias],
  });
  await codex.emit("session_start");
  assert.equal(codex.registry.get(alias), foreign);
  assert.deepEqual(codex.pi.getActiveTools(), ["read", alias]);
  assert.equal(codex.registrations.length, 0);
});

test("cached factories register aliases independently even with identical schema objects", async t => {
  const tools = [source("read"), source("agent"), source("mcp__foreign__lookup")];
  const first = await harness(t, "anthropic", true, { tools });
  await first.emit("session_start");
  const second = await harness(t, "anthropic", true, { module: first.module, tools });
  await second.emit("session_start");
  const [alias] = first.owned();
  assert.ok(second.registry.has(alias));
  assert.ok(second.pi.getActiveTools().includes(alias));
  first.ctx.model = { provider: "openai-codex", id: "codex" };
  await first.emit("before_agent_start");
  assert.equal(first.registry.get(alias).exposure, "hidden");
  assert.equal(second.registry.get(alias).exposure, "model-only");
  assert.ok(second.pi.getActiveTools().includes(alias));
});
