/**
 * weave_patch — Unified batch file operations tool.
 *
 * Combines read, write, edit, and delete into a single tool call.
 * Executes operations sequentially with skip-on-failure semantics.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const EditOp = Type.Object({
	oldText: Type.String({
		description:
			"Exact text to replace. Must be unique in the file. All edits matched against original file, not incrementally.",
	}),
	newText: Type.String({ description: "Replacement text." }),
});

const FileOp = Type.Object({
	op: Type.Union([
		Type.Literal("read"),
		Type.Literal("write"),
		Type.Literal("edit"),
		Type.Literal("delete"),
	]),
	path: Type.String({ description: "Path to the file (relative or absolute)" }),
	content: Type.Optional(
		Type.String({
			description:
				"Full file content. Creates if new, overwrites if exists. Auto-creates parent dirs. Used with op: 'write'.",
		}),
	),
	edits: Type.Optional(
		Type.Array(EditOp, {
			description:
				"One or more targeted replacements matched against the original file, not incrementally.",
		}),
	),
});

export const WeavePatchParams = Type.Object({
	operations: Type.Array(FileOp, {
		description:
			"Ordered list of file operations. Executed sequentially. On failure, remaining operations are skipped.",
	}),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EditReplacement {
	oldText: string;
	newText: string;
}

interface FileOpInput {
	op: "read" | "write" | "edit" | "delete";
	path: string;
	content?: string;
	edits?: EditReplacement[];
}

interface OpResult {
	op: "read" | "write" | "edit" | "delete";
	path: string;
	status: "ok" | "error" | "skipped";
	content?: string;
	bytes?: number;
	blocksChanged?: number;
	error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024; // 50KB

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: string): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function detectLineEnding(content: string): string {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF")
		? { bom: "\uFEFF", text: content.slice(1) }
		: { bom: "", text: content };
}

function truncateContent(content: string): string {
	const lines = content.split("\n");
	if (lines.length > MAX_LINES) {
		return lines.slice(0, MAX_LINES).join("\n") + "\n... (truncated)";
	}
	if (content.length > MAX_BYTES) {
		return content.slice(0, MAX_BYTES) + "\n... (truncated)";
	}
	return content;
}

function generateDiffSummary(oldContent: string, newContent: string): string {
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");

	let added = 0;
	let removed = 0;

	for (const line of newLines) {
		if (!oldLines.includes(line)) added++;
	}
	for (const line of oldLines) {
		if (!newLines.includes(line)) removed++;
	}

	return `+${added} -${removed} lines`;
}

// ---------------------------------------------------------------------------
// Fuzzy matching (simplified)
// ---------------------------------------------------------------------------

function normalizeForMatch(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n");
}

function fuzzyFindText(
	content: string,
	oldText: string,
): { found: boolean; index: number; matchLength: number } {
	// Try exact match first
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return { found: true, index: exactIndex, matchLength: oldText.length };
	}

	// Try trimmed match
	const normalizedContent = normalizeForMatch(content);
	const normalizedOld = normalizeForMatch(oldText);
	const fuzzyIndex = normalizedContent.indexOf(normalizedOld);
	if (fuzzyIndex !== -1) {
		return { found: true, index: fuzzyIndex, matchLength: normalizedOld.length };
	}

	return { found: false, index: -1, matchLength: 0 };
}

function countOccurrences(content: string, oldText: string): number {
	const normalizedContent = normalizeForMatch(content);
	const normalizedOld = normalizeForMatch(oldText);
	let count = 0;
	let pos = 0;
	while (true) {
		const idx = normalizedContent.indexOf(normalizedOld, pos);
		if (idx === -1) break;
		count++;
		pos = idx + normalizedOld.length;
	}
	return count;
}

// ---------------------------------------------------------------------------
// Edit logic
// ---------------------------------------------------------------------------

function applyEdits(
	content: string,
	edits: EditReplacement[],
	filePath: string,
): { newContent: string; diffSummary: string; blocksChanged: number } {
	const normalizedEdits = edits.map((e) => ({
		oldText: normalizeToLF(e.oldText),
		newText: normalizeToLF(e.newText),
	}));

	// Validate non-empty
	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw new Error(`edits[${i}].oldText must not be empty in ${filePath}.`);
		}
	}

	// Check for fuzzy match need
	const needsFuzzy = normalizedEdits.some(
		(edit) => fuzzyFindText(content, edit.oldText).found && !content.includes(edit.oldText),
	);

	const baseContent = needsFuzzy ? normalizeForMatch(content) : content;

	// Match all edits
	interface MatchResult {
		editIndex: number;
		matchIndex: number;
		matchLength: number;
		newText: string;
	}

	const matchedEdits: MatchResult[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(baseContent, edit.oldText);

		if (!matchResult.found) {
			throw new Error(
				edits.length === 1
					? `Could not find the exact text in ${filePath}. The old text must match exactly including all whitespace and newlines.`
					: `Could not find edits[${i}] in ${filePath}. The oldText must match exactly including all whitespace and newlines.`,
			);
		}

		const occurrences = countOccurrences(baseContent, edit.oldText);
		if (occurrences > 1) {
			throw new Error(
				edits.length === 1
					? `Found ${occurrences} occurrences of the text in ${filePath}. The text must be unique. Please provide more context to make it unique.`
					: `Found ${occurrences} occurrences of edits[${i}] in ${filePath}. Each oldText must be unique. Please provide more context to make it unique.`,
			);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			newText: edit.newText,
		});
	}

	// Sort by position (ascending)
	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);

	// Check for overlaps
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${filePath}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	// Apply edits in reverse order to preserve offsets
	let newContent = baseContent;
	for (let i = matchedEdits.length - 1; i >= 0; i--) {
		const edit = matchedEdits[i];
		newContent =
			newContent.substring(0, edit.matchIndex) +
			edit.newText +
			newContent.substring(edit.matchIndex + edit.matchLength);
	}

	if (baseContent === newContent) {
		throw new Error(
			edits.length === 1
				? `No changes made to ${filePath}. The replacement produced identical content.`
				: `No changes made to ${filePath}. The replacements produced identical content.`,
		);
	}

	return {
		newContent,
		diffSummary: generateDiffSummary(baseContent, newContent),
		blocksChanged: matchedEdits.length,
	};
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

function validatePath(inputPath: string, cwd: string): string {
	const resolved = path.resolve(cwd, inputPath);
	const normalizedResolved = path.normalize(resolved);
	const normalizedCwd = path.normalize(cwd);
	if (
		normalizedResolved !== normalizedCwd &&
		!normalizedResolved.startsWith(normalizedCwd + path.sep)
	) {
		throw new Error(
			`Path traversal detected: ${inputPath} resolves outside working directory.`,
		);
	}
	return resolved;
}

// ---------------------------------------------------------------------------
// prepareArguments shim
// ---------------------------------------------------------------------------

function prepareArguments(input: unknown): unknown {
	if (!input || typeof input !== "object") return input;

	const args = input as Record<string, unknown>;

	// Handle top-level edits stringification (some models do this)
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args.edits = parsed;
		} catch {
			/* ignore */
		}
	}

	// Handle legacy format at top level: { path, oldText, newText }
	if (
		typeof args.oldText === "string" &&
		typeof args.newText === "string" &&
		typeof args.path === "string"
	) {
		return {
			operations: [
				{
					op: "edit",
					path: args.path,
					edits: [{ oldText: args.oldText, newText: args.newText }],
				},
			],
		};
	}

	// If no operations array, try to infer from shape
	if (!Array.isArray(args.operations)) {
		if (typeof args.path === "string") {
			// Single operation
			const op: FileOpInput = {
				op: args.content ? "write" : args.edits ? "edit" : "read",
				path: args.path as string,
				content: args.content as string | undefined,
				edits: args.edits as EditReplacement[] | undefined,
			};
			return { operations: [op] };
		}
	}

	// Normalize each operation in the array
	if (Array.isArray(args.operations)) {
		args.operations = args.operations.map((op: unknown) => {
			if (!op || typeof op !== "object") return op;
			const opObj = op as Record<string, unknown>;

			// Infer op if missing
			if (!opObj.op) {
				opObj.op = opObj.content ? "write" : opObj.edits ? "edit" : "read";
			}

			// Handle stringified edits in operation
			if (typeof opObj.edits === "string") {
				try {
					const parsed = JSON.parse(opObj.edits);
					if (Array.isArray(parsed)) opObj.edits = parsed;
				} catch {
					/* ignore */
				}
			}

			return opObj;
		});
	}

	return args;
}

// ---------------------------------------------------------------------------
// Main execute function
// ---------------------------------------------------------------------------

async function executeOperations(
	operations: FileOpInput[],
	cwd: string,
): Promise<{ summary: string; results: OpResult[] }> {
	const results: OpResult[] = [];
	let failed = false;

	const counts = { read: 0, write: 0, edit: 0, delete: 0, error: 0 };

	for (const op of operations) {
		if (failed) {
			results.push({ op: op.op, path: op.path, status: "skipped" });
			continue;
		}

		try {
			const resolvedPath = validatePath(op.path, cwd);

			switch (op.op) {
				case "read": {
					const content = await fs.readFile(resolvedPath, "utf-8");
					const { text } = stripBom(content);
					results.push({
						op: "read",
						path: op.path,
						status: "ok",
						content: truncateContent(text),
					});
					counts.read++;
					break;
				}

				case "write": {
					if (!op.content && op.content !== "") {
						throw new Error("content is required for write operations.");
					}
					await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
					await fs.writeFile(resolvedPath, op.content!, "utf-8");
					results.push({
						op: "write",
						path: op.path,
						status: "ok",
						bytes: Buffer.byteLength(op.content!, "utf-8"),
					});
					counts.write++;
					break;
				}

				case "edit": {
					if (!op.edits || op.edits.length === 0) {
						throw new Error("edits array is required for edit operations.");
					}

					const rawContent = await fs.readFile(resolvedPath, "utf-8");
					const { bom, text: contentWithoutBom } = stripBom(rawContent);
					const originalEnding = detectLineEnding(contentWithoutBom);
					const normalizedContent = normalizeToLF(contentWithoutBom);

					const { newContent, diffSummary, blocksChanged } = applyEdits(
						normalizedContent,
						op.edits,
						op.path,
					);

					const finalContent = bom + restoreLineEndings(newContent, originalEnding);
					await fs.writeFile(resolvedPath, finalContent, "utf-8");

					results.push({
						op: "edit",
						path: op.path,
						status: "ok",
						blocksChanged,
					});
					counts.edit++;
					break;
				}

				case "delete": {
					await fs.unlink(resolvedPath);
					results.push({ op: "delete", path: op.path, status: "ok" });
					counts.delete++;
					break;
				}

				default:
					throw new Error(`Unknown operation type: ${op.op}`);
			}
		} catch (err) {
			failed = true;
			counts.error++;
			results.push({
				op: op.op,
				path: op.path,
				status: "error",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	const totalSuccess = counts.read + counts.write + counts.edit + counts.delete;
	const summaryParts: string[] = [];
	if (counts.read > 0)
		summaryParts.push(`${counts.read} read${counts.read > 1 ? "s" : ""}`);
	if (counts.write > 0)
		summaryParts.push(
			`${counts.write} write${counts.write > 1 ? "s" : ""}`,
		);
	if (counts.edit > 0)
		summaryParts.push(
			`${counts.edit} edit${counts.edit > 1 ? "s" : ""}`,
		);
	if (counts.delete > 0)
		summaryParts.push(
			`${counts.delete} delete${counts.delete > 1 ? "s" : ""}`,
		);

	const summary =
		summaryParts.length > 0
			? `${summaryParts.join(", ")}. ${counts.error} failed.`
			: `${counts.error} failed.`;

	return { summary, results };
}

// ---------------------------------------------------------------------------
// Tool definition factory
// ---------------------------------------------------------------------------

export function createWeavePatchTool() {
	return {
		name: "weave_patch",
		label: "patch",
		description: [
			"Batch file operations: read, write, edit, or delete multiple files in a single call.",
			"Use for cross-cutting changes, multi-file refactors, or when mixing read/write/delete operations.",
			"Prefer this over separate read/write/edit calls when touching 2+ files.",
			"",
			"Operations are executed sequentially in array order.",
			"On failure, remaining operations are skipped.",
		].join("\n"),
		promptSnippet: "Batch read/write/edit/delete files in one call",
		promptGuidelines: [
			"Use weave_patch for multi-file changes, refactors, or when mixing creates/edits/deletes.",
			"Prefer weave_patch over separate write+edit calls when touching 2+ files.",
			"Each operation is independent — edits are matched against the current on-disk file, not against prior patches in the same call.",
			"For single-file edits, the edit tool is also fine. weave_patch shines for cross-cutting changes.",
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
			const args = prepared as { operations: FileOpInput[] };

			if (!Array.isArray(args.operations) || args.operations.length === 0) {
				return {
					content: [
						{ type: "text", text: "Error: operations array is required and must not be empty." },
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

			const { summary, results } = await executeOperations(args.operations, ctx.cwd);

			return {
				content: [{ type: "text", text: summary }],
				details: { results },
			};
		},
	};
}
