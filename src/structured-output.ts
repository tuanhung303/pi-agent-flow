/**
 * Structured JSON output extraction from flow responses.
 *
 * Parses a JSON code block from the end of the flow's final assistant text
 * and validates it against the FlowStructuredOutput schema.
 */

import type { FlowStructuredOutput } from "./types.js";

/** Minimum required fields to consider parsed JSON a valid structured output. */
function isValidStructuredOutput(obj: unknown): obj is FlowStructuredOutput {
	if (typeof obj !== "object" || obj === null) return false;
	const record = obj as Record<string, unknown>;
	return (
		typeof record.version === "string" &&
		typeof record.status === "string" &&
		["complete", "partial", "blocked", "failed"].includes(record.status) &&
		typeof record.summary === "string" &&
		Array.isArray(record.files) &&
		Array.isArray(record.actions) &&
		Array.isArray(record.nextSteps) &&
		Array.isArray(record.reasoning) &&
		Array.isArray(record.notes)
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

	// Sanitize: trim string fields, ensure arrays exist
	return {
		version: parsed.version.trim(),
		status: parsed.status,
		summary: parsed.summary.trim(),
		files: parsed.files,
		actions: parsed.actions,
		nextSteps: parsed.nextSteps,
		reasoning: parsed.reasoning,
		notes: parsed.notes,
		...(parsed.extensions !== undefined ? { extensions: parsed.extensions } : {}),
	};
}
