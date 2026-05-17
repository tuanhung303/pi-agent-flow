/**
 * Shared tool-result utilities.
 *
 * Provides helpers for appending text to tool results and injecting
 * adaptive directive hints after each tool call.
 */

import { isJsonEqual } from "./sliding-prompt.js";

/**
 * Append text to the first text content item in a tool result,
 * or push a new text item if none exists.
 */
export function appendTextToToolResult(result: any, text: string): void {
	const textItem = result?.content?.find?.((c: any) => c.type === "text");
	if (textItem && typeof textItem.text === "string") {
		textItem.text += text;
	} else if (Array.isArray(result?.content)) {
		result.content.push({ type: "text", text: text.trim() });
	}
}

let directiveEnabled = true;

export function configureDirective(enabled: boolean): void {
	directiveEnabled = enabled;
}

// Initialize from env vars (legacy + new) — overrides default true
if (
	typeof process !== "undefined" &&
	typeof process.env !== "undefined" &&
	(process.env.PI_FLOW_NO_STRATEGIC_HINT === "1" || process.env.PI_FLOW_NO_DIRECTIVE === "1")
) {
	directiveEnabled = false;
}

export const DEFAULT_DIRECTIVE =
	"\n\n[Directive: Close what you start. Dispatch a [build] or [scout] flow to verify before advancing.]";

export const NOTDONE_DIRECTIVE =
	"\n\n[Directive: Unfinished work detected. Dispatch a [build] or [debug] flow to close the notDone items. Do not start new work until these are resolved.]";

export const VAGUE_DIRECTIVE =
	"\n\n[Directive: Dispatch the same [build] or [scout] flow to verify uncertainty.]";

const DIRECTIVE_RE = /\n\n\[Directive: [^\n]*\]/g;
const LEGACY_HINT_RE = /\n\n\[Hint: [\s\S]*?\]/g;

export interface FlowHintContext {
	hasNotDone: boolean;
	statusVague: boolean;
}

/**
 * Strip directive hints from text (including legacy [Hint:] format).
 */
export function stripDirectives(text: string): string {
	return text.replace(DIRECTIVE_RE, "").replace(LEGACY_HINT_RE, "");
}

/**
 * Strip directive hints from tool result content (string or text-part array).
 */
export function stripDirectivesFromContent(
	content: string | Array<{ type: string; text?: string }>,
): string | Array<{ type: string; text?: string }> {
	if (typeof content === "string") {
		return stripDirectives(content);
	}
	return content.map((part) => {
		if (part.type === "text" && typeof part.text === "string") {
			return { ...part, text: stripDirectives(part.text) };
		}
		return part;
	});
}

/**
 * Remove directive hints from an array of messages.
 * Returns the sanitized messages and a flag indicating whether anything changed.
 */
export function stripDirectivesFromMessages(messages: any[]): { messages: any[]; changed: boolean } {
	let changed = false;
	const result = messages.map((msg) => {
		if (!("content" in msg)) return msg;
		const stripped = stripDirectivesFromContent(msg.content);
		if (isJsonEqual(stripped, msg.content)) return msg;
		changed = true;
		return { ...msg, content: stripped };
	});
	return { messages: result, changed };
}

const directiveTracker = new WeakMap<object, boolean>();

export function resetDirectiveTracker(): void {
	// WeakMap entries are garbage-collected with their result objects;
	// no manual sweep required for per-result tracking.
}

/**
 * Append an adaptive directive hint to the tool result.
 *
 * Skipped when PI_FLOW_NO_DIRECTIVE=1 (or legacy PI_FLOW_NO_STRATEGIC_HINT=1)
 * is set, when the result is an error, or when a directive was already
 * appended to this specific result.
 */
export function appendDirectiveOnce(result: any, hintContext?: FlowHintContext): void {
	if (!directiveEnabled) return;
	if (result?.failed) return;
	if (directiveTracker.has(result)) return;
	directiveTracker.set(result, true);

	let directive = DEFAULT_DIRECTIVE;
	if (hintContext?.hasNotDone) {
		directive = NOTDONE_DIRECTIVE;
	} else if (hintContext?.statusVague) {
		directive = VAGUE_DIRECTIVE;
	}

	appendTextToToolResult(result, directive);
}

// ---------------------------------------------------------------------------
// Backward-compat deprecated aliases
// ---------------------------------------------------------------------------

export {
	appendDirectiveOnce as appendStrategicHintOnce,
	resetDirectiveTracker as resetStrategicHintTracker,
	configureDirective as configureStrategicHint,
	stripDirectives as stripStrategicHints,
	stripDirectivesFromContent as stripStrategicHintsFromContent,
};
