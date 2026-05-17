/**
 * batch — rendering helpers for tool calls and results.
 */

import { Container, Text, TruncatedText } from "@mariozechner/pi-tui";
import { scrambleManager, runScrambleTimer } from "../tui/scramble/index.js";
import { stripAnsi } from "../tui/render-utils.js";
import type { BatchTheme, OpResult } from "./constants.js";
import { formatBatchOpsSummary } from "./summary.js";

function formatBatchCall(args: Record<string, unknown>): string {
	return formatBatchOpsSummary(args);
}

/** Reuse a cached root container from args.state so the TUI host's reference stays valid. */
function reuseRootContainer(
	args: Record<string, unknown> | undefined,
	fresh: Text | TruncatedText,
): Text | TruncatedText {
	const state = (args as any)?.state as Record<string, any> | undefined;
	if (!state) return fresh;

	if (!state.__batchRoot) {
		const root = new Container();
		root.addChild(fresh);
		state.__batchRoot = root;
		return root;
	}

	const root = state.__batchRoot as Container;
	root.clear();
	root.addChild(fresh);
	root.invalidate();
	return root;
}

export function renderBatchCall(args: Record<string, unknown>, theme: BatchTheme): Text {
	const summary = formatBatchCall(args);
	const text = new Text(theme.fg("muted", "batch ") + theme.fg("accent", summary), 0, 0);
	return reuseRootContainer(args, text) as Text;
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
			const fresh = new TruncatedText(scrambleManager.renderStatic(summary), 0, 0);
			return reuseRootContainer(args, fresh) as TruncatedText;
		}
		const fresh = new Text(scrambleManager.renderStatic(fullText), 0, 0);
		return reuseRootContainer(args, fresh) as Text;
	}
	const now = Date.now();
	const id = (args as any)?.toolCallId || (args as any)?.id || "batch";
	if (!expanded) {
		const summary = fullText.split("\n")[0] ?? "";
		const scrambled = scrambleManager.updateText(id, "result", stripAnsi(summary), now, false).content;
		runScrambleTimer(args as Record<string, any> | undefined, id);
		const fresh = new TruncatedText(scrambled, 0, 0);
		return reuseRootContainer(args, fresh) as TruncatedText;
	}
	const scrambled = scrambleManager.updateText(id, "result", stripAnsi(fullText), now, false).content;
	runScrambleTimer(args as Record<string, any> | undefined, id);
	const fresh = new Text(scrambled, 0, 0);
	return reuseRootContainer(args, fresh) as Text;
}

export function renderBatchReadCall(args: Record<string, unknown>, theme: BatchTheme): Text {
	const summary = formatBatchCall(args);
	const text = new Text(theme.fg("muted", "batch_read ") + theme.fg("accent", summary), 0, 0);
	return reuseRootContainer(args, text) as Text;
}
