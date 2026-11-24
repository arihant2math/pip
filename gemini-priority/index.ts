import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "gemini-priority";
const SETTINGS_KEY = "gemini-priority";
// Priority rates are 1.8x standard for every supported model. pi prices Gemini
// usage at standard rates regardless of the tier that served the request.
const PRIORITY_COST_MULTIPLIER = 1.8;

// https://ai.google.dev/gemini-api/docs/priority-inference#supported-models
const PRIORITY_MODELS = new Set([
	"gemini-4-carbon",
	"gemini-4-argon",
	"gemini-4-neon",
	"gemini-4-hydrogen",
	"gemini-3.8-flash",
	"gemini-3.6-flash",
	"gemini-3.5-flash-lite",
	"gemini-3.1-flash-lite",
	"gemini-3.1-pro-preview",
	"gemini-3-flash-preview",
	"gemini-2.5-pro",
	"gemini-2.5-flash",
	"gemini-2.5-flash-lite",
]);

function isSupported(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "google" && PRIORITY_MODELS.has(ctx.model.id);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function globalSettingsPath(): string {
	return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json");
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
	try {
		return asObject(JSON.parse(await readFile(path, "utf8"))) ?? {};
	} catch (error) {
		if (asObject(error)?.code === "ENOENT") return {};
		throw error;
	}
}

function enabledFromSettings(settings: Record<string, unknown>): boolean | undefined {
	const enabled = asObject(settings[SETTINGS_KEY])?.enabled;
	return typeof enabled === "boolean" ? enabled : undefined;
}

async function loadEnabled(cwd: string): Promise<boolean> {
	const project = enabledFromSettings(await readSettings(join(cwd, ".pi", "settings.json")));
	return project ?? enabledFromSettings(await readSettings(globalSettingsPath())) ?? false;
}

async function persistEnabled(enabled: boolean): Promise<void> {
	const path = globalSettingsPath();
	const settings = await readSettings(path);
	settings[SETTINGS_KEY] = { ...asObject(settings[SETTINGS_KEY]), enabled };
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
}

export default function geminiPriority(pi: ExtensionAPI): void {
	let enabled = false;
	// Tier that served the last request. Priority traffic over the limit is
	// silently downgraded to standard.
	let servedTier: string | undefined;
	// Whether the in-flight request was served (and billed) at priority.
	let billedPriority = false;
	let writes: Promise<void> = Promise.resolve();

	function warn(ctx: ExtensionContext, message: string): void {
		if (ctx.hasUI) ctx.ui.notify(`gemini-priority: ${message}`, "warning");
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!enabled || !isSupported(ctx)) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const downgraded = servedTier !== undefined && servedTier !== "priority";
		const label = downgraded ? `Priority (${servedTier})` : "Priority";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(downgraded ? "warning" : "accent", label));
	}

	pi.registerFlag("gemini-priority", {
		description: "Start with Gemini priority inference enabled",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("no-gemini-priority", {
		description: "Start with Gemini priority inference disabled",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("gemini-priority", {
		description: "Toggle Gemini priority inference",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			servedTier = undefined;
			writes = writes.catch(() => undefined).then(() => persistEnabled(enabled));
			writes.catch((error) => warn(ctx, `failed to write settings: ${error instanceof Error ? error.message : error}`));
			updateStatus(ctx);
			if (!ctx.hasUI) return;
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no active model";
			const state = !enabled ? "disabled" : isSupported(ctx) ? `enabled (${model})` : `enabled but inactive (${model})`;
			ctx.ui.notify(`Gemini priority ${state}.`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			enabled = await loadEnabled(ctx.cwd);
		} catch (error) {
			warn(ctx, `failed to load settings: ${error instanceof Error ? error.message : error}`);
		}
		if (pi.getFlag("gemini-priority") === true) enabled = true;
		if (pi.getFlag("no-gemini-priority") === true) enabled = false;
		updateStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		servedTier = undefined;
		updateStatus(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !isSupported(ctx)) return;
		const payload = asObject(event.payload);
		if (!payload) return;
		billedPriority = false;
		return { ...payload, config: { ...asObject(payload.config), serviceTier: "priority" } };
	});

	// Streaming responses omit the `x-gemini-service-tier` header; the tier is
	// only reported in the final chunk's usage metadata.
	pi.on("provider_stream_event", (event, ctx) => {
		if (!enabled || !isSupported(ctx)) return;
		const tier = asObject(asObject(event.data)?.usageMetadata)?.serviceTier;
		if (typeof tier !== "string") return;
		billedPriority = tier === "priority";
		if (tier === servedTier) return;
		servedTier = tier;
		updateStatus(ctx);
	});

	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant" || !billedPriority) return;
		billedPriority = false;
		const cost = message.usage.cost;
		const input = cost.input * PRIORITY_COST_MULTIPLIER;
		const output = cost.output * PRIORITY_COST_MULTIPLIER;
		const cacheRead = cost.cacheRead * PRIORITY_COST_MULTIPLIER;
		const cacheWrite = cost.cacheWrite * PRIORITY_COST_MULTIPLIER;
		const total = input + output + cacheRead + cacheWrite;
		return { message: { ...message, usage: { ...message.usage, cost: { ...cost, input, output, cacheRead, cacheWrite, total } } } };
	});
}
