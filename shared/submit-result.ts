/**
 * Loaded only into subagents (via `-e`) whose caller asked for structured output.
 * Registers `submit_result` whose parameters ARE the requested JSON Schema, so pi validates (and
 * coerces) the object before execute() runs. execute() echoes the validated params back in
 * `details.result`; the parent reads them from the `tool_execution_end` event, never from the raw
 * pre-validation tool call arguments.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Tool parameters must be an object schema; anything else is wrapped as { value }. Shared with the parent. */
export function toolParameters(schema: any): { parameters: any; wrapped: boolean } {
	const wrapped = schema?.type === "object";
	return { wrapped, parameters: wrapped ? schema : { type: "object", properties: { value: schema }, required: ["value"] } };
}

export default function (pi: ExtensionAPI) {
	const raw = process.env.PI_RESULT_SCHEMA;
	if (!raw) return;
	const { parameters } = toolParameters(JSON.parse(raw));

	pi.registerTool({
		name: "submit_result",
		label: "Submit result",
		description: "Submit your final result. Call exactly once, as your last action.",
		promptSnippet: "Submit the final structured result",
		promptGuidelines: ["When the task is done, call submit_result with the result. Do not answer in plain text."],
		parameters,
		async execute(_id, params) {
			// `params` has passed pi's schema validation; the parent takes the result from here.
			return { content: [{ type: "text", text: "Submitted." }], details: { result: params }, terminate: true };
		},
	});
}
