/**
 * batch — operation execution engine.
 *
 * Orchestrates sequential file operations (read/write/edit/delete) with
 * skip-on-failure semantics, error enrichment, and result summarisation.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type FileOpInput,
	type ExecuteOptions,
	type ReadOptions,
	type OpResult,
	MAX_LINES,
	MAX_BYTES,
	SAFE_FULL_READ_LIMIT,
	TARGETED_READ_LINE_LIMIT,
} from "./constants.js";
import {
	normalizeToLF,
	restoreLineEndings,
	detectLineEnding,
	stripBom,
	applyEdits,
	levenshtein,
	expandTilde,
	validatePath,
} from "./fuzzy-edit.js";
import { buildFileContextMap } from "./symbols.js";

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

function isBatchRead(options: ExecuteOptions): boolean {
	return options.readOptions?.toolName === "batch_read";
}

function isFullFileRead(op: FileOpInput, totalLines: number): boolean {
	const start = op.s ?? 1;
	if (start !== 1) return false;
	return op.l === undefined || op.l >= totalLines;
}

function buildBatchReadSafetyWarning(): string {
	return `[batch_read safety] Raw content truncated at ${TARGETED_READ_LINE_LIMIT} lines to preserve context. Adjust your 's' and 'l' parameters to read further.`;
}

export function readWithOffsetLimit(
	content: string,
	offset?: number,
	limit?: number,
	filePath?: string,
	options: ReadOptions = {},
): { content: string; truncated: boolean; nextOffset?: number; linesRead: number } {
	const allLines = content.split("\n");
	const totalFileLines = allLines.length;
	const shouldTruncate = options.truncate !== false;
	const toolName = options.toolName ?? "batch";

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

	// Apply max-lines cap for regular batch reads. batch_read clamps oversized
	// targeted reads before this helper and context-maps large full-file reads.
	if (shouldTruncate && selectedLines.length > MAX_LINES) {
		selectedLines = selectedLines.slice(0, MAX_LINES);
		truncated = true;
	}

	// A single selected line that exceeds the byte cap is not safely splittable by
	// line-oriented offsets, so keep the existing hard error in both modes.
	for (let i = 0; i < selectedLines.length; i++) {
		if (Buffer.byteLength(selectedLines[i], "utf-8") > MAX_BYTES) {
			const lineDisplay = startLine + i + 1;
			throw new Error(
				`Line ${lineDisplay} exceeds limit. Try: ${toolName} with o:"read", s:${lineDisplay}, l:10, or use bash: head -c ... ${filePath ?? "<file>"}`,
			);
		}
	}

	// Join and check byte size
	let result = selectedLines.join("\n");

	// Truncate by total bytes for regular batch reads only. batch_read relies on
	// its line-oriented safety guards and still rejects an individual huge line.
	if (shouldTruncate && Buffer.byteLength(result, "utf-8") > MAX_BYTES) {
		let byteAccum = 0;
		let keepLines = 0;
		for (let i = 0; i < selectedLines.length; i++) {
			byteAccum += Buffer.byteLength(selectedLines[i], "utf-8") + (i > 0 ? 1 : 0); // newline separator between lines
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

	return { content: result, truncated, nextOffset, linesRead: selectedLines.length };
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Error hints
// ---------------------------------------------------------------------------

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
	if (error.includes("is not readable") || error.includes("not readable"))
		return "Check file permissions.";
	if (error.includes("ENOENT") || error.includes("no such file"))
		return "Verify the path exists.";
	if (error.includes("is beyond end of file"))
		return "Use a smaller offset within the file length.";
	return "";
}

// ---------------------------------------------------------------------------
// Main execute function
// ---------------------------------------------------------------------------

export async function executeOperations(
	operations: FileOpInput[],
	cwd: string,
	signal?: AbortSignal,
	options: ExecuteOptions = {},
): Promise<{ summary: string; contentText: string; results: OpResult[] }> {
	const results: OpResult[] = [];
	let failed = false;

	const counts = { read: 0, write: 0, edit: 0, delete: 0, error: 0, skipped: 0 };
	const errors: { path: string; op: string; message: string; hint?: string }[] = [];
	const truncatedFiles: { path: string; shown: number; total: number; nextOffset?: number }[] = [];
	const includeLimitWarnings = options.includeLimitWarnings ?? true;

	for (const op of operations) {
		if (signal?.aborted) {
			results.push({ op: op.o, path: op.p, status: "skipped", error: "Operation aborted." });
			counts.skipped++;
			continue;
		}

		if (failed) {
			results.push({ op: op.o, path: op.p, status: "skipped" });
			counts.skipped++;
			continue;
		}

		try {
			const resolvedPath = await validatePath(op.p, cwd);

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

					if (isBatchRead(options) && isFullFileRead(op, totalFileLines) && totalFileLines > SAFE_FULL_READ_LIMIT) {
						const context = buildFileContextMap(op.p, allLines);
						results.push({
							op: "read",
							path: op.p,
							status: "ok",
							totalLines: totalFileLines,
							contextMap: true,
							language: context.language !== "plain" ? context.language : undefined,
							symbols: context.symbols.length > 0 ? context.symbols : undefined,
							symbolsTruncated: context.symbolsTruncated,
						});
						counts.read++;
						break;
					}

					let effectiveLimit = op.l;
					let safetyTruncated = false;
					let safetyWarning: string | undefined;
					if (isBatchRead(options) && !isFullFileRead(op, totalFileLines)) {
						if (effectiveLimit === undefined || effectiveLimit > TARGETED_READ_LINE_LIMIT) {
							effectiveLimit = TARGETED_READ_LINE_LIMIT;
							safetyTruncated = true;
							safetyWarning = buildBatchReadSafetyWarning();
						}
					}

					const { content: readContent, truncated, nextOffset, linesRead } =
						readWithOffsetLimit(text, op.s, effectiveLimit, op.p, options.readOptions);
					const finalContent = safetyWarning
						? `${readContent}\n\n${safetyWarning}`
						: readContent;
					const finalTruncated = truncated || safetyTruncated;

					if (finalTruncated || (includeLimitWarnings && effectiveLimit !== undefined && (op.s ?? 1) - 1 + effectiveLimit < totalFileLines)) {
						const shownLines = finalTruncated ? linesRead : effectiveLimit!;
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
						content: finalContent,
						totalLines: totalFileLines,
						warning: safetyWarning,
						truncated: finalTruncated || undefined,
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

					const { newContent, blocksChanged } = applyEdits(
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
					});
					counts.edit++;
					break;
				}

				case "delete": {
					let stat;
					try {
						stat = await fs.lstat(resolvedPath);
					} catch (err: any) {
						if (err.code === "ENOENT") {
							throw new Error(`File not found: ${op.p}`);
						}
						throw err;
					}
					if (stat.isDirectory()) {
						throw new Error(`Cannot delete directory: ${op.p}. Use a recursive removal tool or delete files individually.`);
					}
					await fs.unlink(resolvedPath);
					results.push({ op: "delete", path: op.p, status: "ok" });
					counts.delete++;
					break;
				}

				default:
					throw new Error(`Unknown operation type: ${op.o}`);
			}
		} catch (err) {
			failed = true;
			counts.error++;
			const message = err instanceof Error ? err.message : String(err);

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

			errors.push({ path: op.p, op: op.o, message, hint });
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

// ---------------------------------------------------------------------------
// Summary / content rendering
// ---------------------------------------------------------------------------

function buildSummary(
	counts: { read: number; write: number; edit: number; delete: number; error: number; skipped: number },
	errors: { path: string; op: string; message: string; hint?: string }[],
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
			const hint = err.hint ?? "";
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

export function buildContextMapText(result: OpResult): string {
	const title = result.language || result.symbols ? "context map" : "file summary";
	const lines: string[] = [`\n--- ${result.path} ${title} ---`];
	lines.push(`Total lines: ${result.totalLines ?? 0}`);
	if (result.language) lines.push(`Language: ${result.language}`);
	lines.push("");
	lines.push(`Full-file content omitted because file exceeds SAFE_FULL_READ_LIMIT=${SAFE_FULL_READ_LIMIT} lines.`);
	lines.push("Use targeted reads with s/l, for example:");
	lines.push(`{ "o": "read", "p": "${result.path}", "s": <startLine>, "l": <lineCount> }`);

	if (result.symbols && result.symbols.length > 0) {
		lines.push("");
		lines.push("Context map:");
		for (const entry of result.symbols) {
			lines.push(`- ${entry.kind} ${entry.name} ${entry.startLine}-${entry.endLine}`);
		}
		if (result.symbolsTruncated) {
			lines.push(`... [Context map truncated. Over ${100} entries detected. Use targeted reads to explore further.]`);
		}
	} else if (result.language) {
		lines.push("");
		lines.push("No context map entries detected for this structured file.");
	}

	return lines.join("\n");
}

function buildContentText(summary: string, results: OpResult[]): string {
	const sections: string[] = [summary];

	for (const r of results) {
		if (r.op === "read" && r.status === "ok" && r.contextMap) {
			sections.push(buildContextMapText(r));
		} else if (r.op === "read" && r.status === "ok" && r.content) {
			const lineInfo = r.totalLines !== undefined ? ` (${r.totalLines} lines)` : "";
			sections.push(`\n--- ${r.path}${lineInfo} ---\n${r.content}`);
		} else if (r.op === "edit" && r.status === "ok") {
			const blockInfo = r.blocksChanged !== undefined ? `${r.blocksChanged} block${r.blocksChanged > 1 ? "s" : ""}` : "";
			sections.push(`\n--- edit: ${r.path} (${blockInfo}) ---`);
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
