/**
 * Sliding system prompt utilities.
 *
 * Manages the sliding prompt tag that is injected before the latest user
 * message each turn. Provides helpers for stripping, detecting, and building
 * the prompt so they can be tested independently.
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Tag constants
// ---------------------------------------------------------------------------

const SLIDING_PROMPT_UUID = randomUUID();

export const SLIDING_PROMPT_OPEN_TAG = `<pi-flow-sliding-system id="${SLIDING_PROMPT_UUID}">`;
export const SLIDING_PROMPT_CLOSE_TAG = `</pi-flow-sliding-system id="${SLIDING_PROMPT_UUID}">`;

// ---------------------------------------------------------------------------
// Mode state — toggled by /spec command
// ---------------------------------------------------------------------------

let _specModeActive = true;

/** Query whether spec-driven planning mode is active. */
export function isSpecModeActive(): boolean {
	return _specModeActive;
}

/** Set spec-driven planning mode on/off. */
export function setSpecModeActive(active: boolean): void {
	_specModeActive = active;
}

export const SLIDING_PROMPT =
	`${SLIDING_PROMPT_OPEN_TAG}\n` +
	`You are in spec-driven planning mode.\n\n` +
	`Your goal: Investigate the codebase, discuss with the user, and produce a structured spec file.\n\n` +
	`IMPORTANT: You are the orchestrator. You have batch_read, flow, web, and ask_user.\n` +
	`You do NOT have bash or write. Delegate bash/write operations to flows.\n\n` +
	`## Phase 1: Investigate\n\n` +
	`### Direct (batch_read):\n` +
	`- Read package.json, tsconfig, existing source files\n` +
	`- Read test files, config files, documentation\n` +
	`- Identify patterns, conventions, architecture\n\n` +
	`### Delegated (flow [scout]):\n` +
	`- flow [scout] intent: "Check git status, current branch, recent commits, test setup, CI config. Report findings."\n\n` +
	`### Build a mental map:\n` +
	`- Tech stack, patterns, test coverage, constraints\n` +
	`- What exists vs what needs to be built\n\n` +
	`## Phase 2: Discuss (2-3 questions via ask_user)\n\n` +
	`Ask 2-3 targeted questions grounded in Phase 1 findings.\n\n` +
	`### Question styles (use ALL three):\n` +
	`1. **Challenge assumptions** — "You asked for X, but codebase has Y. Extend Y or build X?"\n` +
	`2. **Present trade-offs** — "Approach A [fast] vs B [extensible]. Which fits?"\n` +
	`3. **Gap-filling** — "Do you need offline support? Expected scale?"\n\n` +
	`### Rules:\n` +
	`- NEVER ask what you can discover with tools\n` +
	`- Mark recommended option with [preferred], place it first\n` +
	`- 2-4 options per question with clear trade-off descriptions\n` +
	`- Questions must be codebase-specific, not generic\n` +
	`## Phase 3: Write Spec (delegate to build flow)\n\n` +
	`flow [build] intent:\n` +
	`"Write the following spec to .specs/{slug}/spec.md. Create directory if needed.\n\n` +
	`Spec content:\n` +
	`{complete spec}"\n\n` +
	`### Spec template:\n` +
	`- Investigation Findings (current state + evidence)\n` +
	`- User Alignment (Q&A record with impact)\n` +
	`- Technical Context (stack, deps, testing)\n` +
	`- Design Decisions (decision/choice/rationale table)\n` +
	`- Implementation Plan (phased)\n` +
	`- Risks & Mitigations\n` +
	`- Assumptions\n\n` +
	`## Phase 4: Report\n\n` +
	`After build flow confirms write, tell user:\n` +
	`"Spec written to .specs/{slug}/spec.md"\n\n` +
	`## Anti-patterns:\n` +
	`- ❌ Asking without investigating first\n` +
	`- ❌ Skipping investigation\n` +
	`- ❌ Asking about discoverable facts\n` +
	`- ❌ Not marking [preferred]\n` +
	`- ❌ Writing spec without Q&A record\n` +
	`- ❌ Using bash/write directly (delegate to flows)\n` +
	`${SLIDING_PROMPT_CLOSE_TAG}`;

export const IMPLEMENT_PROMPT =
	`${SLIDING_PROMPT_OPEN_TAG}\n` +
	`You are the orchestrator. You have batch_read, flow, web, and ask_user.\n` +
	`You do NOT have bash or write. Delegate all implementation to flows.\n\n` +
	`- Context: Answer directly if possible; otherwise, investigate first, then delegate.\n` +
	`- Acts: [Route all git, bash, CLI, or terminal tasks to \`build\` flow, For major conflicts or misaligned goals use ask_user, For lengthy plans with many steps use ask_user to confirm main points before proceeding]\n` +
	`- Mindset: Gather context before acting. Investigate, discuss, plan — then delegate.\n` +
	`- Spec: If a spec exists in \`.specs/\`, read it first and use it to guide implementation.\n` +
	`- Anti-patterns: [Never implement directly, Never ask what you can discover with tools, Never skip investigation]\n` +
	`Note: Context is inherited automatically for child flow; write intents focusing only on new work.\n` +
	`${SLIDING_PROMPT_CLOSE_TAG}`;

const SLIDING_PROMPT_RE = new RegExp(
	SLIDING_PROMPT_OPEN_TAG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
	"[\\s\\S]*?" +
	SLIDING_PROMPT_CLOSE_TAG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
	"g",
);

/** Legacy regex to strip old bare sliding system prompt tags (no id attribute). */
const LEGACY_SLIDING_PROMPT_RE = /<pi-flow-sliding-system(?:\s[^>]*)?>[\s\S]*?<\/pi-flow-sliding-system(?:\s[^>]*)?>/g;

// ---------------------------------------------------------------------------
// Content types
// ---------------------------------------------------------------------------

/** Input-message content types (string or multipart text-part array). */
type MessageContent = string | Array<{ type: string; text?: string }>;

/** Type guard: is this a text-part with a string .text? */
function isTextPart(part: unknown): part is { type: "text"; text: string } {
	return (
		part != null &&
		typeof part === "object" &&
		"type" in part &&
		part.type === "text" &&
		"text" in part &&
		typeof (part as { text?: unknown }).text === "string"
	);
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Strip any old sliding system prompt tags from a string. */
export function stripSlidingPromptText(text: string): string {
	return text.replace(SLIDING_PROMPT_RE, "").replace(LEGACY_SLIDING_PROMPT_RE, "");
}

/** Strip sliding prompt tags from content (string or text-part array). */
export function stripSlidingPromptFromContent(
	content: string | { type: string; text?: string }[],
): string | { type: string; text?: string }[] {
	if (typeof content === "string") {
		return stripSlidingPromptText(content);
	}
	return content.map((c) => {
		if (c.type === "text" && typeof c.text === "string") {
			return { ...c, text: stripSlidingPromptText(c.text) };
		}
		return c;
	});
}

/** Check whether content (string or text-part array) contains the sliding tag. */
export function contentContainsSlidingTag(content: MessageContent): boolean {
	const hasCurrent = (text: string) => text.includes(SLIDING_PROMPT_OPEN_TAG);
	const hasLegacy = (text: string) => text.includes("<pi-flow-sliding-system>");
	const check = (text: string) => hasCurrent(text) || hasLegacy(text);
	if (typeof content === "string") {
		return check(content);
	}
	if (Array.isArray(content)) {
		return content.some((part) => isTextPart(part) && check(part.text));
	}
	return false;
}

/** Deep-equality check that handles unordered object keys (unlike JSON.stringify). */
export function isJsonEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;

	const keysA = Object.keys(a as Record<string, unknown>);
	const keysB = Object.keys(b as Record<string, unknown>);
	if (keysA.length !== keysB.length) return false;

	for (const key of keysA) {
		if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
		if (!isJsonEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
	}
	return true;
}

/** Remove any existing sliding-system-prompt system messages and strip tags from user messages.
 *  Returns the sanitized messages and a flag indicating whether anything changed.
 */
export function stripSlidingPromptsFromMessages(messages: any[]): { messages: any[]; changed: boolean } {
	let changed = false;
	const result = messages
		.filter((msg) => {
			// Remove dedicated sliding system prompt messages
			if (msg.role === "system" && contentContainsSlidingTag(msg.content)) {
				changed = true;
				return false;
			}
			return true;
		})
		.map((msg) => {
			// Also strip stray tags embedded in user/assistant messages
			if (!("content" in msg)) return msg;
			const stripped = stripSlidingPromptFromContent(msg.content);
			if (isJsonEqual(stripped, msg.content)) return msg;
			changed = true;
			return { ...msg, content: stripped };
		});
	return { messages: result, changed };
}

/** Build a system message containing the sliding prompt. */
export function makeSlidingPromptMessage(referenceMessage?: any): any {
	return {
		role: "system",
		content: _specModeActive ? SLIDING_PROMPT : IMPLEMENT_PROMPT,
		timestamp: referenceMessage?.timestamp,
	};
}
