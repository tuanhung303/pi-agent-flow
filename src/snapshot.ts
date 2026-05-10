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
	stripSlidingPromptText,
	contentContainsSlidingTag,
	isJsonEqual,
	SLIDING_PROMPT_OPEN_TAG,
	SLIDING_PROMPT_CLOSE_TAG,
} from "./sliding-prompt.js";
import { stripStrategicHints, stripStrategicHintsFromContent } from "./tool-utils.js";

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
// Additional tool result compressors
// ---------------------------------------------------------------------------

const DEBUG_CONTEXT = typeof process !== "undefined" && process.env.PI_FLOW_DEBUG_CONTEXT === "1";

function logCompress(toolName: string, before: number, after: number) {
	if (!DEBUG_CONTEXT) return;
	const reduction = before > 0 ? ((1 - after / before) * 100).toFixed(0) : "0";
	console.error(`[context-compress] ${toolName}: ${before} → ${after} bytes (${reduction}% reduction)`);
}

/** Compress batch tool result: keep bash sections verbatim, truncate read content. */
function compressBatchResult(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		// File read section with content — truncate
		const readMatch = line.match(/^--- (.+) \((\d+) lines\) ---$/);
		if (readMatch) {
			out.push(`--- ${readMatch[1]} (${readMatch[2]} lines, content truncated) ---`);
			i++;
			while (i < lines.length && !lines[i].match(/^--- /)) {
				i++;
			}
			continue;
		}

		// Context map / file summary section — truncate
		const ctxMapMatch = line.match(/^--- (.+) (context map|file summary) ---$/);
		if (ctxMapMatch) {
			out.push(`--- ${ctxMapMatch[1]} (${ctxMapMatch[2]}, truncated) ---`);
			i++;
			while (i < lines.length && !lines[i].match(/^--- /)) {
				i++;
			}
			continue;
		}

		// File read without line count — truncate
		// Negative lookahead excludes bash/edit/write/delete/read-error sections that should be kept verbatim
		const fallbackReadMatch = line.match(/^--- (?!bash \[|edit:|write:|delete:|read:)(.+) ---$/);
		if (fallbackReadMatch) {
			out.push(`--- ${fallbackReadMatch[1]} (content truncated) ---`);
			i++;
			while (i < lines.length && !lines[i].match(/^--- /)) {
				i++;
			}
			continue;
		}

		// Everything else (bash, edit, write, delete, error, summary) — keep as-is
		out.push(line);
		i++;
	}

	return out.join("\n");
}

/** Compress web tool result into compact metadata. */
function compressWebResult(text: string, args?: unknown): string {
	// Try to extract query/url from args
	let query: string | undefined;
	let url: string | undefined;
	if (args && typeof args === "object") {
		const a = args as Record<string, unknown>;
		const ops = Array.isArray(a.o) ? a.o : Array.isArray(a.op) ? a.op : undefined;
		if (ops && ops.length > 0) {
			const firstOp = ops[0] as Record<string, unknown>;
			query = typeof firstOp.q === "string" ? firstOp.q : undefined;
			url = typeof firstOp.u === "string" ? firstOp.u : undefined;
		}
	}

	// Search result format: numbered list
	if (text.match(/^\d+\. .+\n   https?:\/\//m)) {
		const lines = text.split("\n\n");
		const count = lines.length;
		const firstTitle = lines[0]?.match(/^\d+\. (.+)\n/)?.[1] ?? "unknown";
		const q = query ? ` "${query}"` : "";
		return `[web:search]${q} · ${count} results · first: ${firstTitle}`;
	}

	// Fetch result format: File/Title/Content length/Preview
	const fileMatch = text.match(/^File: (.+)\n/m);
	const titleMatch = text.match(/^Title: (.+)\n/m);
	const lengthMatch = text.match(/^Content length: (\d+) chars\n/m);
	if (fileMatch || titleMatch || lengthMatch || url) {
		const file = url ?? fileMatch?.[1] ?? "";
		const title = titleMatch?.[1] ?? "";
		const length = lengthMatch?.[1] ?? "0";
		return `[web:fetch] ${file} · "${title}" · ${length} chars`;
	}

	return `[web] result truncated (${text.length} chars)`;
}

/** Compress ask_user tool result into compact metadata. */
function compressAskUserResult(text: string, args?: unknown): string {
	let question = "";
	if (args && typeof args === "object") {
		const q = (args as Record<string, unknown>).question;
		if (typeof q === "string") {
			question = q.length > 80 ? q.slice(0, 77) + "..." : q;
		}
	}

	const answeredMatch = text.match(/^User answered: (.+)$/m);
	if (answeredMatch) {
		const q = question ? ` "${question}"` : "";
		return `[ask_user]${q} → "${answeredMatch[1]}"`;
	}
	if (text.match(/^User cancelled/m)) {
		const q = question ? ` "${question}"` : "";
		return `[ask_user]${q} → cancelled`;
	}
	return `[ask_user] · ${text.length} chars`;
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

	// Quick check: if there are no flow cache entries and no compressible tool calls,
	// nothing to compress — return early.
	if (cache.size === 0) {
		const hasCompressible = lines.some((line) => {
			try {
				const entry = JSON.parse(line);
				return entry?.type === "message" && entry.message?.role === "assistant" &&
					Array.isArray(entry.message.content) &&
					entry.message.content.some((p: any) =>
						p.type === "toolCall" &&
						["batch_read", "batch", "web", "ask_user"].includes(p.name),
					);
			} catch { return false; }
		});
		if (!hasCompressible) return snapshot;
	}

	// Build toolCallId → toolName mapping
	const toolCallIdToName = buildToolCallIdToNameMap(lines);

	// Build toolCallId → arguments mapping for all tools (needed for batch/web/ask_user metadata)
	const toolCallIdToArgs = new Map<string, unknown>();
	for (const line of lines) {
		let entry: any;
		try { entry = JSON.parse(line); } catch { continue; }
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part.type === "toolCall" && part.toolCallId && part.arguments) {
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
		let rendered: string | undefined;
		let originalText = "";

		// --- Compress flow tool results ---
		if (toolName === "flow") {
			const compressed = cache.get(toolCallId);
			if (!compressed || compressed.length === 0) { result.push(line); continue; }
			rendered = compressed.map(renderCompressedFlowResult).join("\n\n");
		}

		// --- Compress batch_read tool results ---
		else if (toolName === "batch_read") {
			const args = toolCallIdToArgs.get(toolCallId);
			const paths = extractBatchReadPaths(args);
			rendered = paths.length > 0
				? renderCompressedBatchReadResult(paths)
				: "[batch_read] result compressed";
		}

		// --- Compress batch tool results (selective: keep bash, truncate reads) ---
		else if (toolName === "batch") {
			originalText = extractToolResultText(entry) ?? "";
			rendered = compressBatchResult(originalText);
		}

		// --- Compress web tool results ---
		else if (toolName === "web") {
			originalText = extractToolResultText(entry) ?? "";
			const args = toolCallIdToArgs.get(toolCallId);
			rendered = compressWebResult(originalText, args);
		}

		// --- Compress ask_user tool results ---
		else if (toolName === "ask_user") {
			originalText = extractToolResultText(entry) ?? "";
			const args = toolCallIdToArgs.get(toolCallId);
			rendered = compressAskUserResult(originalText, args);
		}

		if (rendered !== undefined) {
			logCompress(toolName ?? "unknown", originalText.length || line.length, rendered.length);

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

/** Extract text content from a tool result entry for compression analysis. */
function extractToolResultText(entry: any): string | undefined {
	if (typeof entry.message?.content === "string") {
		return entry.message.content;
	}
	if (Array.isArray(entry.message?.content)) {
		for (const part of entry.message.content) {
			if (part.type === "text" && typeof part.text === "string") {
				return part.text;
			}
		}
	}
	return undefined;
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
	let preBytes = 0;
	let postBytes = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		preBytes += line.length + 1;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			sanitizedLines.push(line);
			postBytes += line.length + 1;
			continue;
		}

		let changed = false;

		// Strip sliding prompt from header systemPrompt (first line is header)
		if (i === 0 && entry && typeof entry === "object" && entry.systemPrompt && typeof entry.systemPrompt === "string") {
			const stripped = stripSlidingPromptText(entry.systemPrompt);
			if (stripped !== entry.systemPrompt) {
				entry = { ...entry, systemPrompt: stripped };
				changed = true;
			}
		}

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
				let modifiedContent = message.content;

				// Strip sliding prompts
				const afterSliding = stripSlidingPromptFromContent(modifiedContent);
				if (!isJsonEqual(afterSliding, modifiedContent)) {
					modifiedContent = afterSliding;
					changed = true;
				}

				// Strip strategic hints from tool results
				if (message.role === "tool") {
					const afterHints = stripStrategicHintsFromContent(modifiedContent);
					if (!isJsonEqual(afterHints, modifiedContent)) {
						modifiedContent = afterHints;
						changed = true;
					}
				}

				if (changed) {
					message = { ...message, content: modifiedContent };
				}
			}

			if (changed) {
				entry = { ...entry, message };
			}
		}

		const outLine = changed ? JSON.stringify(entry) : line;
		sanitizedLines.push(outLine);
		postBytes += outLine.length + 1;
	}

	let sanitized = `${sanitizedLines.join("\n")}\n`;

	// Strip batch_read tool calls from assistant messages.
	// Children don't have batch_read in their active tools.
	sanitized = stripBatchReadToolCalls(sanitized);

	// Compress tool results (flow, batch_read, batch, web, ask_user).
	sanitized = compressToolResults(sanitized, cache);

	// Telemetry
	if (DEBUG_CONTEXT) {
		const reduction = preBytes > 0 ? ((1 - postBytes / preBytes) * 100).toFixed(0) : "0";
		console.error(`[context-snapshot] pre: ${preBytes} → post: ${postBytes} bytes (${reduction}% reduction)`);
	}

	return sanitized;
}
