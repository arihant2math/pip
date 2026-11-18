/** Lays out script output the way pi's codemode does, so results read the same. */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Image, OutputItem } from "./kernel.ts";

export type ContentItem = { type: "text"; text: string } | Image;

export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const CHARS_PER_TOKEN = 4;
const OUTPUT_DIR = join(tmpdir(), "pi-codemode");
const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };

function outputFile(extension: string, data: string | Buffer): string {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const path = join(OUTPUT_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${extension}`);
  writeFileSync(path, data);
  return path;
}

/**
 * With more than one text item (`text()` or the returned value), each starts with a `==> text N/M <==` line.
 * Console output follows everything else in one `<console_output>` block.
 */
export function layoutOutput(output: OutputItem[]): ContentItem[] {
  const total = output.filter((item) => item.type === "text" && item.kind === "text").length;
  const items: ContentItem[] = [];
  let consoleText = "";
  let index = 0;
  for (const item of output) {
    if (item.type === "image") items.push(item);
    else if (item.kind === "console") consoleText += item.text;
    else {
      index++;
      items.push({ type: "text", text: total > 1 ? `==> text ${index}/${total} <==\n${item.text}` : item.text });
    }
  }
  consoleText = consoleText.replace(/\n$/, "");
  if (consoleText) items.push({ type: "text", text: `<console_output>\n${consoleText}\n</console_output>` });
  return items;
}

/** Join adjacent text items, each part on its own line. */
export function joinText(items: ContentItem[]): ContentItem[] {
  const joined: ContentItem[] = [];
  for (const item of items) {
    const last = joined.at(-1);
    if (item.type === "text" && last?.type === "text") last.text += (last.text === "" || last.text.endsWith("\n") ? "" : "\n") + item.text;
    else joined.push(item.type === "text" ? { ...item } : item);
  }
  return joined;
}

/**
 * Over the token budget, the text becomes one item keeping its start and end, followed by the images, and the
 * full text goes to a temp file.
 */
export function truncateOutput(items: ContentItem[], maxTokens: number): { items: ContentItem[]; fullOutputPath?: string } {
  const combined = items.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
  const budget = maxTokens * CHARS_PER_TOKEN;
  if (combined.length <= budget) return { items };
  const head = combined.slice(0, Math.floor(budget / 2));
  const tail = combined.slice(combined.length - (budget - head.length));
  const removed = combined.length - head.length - tail.length;
  let text = `Warning: truncated output (original token count: ${Math.ceil(combined.length / CHARS_PER_TOKEN)})\nTotal output lines: ${combined.split("\n").length}\n\n${head}…${Math.ceil(removed / CHARS_PER_TOKEN)} tokens truncated…${tail}`;
  let fullOutputPath: string | undefined;
  try {
    fullOutputPath = outputFile(".txt", combined);
    text += `\n\n[Full output: ${fullOutputPath} (read with offset/limit)]`;
  } catch (error) {
    text += `\n\n[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
  }
  return { items: [{ type: "text", text }, ...items.filter((item) => item.type === "image")], ...(fullOutputPath ? { fullOutputPath } : {}) };
}

/** Put a label with a temp file path before each image, so later turns can reach its bytes. */
export function saveImages(items: ContentItem[]): ContentItem[] {
  const labels = new Map<string, string>();
  return items.flatMap((item) => {
    if (item.type !== "image") return [item];
    let label = labels.get(item.data);
    if (label === undefined) {
      const bytes = Buffer.from(item.data, "base64");
      const kind = `${item.mimeType}, ${bytes.length < 1024 ? `${bytes.length}B` : `${(bytes.length / 1024).toFixed(1)}KB`}`;
      try {
        label = `[Image saved to ${outputFile(IMAGE_EXTENSIONS[item.mimeType] ?? ".bin", bytes)} (${kind})]`;
      } catch (error) {
        label = `[Image (${kind}) could not be saved: ${error instanceof Error ? error.message : String(error)}]`;
      }
      labels.set(item.data, label);
    }
    return [{ type: "text" as const, text: label }, item];
  });
}

/** Lay out, truncate, and label: the whole pipeline from script output to tool result content. */
export function finishOutput(items: ContentItem[], maxTokens: number): { items: ContentItem[]; fullOutputPath?: string } {
  const truncated = truncateOutput(joinText(items), maxTokens);
  return { ...truncated, items: joinText(saveImages(truncated.items)) };
}
