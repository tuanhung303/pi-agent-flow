/**
 * Session snapshot building, sanitization, and flow result compression.
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

/**
 * Compress flow tool results in a sanitized session snapshot.
 *
 * Scans for tool result messages that correspond to flow invocations
 * and replaces their content with compact compressed output.
 */
export function compressFlowToolResults(snapshot: string, cache: Map<string, CompressedFlowResult[]>): string {
	if (cache.size === 0) return snapshot;

	const lines = snapshot.trimEnd().split("\n");
	const result: string[] = [];

	// First pass: map toolCallId → tool name from assistant messages
	const toolCallIdToName = new Map<string, string>();
	for (const line of lines) {
		let entry: any;
		try { entry = JSON.parse(line); } catch { continue; }
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part.type === "toolCall" && part.toolCallId && part.name) {
				toolCallIdToName.set(part.toolCallId, part.name);
			}
		}
	}

	// Second pass: compress flow tool results
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
		if (toolName !== "flow") { result.push(line); continue; }

		const compressed = cache.get(toolCallId);
		if (!compressed || compressed.length === 0) { result.push(line); continue; }

		const rendered = compressed.map(renderCompressedFlowResult).join("\n\n");

		// Replace content in the tool result message
		if (typeof entry.message.toolCallId === "string") {
			// Format 1: toolCallId at message level, content is text array
			entry = {
				...entry,
				message: {
					...entry.message,
					content: [{ type: "text", text: rendered }],
				},
			};
		} else {
			// Format 2: toolCallId inside content array
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
	}

	return `${result.join("\n")}\n`;
}

/**
 * Sanitize a fork session snapshot JSONL to remove only non-inheritable
 * artifacts before passing full parent context to child flows: sliding system
 * prompts, legacy reminders, and assistant reasoning/thinking.
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

	const sanitized = `${sanitizedLines.join("\n")}\n`;
	return compressFlowToolResults(sanitized, cache);
}
