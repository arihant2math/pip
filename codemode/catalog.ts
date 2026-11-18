/**
 * What scripts see of the tools: `ALL_TOOLS`, `searchTools()`, `describeTool()`, and `describeNamespace()`,
 * built the way pi's codemode builds them, so the two are interchangeable from a script's point of view.
 */
import type { ExtensionToolContext, ToolNamespace } from "@earendil-works/pi-coding-agent";
import { renderToolSample } from "@earendil-works/pi-codemode/declarations";
import { toCodemodeIdentifier } from "@earendil-works/pi-codemode";
import type { CatalogEntry } from "./protocol.ts";

type AgentTool = ExtensionToolContext["tools"][number];

export const CODEMODE_TOOL_NAME = "codemode";
const DEFAULT_SEARCH_LIMIT = 8;
const TEXT_OUTPUT_SCHEMA = { type: "string" };

export interface ToolInfo {
  guidelines(name: string): readonly string[];
  namespace(name: string): ToolNamespace | undefined;
}

/** Tools a script may call: every callable tool but codemode itself. */
export function callableTools(tools: readonly AgentTool[]): AgentTool[] {
  return tools.filter((tool) => tool.name !== CODEMODE_TOOL_NAME);
}

/** The tool's description, prompt guidelines, and TypeScript declaration, as codemode lists it. */
export function toolSample(tool: AgentTool, guidelines: readonly string[]): string {
  const bullets = guidelines.flatMap((guideline) => (guideline.trim() ? [`- ${guideline.trim()}`] : []));
  return renderToolSample({
    name: tool.name,
    description: bullets.length > 0 ? `${tool.description.trim()}\n\n${bullets.join("\n")}` : tool.description,
    inputSchema: tool.parameters as never,
    outputSchema: (tool.outputSchema ?? TEXT_OUTPUT_SCHEMA) as never,
  });
}

export function findTool(tools: readonly AgentTool[], name: unknown): AgentTool | undefined {
  if (typeof name !== "string") return undefined;
  return tools.find((tool) => tool.name === name) ?? tools.find((tool) => toCodemodeIdentifier(tool.name) === name);
}

function isNamespaceName(namespace: ToolNamespace, query: string): boolean {
  const queryId = toCodemodeIdentifier(query);
  return [namespace.name, ...(namespace.aliases ?? [])].some((name) => name === query || toCodemodeIdentifier(name) === queryId);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1);
}

/** BM25 over each tool's name, namespace, and description, with name and namespace matches weighted up. */
function rank(query: string, documents: { name: string; text: string; namespace: string }[], limit: number): string[] {
  const terms = new Set(tokenize(query));
  if (terms.size === 0) return [];
  const indexed = documents.map((document) => {
    const counts = new Map<string, number>();
    const words = tokenize(document.text);
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    return { name: document.name, counts, length: words.length, nameTerms: new Set(tokenize(document.name)), namespaceTerms: new Set(tokenize(document.namespace)) };
  });
  const average = indexed.reduce((sum, document) => sum + document.length, 0) / indexed.length || 1;
  const idf = new Map(
    [...terms].map((term) => {
      const frequency = indexed.filter((d) => d.counts.has(term) || d.nameTerms.has(term) || d.namespaceTerms.has(term)).length;
      return [term, Math.log(1 + (indexed.length - frequency + 0.5) / (frequency + 0.5))];
    }),
  );
  const exact = toCodemodeIdentifier(query.trim()).toLowerCase();
  return indexed
    .map((document) => {
      const norm = 1.2 * (0.25 + (0.75 * document.length) / average);
      let score = 0;
      let covered = 0;
      for (const term of terms) {
        const count = document.counts.get(term) ?? 0;
        const weight = (document.nameTerms.has(term) ? 3 : 0) + (document.namespaceTerms.has(term) ? 1.5 : 0) + (count * 2.2) / (count + norm);
        if (weight > 0) covered++;
        score += (idf.get(term) ?? 0) * weight;
      }
      const isExact = toCodemodeIdentifier(document.name).toLowerCase() === exact;
      return { name: document.name, score, covered, isExact };
    })
    .filter((match) => match.score > 0 || match.isExact)
    .sort((a, b) => Number(b.isExact) - Number(a.isExact) || b.covered - a.covered || b.score - a.score)
    .slice(0, limit)
    .map((match) => match.name);
}

export class Catalog {
  readonly tools: AgentTool[];
  readonly #info: ToolInfo;
  readonly #samples = new Map<string, string>();

  constructor(tools: readonly AgentTool[], info: ToolInfo) {
    this.tools = callableTools(tools);
    this.#info = info;
  }

  sample(tool: AgentTool): string {
    let sample = this.#samples.get(tool.name);
    if (sample === undefined) {
      sample = toolSample(tool, this.#info.guidelines(tool.name));
      this.#samples.set(tool.name, sample);
    }
    return sample;
  }

  entry(tool: AgentTool): CatalogEntry {
    return { name: toCodemodeIdentifier(tool.name), description: this.sample(tool) };
  }

  /** `ALL_TOOLS`. */
  all(): CatalogEntry[] {
    return this.tools.map((tool) => this.entry(tool));
  }

  search(query: unknown, options: unknown): CatalogEntry[] {
    if (typeof query !== "string") throw new Error("searchTools() expects a query string");
    const { limit = DEFAULT_SEARCH_LIMIT, namespace } = (options ?? {}) as { limit?: unknown; namespace?: unknown };
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) throw new Error("searchTools() limit must be a positive integer");
    if (namespace !== undefined && namespace !== null && typeof namespace !== "string") throw new Error("searchTools() namespace must be a string");
    const documents = this.tools.flatMap((tool) => {
      const toolNamespace = this.#info.namespace(tool.name);
      if (namespace && (!toolNamespace || !isNamespaceName(toolNamespace, namespace))) return [];
      const namespaceText = toolNamespace ? [toolNamespace.name, toolNamespace.description ?? "", toolNamespace.instructions ?? ""].join(" ") : "";
      return [{ name: tool.name, text: `${tool.description} ${JSON.stringify(tool.parameters)}`, namespace: namespaceText }];
    });
    return rank(query, documents, limit).map((name) => this.entry(findTool(this.tools, name)!));
  }

  describeTool(name: unknown): string | undefined {
    if (typeof name !== "string") throw new Error("describeTool() expects a tool name");
    const tool = findTool(this.tools, name);
    return tool && this.sample(tool);
  }

  describeNamespace(name: unknown) {
    if (typeof name !== "string") throw new Error("describeNamespace() expects a namespace name");
    let namespace: ToolNamespace | undefined;
    const tools: string[] = [];
    for (const tool of this.tools) {
      const toolNamespace = this.#info.namespace(tool.name);
      if (!toolNamespace || !isNamespaceName(toolNamespace, name)) continue;
      namespace ??= toolNamespace;
      tools.push(toCodemodeIdentifier(tool.name));
    }
    if (!namespace) return undefined;
    return {
      name: namespace.name,
      ...(namespace.description ? { description: namespace.description } : {}),
      ...(namespace.instructions ? { instructions: namespace.instructions } : {}),
      tools,
    };
  }
}
