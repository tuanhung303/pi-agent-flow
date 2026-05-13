/**
 * Flow prompt construction for the before_agent_start handler.
 *
 * Extracted from index.ts for single-responsibility and testability.
 */

import type { FlowConfig } from "./agents.js";
import {
	looksLikeUrlPrompt,
	looksLikeWebSearchPrompt,
} from "./web-tool.js";
import type { FlowDepthConfig } from "./depth.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BeforeAgentStartEvent {
	prompt: string;
	systemPrompt: string;
}

// ---------------------------------------------------------------------------
// Active tools helper
// ---------------------------------------------------------------------------

export function computeActiveTools(optimize: boolean): string[] {
	return optimize
		? ["batch_read", "flow", "web", "ask_user"]
		: ["read", "write", "edit", "batch", "bash", "flow", "web", "ask_user"];
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the before_agent_start system prompt augmentation.
 *
 * Adds web steering (when tool optimize is off) and the flow delegation
 * guide with guard info. The steering hint is NOT included here — it
 * is injected dynamically by the context hook in index.ts.
 *
 * Returns the augmented systemPrompt, or undefined if the child flow
 * should skip this handler.
 */
export function buildBeforeAgentStartPrompt(
	event: BeforeAgentStartEvent,
	toolOptimize: boolean,
	canDelegate: boolean,
	discoveredFlows: FlowConfig[],
	depthConfig: FlowDepthConfig,
): string | undefined {
	const { currentDepth, maxDepth, ancestorFlowStack, preventCycles } = depthConfig;

	const prompt = event.prompt;
	const hasUrl = looksLikeUrlPrompt(prompt);
	const likelyNeedsWeb = looksLikeWebSearchPrompt(prompt);

	const webInstructions: string[] = [];
	if (hasUrl) {
		webInstructions.push(
			"The prompt includes a URL. Use web tool with op: { o: 'fetch', u: '<url>' } before answering about that page.",
		);
	}
	if (likelyNeedsWeb) {
		webInstructions.push(
			"The prompt likely needs external or current info. Prefer web tool with op: [{ o: 'search', q: '<query>' }] over memory.",
		);
	}

	let systemPrompt = event.systemPrompt;
	if (!toolOptimize && webInstructions.length > 0) {
		systemPrompt +=
			"\n\n## pi-web steering\n" +
			webInstructions.map((line) => `- ${line}`).join("\n");
	}

	if (!canDelegate || discoveredFlows.length === 0) {
		return systemPrompt;
	}

	const flowList = discoveredFlows
		.map((f) => {
			const badge = f.source === "project" ? " 🔒" : f.source === "user" ? " ⚙" : "";
			return `- [${f.name}]${badge} — ${f.description}`;
		})
		.join("\n");

	// Orchestrator gets the full guide; child flows get a minimal version
	if (currentDepth > 0) {
		return (
			systemPrompt +
			`\n\n## Flows\n${flowList}\n\n` +
			`Guards: depth ${currentDepth}/${maxDepth} | cycles: ${preventCycles ? "blocked" : "off"} | stack: ${ancestorFlowStack.length > 0 ? ancestorFlowStack.join(" -> ") : "(root)"}`
		);
	}

	return (
		systemPrompt +
		`\n\n## Flows

Before acting, reason about whether to dive into a flow:

${flowList}

Multiple independent flows? Batch them into one call:

✅ { "flow": [{ "type": "scout", "intent": "..." }, { "type": "audit", "intent": "..." }] }
❌ Two separate calls — wastes time

Each call renders as:

• flow [scout] — Map the full directory structure...
• flow [audit] — Audit security and quality, then fix safe issues...

Each flow returns a structured result:

flow [type] accomplished

summary — what happened and current status
files — files touched, read, or referenced
actions — what was done, with results and evidence
commands — commands or tool calls executed (auto-extracted from tool history)
notDone — incomplete items, skipped checks, blockers, and reasons
nextSteps — specific recommended follow-up or next flow
reasoning — key hypotheses or inferences made during the flow
notes — observations, warnings, caveats

### Guards
- Depth: ${currentDepth}/${maxDepth} | Cycles: ${preventCycles ? "blocked" : "off"} | Stack: ${ancestorFlowStack.length > 0 ? ancestorFlowStack.join(" -> ") : "(root)"}

### Shared Context
Child flows fork your session automatically:

- They receive a sanitized snapshot of your conversation — files read, commands run, prior flow results.
- Prior flow tool results are **compressed** into compact summaries (files touched, commands used, status).
- Write 'intent' as a **forward-looking mission** — reference what the child already sees, don't re-describe it.
- Set inheritContext: false in a custom flow's front-matter to start with a **clean slate** (no inherited context).
`
	);
}
