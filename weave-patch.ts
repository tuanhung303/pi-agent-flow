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
	]),
	p: Type.String({ description: "Path to the file (relative or absolute)" }),
	c: Type.Optional(
		Type.String({
			description:
				"Full file content. Creates if new, overwrites if exists. Auto-creates parent dirs. Used with o: 'write'.",
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
});

export const WeavePatchParams = Type.Object({
	op: Type.Array(FileOp, {
		description:
			"Ordered list of file operations. Executed sequentially. On failure, remaining operations are skipped.",
	}),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EditReplacement {
	f: string;
	r: string;
}

interface FileOpInput {
	o: "read" | "write" | "edit" | "delete";
	p: string;
	c?: string;
	e?: EditReplacement[];
	s?: number;
	l?: number;
}

interface OpResult {
	op: "read" | "write" | "edit" | "delete";
	path: string;
	status: "ok" | "error" | "skipped";
	content?: string;
	bytes?: number;
	blocksChanged?: number;
	diff?: string;
	totalLines?: number;
	truncated?: boolean;
	nextOffset?: number;
	error?: string;
	hint?: string;
}

interface ReadTruncationResult {
	content: string;
	truncated: boolean;
	nextOffset?: number;
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

function readWithOffsetLimit(
	content: string,
	offset?: number,
	limit?: number,
): ReadTruncationResult {
	const allLines = content.split("\n");
	const totalFileLines = allLines.length;

	// Validate offset
	if (offset !== undefined && offset > totalFileLines) {
		throw new Error(
			`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`,
		);
	}

	// Determine the start line (convert 1-indexed to 0-indexed)
	const startLine = offset !== undefined ? Math.max(0, offset - 1) : 0;

	// Determine end line
	let endLine = totalFileLines;
	if (limit !== undefined) {
		endLine = Math.min(startLine + limit, totalFileLines);
	}

	let selectedLines = allLines.slice(startLine, endLine);
	let truncated = false;
	let nextOffset: number | undefined;

	// Apply max-lines cap
	if (selectedLines.length > MAX_LINES) {
		selectedLines = selectedLines.slice(0, MAX_LINES);
		truncated = true;
	}

	// Join and check byte size
	let result = selectedLines.join("\n");

	// If first line alone exceeds byte limit, give a specific hint
	if (selectedLines.length >= 1 && Buffer.byteLength(selectedLines[0], "utf-8") > MAX_BYTES) {
		const startLineDisplay = startLine + 1;
		throw new Error(
			`Line ${startLineDisplay} exceeds limit. Use bash: head -c ... ${content.length > 0 ? "<path>" : "<file>"}`,
		);
	}

	// Truncate by bytes if needed
	if (Buffer.byteLength(result, "utf-8") > MAX_BYTES) {
		let byteAccum = 0;
		let keepLines = 0;
		for (let i = 0; i < selectedLines.length; i++) {
			byteAccum += Buffer.byteLength(selectedLines[i], "utf-8") + 1; // +1 for \n
			if (byteAccum > MAX_BYTES) break;
			keepLines = i + 1;
		}
		selectedLines = selectedLines.slice(0, keepLines);
		result = selectedLines.join("\n");
		truncated = true;
	}

	// Calculate nextOffset for continuation
	const lastLineRead = startLine + selectedLines.length;
	if (truncated || (limit !== undefined && lastLineRead < totalFileLines)) {
		nextOffset = lastLineRead + 1; // 1-indexed
	}

	// Append truncation/continuation hints
	if (truncated) {
		const endDisplay = startLine + selectedLines.length;
		const startDisplay = startLine + 1;
		result += `\n\n[Showing lines ${startDisplay}-${endDisplay} of ${totalFileLines}. Use s=${nextOffset} to continue.]`;
	} else if (limit !== undefined && lastLineRead < totalFileLines) {
		const remaining = totalFileLines - lastLineRead;
		result += `\n\n[${remaining} more lines in file. Use s=${nextOffset} to continue.]`;
	}

	return { content: result, truncated, nextOffset };
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

// Insert before getErrorHint function (line 230)

function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
	for (let i = 0; i <= m; i++) dp[i][0] = i;
	for (let j = 0; j <= n; j++) dp[0][j] = j;
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] =
				a[i - 1] === b[j - 1]
					? dp[i - 1][j - 1]
					: 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
		}
	}
	return dp[m][n];
}

/**
 * Scan the parent directory (or cwd) for files with similar names.
 * Returns up to 3 suggestions sorted by similarity.
 */
export async function suggestSimilarFiles(
	inputPath: string,
	cwd: string,
): Promise<string[]> {
	const resolved = path.resolve(cwd, inputPath);
	const dir = path.dirname(resolved);
	const target = path.basename(resolved);

	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		const candidates: { name: string; dist: number }[] = [];

		for (const entry of entries) {
			const name = entry.name;
			// Skip hidden files and node_modules
			if (name.startsWith(".") || name === "node_modules") continue;

			const dist = levenshtein(target.toLowerCase(), name.toLowerCase());
			const maxLen = Math.max(target.length, name.length);
			// Only suggest if reasonably similar (within 40% edit distance, or shares prefix)
			if (dist <= Math.ceil(maxLen * 0.4) || name.startsWith(target.slice(0, 3))) {
				candidates.push({ name: entry.isDirectory() ? name + "/" : name, dist });
			}
		}

		return candidates
			.sort((a, b) => a.dist - b.dist)
			.slice(0, 3)
			.map((c) => path.join(path.relative(cwd, dir), c.name));
	} catch {
		return [];
	}
}
function getErrorHint(error: string): string {
	if (error.includes("File not found") || error.includes("file not found"))
		return "Verify the path exists.";
	if (error.includes("Could not find"))
		return "Re-read the file first, then retry with exact f (oldText).";
	if (error.includes("occurrences"))
		return "Add more surrounding context to make oldText unique.";
	if (error.includes("overlap"))
		return "Merge overlapping edits into one.";
	if (error.includes("No changes"))
		return "File already has this content. No edit needed.";
	if (error.includes("Path traversal"))
		return "Use a path within the working directory.";
	if (error.includes("is not readable") || error.includes("not readable"))
		return "Check file permissions.";
	if (error.includes("ENOENT") || error.includes("no such file"))
		return "Verify the path exists.";
	if (error.includes("is beyond end of file"))
		return "Use a smaller offset within the file length.";
	return "";
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
		oldText: normalizeToLF(e.f),
		newText: normalizeToLF(e.r),
	}));

	// Validate non-empty
	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw new Error(`edits[${i}].f (oldText) must not be empty in ${filePath}.`);
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
					: `Could not find edits[${i}] in ${filePath}. The f (oldText) must match exactly including all whitespace and newlines.`,
			);
		}

		const occurrences = countOccurrences(baseContent, edit.oldText);
		if (occurrences > 1) {
			throw new Error(
				edits.length === 1
					? `Found ${occurrences} occurrences of the text in ${filePath}. The text must be unique. Please provide more context to make it unique.`
					: `Found ${occurrences} occurrences of edits[${i}] in ${filePath}. Each f (oldText) must be unique. Please provide more context to make it unique.`,
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

/**
 * Normalize a single operation object from any legacy format to the new
 * single-letter canonical form: { o, p, c, e, s, l }.
 */
function normalizeOp(raw: Record<string, unknown>): Record<string, unknown> {
	const op: Record<string, unknown> = {};

	// Map operation type
	op.o = raw.o ?? raw.op ?? (raw.c || raw.content ? "write" : (raw.e || raw.edits ? "edit" : "read"));

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

function prepareArguments(input: unknown): unknown {
	if (!input || typeof input !== "object") return input;

	const args = input as Record<string, unknown>;

	// Handle legacy top-level format: { path, oldText, newText }
	if (
		typeof args.oldText === "string" &&
		typeof args.newText === "string" &&
		typeof args.path === "string"
	) {
		return [
			normalizeOp({
				o: "edit",
				p: args.path,
				e: [{ oldText: args.oldText, newText: args.newText }],
			}),
		];
	}

	// Unwrap to op array — canonical { op: [...] }, legacy { operations: [...] }, or bare array
	let opsArray: unknown[];
	if (Array.isArray(args.op)) {
		opsArray = args.op;
	} else if (Array.isArray(args.operations)) {
		opsArray = args.operations;
	} else if (Array.isArray(args)) {
		opsArray = args;
	} else if (typeof args.p === "string" || typeof args.path === "string") {
		// Single-operation shorthand: { p: "...", o: "read" }
		opsArray = [args];
	} else {
		return input;
	}

	// Normalize each operation to single-letter form
	return opsArray.map((op: unknown) => {
		if (!op || typeof op !== "object") return op;
		return normalizeOp(op as Record<string, unknown>);
	});
}

// ---------------------------------------------------------------------------
// Main execute function
// ---------------------------------------------------------------------------

async function executeOperations(
	operations: FileOpInput[],
	cwd: string,
): Promise<{ summary: string; contentText: string; results: OpResult[] }> {
	const results: OpResult[] = [];
	let failed = false;

	const counts = { read: 0, write: 0, edit: 0, delete: 0, error: 0, skipped: 0 };
	const errors: { path: string; op: string; message: string }[] = [];
	const truncatedFiles: { path: string; shown: number; total: number; nextOffset?: number }[] = [];

	for (const op of operations) {
		if (failed) {
			results.push({ op: op.o, path: op.p, status: "skipped" });
			counts.skipped++;
			continue;
		}

		try {
			const resolvedPath = validatePath(op.p, cwd);

			switch (op.o) {
				case "read": {
					// Access check before reading
					try {
						await fs.access(resolvedPath);
					} catch {
						throw new Error(`File not found: ${op.p}`);
					}
					try {
						await fs.access(resolvedPath, fs.constants.R_OK);
					} catch {
						throw new Error(`File not readable: ${op.p}`);
					}

					const rawContent = await fs.readFile(resolvedPath, "utf-8");
					const { text } = stripBom(rawContent);
					const allLines = text.split("\n");
					const totalFileLines = allLines.length;

					const { content: readContent, truncated, nextOffset } =
						readWithOffsetLimit(text, op.s, op.l);

					if (truncated || (op.l !== undefined && (op.s ?? 1) - 1 + op.l < totalFileLines)) {
						const shownLines = truncated
							? (op.l !== undefined
									? Math.min(op.l, MAX_LINES)
									: MAX_LINES)
							: op.l!;
						truncatedFiles.push({
							path: op.p,
							shown: shownLines,
							total: totalFileLines,
							nextOffset,
						});
					}

					results.push({
						op: "read",
						path: op.p,
						status: "ok",
						content: readContent,
						totalLines: totalFileLines,
						truncated: truncated || undefined,
						nextOffset,
					});
					counts.read++;
					break;
				}

				case "write": {
					if (!op.c && op.c !== "") {
						throw new Error("c (content) is required for write operations.");
					}
					await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
					await fs.writeFile(resolvedPath, op.c!, "utf-8");
					results.push({
						op: "write",
						path: op.p,
						status: "ok",
						bytes: Buffer.byteLength(op.c!, "utf-8"),
					});
					counts.write++;
					break;
				}

				case "edit": {
					if (!op.e || op.e.length === 0) {
						throw new Error("e (edits) array is required for edit operations.");
					}

					const rawContent = await fs.readFile(resolvedPath, "utf-8");
					const { bom, text: contentWithoutBom } = stripBom(rawContent);
					const originalEnding = detectLineEnding(contentWithoutBom);
					const normalizedContent = normalizeToLF(contentWithoutBom);

					const { newContent, diffSummary, blocksChanged } = applyEdits(
						normalizedContent,
						op.e,
						op.p,
					);

					const finalContent = bom + restoreLineEndings(newContent, originalEnding);
					await fs.writeFile(resolvedPath, finalContent, "utf-8");

					results.push({
						op: "edit",
						path: op.p,
						status: "ok",
						blocksChanged,
						diff: diffSummary,
					});
					counts.edit++;
					break;
				}

				case "delete": {
					await fs.unlink(resolvedPath);
					results.push({ op: "delete", path: op.p, status: "ok" });
					counts.delete++;
					break;
				}

				default:
					throw new Error(`Unknown operation type: ${op.op}`);
			}
		} catch (err) {
			failed = true;
			counts.error++;
			const message = err instanceof Error ? err.message : String(err);
			errors.push({ path: op.p, op: op.o, message });

			// Enrich file-not-found errors with fuzzy filename suggestions
			let hint = getErrorHint(message);
			if (
				message.includes("File not found") ||
				message.includes("file not found") ||
				message.includes("ENOENT") ||
				message.includes("no such file")
			) {
				const suggestions = await suggestSimilarFiles(op.p, cwd);
				if (suggestions.length > 0) {
					hint += ` Did you mean: ${suggestions.join(", ")}?`;
				}
			}

			results.push({
				op: op.o,
				path: op.p,
				status: "error",
				error: message,
				hint,
			});
		}
	}

	// Build the enhanced summary and content text
	const summary = buildSummary(counts, errors, truncatedFiles);
	const contentText = buildContentText(summary, results);

	return { summary, contentText, results };
}

function buildSummary(
	counts: { read: number; write: number; edit: number; delete: number; error: number; skipped: number },
	errors: { path: string; op: string; message: string }[],
	truncatedFiles: { path: string; shown: number; total: number; nextOffset?: number }[],
): string {
	const totalSuccess =
		counts.read + counts.write + counts.edit + counts.delete;
	const totalOps = totalSuccess + counts.error + counts.skipped;

	const parts: string[] = [];

	// Build the success breakdown
	const successParts: string[] = [];
	if (counts.read > 0)
		successParts.push(
			`${counts.read} read${counts.read > 1 ? "s" : ""}`,
		);
	if (counts.write > 0)
		successParts.push(
			`${counts.write} write${counts.write > 1 ? "s" : ""}`,
		);
	if (counts.edit > 0)
		successParts.push(
			`${counts.edit} edit${counts.edit > 1 ? "s" : ""}`,
		);
	if (counts.delete > 0)
		successParts.push(
			`${counts.delete} delete${counts.delete > 1 ? "s" : ""}`,
		);

	if (counts.error === 0) {
		// All success
		parts.push(`✓ ${totalOps} operations: ${successParts.join(", ")}`);
	} else {
		// Mixed success/failure
		parts.push(
			`✗ ${counts.error} failed${counts.skipped > 0 ? `, ${counts.skipped} skipped` : ""}`,
		);
		if (totalSuccess > 0) {
			parts.push(`  ✓ ${successParts.join(", ")} ok`);
		}
		for (const err of errors) {
			const hint = getErrorHint(err.message);
			const hintSuffix = hint ? ` — ${hint}` : "";
			parts.push(`  ✗ ${err.op} ${err.path}: ${err.message}${hintSuffix}`);
		}
	}

	// Truncation warnings
	for (const tf of truncatedFiles) {
		if (tf.nextOffset) {
			parts.push(
				`  ⚠ ${tf.path} truncated (${tf.shown}/${tf.total} lines) — use s=${tf.nextOffset}`,
			);
		}
	}

	return parts.join("\n");
}

function buildContentText(summary: string, results: OpResult[]): string {
	const sections: string[] = [summary];

	for (const r of results) {
		if (r.op === "read" && r.status === "ok" && r.content) {
			const lineInfo = r.totalLines !== undefined ? ` (${r.totalLines} lines)` : "";
			sections.push(`\n--- ${r.path}${lineInfo} ---\n${r.content}`);
		} else if (r.op === "edit" && r.status === "ok") {
			const diffInfo = r.diff ? ` — ${r.diff}` : "";
			const blockInfo = r.blocksChanged !== undefined ? `${r.blocksChanged} block${r.blocksChanged > 1 ? "s" : ""}` : "";
			sections.push(`\n--- edit: ${r.path} (${blockInfo}${diffInfo}) ---`);
		} else if (r.op === "write" && r.status === "ok") {
			sections.push(`\n--- write: ${r.path} (${r.bytes ?? 0} bytes) ---`);
		} else if (r.op === "delete" && r.status === "ok") {
			sections.push(`\n--- delete: ${r.path} ---`);
		} else if (r.status === "error") {
			sections.push(`\n--- ${r.op}: ${r.path} ---\nError: ${r.error}`);
		}
	}

	return sections.join("");
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
			"Pass an object with an `op` array. Operations are executed sequentially in array order.",
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
			const ops = prepared as FileOpInput[];

			if (!Array.isArray(ops) || ops.length === 0) {
				return {
					content: [
						{ type: "text", text: "Error: op array is required and must not be empty." },
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

			const { contentText, results } = await executeOperations(ops, ctx.cwd);

			return {
				content: [{ type: "text", text: contentText }],
				details: { results },
			};
		},
	};
}
