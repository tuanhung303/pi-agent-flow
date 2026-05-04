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
function isValidStructuredOutput(obj: unknown): obj is StructuredOutputRecord {
	if (!isRecord(obj)) return false;
	return (
		typeof obj.version === "string" &&
		typeof obj.status === "string" &&
		VALID_STATUSES.includes(obj.status as FlowStatus) &&
		typeof obj.summary === "string" &&
		isOptionalArray(obj, "files") &&
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

/**
 * Walk the message history and mechanically replace paraphrased bash commands
 * in a structured-output `commands` array with the exact verbatim strings from
 * the actual tool calls. This fixes the common LLM behaviour of summarising
 * `curl -s -X POST …` as `"curl GAWA baseline"`.
 *
 * Batch operations are flattened so that bash commands nested inside a batch
 * call are included in the same chronological order they were executed.
 */
export function enrichStructuredOutputCommands(
	structuredOutput: FlowStructuredOutput,
	messages: Message[],
): FlowStructuredOutput {
	// Collect actual verbatim bash commands (including those inside batch ops)
	const actualBashCommands: string[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const part of msg.content) {
			if (part.type !== "toolCall") continue;
			const name =
				part.name ||
				(part as unknown as { toolName?: string }).toolName ||
				"";
			const args = part.arguments || part.input || {};

			if (name === "bash") {
				const cmd = (args.command as string) || "";
				if (cmd) actualBashCommands.push(cmd);
			} else if (name === "batch") {
				const ops = Array.isArray(args.o)
					? args.o
					: Array.isArray(args.op)
						? args.op
						: Array.isArray(args.operations)
							? args.operations
							: [];
				for (const op of ops) {
					if (!op) continue;
					const opType = (op.o ?? op.op) as string;
					if (opType === "bash" && op.command) {
						actualBashCommands.push(op.command as string);
					}
				}
			}
		}
	}

	if (actualBashCommands.length === 0) return structuredOutput;

	// Replace paraphrased bash commands with actual verbatim ones, in order.
	let bashIdx = 0;
	const enrichedCommands = structuredOutput.commands.map((cmd) => {
		if (cmd.tool === "bash" && bashIdx < actualBashCommands.length) {
			return { ...cmd, command: actualBashCommands[bashIdx++] };
		}
		return cmd;
	});

	return { ...structuredOutput, commands: enrichedCommands };
}
