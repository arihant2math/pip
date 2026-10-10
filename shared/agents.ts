/**
 * Subagent definitions: Markdown files with YAML frontmatter, like Claude Code's.
 *
 *   ---
 *   name: code-reviewer              (required)
 *   description: When to use it      (required; shown to the model)
 *   tools: read, grep, find, bash    (optional allowlist; omitted = inherit the default tools)
 *   disallowedTools: write, edit     (optional denylist)
 *   model: anthropic/claude-sonnet-5 (optional; "inherit" or omitted = the session's model)
 *   thinking: low                    (optional)
 *   background: true                 (optional; always run in the background)
 *   isolation: worktree              (optional; run in a temporary git worktree)
 *   ---
 *   System prompt (appended to pi's own system prompt, so AGENTS.md etc. still load).
 *
 * Lookup, lowest to highest precedence:
 *   bundled (subagents/agents/) < ~/.claude/agents < ~/.pi/agent/agents
 *   < project .claude/agents < project .pi/agents (walking up from cwd; nearest wins; trusted projects only)
 * Claude Code tool names in `tools` (Read, Grep, Glob, Bash, ...) are mapped to pi's.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BUNDLED_AGENTS_DIR = path.join(HERE, "..", "subagents", "agents");

export type AgentSource = "bundled" | "user" | "project";

export interface AgentDefinition {
	name: string;
	description: string;
	prompt: string;
	tools?: string[];
	disallowedTools?: string[];
	model?: string;
	thinking?: string;
	background?: boolean;
	isolation?: "worktree";
	source: AgentSource;
	filePath: string;
}

const CLAUDE_TOOLS: Record<string, string | null> = {
	read: "read",
	write: "write",
	edit: "edit",
	multiedit: "edit",
	notebookedit: "edit",
	bash: "bash",
	grep: "grep",
	glob: "find",
	ls: "ls",
	webfetch: "fetch_content",
	websearch: "web_search",
	task: "agent",
	agent: "agent",
	todowrite: null,
	taskoutput: "task_output",
	taskstop: "task_stop",
	killshell: "task_stop",
	bashoutput: "task_output",
};

function toolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : undefined;
	if (!raw) return undefined;
	const out = new Set<string>();
	for (const r of raw) {
		if (typeof r !== "string") continue;
		const name = r.trim().replace(/\(.*\)$/, ""); // Agent(worker) -> Agent
		if (!name) continue;
		const mapped = CLAUDE_TOOLS[name.toLowerCase()];
		if (mapped === null) continue;
		out.add(mapped ?? name);
	}
	return [...out];
}

function walk(dir: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) files.push(...walk(p));
		else if (e.name.endsWith(".md") && (e.isFile() || e.isSymbolicLink())) files.push(p);
	}
	return files.sort();
}

function load(dir: string, source: AgentSource): AgentDefinition[] {
	const out: AgentDefinition[] = [];
	for (const filePath of walk(dir)) {
		try {
			const { frontmatter: fm, body } = parseFrontmatter<Record<string, unknown>>(fs.readFileSync(filePath, "utf8"));
			if (typeof fm.name !== "string" || typeof fm.description !== "string") continue;
			if (!/^[\w.-]{1,64}$/.test(fm.name)) continue;
			const model = typeof fm.model === "string" && fm.model !== "inherit" ? fm.model : undefined;
			out.push({
				name: fm.name,
				description: fm.description.trim(),
				prompt: body.trim(),
				tools: toolList(fm.tools),
				disallowedTools: toolList(fm.disallowedTools ?? fm.disallowed_tools),
				model,
				thinking: typeof fm.thinking === "string" ? fm.thinking : typeof fm.effort === "string" ? fm.effort : undefined,
				background: fm.background === true,
				isolation: fm.isolation === "worktree" ? "worktree" : undefined,
				source,
				filePath,
			});
		} catch {
			// one bad file must not hide the others
		}
	}
	return out;
}

function projectDirs(cwd: string): string[] {
	const dirs: string[] = [];
	let dir = path.resolve(cwd);
	const home = os.homedir();
	while (true) {
		if (dir !== home) {
			for (const sub of [".claude", ".pi"]) {
				const d = path.join(dir, sub, "agents");
				if (fs.existsSync(d)) dirs.push(d);
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dirs.reverse(); // farthest first, so the nearest directory wins
}

export function discoverAgents(cwd: string, projectTrusted: boolean): AgentDefinition[] {
	const byName = new Map<string, AgentDefinition>();
	const add = (defs: AgentDefinition[]) => {
		for (const d of defs) byName.set(d.name.toLowerCase(), d);
	};
	add(load(BUNDLED_AGENTS_DIR, "bundled"));
	add(load(path.join(os.homedir(), ".claude", "agents"), "user"));
	add(load(path.join(getAgentDir(), "agents"), "user"));
	if (projectTrusted) for (const d of projectDirs(cwd)) add(load(d, "project"));
	return [...byName.values()];
}

export function findAgent(name: string | undefined, cwd: string, projectTrusted: boolean): AgentDefinition | undefined {
	const want = (name ?? "general-purpose").trim().toLowerCase();
	return discoverAgents(cwd, projectTrusted).find((d) => d.name.toLowerCase() === want);
}

/** Model-facing list of agent types, one per line. */
export function describeAgents(defs: AgentDefinition[]): string {
	return defs
		.map((d) => {
			const tools = d.tools ? ` (tools: ${d.tools.join(", ")})` : "";
			return `- ${d.name}: ${d.description.replace(/\s+/g, " ")}${tools}`;
		})
		.join("\n");
}
