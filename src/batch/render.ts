/**
 * batch — rendering helpers for tool calls and results.
 */

import { Text, TruncatedText } from "@mariozechner/pi-tui";
import { scrambleManager, runScrambleTimer } from "../tui/scramble/index.js";
import { stripAnsi } from "../tui/render-utils.js";
import type { BatchTheme, OpResult } from "./constants.js";
import { formatBatchOpsSummary } from "./summary.js";

function formatBatchCall(args: Record<string, unknown>): string {
	return formatBatchOpsSummary(args);
}

export function renderBatchCall(args: Record<string, unknown>, theme: BatchTheme): Text {
	const summary = formatBatchCall(args);
	return new Text(theme.fg("muted", "batch ") + theme.fg("accent", summary), 0, 0);
}

export function renderBatchResult(
	result: { content?: Array<{ type: string; text?: string }> },
	expanded: boolean,
	_theme: BatchTheme,
	args?: Record<string, unknown>,
): Text | TruncatedText {
	const fullText = result.content?.find((c) => c.type === "text")?.text ?? "";
	const canAnimate = !!(args as any)?.invalidate && !!(args as any)?.state;
	if (!canAnimate) {
		if (!expanded) {
			const summary = fullText.split("\n")[0] ?? "";
			return new TruncatedText(scrambleManager.renderStatic(summary), 0, 0);
		}
		return new Text(scrambleManager.renderStatic(fullText), 0, 0);
	}
	const now = Date.now();
	const id = (args as any)?.toolCallId || (args as any)?.id || "batch";
	if (!expanded) {
		const summary = fullText.split("\n")[0] ?? "";
		const scrambled = scrambleManager.updateText(id, "result", stripAnsi(summary), now, false).content;
		runScrambleTimer(args as Record<string, any> | undefined, id);
		return new TruncatedText(scrambled, 0, 0);
	}
	const scrambled = scrambleManager.updateText(id, "result", stripAnsi(fullText), now, false).content;
	runScrambleTimer(args as Record<string, any> | undefined, id);
	return new Text(scrambled, 0, 0);
}

export function renderBatchReadCall(args: Record<string, unknown>, theme: BatchTheme): Text {
	const summary = formatBatchCall(args);
	return new Text(theme.fg("muted", "batch_read ") + theme.fg("accent", summary), 0, 0);
}
