export const meta = {
	name: "review",
	description: "Adversarially verified code review. args: free text saying what to review, or { task, cwd }.",
};

// args: "text" | { task?: string, cwd?: string }. cwd is the repo to review (default: session cwd).
const a = typeof args === "string" ? { task: args } : (args ?? {});
const task = typeof a.task === "string" && a.task.trim() ? a.task : "the uncommitted changes in this repo";
const cwd = typeof a.cwd === "string" && a.cwd ? a.cwd : undefined;
const where = cwd ? `\n\nRepository: ${cwd} (all paths are relative to it).` : "";
const READ_ONLY = ["read", "grep", "find", "ls", "bash"];

phase("scope");
const scope = await agent(
	`Identify the source files that must be reviewed for this request:\n\n${task}${where}\n\n` +
		`Use git and the file tools. Return at most 60 repo-relative paths, most important first.`,
	{ label: "scope", cwd, tools: READ_ONLY, schema: { type: "object", properties: { files: { type: "array", items: { type: "string" } } }, required: ["files"] } },
);
const files = scope?.files ?? [];
if (!files.length) return "No files to review.";
log(`${files.length} files`);

// Small batches keep each reviewer's context clean.
const batches = [];
for (let i = 0; i < files.length; i += 4) batches.push(files.slice(i, i + 4));

const FINDINGS = {
	type: "object",
	properties: {
		findings: {
			type: "array",
			items: {
				type: "object",
				properties: {
					file: { type: "string" },
					line: { type: "number" },
					severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
					title: { type: "string" },
					evidence: { type: "string", description: "Why this is a real problem, with the relevant code" },
				},
				required: ["file", "severity", "title", "evidence"],
			},
		},
	},
	required: ["findings"],
};
const VERDICT = {
	type: "object",
	properties: { real: { type: "boolean" }, reason: { type: "string" } },
	required: ["real", "reason"],
};

phase("review + verify");
// pipeline: each batch's findings get verified as soon as that batch is reviewed.
const verified = await pipeline(
	batches,
	(batch) =>
		agent(
			`Review these files for: ${task}${where}\n\nFiles:\n${batch.join("\n")}\n\n` +
				`Report only concrete, actionable problems you can point to in the code. No style nits. An empty list is fine.`,
			{ label: `review ${batch[0]}${batch.length > 1 ? ` +${batch.length - 1}` : ""}`, cwd, tools: READ_ONLY, schema: FINDINGS },
		),
	(res) =>
		parallel(
			(res.findings ?? []).map(async (f) => {
				const v = await agent(
					`A reviewer claims this problem exists. Try hard to refute it by reading the code and its callers.\n\n` +
						`${JSON.stringify(f, null, 2)}${where}\n\nreal=true only if the problem survives your scrutiny.`,
					{ label: `verify ${f.file}: ${f.title}`.slice(0, 60), cwd, tools: READ_ONLY, schema: VERDICT },
				);
				return v?.real ? { ...f, why: v.reason } : null;
			}),
		),
);

const order = { critical: 0, high: 1, medium: 2, low: 3 };
const out = verified.flat().filter(Boolean).sort((a, b) => order[a.severity] - order[b.severity]);
log(`${out.length} verified findings`);
return out.length ? out : "No verified findings.";
