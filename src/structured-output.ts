/**
 * Structured JSON output extraction from flow responses.
 *
 * Parses a JSON code block from the end of the flow's final assistant text
 * and validates it against the FlowStructuredOutput schema.
 */

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
