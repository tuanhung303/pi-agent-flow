/**
 * Two JSONL protocols are used in this codebase:
 *
 * 1. Fork Snapshot Protocol (snapshot.ts):
 *    Types: session, model_change, thinking_level_change, system, message,
 *           compression-stats
 *    Purpose: Serialized session state passed to child flows via --session.
 *              Emitted by buildForkSessionSnapshotJsonl() and consumed by
 *              sanitizeForkSnapshot() before forking.
 *
 * 2. Streaming Stdout Protocol (runner-events.ts):
 *    Types: session, agent_start, turn_start, message_start, message_end,
 *           message_update
 *    Sub-events under message_update: thinking_start, thinking_delta, text_delta
 *    Purpose: Real-time events emitted by the pi process stdout during flow
 *              execution. Parsed by processFlowJsonLine().
 */

/**
 * Session snapshot building, sanitization, and tool result compression.
 *
 * Extracted from index.ts for single-responsibility and testability.
 */

import type { CompressedFlowResult } from "../types/output.js";
import { isFlowError } from "../types/flow.js";
import { stripReasoningFromAssistantMessage } from "./reasoning-strip.js";
import {
	stripSteeringHintFromContent,
	stripSteeringHintText,
	contentContainsSteeringHintTag,
	isJsonEqual,
} from "../steering/sliding-prompt.js";
import { stripStrategicHints, stripStrategicHintsFromContent } from "../steering/tool-utils.js";
import { logError } from "../config/log.js";
import * as fs from "node:fs";

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
	const lines: string[] = [];

	// Emit session header once, unless getBranch() already includes it as the
	// first entry (some session managers include the header in the branch).
	const firstBranch = branchEntries[0];
	const headerId = (header as any)?.id;
	const firstId = firstBranch && typeof firstBranch === "object" ? (firstBranch as any)?.id : undefined;
	const firstType = firstBranch && typeof firstBranch === "object" ? (firstBranch as any)?.type : undefined;
	if (
		!firstBranch ||
		typeof firstBranch !== "object" ||
		(firstType !== "session" && firstType !== "header") ||
		firstId !== headerId
	) {
		lines.push(JSON.stringify(header));
	}

	// Emit system event so the JSONL is self-contained — parsers can reconstruct
	// full context without needing the markdown section.
	const systemPrompt = (header as any).systemPrompt;
	if (typeof systemPrompt === "string" && systemPrompt) {
		lines.push(JSON.stringify({ type: "system", content: systemPrompt }));
	}

	for (const entry of branchEntries) lines.push(JSON.stringify(entry));
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Flow result compression
// ---------------------------------------------------------------------------

/**
 * Render a compressed flow result as compact text for child context.
 */
export function renderCompressedFlowResult(r: CompressedFlowResult): string | undefined {
	const parts: string[] = [`[Flow: ${r.type} ${r.status}]`];
	if (r.intent) parts.push(`Intent: ${r.intent}`);
	if (r.aim) parts.push(`Aim: ${r.aim}`);
	if (r.summary) parts.push(`Summary: ${r.summary}`);
	if (r.files?.length) {
		const fileLines = r.files
			.map((f) => {
				if (!f.path) return undefined;
				const role = f.role ? ` (${f.role})` : "";
				const desc = f.description ? ` — ${f.description}` : "";
				return `  ${f.path}${role}${desc}`;
			})
			.filter((line): line is string => line !== undefined);
		// Safety net: if >50% of file entries were invalid (no path), compression is
		// producing garbage. Return undefined so caller falls back to truncated raw.
		if (fileLines.length === 0 || fileLines.length < r.files.length / 2) {
			return undefined;
		}
		parts.push(`Files:\n${fileLines.join("\n")}`);
	}
	if (r.actions?.length) {
		const actionLines = r.actions.map((a) => {
			const result = a.result ? ` → ${a.result}` : "";
			const target = a.target ? ` (${a.target})` : "";
			return `  [${a.type}] ${a.description}${target}${result}`;
		});
		parts.push(`Actions:\n${actionLines.join("\n")}`);
	}
	if (r.commands?.length) {
		const cmdLines = r.commands.map((c) => `  ${c.tool ?? "cmd"}: ${c.command}`);
		parts.push(`Commands:\n${cmdLines.join("\n")}`);
	}
	if (r.notDone?.length) {
		const ndLines = r.notDone.map((n) => {
			const reason = n.reason ? ` — ${n.reason}` : "";
			return `  ${n.item}${reason}`;
		});
		parts.push(`Not done:\n${ndLines.join("\n")}`);
	}
	if (r.nextSteps?.length) {
		parts.push(`Next steps:\n${r.nextSteps.map((s) => `  ${s}`).join("\n")}`);
	}
	if (r.reasoning?.length) {
		parts.push(`Reasoning:\n${r.reasoning.map((s) => `  ${s}`).join("\n")}`);
	}
	if (r.notes?.length) {
		parts.push(`Notes:\n${r.notes.map((s) => `  ${s}`).join("\n")}`);
	}
	if (r.error) parts.push(`Error: ${r.error}`);
	const text = parts.join("\n");
	if (text.includes("undefined")) return undefined;
	return text;
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
	logError(`[context-compress] ${toolName}: ${before} → ${after} bytes (${reduction}% reduction)`);
}

const KNOWN_SECTION_HEADERS = [
	/^--- (.+) \((\d+) lines\) ---$/,
	/^--- (.+) (context map|file summary) ---$/,
	/^--- bash \[.+\] exit (\d+) ---$/,
	/^--- edit: .+ ---$/,
	/^--- write: .+ ---$/,
	/^--- delete: .+ ---$/,
	/^--- read: .+ ---$/,
	/^--- (?!bash \[|edit:|write:|delete:|read:)(.+) ---$/,
];

function isKnownSectionHeader(line: string): boolean {
	return KNOWN_SECTION_HEADERS.some((re) => re.test(line));
}

/** Compress batch tool result: keep bash sections verbatim, truncate read content. */
function compressBatchResult(text: string): string {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const out: string[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		// File read section with content — truncate
		const readMatch = line.match(/^--- (.+) \((\d+) lines\) ---$/);
		if (readMatch) {
			out.push(`--- ${readMatch[1]} (${readMatch[2]} lines, content truncated) ---`);
			i++;
			while (i < lines.length && !isKnownSectionHeader(lines[i])) {
				i++;
			}
			continue;
		}

		// Context map / file summary section — truncate
		const ctxMapMatch = line.match(/^--- (.+) (context map|file summary) ---$/);
		if (ctxMapMatch) {
			out.push(`--- ${ctxMapMatch[1]} (${ctxMapMatch[2]}, truncated) ---`);
			i++;
			while (i < lines.length && !isKnownSectionHeader(lines[i])) {
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
			while (i < lines.length && !isKnownSectionHeader(lines[i])) {
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

	const answeredMatch = text.match(/^User answered: (.+)$/ms);
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
			if (part.type === "toolCall" && part.name) {
				const tcId = part.id ?? part.toolCallId;
				if (typeof tcId === "string" && tcId.trim()) {
					map.set(tcId, part.name);
				}
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
		const hasToolResultMessages = lines.some((line) => {
			try {
				const entry = JSON.parse(line);
				return entry?.type === "message" &&
					(entry.message?.role === "tool" || entry.message?.role === "toolResult");
			} catch { return false; }
		});
		// Must run the pass whenever tool results exist: we drop empty/whitespace
		// toolCallIds and pass through bash/flow/etc. even when the cache is empty.
		if (!hasCompressible && !hasToolResultMessages) return snapshot;
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
			if (part.type === "toolCall" && (part.id || part.toolCallId) && part.arguments) {
				toolCallIdToArgs.set(part.id ?? part.toolCallId, part.arguments);
			}
		}
	}

	const result: string[] = [];

	// Second pass: compress matching tool results
	for (const line of lines) {
		let entry: any;
		try { entry = JSON.parse(line); } catch { result.push(line); continue; }

		if (entry?.type !== "message" || (entry.message?.role !== "tool" && entry.message?.role !== "toolResult")) {
			result.push(line);
			continue;
		}

		// Extract toolCallId — message-level or content-level toolResult.
		// Drop only *explicit* empty/whitespace IDs (APIs reject those). Missing
		// toolCallId is treated as legacy shape and passes through unchanged.
		let toolCallId: string | undefined;
		let invalidEmptyId = false;

		if (typeof entry.message.toolCallId === "string") {
			const v = entry.message.toolCallId;
			if (!v.trim()) invalidEmptyId = true;
			else toolCallId = v;
		} else if (Array.isArray(entry.message.content)) {
			for (const part of entry.message.content) {
				if (part.type === "toolResult" && typeof part.toolCallId === "string") {
					if (!part.toolCallId.trim()) {
						invalidEmptyId = true;
						break;
					}
					toolCallId = part.toolCallId;
					break;
				}
			}
		}

		if (invalidEmptyId) continue;

		if (!toolCallId) {
			result.push(line);
			continue;
		}

		const toolName = toolCallIdToName.get(toolCallId);
		let rendered: string | undefined;
		let originalText = "";

		// --- Compress flow tool results ---
		if (toolName === "flow") {
			const compressed = cache.get(toolCallId);
			if (!compressed || compressed.length === 0) {
				// Cache miss (never populated or evicted) — do NOT pass megabytes of raw
				// flow output verbatim into child context. Render a minimal placeholder.
				originalText = extractToolResultText(entry) ?? "";
				const rawContent = entry.message?.content;
				const contentSize = rawContent
					? (typeof rawContent === "string" ? rawContent.length : JSON.stringify(rawContent).length)
					: 0;
				const size = originalText.length || contentSize || line.length;
				rendered = `[flow] prior result · ${size} chars — full context unavailable (result not cached at this depth)`;
			} else {
				const renderResults = compressed.map(renderCompressedFlowResult);
				const hasAnyUndefined = renderResults.some(r => r === undefined);
				
				if (hasAnyUndefined) {
					// Safety net: compression produced garbage, fall back to truncated raw.
					originalText = extractToolResultText(entry) ?? "";
					const size = originalText.length;
					rendered = size > 2000
						? originalText.slice(0, 2000) + "\n[truncated]"
						: originalText;
				} else {
					rendered = renderResults.filter((r): r is string => r !== undefined).join("\n\n");
				}
			}
		}

		// Note: batch_read tool results are now compressed in stripBatchReadToolCalls
		// before compressToolResults runs, so this branch is no longer needed.
		// Kept as a no-op safety net for any edge cases.
		else if (toolName === "batch_read") {
			rendered = undefined; // handled upstream
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

			// Strip the 'details' field which carries UI metadata that children don't need.
			// This eliminates ~98% of payload bloat from flow tool results.
			const { details, ...messageWithoutDetails } = entry.message;

			if (typeof entry.message.toolCallId === "string") {
				entry = {
					...entry,
					message: {
						...messageWithoutDetails,
						content: [{ type: "text", text: rendered }],
					},
				};
			} else {
				entry = {
					...entry,
					message: {
						...messageWithoutDetails,
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
 * from assistant messages AND drops the corresponding toolResult messages
 * whose toolCallId references a stripped batch_read call. Keeping orphaned tool
 * results causes strict API providers (e.g. kimi-coding, DeepSeek) to reject
 * the request with `tool_call_id is not found`.
 */
export function stripBatchReadToolCalls(snapshot: string): string {
	const lines = snapshot.trimEnd().split("\n");

	// Pass 1: Collect all batch_read toolCallIds from assistant messages.
	const batchReadToolCallIds = new Set<string>();
	for (const line of lines) {
		let entry: any;
		try { entry = JSON.parse(line); } catch { continue; }

		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;

		for (const part of content) {
			if (part.type === "toolCall" && part.name === "batch_read" && (part.id || part.toolCallId)) {
				batchReadToolCallIds.add(part.id ?? part.toolCallId);
			}
		}
	}

	// Pass 2: Strip batch_read toolCall parts from assistant messages,
	// and remove orphaned tool result messages.
	const result: string[] = [];

	for (const line of lines) {
		let entry: any;
		try { entry = JSON.parse(line); } catch { result.push(line); continue; }

		if (entry?.type !== "message") {
			result.push(line);
			continue;
		}

		// Tool result message — skip if it's a batch_read result
		if (entry.message.role === "tool" || entry.message.role === "toolResult") {
			const toolCallId = entry.message.toolCallId ??
				(Array.isArray(entry.message.content) ? entry.message.content.find((p: any) => p.type === "toolResult")?.toolCallId : undefined);
			if (toolCallId && batchReadToolCallIds.has(toolCallId)) continue;
			result.push(line);
			continue;
		}

		if (entry.message.role !== "assistant") { result.push(line); continue; }

		const content = entry.message.content;
		if (!Array.isArray(content)) { result.push(line); continue; }

		const hasBatchReadCall = content.some(
			(part: any) => part.type === "toolCall" && part.name === "batch_read",
		);
		if (!hasBatchReadCall) { result.push(line); continue; }

		const filteredContent = content.filter(
			(part: any) => !(part.type === "toolCall" && part.name === "batch_read"),
		);

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
// Reparent orphans
// ---------------------------------------------------------------------------

/**
 * Fix parentId references that point to messages which no longer exist.
 * Call this after any pass that drops messages.
 */
function reparentOrphans(snapshot: string): string {
	const lines = snapshot.trimEnd().split("\n");
	const survivingIds = new Set<string>();
	for (const line of lines) {
		try {
			const entry = JSON.parse(line);
			const id = entry?.message?.id ?? entry?.message?.messageId ?? entry?.id;
			if (typeof id === "string" && id) survivingIds.add(id);
			const parentId = entry?.parentId ?? entry?.parentMessageId ?? entry?.message?.parentId ?? entry?.message?.parentMessageId;
			if (typeof parentId === "string" && parentId && !(typeof id === "string" && id)) survivingIds.add(parentId);
		} catch { /* ignore */ }
	}
	for (let i = 0; i < lines.length; i++) {
		try {
			let entry = JSON.parse(lines[i]);
			const entryParentId = entry.parentId ?? entry.parentMessageId;
			const messageParentId = entry.message?.parentId ?? entry.message?.parentMessageId;
			const parentId = entryParentId ?? messageParentId;
			if (typeof parentId === "string" && parentId && !survivingIds.has(parentId)) {
				let modified = false;
				if (entry.parentId === parentId || entry.parentMessageId === parentId) {
					const { parentId: _pid, parentMessageId: _pmid, ...restEntry } = entry;
					entry = restEntry;
					modified = true;
				}
				if (entry.message && (entry.message.parentId === parentId || entry.message.parentMessageId === parentId)) {
					const { parentId: _pid, parentMessageId: _pmid, ...restMessage } = entry.message;
					entry = { ...entry, message: restMessage };
					modified = true;
				}
				if (modified) {
					lines[i] = JSON.stringify(entry);
				}
			}
		} catch { /* ignore */ }
	}
	return `${lines.join("\n")}\n`;
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
export interface SanitizeForkSnapshotOptions {
	forkedFrom?: string;
	forkedAt?: string;
	parentFlow?: string;
	depth?: number;
}

export function sanitizeForkSnapshot(
	snapshot: string | null,
	cache: Map<string, CompressedFlowResult[]> = new Map(),
	options?: SanitizeForkSnapshotOptions,
): { result: string | null; passesApplied: string[] } {
	if (!snapshot) return { result: snapshot, passesApplied: [] };

	const preBytes = snapshot.length;
	const lines = snapshot.trimEnd().split("\n");
	const sanitizedLines: string[] = [];
	const subPasses = new Set<string>();

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			sanitizedLines.push(line);
			continue;
		}

		let changed = false;

		// Header (first line): merge fork metadata and replace parent system prompt.
		if (i === 0 && entry && typeof entry === "object") {
			// Inject fork metadata so children know their lineage.
			if (options && (options.forkedFrom || options.forkedAt || options.parentFlow || options.depth !== undefined)) {
				entry = {
					...entry,
					...(options.forkedFrom !== undefined ? { forkedFrom: options.forkedFrom } : {}),
					...(options.forkedAt !== undefined ? { forkedAt: options.forkedAt } : {}),
					...(options.parentFlow !== undefined ? { parentFlow: options.parentFlow } : {}),
					...(options.depth !== undefined ? { depth: options.depth } : {}),
				};
				changed = true;
				subPasses.add("forkMetadataInjection");
			}

			// Replace the parent orchestrator system prompt with a brief note.
			// Children receive their own directive in the <activation> block.
			if (entry.systemPrompt && typeof entry.systemPrompt === "string") {
				entry = { ...entry, systemPrompt: "[parent orchestrator system prompt stripped — child receives its own directive]" };
				changed = true;
				subPasses.add("stripSystemPrompt");
			}

			// Prevent child from inheriting parent's session identity.
			// Rename id → parentId so lineage is preserved but the child
			// generates its own session identifier.
			if ('id' in entry) {
				entry = { ...entry, parentId: entry.id };
				delete entry.id;
				changed = true;
				subPasses.add('stripSessionId');
			}
		}

		// Drop type: "system" entries — the parent orchestrator system prompt was already
		// stripped from the header above. Standalone system events leak the full prompt.
		// Children receive their own directive in the <activation> block.
		if (entry?.type === "system") {
			subPasses.add("dropSystemEvents");
			continue;
		}

		// Drop custom_message entries — hidden orchestrator instructions (e.g.
		// flow continuation hook messages with display:false) that children
		// should never see.
		if (entry?.type === "custom_message") {
			subPasses.add("dropCustomMessages");
			continue;
		}

		// Drop parent-specific configuration events; child receives its own
		// model/tier via the <activation> block and CLI args.
		if (entry?.type === "model_change" || entry?.type === "thinking_level_change") {
			subPasses.add("dropConfigEvents");
			continue;
		}

		// Defense-in-depth: drop entries with an explicit unknown type that do not
		// belong in the fork snapshot protocol. Entries without a type field (e.g. bare
		// session headers from getHeader) pass through unchanged.
		if (
			entry?.type !== undefined &&
			entry?.type !== "session" &&
			entry?.type !== "message"
		) {
			subPasses.add("dropUnknownTypes");
			continue;
		}

		// Drop malformed message entries that lack a message payload.
		if (entry?.type === "message" && !entry.message) {
			subPasses.add("dropMalformedMessages");
			continue;
		}

		// Drop sliding system prompt messages entirely.
		if (
			entry?.type === "message" &&
			entry.message?.role === "system" &&
			contentContainsSteeringHintTag(entry.message?.content)
		) {
			subPasses.add("dropSlidingSystemPrompts");
			continue;
		}

		if (entry?.type === "message" && entry.message) {
			let message = entry.message;

			// Normalize internal "toolResult" role to "tool" for API compatibility.
			if (message.role === "toolResult") {
				message = { ...message, role: "tool" };
				changed = true;
				subPasses.add("normalizeToolResultRole");
			}

			// Strip reasoning/thinking from assistant messages.
			// (Reasoning typically only appears in assistant messages, but we
			// also check system/tool roles as a safety net for provider-specific
			// formats. stripReasoningFromAssistantMessage is a no-op on non-assistant
			// shapes, so calling it universally is safe.)
			if (message.role === "assistant" || message.role === "system" || message.role === "tool") {
				const stripped = stripReasoningFromAssistantMessage(message);
				message = stripped.message;
				if (stripped.changed) {
					changed = true;
					subPasses.add("stripReasoning");
				}
			}

			// Strip inner `message.timestamp` — the outer event-level timestamp (ISO string)
			// is sufficient for ordering. The inner epoch-ms timestamp is redundant.
			if ("timestamp" in message) {
				const { timestamp, ...restMessage } = message;
				message = restMessage;
				changed = true;
				subPasses.add("stripTimestamps");
			}

			// Strip API metadata fields that children don't need (~5-7 KB per assistant message).
			// IMPORTANT: keep `usage` (including `totalTokens`). The child `pi` process replays
			// this JSONL and core/session code reads `message.usage.totalTokens`; stripping
			// `usage` causes: Cannot read properties of undefined (reading 'totalTokens').
			// Strip `cost` from `usage` — it's always zeros in forked context and children never need it.
			if (message.role === "assistant") {
				const { api, provider, model, stopReason, responseId, responseModel, usage, ...rest } = message;
				let stripped = false;
				if (api !== undefined || provider !== undefined || model !== undefined ||
					stopReason !== undefined || responseId !== undefined || responseModel !== undefined) {
					stripped = true;
				}
				// Strip cost sub-object from usage while preserving totalTokens and other fields.
				let cleanedUsage = usage;
				if (usage && typeof usage === "object" && "cost" in usage) {
					const { cost, ...usageWithoutCost } = usage as any;
					cleanedUsage = usageWithoutCost;
					stripped = true;
				}
				if (stripped) {
					message = { ...rest, ...(cleanedUsage !== undefined ? { usage: cleanedUsage } : {}) };
					changed = true;
					subPasses.add("stripApiMetadata");
				}
			}

			// Strip `details` from tool/toolResult messages — carries FlowDetails UI metadata
			// (mode, flowStyle, projectAgentsDir, results) that children never need.
			if (message.role === "tool" || message.role === "toolResult") {
				if ("details" in message) {
					const { details, ...restMessage } = message;
					message = restMessage;
					changed = true;
					subPasses.add("stripDetails");
				}
			}

			if ("content" in message) {
				let modifiedContent = message.content;

				// Strip sliding prompts
				const afterSliding = stripSteeringHintFromContent(modifiedContent);
				if (!isJsonEqual(afterSliding, modifiedContent)) {
					modifiedContent = afterSliding;
					changed = true;
					subPasses.add("stripSteeringHints");
				}

				// Strip strategic hints from tool results
				if (message.role === "tool" || message.role === "toolResult") {
					const afterHints = stripStrategicHintsFromContent(modifiedContent);
					if (!isJsonEqual(afterHints, modifiedContent)) {
						modifiedContent = afterHints;
						changed = true;
						subPasses.add("stripStrategicHints");
					}
				}

				// Compress parent activation prompts in nested snapshot JSONL
				// (detect user messages containing <context-seal> at depth >= 2).
				if (message.role === "user" && options?.depth !== undefined && options.depth >= 2) {
					let hasParentActivation = false;
					let previewText = "";
					const parentActivationRegex = /<context-seal>[\s\S]*?<\/context-seal>/;
					let fullText = "";
					if (typeof modifiedContent === "string") {
						fullText = modifiedContent;
					} else if (Array.isArray(modifiedContent)) {
						fullText = modifiedContent
							.filter((p: any) => p.type === "text" && typeof p.text === "string")
							.map((p: any) => p.text)
							.join("");
					}
					if (parentActivationRegex.test(fullText)) {
						hasParentActivation = true;
						// Extract mission content for preview; fall back to content after </context-seal>
						const missionMatch = fullText.match(/<mission>([\s\S]*?)<\/mission>/);
						if (missionMatch) {
							previewText = missionMatch[1].trim().replace(/\s+/g, " ").slice(0, 200).trim();
						} else {
							const afterSeal = fullText.split(/<\/context-seal>/).pop() ?? fullText;
							previewText = afterSeal.trim().slice(0, 200).trim();
						}
					}
					if (hasParentActivation) {
						const compact = `[Parent flow activation stripped] Mission preview: ${previewText}`;
						if (typeof modifiedContent === "string") {
							modifiedContent = compact;
						} else {
							modifiedContent = [{ type: "text", text: compact }];
						}
						changed = true;
						subPasses.add("compressParentActivation");
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
	}

	const passesApplied: string[] = [];

	let sanitized = `${sanitizedLines.join("\n")}\n`;
	passesApplied.push(...subPasses);

	// Reparent orphaned parentIds after steering-hint messages were dropped.
	sanitized = reparentOrphans(sanitized);
	passesApplied.push("reparentOrphans");

	// Strip batch_read tool calls from assistant messages.
	// Children don't have batch_read in their active tools.
	sanitized = stripBatchReadToolCalls(sanitized);
	passesApplied.push("stripBatchRead");

	// Compress tool results (flow, batch, web, ask_user).
	sanitized = compressToolResults(sanitized, cache);
	passesApplied.push("compressToolResults");

	// Reparent again after stripBatchRead and compressToolResults may have
	// dropped additional messages, leaving new orphaned parentIds.
	sanitized = reparentOrphans(sanitized);
	passesApplied.push("reparentOrphans");

	// Telemetry: measure total delta across sanitization, stripping, and compression.
	const postBytes = sanitized.length;
	const reduction = preBytes > 0 ? ((1 - postBytes / preBytes) * 100).toFixed(0) : "0";
	if (DEBUG_CONTEXT) {
		logError(`[context-snapshot] pre: ${preBytes} → post: ${postBytes} bytes (${reduction}% reduction)`);
	}
	// Always emit compression-stats as a trailing metadata entry so the dump contains
	// observability data regardless of DEBUG_CONTEXT setting.
	sanitized = sanitized.trimEnd() + "\n" + JSON.stringify({
		type: "compression-stats",
		preBytes,
		postBytes,
		reductionPercent: Number(reduction),
		passesApplied,

	}) + "\n";

	return { result: sanitized, passesApplied };
}
