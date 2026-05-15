/**
 * Structured JSON output extraction from flow responses.
 *
 * Parses a JSON code block from the end of the flow's final assistant text
 * and validates it against the FlowStructuredOutput schema.
 */

import type { Message } from "@mariozechner/pi-ai";
import type { Action, CommandEntry, FileEntry, FlowStructuredOutput, NotDoneItem } from "./types.js";

type FlowStatus = FlowStructuredOutput["status"];

type StructuredOutputRecord = {
	version: string;
	status: FlowStatus;
	summary: string;
	files?: FileEntry[];
	actions?: Action[];
	commands?: CommandEntry[];
	notDone?: NotDoneItem[];
	nextSteps?: string[];
	reasoning?: string[];
	notes?: string[];
	extensions?: Record<string, unknown>;
};

const VALID_STATUSES: FlowStatus[] = ["complete", "partial", "blocked", "failed"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalArray(record: Record<string, unknown>, key: string): boolean {
	return record[key] === undefined || Array.isArray(record[key]);
}

/** Minimum required fields to consider parsed JSON a valid structured output. */
function isValidFileEntry(item: unknown): boolean {
	if (!isRecord(item)) return false;
	return typeof item.path === "string";
}

/** Minimum required fields to consider parsed JSON a valid structured output. */
function isValidStructuredOutput(obj: unknown): obj is StructuredOutputRecord {
	if (!isRecord(obj)) return false;
	return (
		typeof obj.version === "string" &&
		typeof obj.status === "string" &&
		VALID_STATUSES.includes(obj.status as FlowStatus) &&
		typeof obj.summary === "string" &&
		isOptionalArray(obj, "files") &&
		(Array.isArray(obj.files) ? obj.files.every(isValidFileEntry) : true) &&
		isOptionalArray(obj, "actions") &&
		isOptionalArray(obj, "commands") &&
		isOptionalArray(obj, "notDone") &&
		isOptionalArray(obj, "nextSteps") &&
		isOptionalArray(obj, "reasoning") &&
		isOptionalArray(obj, "notes")
	);
}

/**
 * Extract a structured JSON output block from the end of an assistant's text.
 *
 * Looks for a final ```json ... ``` code block, parses it, and validates
 * against the FlowStructuredOutput schema. Returns undefined when the block
 * is missing, malformed, or fails validation.
 */
export function extractStructuredOutput(text: string): FlowStructuredOutput | undefined {
	if (!text) return undefined;

	// Find the last ```json ... ``` block in the text.
	// Scan backward from the end to handle multiple blocks.
	const allMatches = [...text.matchAll(/```json\s*([\s\S]*?)\s*```/g)];
	const match = allMatches.length > 0 ? allMatches[allMatches.length - 1] : null;
	if (!match || !match[1]) return undefined;

	const jsonStr = match[1].trim();
	if (!jsonStr) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		return undefined;
	}

	if (!isValidStructuredOutput(parsed)) return undefined;

	// Sanitize: trim string fields and normalize omitted arrays to [] for
	// backward compatibility with earlier structured-output prompts.
	return {
		version: parsed.version.trim(),
		status: parsed.status,
		summary: parsed.summary.trim(),
		files: parsed.files ?? [],
		actions: parsed.actions ?? [],
		commands: parsed.commands ?? [],
		notDone: parsed.notDone ?? [],
		nextSteps: parsed.nextSteps ?? [],
		reasoning: parsed.reasoning ?? [],
		notes: parsed.notes ?? [],
		...(parsed.extensions !== undefined ? { extensions: parsed.extensions } : {}),
	};
}

// ---------------------------------------------------------------------------
// Mechanical command generation from tool call history
// ---------------------------------------------------------------------------

/**
 * Extract [Execution time: ...] markers keyed by bash-op-ID from batch
 * result text. Uses the `--- bash [ID]` delimiter to split sections.
 * Pending sections (no timing marker) are not included in the result.
 */
function extractBatchTimingsById(text: string): Map<string, string> {
	const result = new Map<string, string>();
	const sections = text.split(/^--- bash \[([^\]]+)\]/m);
	// sections: [preamble, id1, body1, id2, body2, ...]
	for (let i = 1; i < sections.length - 1; i += 2) {
		const id = sections[i].trim();
		const body = sections[i + 1] || "";
		const match = body.match(/\[Execution time: ([^\]]+)\]/);
		if (match) result.set(id, match[1]);
	}
	return result;
}

/**
 * Extract [Execution time: ...] markers keyed by bash-op-ID from poll
 * result text. Uses the `--- [ID]` delimiter to split sections.
 */
function extractPollTimingsById(text: string): Map<string, string> {
	const result = new Map<string, string>();
	const sections = text.split(/^--- \[([^\]]+)\]/m);
	// sections: [preamble, id1, body1, id2, body2, ...]
	for (let i = 1; i < sections.length - 1; i += 2) {
		const id = sections[i].trim();
		const body = sections[i + 1] || "";
		const match = body.match(/\[Execution time: ([^\]]+)\]/);
		if (match) result.set(id, match[1]);
	}
	return result;
}

/**
 * Walk the message history and mechanically generate a commands array
 * from all bash tool calls (standalone, batch-nested, and batch_bash_poll).
 *
 * This replaces the old enrichStructuredOutputCommands approach which relied
 * on the LLM generating a paraphrased commands array that was then replaced
 * with verbatim versions. Now commands are generated purely from tool call
 * history — no LLM involvement required.
 *
 * Deduplication strategy:
 * - Batch-nested bash ops that completed within the batch call are emitted
 *   immediately with their timing.
 * - Batch-nested bash ops that were still pending when the batch returned
 *   (no timing available) are deferred to batch_bash_poll.
 * - batch_bash_poll only emits entries for IDs that were deferred AND have
 *   completed (with timing). Still-pending poll results are skipped.
 * - Once an ID is emitted (from batch or poll), subsequent encounters skip it.
 */
export function generateCommandsFromHistory(messages: Message[]): CommandEntry[] {
	const commands: CommandEntry[] = [];

	// ── Phase 1: Build lookup maps ──

	// Map toolCallId → concatenated text from tool result messages
	const toolResultTexts = new Map<string, string>();
	for (const msg of messages) {
		if ((msg.role !== "tool" && msg.role !== "toolResult") || !Array.isArray(msg.content)) continue;
		const id =
			(msg as unknown as { toolCallId?: string }).toolCallId ||
			(msg as unknown as { tool_call_id?: string }).tool_call_id ||
			"";
		if (!id) continue;
		const text = msg.content
			.filter((c: { type: string; text?: string }) => c.type === "text" && typeof c.text === "string")
			.map((c: { text: string }) => c.text)
			.join("");
		toolResultTexts.set(id, text);
	}

	// Map toolCallId → execution time (from [Execution time: ...] markers)
	const timingMap = new Map<string, string>();
	for (const [id, text] of toolResultTexts) {
		const match = text.match(/\[Execution time: ([^\]]+)\]/);
		if (match) timingMap.set(id, match[1]);
	}

	// Map bash-op-ID → command string (from all batch calls, for poll lookback)
	const bashIdToCommand = new Map<string, string>();

	// Track which bash-op IDs have already been emitted (with timing).
	// Prevents duplicates from poll calls.
	const emittedBashIds = new Set<string>();

	// ── Phase 2: Walk tool calls ──

	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const part of msg.content) {
			if (part.type !== "toolCall") continue;
			const name = part.name || (part as unknown as { toolName?: string }).toolName || "";
			const args = part.arguments || part.input || {};
			const toolCallId = (part as unknown as { toolCallId?: string }).toolCallId || (part as unknown as { tool_call_id?: string }).tool_call_id || "";

			switch (name) {
				case "bash": {
					const cmd = (args.command as string) || "";
					if (cmd) {
						commands.push({
							command: cmd,
							tool: "bash",
							...(timingMap.has(toolCallId) ? { executionTime: timingMap.get(toolCallId) } : {}),
						});
					}
					break;
				}

				case "batch": {
					const ops = Array.isArray(args.o)
						? args.o
						: Array.isArray(args.op)
							? args.op
							: Array.isArray(args.operations)
								? args.operations
								: [];
					const resultText = toolResultTexts.get(toolCallId) || "";
					const batchTimings = extractBatchTimingsById(resultText);

					for (const op of ops) {
						if (!op) continue;
						const opType = (op.o ?? op.op) as string;
						if (opType === "bash" && op.command) {
							const id = (op.i ?? op.id) as string;
							if (id) bashIdToCommand.set(id, op.command as string);

							const timing = id ? batchTimings.get(id) : undefined;

							if (timing) {
								// Completed within batch — emit immediately with timing
								commands.push({
									command: op.command as string,
									tool: "bash",
									executionTime: timing,
								});
								if (id) emittedBashIds.add(id);
							}
							// Pending ops (no timing) are deferred to batch_bash_poll
						}
					}
					break;
				}

				case "batch_bash_poll": {
					const ids = Array.isArray(args.i) ? args.i as string[] : [];
					const resultText = toolResultTexts.get(toolCallId) || "";
					const pollTimings = extractPollTimingsById(resultText);

					for (const id of ids) {
						if (emittedBashIds.has(id)) continue; // already emitted
						const command = bashIdToCommand.get(id);
						if (!command) continue; // unknown ID — skip
						const timing = pollTimings.get(id);
						if (!timing) continue; // still pending — skip, defer to next poll

						commands.push({
							command,
							tool: "bash",
							executionTime: timing,
						});
						emittedBashIds.add(id);
					}
					break;
				}
			}
		}
	}

	return commands;
}
