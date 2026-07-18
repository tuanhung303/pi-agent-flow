import type { Message } from "@earendil-works/pi-ai";
import { logWarn } from "../config/log.js";
import type { TraceStructuredOutput } from "../types/output.js";

/**
 * Strip markdown code block fences from the start/end of a string when the
 * ENTIRE string is wrapped in a fence. Returns the original string if no
 * complete fence is found.
 *
 * Matches:
 *   ^\s*```(?:\w+)?\s*\n  ...  \n\s*```\s*$
 *
 * Uses a greedy inner capture so nested fences are preserved.
 */
export function unwrapMarkdownCodeBlock(text: string): string {
	if (!text || typeof text !== "string") return text;
	const match = text.match(/^\s*```(?:\w+)?(?:[^\S\n]+[^\n]*)?\n([\s\S]*)\n\s*```\s*$/);
	return match ? match[1] : text;
}

/**
 * Extract a structured JSON output block from the end of an assistant's text for trace flow.
 *
 * Looks for a final ```json ... ``` code block, parses it, and validates
 * against the TraceStructuredOutput schema. Returns undefined when the block
 * is missing, malformed, or fails validation.
 */
export function extractTraceStructuredOutput(text: string): TraceStructuredOutput | undefined {
	if (!text) return undefined;

	// Find the last ```json block and try closing fences from the end inward
	// to handle nested code blocks inside the JSON content.
	const lastJsonIdx = text.lastIndexOf("```json");
	if (lastJsonIdx === -1) return undefined;

	const afterJson = text.slice(lastJsonIdx + 7);
	const closePositions: number[] = [];
	let pos = afterJson.indexOf("```");
	while (pos !== -1) {
		closePositions.push(pos);
		pos = afterJson.indexOf("```", pos + 1);
	}

	for (let i = closePositions.length - 1; i >= 0; i--) {
		const jsonStr = afterJson.slice(0, closePositions[i]).trim();
		if (!jsonStr) continue;
		try {
			const parsed = JSON.parse(jsonStr);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				if (typeof parsed.note === "string" && Array.isArray(parsed.tool_ids)) {
					return {
						note: unwrapMarkdownCodeBlock(parsed.note.trim()),
						tool_ids: parsed.tool_ids.map((id: unknown) =>
							unwrapMarkdownCodeBlock(String(id).trim())
						),
					};
				}
			}
		} catch {
			// Continue trying earlier closing positions
		}
	}
	return undefined;
}

// Fallback for external APIs that use snake_case
const SNAKE_TOOL_CALL_ID = "tool_call_id";
const DEFAULT_TRACE_EVIDENCE_MAX_BYTES = 100_000;

function getToolCallId(part: unknown): string | undefined {
	if (!part || typeof part !== "object") return undefined;
	const record = part as Record<string, unknown>;
	const id = record.id || record.toolCallId || record[SNAKE_TOOL_CALL_ID];
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Collect tool call IDs in execution order from assistant messages. Supports
 * native, camelCase, and snake_case call ID fields used by provider adapters.
 */
export function collectExecutedToolCallIds(messages: Message[]): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (!part || part.type !== "toolCall") continue;
			const id = getToolCallId(part);
			if (id && !seen.has(id)) {
				seen.add(id);
				ids.push(id);
			}
		}
	}
	return ids;
}

/**
 * Always include calls executed by this trace. Agent-reported IDs are retained
 * only as unique trailing references to parent-branch history.
 */
export function buildTraceEvidenceIds(messages: Message[], reportedToolIds: unknown): string[] {
	const ids = collectExecutedToolCallIds(messages);
	const seen = new Set(ids);
	if (!Array.isArray(reportedToolIds)) return ids;
	for (const id of reportedToolIds) {
		if (typeof id === "string" && id.length > 0 && !seen.has(id)) {
			seen.add(id);
			ids.push(id);
		}
	}
	return ids;
}

/** Read the evidence cap at resolution time so tests and live settings can override it. */
export function getTraceEvidenceMaxBytes(): number {
	const parsed = Number.parseInt(process.env.PI_FLOW_TRACE_EVIDENCE_MAX_BYTES ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TRACE_EVIDENCE_MAX_BYTES;
}

function findToolCall(messages: Message[], targetId: string) {
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const part of msg.content) {
			if (part && part.type === "toolCall") {
				const id = getToolCallId(part);
				if (id === targetId) {
					return {
						tool: part.name || part.toolName || "",
						args: part.arguments || part.input || {},
					};
				}
			}
		}
	}
	return null;
}

function findToolResult(messages: Message[], targetId: string): string | null {
	const outputParts: string[] = [];
	for (const msg of messages) {
		if (msg.role !== "tool" && msg.role !== "toolResult") continue;
		const id = (msg as { toolCallId?: string }).toolCallId || ((msg as unknown) as Record<string, unknown>)[SNAKE_TOOL_CALL_ID] as string | undefined || (msg as { id?: string }).id;
		if (id === targetId) {
			if (typeof msg.content === "string") {
				outputParts.push(msg.content);
			} else if (Array.isArray(msg.content)) {
				const text = msg.content
					.filter((c: unknown) => c && typeof c === "object" && (c as { type?: string; text?: unknown }).type === "text" && typeof (c as { text?: unknown }).text === "string")
					.map((c: unknown) => (c as { text: string }).text)
					.join("");
				outputParts.push(text);
			}
		}
	}
	return outputParts.length > 0 ? outputParts.join("\n\n") : null;
}

/** Choose a backtick fence that cannot be closed by any run of backticks inside content. */
function chooseFence(content: string): string {
	const maxTicks = [...content.matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length), 0);
	return "`".repeat(Math.max(3, maxTicks + 1));
}

/**
 * Resolve selected IDs to verbatim args + output, bounded at whole-entry boundaries.
 */
export function resolveToolEvidence(
	toolIds: string[],
	messages: Message[],
	parentBranch: unknown[],
	maxBytes = getTraceEvidenceMaxBytes(),
): string {
	const branchMessages: Message[] = [];
	if (Array.isArray(parentBranch)) {
		for (const entry of parentBranch) {
			if (entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "message" && (entry as Record<string, unknown>).message) {
				branchMessages.push((entry as Record<string, unknown>).message as Message);
			}
		}
	}

	const allMessages = [...branchMessages, ...messages];
	const evidenceParts: string[] = [];

	for (const id of toolIds) {
		const toolCall = findToolCall(allMessages, id);
		if (!toolCall) {
			continue;
		}

		const resultText = findToolResult(allMessages, id);
		if (resultText === null) {
			continue;
		}

		const argsFence = chooseFence(JSON.stringify(toolCall.args, null, 2));
		const outputFence = chooseFence(resultText);
		const outputLabel = "text";

		evidenceParts.push(
			`### ${toolCall.tool} [${id}]\n` +
			`**Args:**\n` +
			`${argsFence}json\n` +
			`${JSON.stringify(toolCall.args, null, 2)}\n` +
			`${argsFence}\n\n` +
			`**Output:**\n` +
			`${outputFence}${outputLabel}\n` +
			`${resultText}\n` +
			`${outputFence}`
		);
	}

	if (evidenceParts.length === 0) {
		return "";
	}

	const heading = "## Verbatim Evidence\n\n";
	let includedCount = 0;
	for (let index = 0; index < evidenceParts.length; index++) {
		const candidateEntries = evidenceParts.slice(0, index + 1);
		const omitted = evidenceParts.length - candidateEntries.length;
		const marker = omitted > 0 ? `\n\n[Evidence truncated: ${omitted} more tool call(s) omitted]` : "";
		const candidate = heading + candidateEntries.join("\n\n") + marker;
		if (Buffer.byteLength(candidate, "utf-8") > maxBytes) break;
		includedCount = candidateEntries.length;
	}

	if (includedCount === evidenceParts.length) return heading + evidenceParts.join("\n\n");

	const omitted = evidenceParts.length - includedCount;
	const marker = `[Evidence truncated: ${omitted} more tool call(s) omitted]`;
	const separator = includedCount > 0 ? "\n\n" : "";
	const truncated = heading + evidenceParts.slice(0, includedCount).join("\n\n") + separator + marker;
	// Do not cut entries mid-block; the configured cap is enforced whenever it
	// can contain the required heading and truncation marker.
	return truncated;
}
