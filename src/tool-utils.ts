/**
 * Shared tool-result utilities.
 *
 * Provides helpers for appending text to tool results and injecting
 * strategic planning hints after each tool call.
 */

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

const NO_STRATEGIC_HINT =
	typeof process !== "undefined" &&
	typeof process.env !== "undefined" &&
	process.env.PI_FLOW_NO_STRATEGIC_HINT === "1";

const STRATEGIC_HINT =
	"\n\n[Hint: Plan next step. Batch ALL pending edits/reads/commands into ONE batch call. Execute decisively.]";

const STRATEGIC_HINT_RE = /\n\n\[Hint: [\s\S]*?\]/g;

/**
 * Strip strategic hints from text.
 */
export function stripStrategicHints(text: string): string {
	return text.replace(STRATEGIC_HINT_RE, "");
}

/**
 * Strip strategic hints from tool result content (string or text-part array).
 */
export function stripStrategicHintsFromContent(
	content: string | Array<{ type: string; text?: string }>,
): string | Array<{ type: string; text?: string }> {
	if (typeof content === "string") {
		return stripStrategicHints(content);
	}
	return content.map((part) => {
		if (part.type === "text" && typeof part.text === "string") {
			return { ...part, text: stripStrategicHints(part.text) };
		}
		return part;
	});
}

/**
 * Append a concise strategic planning hint to the tool result.
 *
 * Skipped when PI_FLOW_NO_STRATEGIC_HINT=1 is set or when the result
 * is an error (no hint on failed calls — the model should focus on
 * fixing the error, not planning ahead).
 */
let hintAppendedThisTurn = false;

export function resetStrategicHintTracker(): void {
	hintAppendedThisTurn = false;
}

export function appendStrategicHintOnce(result: any): void {
	if (NO_STRATEGIC_HINT) return;
	if (result?.isError) return;
	if (hintAppendedThisTurn) return;
	hintAppendedThisTurn = true;
	appendTextToToolResult(result, STRATEGIC_HINT);
}

export function appendStrategicHint(result: any): void {
	if (NO_STRATEGIC_HINT) return;
	if (result?.isError) return;
	appendTextToToolResult(result, STRATEGIC_HINT);
}
