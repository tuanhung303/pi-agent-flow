/**
 * batch — tool definition factory.
 *
 * Creates the `batch` and `batch_read` tool instances with schema, argument
 * preparation, execution, and rendering wired up.
 */

import { Type } from "@sinclair/typebox";
import type { BatchTheme, FileOpInput } from "./constants.js";
import { SAFE_FULL_READ_LIMIT, TARGETED_READ_LINE_LIMIT, BASH_SOFT_TIMEOUT_MS } from "./constants.js";
import { executeOperations, suggestSimilarFiles } from "./execute.js";
import { expandTilde, isWithinDirectory } from "./fuzzy-edit.js";
import {
	renderBatchCall,
	renderBatchReadCall,
	renderBatchResult,
} from "./render.js";
import {
	type BashProcessTracker,
	generateBashId,
	normalizeBashOp,
	executeBatchBash,
} from "./batch-bash.js";
import { appendStrategicHint } from "../tool-utils.js";

// Re-export polling tool factory and tracker from batch-bash
export { BashProcessTracker, createBatchBashPollTool, pollBatchBashResults } from "./batch-bash.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const EditOp = Type.Object({
	f: Type.String({
		description:
			"Exact text to find (oldText). Must be unique in the file. All edits matched against original file, not incrementally.",
	}),
	r: Type.String({ description: "Replacement text (newText)." }),
});

const FileOp = Type.Object({
	o: Type.Union([
		Type.Literal("read"),
		Type.Literal("write"),
		Type.Literal("edit"),
		Type.Literal("delete"),
		Type.Literal("bash"),
	]),
	p: Type.String({ description: "Path to the file (relative or absolute). Use 'bash' or any string for o: 'bash'." }),
	c: Type.Optional(
		Type.String({
			description:
				"File content for o: 'write'. Shell command for o: 'bash'.",
		}),
	),
	e: Type.Optional(
		Type.Array(EditOp, {
			description:
				"One or more targeted replacements matched against the original file, not incrementally.",
		}),
	),
	s: Type.Optional(
		Type.Number({
			minimum: 1,
			description:
				"1-indexed line number to start reading from (offset). Used with o: 'read'.",
		}),
	),
	l: Type.Optional(
		Type.Number({
			minimum: 1,
			description:
				"Maximum number of lines to read (limit). Used with o: 'read'.",
		}),
	),
	i: Type.Optional(
		Type.String({
			description: "Unique ID for this bash operation. Auto-generated if omitted. Used with o: 'bash'.",
		}),
	),
	t: Type.Optional(
		Type.Number({
			minimum: 1,
			description: `Soft timeout in ms. Default: ${BASH_SOFT_TIMEOUT_MS}. Command keeps running after timeout; returns partial output with pending status. Used with o: 'bash'.`,
		}),
	),
	h: Type.Optional(
		Type.String({
			description: "Working directory override for this command. Used with o: 'bash'.",
		}),
	),
});

export const WeavePatchParams = Type.Object({
	o: Type.Array(FileOp, {
		description:
			"Ordered list of operations. File ops (read/write/edit/delete) execute sequentially — on failure, remaining file ops are skipped. Bash ops (bash) run in parallel after file ops complete and do not skip each other on failure.",
	}),
});

export const BatchReadParams = Type.Object({
	o: Type.Array(
		Type.Object({
			o: Type.Literal("read"),
			p: Type.String({ description: "Path to the file (relative or absolute)" }),
			s: Type.Optional(
				Type.Number({
					minimum: 1,
					description:
						"1-indexed line number to start reading from (offset). Used with o: 'read'.",
				}),
			),
			l: Type.Optional(
				Type.Number({
					minimum: 1,
					description:
						"Maximum number of lines to read (limit). Used with o: 'read'.",
				}),
			),
		}),
		{
			description:
				"Ordered list of read operations. Executed sequentially. On failure, remaining operations are skipped.",
		},
	),
});

// ---------------------------------------------------------------------------
// Argument preparation
// ---------------------------------------------------------------------------

function normalizeOp(raw: Record<string, unknown>): Record<string, unknown> {
	const op: Record<string, unknown> = {};

	// Map operation type
	op.o = raw.o ?? raw.op ?? (raw.c != null || raw.content != null ? "write" : (raw.e != null || raw.edits != null ? "edit" : "read"));

	// Bash ops use a separate normalizer
	if (op.o === "bash") {
		return normalizeBashOp(raw);
	}

	// Map path
	op.p = raw.p ?? raw.path;

	// Map content
	if (raw.c !== undefined) op.c = raw.c;
	else if (raw.content !== undefined) op.c = raw.content;

	// Map edits
	let editsRaw = raw.e ?? raw.edits;
	if (typeof editsRaw === "string") {
		try { editsRaw = JSON.parse(editsRaw); } catch { /* ignore */ }
	}
	if (Array.isArray(editsRaw)) {
		op.e = editsRaw.map((e: unknown) => {
			if (!e || typeof e !== "object") return e;
			const edit = e as Record<string, unknown>;
			return { f: edit.f ?? edit.oldText, r: edit.r ?? edit.newText };
		});
	}

	// Map offset / limit
	if (raw.s !== undefined) op.s = raw.s;
	else if (raw.offset !== undefined) op.s = raw.offset;
	if (raw.l !== undefined) op.l = raw.l;
	else if (raw.limit !== undefined) op.l = raw.limit;

	return op;
}

function prepareArguments(input: unknown): { o: unknown[] } | unknown {
	if (!input || typeof input !== "object") return { o: [] };

	const args = input as Record<string, unknown>;

	// Handle legacy top-level format: { path, oldText, newText }
	if (
		typeof args.oldText === "string" &&
		typeof args.newText === "string" &&
		typeof args.path === "string"
	) {
		return {
			o: [
				normalizeOp({
					o: "edit",
					p: args.path,
					e: [{ oldText: args.oldText, newText: args.newText }],
				}),
			],
		};
	}

	// Extract ops array — canonical { o: [...] }, legacy { op: [...] }, legacy { operations: [...] }, or bare array
	let opsArray: unknown[];
	if (Array.isArray(args.o)) {
		opsArray = args.o;
	} else if (Array.isArray(args.op)) {
		opsArray = args.op;
	} else if (Array.isArray(args.operations)) {
		opsArray = args.operations;
	} else if (Array.isArray(args)) {
		opsArray = args;
	} else if (typeof args.p === "string" || typeof args.path === "string") {
		// Single-operation shorthand: { p: "...", o: "read" }
		opsArray = [args];
	} else {
		return { o: [] };
	}

	// Normalize each operation to single-letter form
	return {
		o: opsArray.map((op: unknown) => {
			if (!op || typeof op !== "object") return op;
			return normalizeOp(op as Record<string, unknown>);
		}),
	};
}

function prepareBatchReadArguments(input: unknown): { o: FileOpInput[] } | unknown {
	const prepared = prepareArguments(input);
	const ops = Array.isArray(prepared) ? prepared : (prepared as { o: unknown[] }).o;
	if (!Array.isArray(ops)) return { o: [] };

	for (const op of ops) {
		if (!op || typeof op !== "object") continue;
		const obj = op as Record<string, unknown>;
		const opType = String(obj.o ?? obj.op ?? "").toLowerCase();
		if (opType && opType !== "read") {
			throw new Error(`batch_read only supports read operations. Received: ${opType}`);
		}
	}
	return prepared;
}

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

export function createBatchReadTool() {
	return {
		name: "batch_read",
		label: "batch_read",
		description: [
			"Batch read-only file operations — run multiple read ops in a single call.",
			"Each operation is independent and executes sequentially in array order; on failure, remaining operations are skipped.",
			`Full-file reads up to ${SAFE_FULL_READ_LIMIT} lines return raw content; larger full-file reads return a context map for code/infra files or total lines for plain text.`,
			`Targeted reads with l over ${TARGETED_READ_LINE_LIMIT} are clamped with a continuation warning; a single line over the byte limit still errors.`,
			"Use `o: \"read\"` with `s` (offset) and `l` (limit) for targeted reading. Prefer this over bash sed/head/tail.",
			"Best for reading multiple files or sections in one call.",
		].join("\n"),
		promptSnippet: "Batch read-only file operations — run multiple read ops in one call",
		promptGuidelines: [
			"Use batch_read to perform multiple file reads in a single call rather than separate tool calls.",
			"Prefer batch_read when reading 2+ files or multiple sections of the same file.",
			`Small full-file reads (<=${SAFE_FULL_READ_LIMIT} lines) return raw content; larger full-file reads return navigable context maps or line counts.`,
			`Use targeted reads with s/l around context-map entries; targeted reads are capped at ${TARGETED_READ_LINE_LIMIT} lines.`,
			"Do not retry the same full-file read when a context map is returned.",
		],
		parameters: BatchReadParams,
		prepareArguments: prepareBatchReadArguments,

		async execute(
			_toolCallId: string,
			input: unknown,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: { cwd: string },
		) {
			let prepared: unknown;
			try {
				prepared = prepareBatchReadArguments(input);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Error: ${message}` }],
					isError: true,
				};
			}

			const ops = Array.isArray(prepared)
				? (prepared as FileOpInput[])
				: (prepared as { o: FileOpInput[] }).o;

			if (!Array.isArray(ops) || ops.length === 0) {
				return {
					content: [
						{ type: "text", text: "Error: o array is required and must not be empty." },
					],
					isError: true,
				};
			}

			// Defensive validation: reject any non-read operations
			for (const op of ops) {
				if (op.o !== "read") {
					return {
						content: [
							{
								type: "text",
								text: `Error: batch_read only supports read operations. Received ${op.o} for ${op.p}.`,
							},
						],
						isError: true,
					};
				}
			}

			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "Operation aborted." }],
					isError: true,
				};
			}

			const { contentText, results } = await executeOperations(ops, ctx.cwd, signal, {
				readOptions: { truncate: false, toolName: "batch_read" },
				includeLimitWarnings: false,
			});

			const readResult = {
				content: [{ type: "text", text: contentText }],
				details: { results },
			};
			appendStrategicHint(readResult);
			return readResult;
		},

		renderCall: (args: Record<string, unknown>, theme: BatchTheme) => renderBatchReadCall(args, theme),
		renderResult: (result: any, { expanded }: { expanded: boolean }, theme: BatchTheme, args?: Record<string, unknown>) =>
			renderBatchResult(result, expanded, theme, args),
	};
}

/**
 * Create the batch tool.
 *
 * @param bashTracker Optional BashProcessTracker for executing bash operations.
 *   When omitted, bash ops return an error. Both the batch tool and the
 *   batch_bash_poll tool must share the same tracker instance.
 */
export function createBatchTool(bashTracker?: BashProcessTracker) {
	return {
		name: "batch",
		label: "batch",
		description: [
			"Batch operations — run multiple file ops (read/write/edit/delete) and bash commands in a single call.",
			"Each file operation is independent: edits are matched against the current on-disk file, not against prior operations in the same call.",
			"File operations execute sequentially in array order; on failure, remaining file operations are skipped.",
			"Bash operations (o: 'bash') run in parallel after all file ops complete. Bash ops do NOT skip each other on failure.",
			`Bash ops use c (command), i (id), t (timeout, default ${BASH_SOFT_TIMEOUT_MS}ms), h (cwd). Commands exceeding the soft timeout return "pending" status with last 50 lines of output; poll with batch_bash_poll.`,
			"Use `o: \"read\"` with `s` (offset) and `l` (limit) for targeted reading. Prefer this over bash sed/head/tail.",
			"Best for cross-cutting changes, multi-file refactors, or mixing reads with writes across several files.",
		].join("\n"),
		promptSnippet: "Batch operations — run multiple file ops and bash commands in one call",
		promptGuidelines: [
			"Use batch to perform multiple file operations and bash commands in a single call.",
			"Prefer batch when touching 2+ files, mixing creates/edits/reads/deletes, or running shell commands.",
			"Each file operation is independent — edits match the on-disk file, not prior ops in the same call.",
			"Bash ops run in parallel. Use i (id) to track them. Use batch_bash_poll to check on pending commands.",
			"For single-file edits, the edit tool is fine; batch shines for cross-cutting and multi-file work.",
		],
		parameters: WeavePatchParams,
		prepareArguments: prepareArguments,

		async execute(
			_toolCallId: string,
			input: unknown,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: { cwd: string },
		) {
			const prepared = prepareArguments(input);
			// prepareArguments always returns { o: [...] }, but handle
			// legacy bare arrays for backward compatibility
			const ops = Array.isArray(prepared)
				? prepared as FileOpInput[]
				: (prepared as { o: FileOpInput[] }).o;

			if (!Array.isArray(ops) || ops.length === 0) {
				return {
					content: [
						{ type: "text", text: "Error: o array is required and must not be empty." },
					],
					isError: true,
				};
			}

			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "Operation aborted." }],
					isError: true,
				};
			}

			// Split ops into file ops and bash ops
			const fileOps: FileOpInput[] = [];
			const bashOps: FileOpInput[] = [];
			for (const op of ops) {
				if (op.o === "bash") {
					bashOps.push(op);
				} else {
					fileOps.push(op);
				}
			}

			// Execute file ops first (sequential, skip-on-failure)
			let fileContentText = "";
			let fileResults: import("./constants.js").OpResult[] = [];
			let fileFailed = false;

			if (fileOps.length > 0) {
				const fileOutput = await executeOperations(fileOps, ctx.cwd, signal);
				fileContentText = fileOutput.contentText;
				fileResults = fileOutput.results;
				fileFailed = fileOutput.results.some((r) => r.status === "error");
			}

			// Execute bash ops in parallel (independent of file failures,
			// unless ALL ops are file+bash and a file op failed before any bash op)
			// Per spec: file op failure skips bash ops
			let bashResults: import("./constants.js").OpResult[] = [];
			let bashContentText = "";

			if (bashOps.length > 0 && !fileFailed && bashTracker) {
				const normalizedBashOps = bashOps.map((op) => ({
					i: op.i ?? generateBashId(),
					c: op.c ?? "",
					t: op.t,
					h: op.h,
				}));

				const bashOutput = await executeBatchBash(
					normalizedBashOps,
					ctx.cwd,
					bashTracker,
					signal,
				);

				bashResults = bashOutput;

				// Format bash results into content text
				const bashLines: string[] = [];
				for (const r of bashOutput) {
					const timingInfo = r.timingTier ? ` (${r.timingTier})` : "";
					if (r.status === "ok") {
						bashLines.push(`\n--- bash [${r.id}] exit ${r.exitCode}${timingInfo} ---`);
						if (r.stdout?.trim()) bashLines.push(r.stdout.trimEnd());
					} else if (r.status === "pending") {
						bashLines.push(`\n--- bash [${r.id}] pending${timingInfo} ---`);
						if (r.stdout?.trim()) bashLines.push(`[partial output]\n${r.stdout.trimEnd()}`);
						bashLines.push(`[Use batch_bash_poll with i: ["${r.id}"] to check results]`);
					} else {
						bashLines.push(`\n--- bash [${r.id}] error${timingInfo} ---`);
						if (r.stdout?.trim()) bashLines.push(r.stdout.trimEnd());
						if (r.stderr?.trim()) bashLines.push(`[stderr]\n${r.stderr.trimEnd()}`);
					}
				}
				bashContentText = bashLines.join("\n");
			} else if (bashOps.length > 0 && fileFailed) {
				// File ops failed — mark bash ops as skipped
				bashResults = bashOps.map((op) => ({
					op: "bash" as const,
					path: op.p,
					status: "skipped" as const,
					id: op.i,
					command: op.c,
					error: "Skipped: a file operation failed.",
				}));
				bashContentText = `\n--- bash: ${bashOps.length} command(s) skipped (file op failed) ---`;
			} else if (bashOps.length > 0 && !bashTracker) {
				bashResults = bashOps.map((op) => ({
					op: "bash" as const,
					path: op.p,
					status: "error" as const,
					id: op.i,
					command: op.c,
					error: "Bash tracker not available.",
				}));
				bashContentText = "\n--- bash: tracker not available ---";
			}

			// Combine results
			const allResults = [...fileResults, ...bashResults];
			const contentText = [fileContentText, bashContentText].filter(Boolean).join("\n");

			const batchResult = {
				content: [{ type: "text", text: contentText }],
				details: { results: allResults },
			};
			appendStrategicHint(batchResult);
			return batchResult;
		},

		renderCall: (args: Record<string, unknown>, theme: BatchTheme) => renderBatchCall(args, theme),
		renderResult: (result: any, { expanded }: { expanded: boolean }, theme: BatchTheme, args?: Record<string, unknown>) =>
			renderBatchResult(result, expanded, theme, args),
	};
}
