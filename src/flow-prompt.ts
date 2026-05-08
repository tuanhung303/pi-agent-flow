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
import { SLIDING_PROMPT } from "./sliding-prompt.js";
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
		? ["batch_read", "batch_bash_poll", "flow"]
		: ["read", "write", "edit", "batch", "bash", "flow", "web"];
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the before_agent_start system prompt augmentation.
 *
 * Adds web steering (when tool optimize is off), sliding prompt,
 * and the flow delegation guide with guard info.
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

	// Append sliding prompt to static system prompt unconditionally.
	systemPrompt += "\n\n" + SLIDING_PROMPT;

	if (!canDelegate || discoveredFlows.length === 0) {
		return systemPrompt;
	}

	const flowList = discoveredFlows
		.map((f) => {
			const badge = f.source === "project" ? " 🔒" : f.source === "user" ? " ⚙" : "";
			return `- [${f.name}]${badge} — ${f.description}`;
		})
		.join("\n");

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

Each flow returns:

flow [type] accomplished

[Summary] — what happened and current status
[Done] — completed work with file:line references and verification results
[Not Done] — incomplete items, skipped checks, blockers, and reasons
[Next Steps] — specific recommended follow-up or next flow

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
