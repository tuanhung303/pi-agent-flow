/**
 * batch — operation execution engine.
 *
 * Orchestrates sequential file operations (read/write/edit/delete) with
 * skip-on-failure semantics, error enrichment, and result summarisation.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import {
	type FileOpInput,
	type RgOpInput,
	type ExecuteOptions,
	type ReadOptions,
	type OpResult,
	type BatchOnUpdate,
	MAX_LINES,
	MAX_BYTES,
	SAFE_FULL_READ_LIMIT,
	TARGETED_READ_LINE_LIMIT,
	MAX_TOTAL_RESULT_LINES,
	BATCH_READ_MAX_TOTAL_BYTES,
	RG_SIGNATURES_MAX_FILES,
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
import { applyPatch } from "./apply-patch.js";
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

export interface BatchError {
	error: string;
	hint: string;
	retryable: boolean;
	suggestedFix?: string;
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
	if (error.includes("is not readable") || error.includes("not readable"))
		return "Check file permissions.";
	if (error.includes("ENOENT") || error.includes("no such file"))
		return "Verify the path exists.";
	if (error.includes("is beyond end of file"))
		return "Use a smaller offset within the file length.";
	if (error.includes("ripgrep failed"))
		return "Ripgrep crashed or was killed. Try narrowing the search path or adding max-count to limit output.";
	return "";
}

function isRetryable(error: string): boolean {
	const transient = [
		"File not found",
		"file not found",
		"ENOENT",
		"no such file",
		"Could not find",
		"occurrences",
	];
	return transient.some((p) => error.includes(p));
}

// ---------------------------------------------------------------------------
// Main execute function
// ---------------------------------------------------------------------------

export async function executeOperations(
	operations: FileOpInput[],
	cwd: string,
	signal?: AbortSignal,
	options: ExecuteOptions = {},
	onUpdate?: BatchOnUpdate,
): Promise<{ summary: string; contentText: string; results: OpResult[] }> {
	const results: OpResult[] = [];
	const counts = { read: 0, write: 0, edit: 0, delete: 0, rg: 0, patch: 0, bash: 0, error: 0, skipped: 0 };
	const errors: { path: string; op: string; message: string; hint?: string }[] = [];
	const truncatedFiles: { path: string; shown: number; total: number; nextOffset?: number }[] = [];
	const aggregateLimitSkipped: { path: string }[] = [];
	const aggregateByteLimitSkipped: { path: string }[] = [];
	let aggregateLinesRead = 0;
	let aggregateBytesRead = 0;
	const includeLimitWarnings = options.includeLimitWarnings ?? true;

	let lastUpdateTime = 0;
	let finalUpdateEmitted = false;
	function emitPartialUpdate() {
		if (!onUpdate) return;
		const now = Date.now();
		const isFinal = results.length === operations.length;
		if (!isFinal && now - lastUpdateTime < 100) return;
		if (isFinal && finalUpdateEmitted) return;
		finalUpdateEmitted = isFinal;
		lastUpdateTime = now;
		const partialSummary = buildSummary(
			counts,
			errors,
			truncatedFiles,
			aggregateLimitSkipped,
			aggregateByteLimitSkipped,
		);
		const partialContentText = buildContentText(partialSummary, results);
		onUpdate({
			content: [{ type: "text", text: partialContentText }],
			details: { results: [...results] },
		});
	}

	for (let i = 0; i < operations.length; i++) {
		const op = operations[i];
		if (signal?.aborted) {
			for (let j = i; j < operations.length; j++) {
				const r = operations[j];
				results.push({ op: r.o, path: r.p, status: "skipped", error: "Operation aborted.", s: r.s, l: r.l, q: r.q });
				counts.skipped++;
			}
			emitPartialUpdate();
			break;
		}

		try {
			const { path: resolvedPath, warning: pathWarning } = await validatePath(op.p, cwd);

			switch (op.o) {
				case "read": {
					if (aggregateLinesRead >= MAX_TOTAL_RESULT_LINES) {
						const remainingOps = operations.length - i - 1;
						results.push({
							op: "read",
							path: op.p,
							status: "skipped",
							skipped: true,
							reason: "aggregate_line_limit",
							consumed: { lines: aggregateLinesRead, bytes: aggregateBytesRead },
							remainingOps,
							error: `Skipped: aggregate line limit of ${MAX_TOTAL_RESULT_LINES} reached (${aggregateLinesRead} lines consumed). ${remainingOps} remaining operation(s) will still execute. Use separate batch/batch_read calls.`,
							s: op.s,
							l: op.l,
						});
						counts.skipped++;
						aggregateLimitSkipped.push({ path: op.p });
						break;
					}

					if (aggregateBytesRead >= BATCH_READ_MAX_TOTAL_BYTES) {
						const remainingOps = operations.length - i - 1;
						results.push({
							op: "read",
							path: op.p,
							status: "skipped",
							skipped: true,
							reason: "aggregate_byte_limit",
							consumed: { lines: aggregateLinesRead, bytes: aggregateBytesRead },
							remainingOps,
							error: `Skipped: aggregate byte limit of ${BATCH_READ_MAX_TOTAL_BYTES} reached (${aggregateBytesRead} bytes consumed). ${remainingOps} remaining operation(s) will still execute. Use separate batch/batch_read calls.`,
							s: op.s,
							l: op.l,
						});
						counts.skipped++;
						aggregateByteLimitSkipped.push({ path: op.p });
						break;
					}

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

					aggregateLinesRead += linesRead;
					aggregateBytesRead += Buffer.byteLength(finalContent, "utf-8");

					results.push({
						op: "read",
						path: op.p,
						status: "ok",
						content: finalContent,
						totalLines: totalFileLines,
						warning: [pathWarning, safetyWarning].filter(Boolean).join("\n") || undefined,
						truncated: finalTruncated || undefined,
						nextOffset,
						s: op.s,
						l: op.l,
					});
					counts.read++;
					break;
				}

				case "write": {
					if (!op.c && op.c !== "") {
						throw new Error("c (content) is required for write operations.");
					}
					await withFileMutationQueue(resolvedPath, async () => {
						await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
						await fs.writeFile(resolvedPath, op.c!, "utf-8");
					});
					results.push({
						op: "write",
						path: op.p,
						status: "ok",
						bytes: Buffer.byteLength(op.c!, "utf-8"),
						warning: pathWarning,
					});
					counts.write++;
					break;
				}

				case "edit": {
					if (!op.e || op.e.length === 0) {
						throw new Error("e (edits) array is required for edit operations.");
					}
					const edits = op.e;

					const blocksChanged = await withFileMutationQueue(resolvedPath, async () => {
						const rawContent = await fs.readFile(resolvedPath, "utf-8");
						const { bom, text: contentWithoutBom } = stripBom(rawContent);
						const originalEnding = detectLineEnding(contentWithoutBom);
						const normalizedContent = normalizeToLF(contentWithoutBom);

						const { newContent, blocksChanged: changed } = applyEdits(
							normalizedContent,
							edits,
							op.p,
						);

						const finalContent = bom + restoreLineEndings(newContent, originalEnding);
						await fs.writeFile(resolvedPath, finalContent, "utf-8");
						return changed;
					});

					results.push({
						op: "edit",
						path: op.p,
						status: "ok",
						blocksChanged,
						warning: pathWarning,
					});
					counts.edit++;
					break;
				}

				case "delete": {
					await withFileMutationQueue(resolvedPath, async () => {
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
					});
					results.push({ op: "delete", path: op.p, status: "ok", warning: pathWarning });
					counts.delete++;
					break;
				}

				case "rg": {
					const rgOp = op as unknown as RgOpInput;
					if (!rgOp.q) {
						throw new Error("q (search pattern) is required for rg operations.");
					}
					const searchPath = (rgOp.p.startsWith("~") || path.isAbsolute(rgOp.p)) ? resolvedPath : rgOp.p;
					const args = buildRgArgs({ ...rgOp, p: searchPath });
					const matches = await execRg(args, cwd, signal);
					const content = matches.join("\n");

					// Try to attach enclosing signatures (only when we have line numbers)
					let enclosingSignatures: Record<string, string> | undefined;
					const uniqueFiles = extractUniqueFilesFromRg(matches);
					if (uniqueFiles.size > 0 && uniqueFiles.size <= RG_SIGNATURES_MAX_FILES && !isFilesOnlyRg(matches)) {
						enclosingSignatures = await buildEnclosingSignatures(uniqueFiles, matches, cwd);
					}

					results.push({
						op: "rg",
						path: rgOp.p,
						status: "ok",
						content,
						totalLines: matches.length,
						enclosingSignatures,
						warning: pathWarning,
						q: rgOp.q,
					});
					counts.rg++;
					break;
				}

				case "patch": {
					if (!op.c && op.c !== "") {
						throw new Error("c (patch text) is required for patch operations.");
					}
					const { affected, exact } = await applyPatch(op.c!, cwd);
					results.push({
						op: "patch",
						path: op.p,
						status: "ok",
						affected,
						exact,
						warning: pathWarning,
					});
					counts.patch++;
					break;
				}

				default:
					throw new Error(`Unknown operation type: ${op.o}`);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);

			// Treat mid-flight rg abort as skipped rather than error
			if (message === "Aborted" && signal?.aborted) {
				counts.skipped++;
				results.push({
					op: op.o,
					path: op.p,
					status: "skipped",
					error: "Operation aborted.",
				});
				continue;
			}

			counts.error++;
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

			const retryable = isRetryable(message);
			const suggestedFix = hint || undefined;

			errors.push({ path: op.p, op: op.o, message, hint });
			results.push({
				op: op.o,
				path: op.p,
				status: "error",
				error: message,
				hint,
				retryable,
				suggestedFix,
				s: op.s,
				l: op.l,
				q: op.q,
			});
		}
		emitPartialUpdate();
	}
	emitPartialUpdate();
	// Build the enhanced summary and content text
	const summary = buildSummary(counts, errors, truncatedFiles, aggregateLimitSkipped, aggregateByteLimitSkipped);
	const contentText = buildContentText(summary, results);

	return { summary, contentText, results };
}

// ---------------------------------------------------------------------------
// Summary / content rendering
// ---------------------------------------------------------------------------

function buildSummary(
	counts: { read: number; write: number; edit: number; delete: number; rg: number; patch: number; bash: number; error: number; skipped: number },
	errors: { path: string; op: string; message: string; hint?: string }[],
	truncatedFiles: { path: string; shown: number; total: number; nextOffset?: number }[],
	aggregateLimitSkipped: { path: string }[] = [],
	aggregateByteLimitSkipped: { path: string }[] = [],
): string {
	const parts: string[] = [];

	// Build success parts from counts
	const successParts: string[] = [];
	if (counts.read > 0) successParts.push(`${counts.read} read`);
	if (counts.write > 0) successParts.push(`${counts.write} write`);
	if (counts.edit > 0) successParts.push(`${counts.edit} edit`);
	if (counts.delete > 0) successParts.push(`${counts.delete} delete`);
	if (counts.rg > 0) successParts.push(`${counts.rg} rg`);
	if (counts.patch > 0) successParts.push(`${counts.patch} patch`);
	if (counts.bash > 0) successParts.push(`${counts.bash} bash`);

	// Build failure parts from errors
	const failedCounts: Record<string, number> = {};
	for (const err of errors) {
		failedCounts[err.op] = (failedCounts[err.op] || 0) + 1;
	}
	const failedParts: string[] = [];
	if (failedCounts.read > 0) failedParts.push(`${failedCounts.read} read`);
	if (failedCounts.write > 0) failedParts.push(`${failedCounts.write} write`);
	if (failedCounts.edit > 0) failedParts.push(`${failedCounts.edit} edit`);
	if (failedCounts.delete > 0) failedParts.push(`${failedCounts.delete} delete`);
	if (failedCounts.rg > 0) failedParts.push(`${failedCounts.rg} rg`);
	if (failedCounts.patch > 0) failedParts.push(`${failedCounts.patch} patch`);
	if (failedCounts.bash > 0) failedParts.push(`${failedCounts.bash} bash`);

	const hasSuccess = successParts.length > 0;
	const hasFailure = failedParts.length > 0;
	const hasSkipped = counts.skipped > 0;

	if (!hasFailure) {
		// All success (or skipped)
		const summaryParts = [...successParts];
		if (hasSkipped) summaryParts.push(`${counts.skipped} skipped`);
		parts.push(`✔ ${summaryParts.join(", ")}`);
	} else {
		// Mixed or all failed
		if (hasSuccess) {
			parts.push(`✔ ${successParts.join(", ")} | ✗ ${failedParts.join(", ")}`);
		} else {
			parts.push(`✗ ${failedParts.join(", ")}`);
		}
		if (hasSkipped) {
			parts.push(`${counts.skipped} skipped`);
		}
	}

	// Error details
	for (const err of errors) {
		const hint = err.hint ?? "";
		const hintSuffix = hint ? ` — ${hint}` : "";
		parts.push(`  ${err.op} ${err.path}: ${err.message}${hintSuffix}`);
	}

	// Truncation warnings
	for (const tf of truncatedFiles) {
		if (tf.nextOffset) {
			parts.push(
				`  ⚠ ${tf.path} truncated (${tf.shown}/${tf.total} lines) — use s=${tf.nextOffset}`,
			);
		}
	}

	// Aggregate line limit warnings
	if (aggregateLimitSkipped.length > 0) {
		parts.push(
			`  ⚠ Aggregate line limit (${MAX_TOTAL_RESULT_LINES}) reached — skipped ${aggregateLimitSkipped.length} read${aggregateLimitSkipped.length > 1 ? "s" : ""}: ${aggregateLimitSkipped.map((s) => s.path).join(", ")}`,
		);
	}

	// Aggregate byte limit warnings
	if (aggregateByteLimitSkipped.length > 0) {
		parts.push(
			`  ⚠ Aggregate byte limit (${BATCH_READ_MAX_TOTAL_BYTES}) reached — skipped ${aggregateByteLimitSkipped.length} read${aggregateByteLimitSkipped.length > 1 ? "s" : ""}: ${aggregateByteLimitSkipped.map((s) => s.path).join(", ")}`,
		);
	}

	return parts.join("\n");
}

function buildContextMapText(result: OpResult): string {
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
		} else if (r.op === "rg" && r.status === "ok") {
			if (r.enclosingSignatures && Object.keys(r.enclosingSignatures).length > 0) {
				const grouped = groupRgMatchesByFile(r.content ?? "", r.enclosingSignatures);
				sections.push(`\n--- rg: ${r.path} ---\n${grouped}`);
			} else {
				sections.push(`\n--- rg: ${r.path} ---\n${r.content}`);
			}
		} else if (r.status === "error") {
			sections.push(`\n--- ${r.op}: ${r.path} ---\nError: ${r.error}`);
		} else if (r.op === "patch" && r.status === "ok") {
			const parts: string[] = [];
			if (r.affected?.added.length) parts.push(`A ${r.affected.added.join(', ')}`);
			if (r.affected?.modified.length) parts.push(`M ${r.affected.modified.join(', ')}`);
			if (r.affected?.deleted.length) parts.push(`D ${r.affected.deleted.join(', ')}`);
			sections.push(`\n--- patch: ${r.path} ---\n${parts.join('\n')}`);
		} else if (r.status === "skipped") {
			sections.push(`\n--- ${r.op}: ${r.path} ---\n${r.error ?? "Skipped"}`);
		}
	}

	return sections.join("");
}

// ---------------------------------------------------------------------------
// ripgrep helpers
// ---------------------------------------------------------------------------

function buildRgArgs(op: RgOpInput): string[] {
	const args: string[] = [];
	args.push("-n");
	if (op.l === true || op.l === undefined) args.push("-l");
	if (op.i === true) args.push("-i");
	if (typeof op.t === "string" && op.t) args.push("-t", op.t);
	if (typeof op.n === "number" && Number.isFinite(op.n) && op.n >= 1) args.push("--max-count", String(Math.floor(op.n)));
	if (typeof op.u === "number" && op.u >= 0) {
		const uCount = Math.min(op.u + 1, 3); // ripgrep caps at -uuu
		args.push("-" + "u".repeat(uCount));
	}
	args.push("--");
	args.push(op.q);
	args.push(op.p);
	return args;
}

function isFilesOnlyRg(matches: string[]): boolean {
	// When rg runs with -l, matches are just filenames with no line numbers
	return matches.length > 0 && !matches.some((m) => m.includes(":"));
}

function extractUniqueFilesFromRg(matches: string[]): Set<string> {
	const files = new Set<string>();
	for (const m of matches) {
		const colonIdx = m.indexOf(":");
		if (colonIdx > 0) files.add(m.substring(0, colonIdx));
	}
	return files;
}

function parseRgLineNumber(match: string): number | null {
	// format: path:line:content
	const parts = match.split(":");
	if (parts.length < 3) return null;
	const lineNum = parseInt(parts[1], 10);
	return Number.isFinite(lineNum) ? lineNum : null;
}

function parseRgFilePath(match: string): string | null {
	const colonIdx = match.indexOf(":");
	return colonIdx > 0 ? match.substring(0, colonIdx) : null;
}

async function buildEnclosingSignatures(
	files: Set<string>,
	matches: string[],
	cwd: string,
): Promise<Record<string, string>> {
	const sigMap: Record<string, string> = {};
	for (const filePath of files) {
		try {
			const abs = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
			const raw = await fs.readFile(abs, "utf-8");
			const lines = raw.split("\n");
			const ctxMap = buildFileContextMap(filePath, lines);
			if (!ctxMap.symbols || ctxMap.symbols.length === 0) continue;

			// For each match line in this file, find enclosing symbol
			for (const match of matches) {
				const lineNum = parseRgLineNumber(match);
				if (lineNum === null) continue;
				const matchPath = parseRgFilePath(match);
				if (matchPath !== filePath) continue;

				const enclosing = ctxMap.symbols
				.filter(
					(s) => lineNum >= s.startLine && lineNum <= s.endLine,
				)
				.sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
			if (enclosing?.signature) {
					sigMap[match] = enclosing.signature;
				}
			}
		} catch {
			// File not readable, skip
		}
	}
	return sigMap;
}

function groupRgMatchesByFile(content: string, sigMap: Record<string, string>): string {
	// Group matches by file, deduplicate signatures per file
	const fileGroups = new Map<string, { sigs: Set<string>; lines: string[] }>();
	for (const match of content.split("\n").filter(Boolean)) {
		const filePath = parseRgFilePath(match);
		if (!filePath) {
			// Fallback: keep bare match as-is
			const fallbackKey = "";
			const group = fileGroups.get(fallbackKey) ?? { sigs: new Set<string>(), lines: [] };
			group.lines.push(match);
			fileGroups.set(fallbackKey, group);
			continue;
		}
		const group = fileGroups.get(filePath) ?? { sigs: new Set<string>(), lines: [] };
		const sig = sigMap[match];
		if (sig) group.sigs.add(sig);
		group.lines.push(match);
		fileGroups.set(filePath, group);
	}

	const out: string[] = [];
	for (const [filePath, { sigs, lines }] of fileGroups) {
		if (!filePath) {
			out.push(...lines);
			continue;
		}
		out.push(filePath);
		for (const sig of sigs) {
			out.push(`  ${sig}`);
		}
		for (const line of lines) {
			const colonIdx = line.indexOf(":");
			const afterPath = colonIdx > 0 ? line.substring(colonIdx + 1) : line;
			out.push(`  → ${afterPath}`);
		}
	}
	return out.join("\n");
}

function execRg(args: string[], cwd: string, signal?: AbortSignal): Promise<string[]> {
	return new Promise((resolve, reject) => {
		const child = execFile("rg", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				// ripgrep exits with code 1 when no matches are found
				if ((err as any).code === 1) {
					resolve([]);
					return;
				}
				if ((err as any).code === "ENOBUFS" || (err as any).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
					reject(new Error("ripgrep output exceeded 10MB buffer limit. Use a more specific pattern or add max-count."));
					return;
				}
				if ((err as any).code === "ENOENT") {
					reject(new Error("ripgrep (rg) binary not found. Please install ripgrep."));
					return;
				}
				const stderrMsg = stderr?.trim() ? ` — ${stderr.trim()}` : "";
				const codeInfo = (err as any).code ? ` (code: ${(err as any).code})` : "";
				const msgInfo = err.message ? `: ${err.message}` : "";
				reject(new Error(`ripgrep failed${codeInfo}${msgInfo}${stderrMsg}`));
				return;
			}
			const lines = stdout.split("\n").filter((line) => line.length > 0);
			resolve(lines);
		});
		if (signal) {
			const onAbort = () => {
				try { child.kill("SIGTERM"); } catch { /* already dead */ }
				reject(new Error("Aborted"));
			};
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
				child.on("close", () => signal.removeEventListener("abort", onAbort));
			}
		}
	});
}
