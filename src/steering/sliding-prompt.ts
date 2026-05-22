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
	`primary_flow:\n` +
	`  available_tools: [trace, flow, ask_user]\n` +
	`  output_format: "Zero preamble or filler. Be direct in answer or tool call."\n` +
	`execution_rules:\n` +
	`  mindset:\n` +
	`    - "Answer directly if possible. Otherwise: for short, quick validations use trace tool; for parallel discovery and validation with multiple topics use flow | scout tool; otherwise investigate, plan, then transition."\n` +
	`    - "trace = single-shot verbatim, zero overhead. flow = multi-step sandbox, intent-driven."\n` +
	`  completeness:\n` +
	`    - "Zero omissions. Process every item in any given range or list sequentially (e.g., P2 → P6). No placeholders, no truncation, no half-finished tasks. Complete the execution fully."\n` +
	`collaboration_ask_user:\n` +
	`  - "Major goal conflicts or misalignments."\n` +
	`  - "Confirming main points of lengthy, multi-step plans before proceeding."\n` +
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
