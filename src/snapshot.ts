/**
 * Session snapshot building, sanitization, and tool result compression.
 *
 * Extracted from index.ts for single-responsibility and testability.
 */

import {
	type CompressedFlowResult,
	isFlowError,
} from "./types.js";
import { stripReasoningFromAssistantMessage } from "./reasoning-strip.js";
import {
	stripSlidingPromptFromContent,
	contentContainsSlidingTag,
	isJsonEqual,
} from "./sliding-prompt.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionSnapshotSource {
	getHeader: () => unknown;
	getBranch: () => unknown[];
}

// ---------------------------------------------------------------------------
// Session snapshot serialization
// ---------------------------------------------------------------------------

export function buildForkSessionSnapshotJsonl(
	sessionManager: SessionSnapshotSource,
): string | null {
	const header = sessionManager.getHeader();
	if (!header || typeof header !== "object") return null;

	const branchEntries = sessionManager.getBranch();
	const lines = [JSON.stringify(header)];
	for (const entry of branchEntries) lines.push(JSON.stringify(entry));
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Flow result compression
// ---------------------------------------------------------------------------

/**
 * Render a compressed flow result as compact text for child context.
 */
export function renderCompressedFlowResult(r: CompressedFlowResult): string {
	const parts: string[] = [`[Flow: ${r.type} ${r.status}]`];
	if (r.files?.length) {
		const fileLines = r.files.map((f) => {
			const role = f.role ? ` (${f.role})` : "";
			const desc = f.description ? ` — ${f.description}` : "";
			return `  ${f.path}${role}${desc}`;
		});
		parts.push(`Files:\n${fileLines.join("\n")}`);
	}
	if (r.commands?.length) {
		const cmdLines = r.commands.map((c) => `  ${c.tool ?? "cmd"}: ${c.command}`);
		parts.push(`Commands:\n${cmdLines.join("\n")}`);
	}
	if (r.error) parts.push(`Error: ${r.error}`);
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// batch_read result compression
// ---------------------------------------------------------------------------

/**
 * Extract file paths from a batch_read tool call's arguments.
 * Handles both { o: [...] } and bare array argument formats.
 */
function extractBatchReadPaths(args: unknown): string[] {
	if (!args || typeof args !== "object") return [];

	let ops: unknown[];
	if (Array.isArray(args)) {
		ops = args;
	} else if (Array.isArray((args as Record<string, unknown>).o)) {
		ops = (args as Record<string, unknown>).o as unknown[];
	} else {
		return [];
	}

	const paths: string[] = [];
	for (const op of ops) {
		if (!op || typeof op !== "object") continue;
		const p = (op as Record<string, unknown>).p;
		if (typeof p === "string" && p) paths.push(p);
	}
	return paths;
}

/**
 * Render a compressed batch_read result as compact metadata for child context.
 * Format: [batch_read] N ops → paths: file1.ts, file2.ts, …
 */
function renderCompressedBatchReadResult(paths: string[]): string {
	const MAX_PATHS_DISPLAY = 10;
	const display = paths.slice(0, MAX_PATHS_DISPLAY);
	const suffix = paths.length > MAX_PATHS_DISPLAY ? `, … +${paths.length - MAX_PATHS_DISPLAY} more` : "";
	return `[batch_read] ${paths.length} ops → paths: ${display.join(", ")}${suffix}`;
}

// ---------------------------------------------------------------------------
// Shared: toolCallId → toolName mapping
// ---------------------------------------------------------------------------

/**
 * Build a map from toolCallId → toolName by scanning assistant messages.
 */
function buildToolCallIdToNameMap(lines: string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const line of lines) {
		let entry: any;
		try { entry = JSON.parse(line); } catch { continue; }
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part.type === "toolCall" && part.toolCallId && part.name) {
				map.set(part.toolCallId, part.name);
			}
		}
	}
	return map;
}

// ---------------------------------------------------------------------------
// Tool result compression (flow + batch_read)
// ---------------------------------------------------------------------------

/**
 * Compress tool results in a sanitized session snapshot.
 *
 * Handles two tool types:
 * - `flow` results: replaced with compact CompressedFlowResult output from cache.
 * - `batch_read` results: replaced with compact metadata (paths + op count)
 *   since children have `batch` and can re-read files themselves.
 */
export function compressToolResults(snapshot: string, cache: Map<string, CompressedFlowResult[]>): string {
	const lines = snapshot.trimEnd().split("\n");

	// Quick check: if there are no flow cache entries and no batch_read tool calls,
	// nothing to compress — return early.
	if (cache.size === 0) {
		const hasBatchRead = lines.some((line) => {
			try {
				const entry = JSON.parse(line);
				return entry?.type === "message" && entry.message?.role === "assistant" &&
					Array.isArray(entry.message.content) &&
					entry.message.content.some((p: any) => p.type === "toolCall" && p.name === "batch_read");
			} catch { return false; }
		});
		if (!hasBatchRead) return snapshot;
	}

	// Build toolCallId → toolName mapping
	const toolCallIdToName = buildToolCallIdToNameMap(lines);

	// Also build toolCallId → arguments mapping for batch_read path extraction
	const toolCallIdToArgs = new Map<string, unknown>();
	for (const line of lines) {
		let entry: any;
		try { entry = JSON.parse(line); } catch { continue; }
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part.type === "toolCall" && part.toolCallId && part.name === "batch_read" && part.arguments) {
				toolCallIdToArgs.set(part.toolCallId, part.arguments);
			}
		}
	}

	const result: string[] = [];

	// Second pass: compress matching tool results
	for (const line of lines) {
		let entry: any;
		try { entry = JSON.parse(line); } catch { result.push(line); continue; }

		if (entry?.type !== "message" || entry.message?.role !== "tool") {
			result.push(line);
			continue;
		}

		// Extract toolCallId — either from message-level or content-level toolResult
		let toolCallId: string | undefined;
		if (typeof entry.message.toolCallId === "string") {
			toolCallId = entry.message.toolCallId;
		} else if (Array.isArray(entry.message.content)) {
			for (const part of entry.message.content) {
				if (part.type === "toolResult" && part.toolCallId) {
					toolCallId = part.toolCallId;
					break;
				}
			}
		}

		if (!toolCallId) { result.push(line); continue; }

		const toolName = toolCallIdToName.get(toolCallId);

		// --- Compress flow tool results ---
		if (toolName === "flow") {
			const compressed = cache.get(toolCallId);
			if (!compressed || compressed.length === 0) { result.push(line); continue; }

			const rendered = compressed.map(renderCompressedFlowResult).join("\n\n");

			if (typeof entry.message.toolCallId === "string") {
				entry = {
					...entry,
					message: {
						...entry.message,
						content: [{ type: "text", text: rendered }],
					},
				};
			} else {
				entry = {
					...entry,
					message: {
						...entry.message,
						content: entry.message.content.map((part: any) =>
							part.type === "toolResult" && part.toolCallId === toolCallId
								? { ...part, content: rendered }
								: part,
						),
					},
				};
			}

			result.push(JSON.stringify(entry));
			continue;
		}

		// --- Compress batch_read tool results ---
		if (toolName === "batch_read") {
			const args = toolCallIdToArgs.get(toolCallId);
			const paths = extractBatchReadPaths(args);
			const rendered = paths.length > 0
				? renderCompressedBatchReadResult(paths)
				: "[batch_read] result compressed";

			if (typeof entry.message.toolCallId === "string") {
				entry = {
					...entry,
					message: {
						...entry.message,
						content: [{ type: "text", text: rendered }],
					},
				};
			} else {
				entry = {
					...entry,
					message: {
						...entry.message,
						content: entry.message.content.map((part: any) =>
							part.type === "toolResult" && part.toolCallId === toolCallId
								? { ...part, content: rendered }
								: part,
						),
					},
				};
			}

			result.push(JSON.stringify(entry));
			continue;
		}

		// Other tool results pass through unchanged
		result.push(line);
	}

	return `${result.join("\n")}\n`;
}

/**
 * Backward-compatible alias for compressToolResults.
 * @deprecated Use compressToolResults instead.
 */
export function compressFlowToolResults(snapshot: string, cache: Map<string, CompressedFlowResult[]>): string {
	return compressToolResults(snapshot, cache);
}

// ---------------------------------------------------------------------------
// batch_read tool call stripping
// ---------------------------------------------------------------------------

/**
 * Strip batch_read tool calls from assistant messages in a session snapshot.
 *
 * Children don't have batch_read in their active tools, so seeing calls to it
 * could confuse the model. This removes toolCall parts where name === "batch_read"
 * from assistant messages, while keeping the rest of the message intact.
 */
export function stripBatchReadToolCalls(snapshot: string): string {
	const lines = snapshot.trimEnd().split("\n");
	const result: string[] = [];

	for (const line of lines) {
		let entry: any;
		try { entry = JSON.parse(line); } catch { result.push(line); continue; }

		if (entry?.type !== "message" || entry.message?.role !== "assistant") {
			result.push(line);
			continue;
		}

		const content = entry.message.content;
		if (!Array.isArray(content)) { result.push(line); continue; }

		// Check if any toolCall parts reference batch_read
		const hasBatchReadCall = content.some(
			(part: any) => part.type === "toolCall" && part.name === "batch_read",
		);
		if (!hasBatchReadCall) { result.push(line); continue; }

		// Filter out batch_read toolCall parts
		const filteredContent = content.filter(
			(part: any) => !(part.type === "toolCall" && part.name === "batch_read"),
		);

		// If all content was batch_read calls, keep at least an empty text part
		// to avoid an empty content array
		if (filteredContent.length === 0) {
			filteredContent.push({ type: "text", text: "" });
		}

		result.push(JSON.stringify({
			...entry,
			message: {
				...entry.message,
				content: filteredContent,
			},
		}));
	}

	return `${result.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Snapshot sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize a fork session snapshot JSONL to remove non-inheritable
 * artifacts before passing parent context to child flows:
 * sliding system prompts, assistant reasoning/thinking,
 * batch_read tool calls, and compress flow/batch_read tool results.
 */
export function sanitizeForkSnapshot(snapshot: string | null, cache: Map<string, CompressedFlowResult[]> = new Map()): string | null {
	if (!snapshot) return snapshot;

	const lines = snapshot.trimEnd().split("\n");
	const sanitizedLines: string[] = [];

	for (const line of lines) {
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			sanitizedLines.push(line);
			continue;
		}

		let changed = false;

		// Drop sliding system prompt messages entirely.
		if (
			entry?.type === "message" &&
			entry.message?.role === "system" &&
			contentContainsSlidingTag(entry.message?.content)
		) {
			continue;
		}

		if (entry?.type === "message" && entry.message) {
			let message = entry.message;

			if (message.role === "assistant") {
				const stripped = stripReasoningFromAssistantMessage(message);
				message = stripped.message;
				changed ||= stripped.changed;
			}

			if ("content" in message) {
				const originalContent = message.content;
				const strippedContent = stripSlidingPromptFromContent(originalContent);

				if (!isJsonEqual(strippedContent, originalContent)) {
					message = {
						...message,
						content: strippedContent,
					};
					changed = true;
				}
			}

			if (changed) {
				entry = { ...entry, message };
			}
		}

		sanitizedLines.push(changed ? JSON.stringify(entry) : line);
	}

	let sanitized = `${sanitizedLines.join("\n")}\n`;

	// Strip batch_read tool calls from assistant messages.
	// Children don't have batch_read in their active tools.
	sanitized = stripBatchReadToolCalls(sanitized);

	// Compress flow and batch_read tool results.
	sanitized = compressToolResults(sanitized, cache);

	return sanitized;
}
