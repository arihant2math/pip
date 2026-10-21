/** Test-only extension: a scripted "faux/echo" model so pi-live can be tested without an API key. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
	const core = createFauxCore({
		api: "pi-live-faux",
		provider: "faux",
		models: [{ id: "echo", name: "Echo" }],
		tokensPerSecond: 200,
	});
	const lastUser = (ctx: any): string => {
		const msgs = ctx.messages as any[];
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i];
			if (m.role === "user") return typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text ?? "").join("");
			if (m.role === "toolResult") return "";
		}
		return "";
	};
	const respond = (context: any) => {
		const text = lastUser(context);
		if (text.includes("run tool")) return fauxAssistantMessage([fauxText("Running a tool."), fauxToolCall("bash", { command: "echo tool-output-42" })], { stopReason: "toolUse" });
		if (text.includes("slow")) return fauxAssistantMessage("slow ".repeat(400));
		if (!text) return fauxAssistantMessage("Tool finished.");
		return fauxAssistantMessage(`echo: ${text}`);
	};
	core.setResponses(Array.from({ length: 200 }, () => respond));
	pi.registerProvider("faux", {
		baseUrl: "http://localhost",
		apiKey: "x",
		api: "pi-live-faux" as any,
		streamSimple: core.streamSimple as any,
		models: [{ id: "echo", name: "Echo", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
	});
}
