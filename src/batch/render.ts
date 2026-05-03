/**
 * batch — rendering helpers for tool calls and results.
 */

import * as os from "node:os";
import { Text, TruncatedText } from "@mariozechner/pi-tui";
import type { BatchTheme, OpResult } from "./constants.js";

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function extractBatchOps(args: Record<string, unknown>): Array<{ o: string; p: string; e?: unknown[] }> {
	let rawOps: unknown[];
	if (Array.isArray(args.o)) rawOps = args.o;
	else if (Array.isArray(args.op)) rawOps = args.op;
	else if (Array.isArray(args.operations)) rawOps = args.operations;
	else if (Array.isArray(args)) rawOps = args;
	else rawOps = [];

	return rawOps
		.filter((op): op is Record<string, unknown> => !!op && typeof op === "object")
		.map((op) => {
			const opName = String(op.o ?? op.op ?? "?");
			const opPath = String(op.p ?? op.path ?? "?");
			const edits = Array.isArray(op.e) ? op.e : Array.isArray(op.edits) ? op.edits : undefined;
			return { o: opName, p: opPath, e: edits };
		});
}

function formatBatchCall(args: Record<string, unknown>): string {
	const ops = extractBatchOps(args);
	if (ops.length === 0) return "batch (empty)";

	const parts: string[] = [];
	for (const op of ops) {
		const shortPath = shortenPath(op.p);
		if (op.o === "edit" && op.e && op.e.length > 1) {
			parts.push(`edit ${shortPath} (${op.e.length} blocks)`);
		} else {
			parts.push(`${op.o} ${shortPath}`);
		}
	}

	if (parts.length <= 3) {
		return parts.join(", ");
	}
	return `${parts.slice(0, 2).join(", ")} +${parts.length - 2} more`;
}

export function renderBatchCall(args: Record<string, unknown>, theme: BatchTheme): Text {
	const summary = formatBatchCall(args);
	return new Text(theme.fg("muted", "batch ") + theme.fg("accent", summary), 0, 0);
}

export function renderBatchResult(
	result: { content?: Array<{ type: string; text?: string }> },
	expanded: boolean,
	_theme: BatchTheme,
	_args?: Record<string, unknown>,
): Text | TruncatedText {
	const fullText = result.content?.find((c) => c.type === "text")?.text ?? "";
	if (!expanded) {
		const summary = fullText.split("\n")[0] ?? "";
		return new TruncatedText(summary, 0, 0);
	}
	return new Text(fullText, 0, 0);
}

export function renderBatchReadCall(args: Record<string, unknown>, theme: BatchTheme): Text {
	const summary = formatBatchCall(args);
	return new Text(theme.fg("muted", "batch_read ") + theme.fg("accent", summary), 0, 0);
}
