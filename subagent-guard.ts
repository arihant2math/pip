import {
    isToolCallEventType,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const SUBAGENT_INSTRUCTIONS = `
## Subagents

Subagents are just more Pi instances that you can use for basically anything.If you want to figure out how to use a library, clone it's repo into /tmp and run a subagent there. If you want to use a bunch of smaller Pi instances to do work without wasting your own context, run a subagent in the cwd. etc. Examples of how to spawn pi:

\`\`\`
# just send a prompt to run pi in the pwd and get a response out
pi -p "some prompt"

# read-only tools (useful for the /tmp cloning example)
git clone git@github.com:mixmark-io/turndown /tmp/turndown && cd /tmp/turndown && pi --readonly -p "briefly describe the internals of Turndown and its HTML->Markdown pipeline"
\`\`\`

Prefer only giving the agent read-only tools (no edit,write,bash) unless the task requires them. However, avoid subagents for intelligence-heavy tasks; they are strictly less smart than you.

Always run subagents with a timeout of at least 600 seconds. When running subagents in scripts or outside of your bash tool, set PI_SUBAGENT=1; this is done automatically by your bash tool.
`;

export default function (pi: ExtensionAPI) {
    pi.registerFlag("readonly", {
        description:
            "Disable edit, write, and bash and add grep, find, ls, glob.",
        type: "boolean",
        default: false,
    });

    if (process.env.PI_SUBAGENT === undefined) {
        pi.on("before_agent_start", (event) => ({
            systemPrompt: `${event.systemPrompt}\n\n${SUBAGENT_INSTRUCTIONS}`,
        }));
    }

    pi.on("session_start", () => {
        if (pi.getFlag("readonly")) {
            pi.setActiveTools(
                pi
                    .getActiveTools()
                    .filter((tool) => !["write", "edit", "bash"].includes(tool))
                    .concat(["grep", "find", "ls", "glob"]),
            );
        }
    });

    pi.on("tool_call", (event) => {
        if (!isToolCallEventType("bash", event)) return;

        event.input.command = `export PI_SUBAGENT=1\n${event.input.command}`;
    });
}
