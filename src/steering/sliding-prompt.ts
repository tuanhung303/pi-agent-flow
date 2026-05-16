/**
 * Steering hint utilities.
 *
 * Manages the steering hint tag that is injected before the latest user
 * message each turn. Provides helpers for stripping, detecting, and building
 * the hint so they can be tested independently.
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Tag constants
// ---------------------------------------------------------------------------

const STEERING_HINT_UUID = randomUUID();

export const STEERING_HINT_OPEN_TAG = `<pi-flow-steering-hint id="${STEERING_HINT_UUID}">`;
export const STEERING_HINT_CLOSE_TAG = `</pi-flow-steering-hint id="${STEERING_HINT_UUID}">`;

export const STEERING_HINT =
	`${STEERING_HINT_OPEN_TAG}\n` +
	`You are the orchestrator. You have batch_read, flow, web, and ask_user.\n` +
	`You do NOT have bash or write. Delegate all implementation to flows.\n\n` +
	`- Context: Answer directly if possible; otherwise, investigate first, then delegate.\n` +
	`- Acts: [Route all git, bash, CLI, or terminal tasks to \`build\` flow, For major conflicts or misaligned goals use ask_user, For lengthy plans with many steps use ask_user to confirm main points before proceeding]\n` +
	`- Mindset: Gather context before acting. Investigate, discuss, plan — then delegate.\n` +
	`- Anti-patterns: [Never implement directly, Never ask what you can discover with tools, Never skip investigation]\n` +
	`- Workflow: Scouts must complete 5 steps (Survey → Inspect → Trace → Report → Validate). Reject and resend if Validate is missing. For quick directional signals use sessionMode snap (90s sprint).\n` +
	`- Markers: Preserve exactly ([V] Verified, [I] Inferred, [A] Assumed, [U] Unknown). Never present [A] or [U] as facts to the user. Dispatch a validation scout if critical claims are [A]/[U].\n` +
	`- Output: Zero preamble or filler. Start immediately with the answer or tool call.\n` +
	`Note: Context is inherited automatically for child flow; write intents focusing only on new work.\n` +
	`${STEERING_HINT_CLOSE_TAG}`;

const STEERING_HINT_RE = new RegExp(
	STEERING_HINT_OPEN_TAG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
	"[\\s\\S]*?" +
	STEERING_HINT_CLOSE_TAG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
	"g",
);

/** Legacy regex to strip old bare steering hint tags (no id attribute). */
const LEGACY_STEERING_HINT_RE = /<pi-flow-steering-hint(?:\s[^>]*)?>[\s\S]*?<\/pi-flow-steering-hint(?:\s[^>]*)?>/g;

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

/** Strip any old steering hint tags from a string. */
export function stripSteeringHintText(text: string): string {
	return text.replace(STEERING_HINT_RE, "").replace(LEGACY_STEERING_HINT_RE, "");
}

/** Strip steering hint tags from content (string or text-part array). */
export function stripSteeringHintFromContent(
	content: string | { type: string; text?: string }[],
): string | { type: string; text?: string }[] {
	if (typeof content === "string") {
		return stripSteeringHintText(content);
	}
	return content.map((c) => {
		if (c.type === "text" && typeof c.text === "string") {
			return { ...c, text: stripSteeringHintText(c.text) };
		}
		return c;
	});
}

/** Check whether content (string or text-part array) contains the steering hint tag. */
export function contentContainsSteeringHintTag(content: MessageContent): boolean {
	const hasCurrent = (text: string) => text.includes(STEERING_HINT_OPEN_TAG);
	const hasLegacy = (text: string) => text.includes("<pi-flow-steering-hint>");
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

/** Remove any existing steering-hint system messages and strip tags from user messages.
 *  Returns the sanitized messages and a flag indicating whether anything changed.
 */
export function stripSteeringHintsFromMessages(messages: any[]): { messages: any[]; changed: boolean } {
	let changed = false;
	const result = messages
		.filter((msg) => {
			// Remove dedicated steering hint system messages
			if (msg.role === "system" && contentContainsSteeringHintTag(msg.content)) {
				changed = true;
				return false;
			}
			return true;
		})
		.map((msg) => {
			// Also strip stray tags embedded in user/assistant messages
			if (!("content" in msg)) return msg;
			const stripped = stripSteeringHintFromContent(msg.content);
			if (isJsonEqual(stripped, msg.content)) return msg;
			changed = true;
			return { ...msg, content: stripped };
		});
	return { messages: result, changed };
}

// ---------------------------------------------------------------------------
// Configurable steering
// ---------------------------------------------------------------------------

let steeringConfig = { enabled: true, customPrompt: undefined as string | undefined };

export function configureSteering(config: { enabled: boolean; customPrompt?: string }): void {
	steeringConfig = { enabled: config.enabled, customPrompt: config.customPrompt };
}

/** Build a system message containing the steering hint.
 *  Returns null when steering is disabled so the caller can skip injection.
 */
export function makeSteeringHintMessage(referenceMessage?: any): any | null {
	if (!steeringConfig.enabled) {
		return null;
	}
	const body = steeringConfig.customPrompt ?? STEERING_HINT;
	return {
		role: "system",
		content: body,
		timestamp: referenceMessage?.timestamp,
	};
}
