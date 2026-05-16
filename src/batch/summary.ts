/**
 * Pure formatting utilities for batch operation summaries.
 */

import * as os from "node:os";

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function extractBatchOps(args: Record<string, unknown>): Array<{ o: string; p: string; e?: unknown[]; c?: string; s?: number; l?: number; q?: string; t?: string }> {
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
			const cmd = typeof op.c === "string" ? op.c : typeof op.command === "string" ? op.command : undefined;
			const offset = typeof op.s === "number" ? op.s : typeof op.offset === "number" ? op.offset : undefined;
			const limit = typeof op.l === "number" ? op.l : typeof op.limit === "number" ? op.limit : undefined;
			const pattern = typeof op.q === "string" ? op.q : undefined;
			const typeFilter = typeof op.t === "string" ? op.t : undefined;
			return { o: opName, p: opPath, e: edits, c: cmd, s: offset, l: limit, q: pattern, t: typeFilter };
		});
}

function formatOpSummary(op: { o: string; p: string; e?: unknown[]; c?: string; s?: number; l?: number; q?: string; t?: string }): string {
	const shortPath = shortenPath(op.p);
	switch (op.o) {
		case "bash": {
			const cmd = op.c ?? "?";
			const display = cmd.length > 30 ? cmd.slice(0, 27) + "..." : cmd;
			return `bash: ${display}`;
		}
		case "read": {
			let text = `read ${shortPath}`;
			if (op.s !== undefined || op.l !== undefined) {
				const start = op.s ?? 1;
				const end = op.l !== undefined ? start + op.l - 1 : "";
				text += `:${start}${end ? `-${end}` : ""}`;
			}
			return text;
		}
		case "write": {
			const lines = (op.c ?? "").split("\n").length;
			return lines > 1 ? `write ${shortPath} (${lines} lines)` : `write ${shortPath}`;
		}
		case "edit": {
			const blockInfo = op.e && op.e.length > 1 ? ` (${op.e.length} blocks)` : "";
			return `edit ${shortPath}${blockInfo}`;
		}
		case "ls":
			return `ls ${shortPath}`;
		case "find":
			return `find ${shortPath}`;
		case "rg":
			return `rg ${op.q ?? "?"} in ${shortPath}${op.t ? ` (${op.t})` : ""}`;
		case "delete":
			return `delete ${shortPath}`;
		default:
			return `${op.o} ${shortPath}`;
	}
}

export function formatBatchOpsSummary(args: Record<string, unknown>): string {
	const ops = extractBatchOps(args);
	if (ops.length === 0) return "batch (empty)";

	const parts: string[] = [];
	let prev = "";
	let count = 0;

	for (const op of ops) {
		const summary = formatOpSummary(op);
		if (summary === prev) {
			count++;
		} else {
			if (count > 1) {
				parts[parts.length - 1] += `×${count}`;
			}
			parts.push(summary);
			prev = summary;
			count = 1;
		}
	}
	if (count > 1) {
		parts[parts.length - 1] += `×${count}`;
	}

	if (parts.length <= 3) {
		return parts.join(", ");
	}
	return `${parts.slice(0, 2).join(", ")} +${parts.length - 2} more`;
}
