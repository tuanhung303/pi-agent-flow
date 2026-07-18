/**
 * batch — tool definition factory.
 *
 * Creates the `batch` and `batch_read` tool instances with schema, argument
 * preparation, execution, and rendering wired up.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BatchTheme, FileOpInput, BatchOnUpdate } from "./constants.js";
import { SAFE_FULL_READ_LIMIT, TARGETED_READ_LINE_LIMIT, BASH_SOFT_TIMEOUT_MS, BASH_DEFAULT_TIMEOUT_MS, MAX_LINES, MAX_BYTES, MAX_BASH_OUTPUT_LINES, MAX_BASH_OUTPUT_BYTES } from "./constants.js";
import { executeOperations, suggestSimilarFiles } from "./execute.js";
import { expandTilde, isWithinDirectory } from "./fuzzy-edit.js";
import {
	renderBatchCall,
	renderBatchReadCall,
	renderBatchResult,
	renderBatchReadResult,
} from "./render.js";
import {
	type BashProcessTracker,
	normalizeBashOp,
	executeBatchBash,
} from "./batch-bash.js";
import { normalizeBatchOp, generateBashId } from "./normalize.js";
import { coerceArrayOfObjects } from "../tools/array-coerce.js";
import { checkLoopGuard } from "../tools/loop-guard.js";
import { logWarn } from "../config/log.js";
import { runWebOps } from "../tools/web-ops.js";

// Re-export polling tool factory and tracker from batch-bash
export { BashProcessTracker, createBatchBashPollTool, pollBatchBashResults, runBashWithLimits } from "./batch-bash.js";

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

const ReadFileOp = Type.Object({
	o: Type.Literal("read"),
	p: Type.String({ description: "Path to the file (relative or absolute)." }),
	s: Type.Optional(
		Type.Number({
			minimum: 1,
			description: "1-indexed line number to start reading from (offset).",
		}),
	),
	l: Type.Optional(
		Type.Number({
			minimum: 1,
			description: "Maximum number of lines to read (limit).",
		}),
	),
}, { description: "Read a file, whole or a section via s/l." });

const WriteFileOp = Type.Object({
	o: Type.Literal("write"),
	p: Type.String({ description: "Path to the file (relative or absolute)." }),
	c: Type.String({ description: "Full file content to write. Creates parent directories as needed." }),
}, { description: "Write (create or overwrite) a file." });

const EditFileOp = Type.Object({
	o: Type.Literal("edit"),
	p: Type.String({ description: "Path to the file (relative or absolute)." }),
	e: Type.Array(EditOp, {
		description:
			"One or more targeted replacements matched against the original file, not incrementally.",
	}),
}, { description: "Apply targeted find/replace edits to a file." });

const DeleteFileOp = Type.Object({
	o: Type.Literal("delete"),
	p: Type.String({ description: "Path to the file to delete." }),
}, { description: "Delete a file." });

const PatchFileOp = Type.Object({
	o: Type.Literal("patch"),
	p: Type.Optional(Type.String({ description: "Optional display label. File paths come from the patch text itself." })),
	c: Type.String({
		description:
			"Patch text in apply_patch envelope format — NOT unified diff. Structure: '*** Begin Patch', then one or more '*** Add File: <path>' / '*** Update File: <path>' / '*** Delete File: <path>' sections with '@@' context hunks (' ' keep, '-' remove, '+' add line prefixes), then '*** End Patch'.",
	}),
}, { description: "Apply a multi-file patch in apply_patch envelope format." });

const RgFileOp = Type.Object({
	o: Type.Literal("rg"),
	p: Type.String({ description: "Path to search (relative or absolute). Use '.' for cwd." }),
	q: Type.String({ description: "Search pattern (ripgrep regex)." }),
	l: Type.Optional(
		Type.Boolean({
			description: "Files-with-matches flag. Default false — returns matching lines with content. Set true to get filenames only.",
		}),
	),
	i: Type.Optional(Type.Boolean({ description: "Ignore-case flag." })),
	t: Type.Optional(Type.String({ description: "Type filter (e.g., 'ts', 'js')." })),
	n: Type.Optional(
		Type.Number({
			minimum: 1,
			description: "Max-count (matches per file). Broad searches on '.' auto-default to 50 when omitted.",
		}),
	),
	u: Type.Optional(
		Type.Number({
			minimum: 0,
			maximum: 3,
			description: "Ignore level (0-3). Maps to -u (0), -uu (1), -uuu (2-3).",
		}),
	),
}, { description: "Search file contents with ripgrep." });

const BashFileOp = Type.Object({
	o: Type.Literal("bash"),
	c: Type.String({ description: "Shell command to run." }),
	i: Type.Optional(
		Type.String({
			description: "Unique ID for this bash operation. Auto-generated if omitted. Needed to poll long-running commands via batch_bash_poll.",
		}),
	),
	t: Type.Optional(
		Type.Number({
			minimum: 1,
			description: `Soft timeout in ms. Default: ${BASH_SOFT_TIMEOUT_MS}. Does NOT kill the command — the batch returns partial output with pending status and the command keeps running (poll via batch_bash_poll). When several bash ops set t, the smallest value bounds the wait for the whole batch.`,
		}),
	),
	h: Type.Optional(Type.String({ description: "Working directory override for this command." })),
	p: Type.Optional(Type.String({ description: "Unused for bash ops; may be omitted." })),
}, { description: "Run a shell command. Bash ops run in parallel after file and web ops complete." });

const FileOp = Type.Union([
	ReadFileOp,
	WriteFileOp,
	EditFileOp,
	DeleteFileOp,
	PatchFileOp,
	RgFileOp,
	BashFileOp,
], { description: "A single operation, discriminated by o." });

const WebOp = Type.Union([
	Type.Object({
		o: Type.Literal("search"),
		q: Type.String({ minLength: 1, description: "Search query" }),
	}, { description: "Keyless web search. Returns top results with title, URL, and snippet." }),
	Type.Object({
		o: Type.Literal("fetch"),
		u: Type.String({ minLength: 1, description: "URL to fetch" }),
		f: Type.Optional(
			Type.Union([Type.Literal("markdown"), Type.Literal("text"), Type.Literal("html")], {
				description: "Output format (default: markdown).",
			}),
		),
	}, { description: "Fetch a URL. Full content is saved to a temp file (path returned) with a short inline preview — use a read op on the returned path for the rest." }),
]);

export const WeavePatchParams = Type.Object({
	o: Type.Array(FileOp, {
		description:
			"Ordered operations. File ops run sequentially and independently — a failure never stops remaining ops. Bash ops run in parallel after file and web ops complete.",
	}),
	w: Type.Optional(
		Type.Array(WebOp, {
			description:
				"Web ops, run after file ops and before bash. E.g. w: [{ o: 'search', q: '...' }] or [{ o: 'fetch', u: '...' }]",
		}),
		),
}, {
	title: "BatchToolParams",
	examples: [
		{ o: [{ o: "read", p: "src/index.ts" }, { o: "rg", p: ".", q: "TODO", t: "ts" }] },
		{ o: [{ o: "write", p: "./tmp/check.py", c: "print('ok')" }, { o: "bash", c: "python ./tmp/check.py" }] },
		{ o: [{ o: "edit", p: "src/app.ts", e: [{ f: "const retries = 1", r: "const retries = 3" }] }], w: [{ o: "search", q: "typescript satisfies operator" }] },
	],
});

const BatchReadOp = Type.Union([
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
	Type.Object({
		o: Type.Literal("rg"),
		p: Type.String({ description: "Path to search (relative or absolute). Use '.' for cwd." }),
		q: Type.String({ description: "Search pattern for o: 'rg'." }),
		l: Type.Optional(
			Type.Boolean({
				description:
					"Files-with-matches flag for o: 'rg'. Default false — returns matching lines with content. Set true to get filenames only.",
			}),
		),
		i: Type.Optional(
			Type.Boolean({
				description: "Ignore-case flag for o: 'rg'.",
			}),
		),
		t: Type.Optional(
			Type.String({
				description: "Type filter for o: 'rg' (e.g., 'ts', 'js').",
			}),
		),
		n: Type.Optional(
			Type.Number({
				minimum: 1,
				description: "Max-count for o: 'rg' (matches per file). Broad searches on '.' auto-default to 50 when omitted.",
			}),
		),
		u: Type.Optional(
			Type.Number({
				minimum: 0,
				maximum: 3,
				description: "Ignore level for o: 'rg' (0-3). Maps to -u (0), -uu (1), -uuu (2-3).",
			}),
		),
	}),
]);

export const BatchReadParams = Type.Object({
	o: Type.Array(BatchReadOp, {
		description:
			"Ordered list of read operations. Executed sequentially. Each operation executes independently; failures are reported per-operation without stopping remaining ops.",
	}),
	w: Type.Optional(
		Type.Array(WebOp, {
			description:
				"Web ops, run after read ops. E.g. w: [{ o: 'search', q: '...' }] or [{ o: 'fetch', u: '...' }]",
		}),
	),
});

// ---------------------------------------------------------------------------
// Argument preparation
// ---------------------------------------------------------------------------

function prepareArguments(input: unknown): { o: unknown[]; w?: unknown[] } | unknown {
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
				normalizeBatchOp({
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
		opsArray = [];
	}

	const sanitized = coerceArrayOfObjects<Record<string, unknown>>(opsArray, { label: "batch.o" });

	// Normalize each operation to single-letter form
	const result: { o: unknown[]; w?: unknown[] } = {
		o: sanitized.value.map((op) => normalizeBatchOp(op)),
	};

	// Extract and sanitize web ops if present
	if (Array.isArray(args.w)) {
		const sanitizedW = coerceArrayOfObjects<Record<string, unknown>>(args.w, { label: "batch.w" });
		if (sanitizedW.value.length > 0) {
			result.w = sanitizedW.value;
		} else if (args.w.length > 0) {
			// User provided w but sanitization dropped everything — preserve the empty
			// result so the user sees "no valid web ops" rather than a schema crash.
			result.w = [];
		}
		// If args.w was provided as an empty array, leave result.w undefined.
	}

	return result;
}

function prepareBatchReadArguments(input: unknown): { o: FileOpInput[]; w?: unknown[] } | unknown {
	const prepared = prepareArguments(input);
	const ops = Array.isArray(prepared) ? prepared : (prepared as { o: unknown[] }).o;
	if (!Array.isArray(ops)) return { o: [] };

	const normalizedOps: unknown[] = [];
	const allowedBatchReadOps = new Set(["read", "rg"]);
	for (const op of ops) {
		if (!op || typeof op !== "object") continue;
		const normalized = normalizeBatchOp(op as Record<string, unknown>);
		const opType = String(normalized.o ?? "").toLowerCase();
		if (opType && !allowedBatchReadOps.has(opType)) {
			throw new Error(`batch_read only supports read operations. Received: ${opType}`);
		}
		normalizedOps.push(normalized);
	}
	const result: { o: unknown[]; w?: unknown[] } = { o: normalizedOps };
	const webOps = (prepared as { w?: unknown[] }).w;
	if (webOps !== undefined) {
		result.w = webOps;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

export function createBatchReadTool() {
	return {
		name: "batch_read",
		label: "batch_read",
		description: "Read-only: verbatim file contents (whole or by [s]/[l] section), ripgrep matches, and web ([search] [fetch]) via the [w] array. Ops: [read] [rg]. Order: reads first, then web. No shell or writes.",
		promptSnippet: "Read multiple files/sections + web search/fetch in one call (read-only)",
		promptGuidelines: [
			"Combine multiple read/rg ops into one call.",
			"Use `s` (start line) and `l` (line count) to target specific sections of large files.",
			"Web: `w: [{ o: 'search', q: '...' }]` or `w: [{ o: 'fetch', u: '...' }]` — runs after read ops.",
		],
		parameters: BatchReadParams,
		prepareArguments: prepareBatchReadArguments,

		async execute(
			_toolCallId: string,
			input: unknown,
			signal: AbortSignal | undefined,
			onUpdate: BatchOnUpdate | undefined,
			ctx: ExtensionContext,
		) {
			const loopWarning = checkLoopGuard("batch_read", input);
			const prepared = prepareBatchReadArguments(input);

			const ops = Array.isArray(prepared)
				? (prepared as FileOpInput[])
				: (prepared as { o: FileOpInput[] }).o;
			const webOps = (prepared as { w?: unknown[] }).w;

			const hasReadOps = Array.isArray(ops) && ops.length > 0;
			const hasWebOps = Array.isArray(webOps) && webOps.length > 0;
			if (!hasReadOps && !hasWebOps) {
				throw new Error("Error: o or w array must not be empty.");
			}

			// Defensive validation: reject any non-read/rg operations
			const allowedBatchReadOps = new Set(["read", "rg"]);
			for (const op of hasReadOps ? ops : []) {
				if (!allowedBatchReadOps.has(op.o)) {
					throw new Error(`Error: batch_read only supports read operations. Received ${op.o} for ${op.p}.`);
				}
			}

			if (signal?.aborted) {
				throw new Error("Operation aborted.");
			}

			// Execute read ops first (sequential)
			let readContentText = "";
			let readResults: import("./constants.js").OpResult[] = [];
			if (hasReadOps) {
				const readOutput = await executeOperations(ops, ctx.cwd, signal, {
					readOptions: { truncate: false, toolName: "batch_read" },
					includeLimitWarnings: false,
				}, onUpdate);
				readContentText = readOutput.contentText;
				readResults = readOutput.results;
			}

			// Execute web ops after read ops (sequential)
			let webContentText = "";
			let webResults: import("./constants.js").OpResult[] = [];
			if (hasWebOps) {
				if (onUpdate && hasReadOps) {
					onUpdate({
						content: [{ type: "text", text: readContentText }],
						details: { results: readResults },
					});
				}
				try {
					const webOutput = await runWebOps({ op: webOps as import("../tools/web-ops.js").WebOpInput[] }, ctx, signal);
					webContentText = webOutput.content[0].text;
					webResults = webOutput.details.ops as unknown as import("./constants.js").OpResult[];
				} catch (err) {
					// Catastrophic failure in runWebOps itself (should not happen with per-op handling)
					const errorText = err instanceof Error ? err.message : String(err);
					webContentText = `\n--- web error (unexpected) ---\n${errorText}`;
					webResults = [];
				}
			}

			const contentText = [readContentText, webContentText].filter(Boolean).join("\n");
			const results = [...readResults, ...webResults];

			const readResult = {
				content: [{ type: "text", text: loopWarning ? contentText + loopWarning : contentText }],
				details: { results },
			};
			return readResult;
		},

		renderCall: (args: Record<string, unknown>, theme: BatchTheme) => renderBatchReadCall(args, theme),
		renderResult: (result: any, { expanded, isPartial }: { expanded: boolean; isPartial?: boolean }, theme: BatchTheme, args?: Record<string, unknown>) =>
			renderBatchReadResult(result, { expanded, isPartial: isPartial ?? false }, theme, args),
	};
}

/**
 * Create the batch tool.
 *
 * @param bashTracker Optional BashProcessTracker for executing bash operations.
 *   When omitted, bash ops return an error. Both the batch tool and the
 *   batch_bash_poll tool must share the same tracker instance.
 */
export function createBatchTool(bashTracker?: BashProcessTracker, toolOptimize?: boolean) {
	return {
		name: "batch",
		label: "batch",
		description: "Multi-op executor: file ops, bash, and web in one call. Ops in [o]: [read] [write] [edit] [delete] [patch] [rg] [bash]; web ([search] [fetch]) goes in [w]. Order: file ops, then web, then bash (parallel).",
		promptSnippet: "Batch: file ops + bash + web in one call",
		promptGuidelines: [
			"Combine all pending operations into a single `batch` call.",
			"File ops run first, then web, then bash — write → bash is safe for scripts.",
			"Web: `w: [{ o: 'search', q: '...' }]` or `w: [{ o: 'fetch', u: '...' }]`",
			"Field aliases: cmd/command=c, content=c, path=p, edits=e, offset=s, limit=l. Canonical wins.",
			"`patch` ops take the apply_patch envelope (`*** Begin Patch` … `*** End Patch`), not unified diff. Prefer `edit` for single-file changes.",
			...(toolOptimize ? ["Batch is your ONLY edit tool — no separate edit command."] : []),
		],
		parameters: WeavePatchParams,
		prepareArguments: prepareArguments,

		async execute(
			_toolCallId: string,
			input: unknown,
			signal: AbortSignal | undefined,
			onUpdate: BatchOnUpdate | undefined,
			ctx: ExtensionContext,
		) {
			const loopWarning = checkLoopGuard("batch", input);
			const prepared = prepareArguments(input);
			// prepareArguments always returns { o: [...] }, but handle
			// legacy bare arrays for backward compatibility
			const ops = Array.isArray(prepared)
				? prepared as FileOpInput[]
				: (prepared as { o: FileOpInput[] }).o;

			// Extract web ops (pass-through, no normalization needed)
			const webOps = (prepared as { w?: unknown[] }).w;

			const hasFileOps = Array.isArray(ops) && ops.length > 0;
			const hasWebOps = Array.isArray(webOps) && webOps.length > 0;
			if (!hasFileOps && !hasWebOps) {
				throw new Error("Error: o or w array must not be empty.");
			}

			if (signal?.aborted) {
				throw new Error("Operation aborted.");
			}

			// Split ops into file ops and bash ops
			const fileOps: FileOpInput[] = [];
			const bashOps: FileOpInput[] = [];
			if (hasFileOps) {
				for (const op of ops) {
					if (op.o === "bash") {
						bashOps.push(op);
					} else {
						fileOps.push(op);
					}
				}
			}

			// Execute file ops first (sequential)
			let fileContentText = "";
			let fileResults: import("./constants.js").OpResult[] = [];

			if (fileOps.length > 0) {
				const fileOutput = await executeOperations(fileOps, ctx.cwd, signal, {}, onUpdate);
				fileContentText = fileOutput.contentText;
				fileResults = fileOutput.results;
			}

			// Emit update after file ops
			if (onUpdate && fileOps.length > 0) {
				onUpdate({
					content: [{ type: "text", text: fileContentText }],
					details: { results: fileResults },
				});
			}

			// Execute web ops after file ops, before bash ops (sequential)
			let webContentText = "";
			let webResults: import("./constants.js").OpResult[] = [];

			if (Array.isArray(webOps) && webOps.length > 0) {
				try {
					const webOutput = await runWebOps({ op: webOps as import("../tools/web-ops.js").WebOpInput[] }, ctx, signal);
					webContentText = webOutput.content[0].text;
					webResults = webOutput.details.ops as unknown as import("./constants.js").OpResult[];
				} catch (err) {
					// Catastrophic failure in runWebOps itself (should not happen with per-op handling)
					const errorText = err instanceof Error ? err.message : String(err);
					webContentText = `\n--- web error (unexpected) ---\n${errorText}`;
					webResults = [];
				}

				// Emit update after web ops
				if (onUpdate) {
					onUpdate({
						content: [{ type: "text", text: [fileContentText, webContentText].filter(Boolean).join("\n") }],
						details: { results: [...fileResults, ...webResults] },
					});
				}
			}

			// Execute bash ops in parallel after file and web ops complete.
			// Bash ops run regardless of file or web op failures.
			let bashResults: import("./constants.js").OpResult[] = [];
			let bashContentText = "";

			if (bashOps.length > 0 && bashTracker) {
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
					if (r.status === "ok") {
						bashLines.push(`\n--- bash [${r.id}] exit ${r.exitCode} ---`);
						if (r.timingTier) bashLines.push(`[Execution time: ${r.timingTier}]`);
						if (r.stdout?.trim()) bashLines.push(r.stdout.trimEnd());
					} else if (r.status === "pending") {
						bashLines.push(`\n--- bash [${r.id}] pending ---`);
						if (r.stdout?.trim()) bashLines.push(`[partial output]\n${r.stdout.trimEnd()}`);
						bashLines.push(`[Use batch_bash_poll with i: ["${r.id}"] to check results]`);
					} else {
						bashLines.push(`\n--- bash [${r.id}] error ---`);
						if (r.timingTier) bashLines.push(`[Execution time: ${r.timingTier}]`);
						if (r.stdout?.trim()) bashLines.push(r.stdout.trimEnd());
						if (r.stderr?.trim()) bashLines.push(`[stderr]\n${r.stderr.trimEnd()}`);
					}
				}
				bashContentText = bashLines.join("\n");
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
			const allResults = [...fileResults, ...webResults, ...bashResults];
			const contentText = [fileContentText, webContentText, bashContentText].filter(Boolean).join("\n");

			// Emit final update after bash ops complete
			if (onUpdate && (bashOps.length > 0 || (Array.isArray(webOps) && webOps.length > 0))) {
				onUpdate({
					content: [{ type: "text", text: contentText }],
					details: { results: allResults },
				});
			}

			const batchResult = {
				content: [{ type: "text", text: loopWarning ? contentText + loopWarning : contentText }],
				details: { results: allResults },
			};
			return batchResult;
		},

		renderCall: (args: Record<string, unknown>, theme: BatchTheme) => renderBatchCall(args, theme),
		renderResult: (result: any, { expanded, isPartial }: { expanded: boolean; isPartial?: boolean }, theme: BatchTheme, args?: Record<string, unknown>) =>
			renderBatchResult(result, { expanded, isPartial: isPartial ?? false }, theme, args),
	};
}
