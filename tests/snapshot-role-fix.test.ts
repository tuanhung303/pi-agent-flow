import { describe, it, expect } from "vitest";
import {
	compressToolResults,
	stripBatchReadToolCalls,
	sanitizeForkSnapshot,
} from "../src/snapshot.js";
import type { CompressedFlowResult } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a JSONL snapshot string from an array of entry objects. */
function makeSnapshot(entries: any[]): string {
	return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/** Parse a JSONL snapshot string back into an array of entry objects. */
function parseSnapshot(snapshot: string): any[] {
	return snapshot
		.trimEnd()
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l));
}

// ===========================================================================
// 1. buildToolCallIdToNameMap / compressToolResults with `id` field
// ===========================================================================
// Real JSONL sessions use `id` (not `toolCallId`) on toolCall content parts.
// The fix made buildToolCallIdToNameMap check `part.id ?? part.toolCallId`.
// These tests verify compression works when toolCall parts have the `id` field.
// ===========================================================================

describe("compressToolResults with production JSONL `id` field", () => {
	it("drops batch_read tool results via stripBatchReadToolCalls (compressToolResults no longer handles batch_read)", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "br-id-1", name: "batch_read", arguments: { o: [{ o: "read", p: "src/a.ts" }, { o: "read", p: "src/b.ts" }] } },
					],
					timestamp: 1,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "br-id-1",
					content: [{ type: "text", text: "Huge file content of a.ts and b.ts..." }],
					timestamp: 2,
				},
			},
		]);

		const result = stripBatchReadToolCalls(snapshot);

		expect(result).not.toContain("br-id-1");
		expect(result).not.toContain("Huge file content");
	});

	it("compresses flow tool results when toolCall uses `id` field", () => {
		const cache = new Map<string, CompressedFlowResult[]>();
		cache.set("flow-id-1", [{ type: "scout", status: "accomplished" }]);

		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "flow-id-1", name: "flow", arguments: { flow: [{ type: "scout" }] } },
					],
					timestamp: 1,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "flow-id-1",
					content: [{ type: "text", text: "Very long flow result that should be compressed..." }],
					timestamp: 2,
				},
			},
		]);

		const result = compressToolResults(snapshot, cache);

		expect(result).toContain("[Flow: scout accomplished]");
		expect(result).not.toContain("Very long flow result");
	});

	it("compresses batch tool results when toolCall uses `id` field", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "batch-id-1", name: "batch", arguments: { o: [{ o: "read", p: "src/file.ts" }] } },
					],
					timestamp: 1,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "batch-id-1",
					content: "✓ 1 operation: 1 read\n\n--- src/file.ts (42 lines) ---\nline 1\nline 2",
					timestamp: 2,
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());

		expect(result).toContain("content truncated");
		expect(result).not.toContain("line 1");
	});

	it("compresses web tool results when toolCall uses `id` field", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "web-id-1", name: "web", arguments: { op: [{ o: "search", q: "test query" }] } },
					],
					timestamp: 1,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "web-id-1",
					content: "1. Result One\n   https://example.com",
					timestamp: 2,
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());

		expect(result).toContain("[web:search]");
	});

	it("compresses ask_user tool results when toolCall uses `id` field", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "ask-id-1", name: "ask_user", arguments: { question: "Continue?" } },
					],
					timestamp: 1,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "ask-id-1",
					content: "User answered: yes",
					timestamp: 2,
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());

		// Result is embedded in JSON; check for the compressed text fragment
		expect(result).toContain('[ask_user]');
		expect(result).toContain('Continue?');
		expect(result).not.toContain('User answered: yes');
	});

	it("drops mixed `id` and `toolCallId` fields via stripBatchReadToolCalls", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "br-id-field", name: "batch_read", arguments: { o: [{ o: "read", p: "src/a.ts" }] } },
					],
					timestamp: 1,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "br-id-field",
					content: [{ type: "text", text: "Content of a.ts" }],
					timestamp: 2,
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "br-tc-field", name: "batch_read", arguments: { o: [{ o: "read", p: "src/b.ts" }] } },
					],
					timestamp: 3,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "br-tc-field",
					content: [{ type: "text", text: "Content of b.ts" }],
					timestamp: 4,
				},
			},
		]);

		const result = stripBatchReadToolCalls(snapshot);

		expect(result).not.toContain("br-id-field");
		expect(result).not.toContain("br-tc-field");
		expect(result).not.toContain("Content of a.ts");
		expect(result).not.toContain("Content of b.ts");
	});

	it("drops tool results with role 'tool' (backward compat) via stripBatchReadToolCalls", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "br-old-1", name: "batch_read", arguments: { o: [{ o: "read", p: "src/a.ts" }] } },
					],
					timestamp: 1,
				},
			},
			{
				type: "message",
				message: {
					role: "tool", // Legacy format — still matched for backward compat
					toolCallId: "br-old-1",
					content: [{ type: "text", text: "Full content of a.ts" }],
					timestamp: 2,
				},
			},
		]);

		const result = stripBatchReadToolCalls(snapshot);

		expect(result).not.toContain("br-old-1");
		expect(result).not.toContain("Full content of a.ts");
	});
});

// ===========================================================================
// 2. stripBatchReadToolCalls with production `id` field
// ===========================================================================
// Real JSONL sessions use `id` (not `toolCallId`) on toolCall content parts.
// The fix made stripBatchReadToolCalls collect stripped IDs from `part.id ?? part.toolCallId`.
// These tests verify orphan stripping works when toolCall parts have the `id` field.
// ===========================================================================

describe("stripBatchReadToolCalls with production JSONL `id` field", () => {
	it("strips batch_read toolCall using `id` field from assistant messages", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "user",
					content: "Read those files",
					timestamp: 0,
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "I'll read the files." },
						{ type: "toolCall", id: "br-id-1", name: "batch_read", arguments: { o: [{ o: "read", p: "src/a.ts" }] } },
					],
					timestamp: 1,
				},
			},
		]);

		const result = stripBatchReadToolCalls(snapshot);

		expect(result).not.toContain("\"name\":\"batch_read\"");
		expect(result).not.toContain("br-id-1");
		expect(result).toContain("I'll read the files.");
		expect(result).toContain("Read those files");
	});

	it("drops orphaned batch_read toolResults", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: { role: "user", content: "Read files", timestamp: 0 },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Reading files." },
						{ type: "toolCall", id: "br-id-orphan", name: "batch_read", arguments: { o: [{ o: "read", p: "src/a.ts" }] } },
					],
					timestamp: 1,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "br-id-orphan",
					content: [{ type: "text", text: "file content here" }],
					timestamp: 2,
				},
			},
			{
				type: "message",
				message: { role: "user", content: "Now analyze", timestamp: 3 },
			},
		]);

		const result = stripBatchReadToolCalls(snapshot);

		// The batch_read toolCall is removed from assistant messages
		expect(result).not.toContain("\"name\":\"batch_read\"");

		// The toolResult is DROPPED to avoid orphaned tool results in child context
		expect(result).not.toContain("br-id-orphan");
		expect(result).not.toContain("file content here");

		// Other messages preserved
		expect(result).toContain("Read files");
		expect(result).toContain("Now analyze");
	});

	it("preserves non-batch_read tool results while dropping batch_read ones", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "br-id-1", name: "batch_read", arguments: {} },
						{ type: "toolCall", id: "flow-id-1", name: "flow", arguments: {} },
					],
					timestamp: 1,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "br-id-1",
					content: [{ type: "text", text: "batch_read result" }],
					timestamp: 2,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "flow-id-1",
					content: [{ type: "text", text: "flow result" }],
					timestamp: 3,
				},
			},
		]);

		const result = stripBatchReadToolCalls(snapshot);

		// batch_read call removed from assistant, toolResult dropped
		expect(result).not.toContain("\"name\":\"batch_read\"");
		expect(result).not.toContain("br-id-1");
		expect(result).not.toContain("batch_read result");

		// flow call and result preserved
		expect(result).toContain("flow-id-1");
		expect(result).toContain("flow result");
	});

	it("drops orphaned tool results with content-level toolCallId when batch_read uses `id`", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "br-id-2", name: "batch_read", arguments: {} },
					],
					timestamp: 1,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					content: [
						{ type: "toolResult", toolCallId: "br-id-2", content: "some result" },
					],
					timestamp: 2,
				},
			},
		]);

		const result = stripBatchReadToolCalls(snapshot);

		expect(result).not.toContain("br-id-2");
		expect(result).not.toContain("some result");
	});

	it("handles assistant with only batch_read `id`-field calls (adds empty text part)", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "br-id-only", name: "batch_read", arguments: {} },
					],
					timestamp: 1,
				},
			},
		]);

		const result = stripBatchReadToolCalls(snapshot);

		const parsed = parseSnapshot(result);
		const assistantMsg = parsed.find((e: any) => e.message?.role === "assistant");
		expect(assistantMsg.message.content).toEqual([{ type: "text", text: "" }]);
	});

	it("drops tool results when role is 'tool' (backward compat)", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "br-old-role", name: "batch_read", arguments: {} },
					],
					timestamp: 1,
				},
			},
			{
				type: "message",
				message: {
					role: "tool", // Legacy format — still matched for backward compat
					toolCallId: "br-old-role",
					content: [{ type: "text", text: "orphaned tool result" }],
					timestamp: 2,
				},
			},
		]);

		const result = stripBatchReadToolCalls(snapshot);

		// The batch_read toolCall is stripped from the assistant message
		expect(result).not.toContain("\"name\":\"batch_read\"");

		// Tool result is dropped to avoid orphaned tool results
		expect(result).not.toContain("br-old-role");
		expect(result).not.toContain("orphaned tool result");
	});

	it("drops multiple batch_read results", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "br-multi-1", name: "batch_read", arguments: {} },
						{ type: "toolCall", id: "br-multi-2", name: "batch_read", arguments: {} },
						{ type: "toolCall", id: "flow-keep", name: "flow", arguments: {} },
					],
					timestamp: 1,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "br-multi-1",
					content: [{ type: "text", text: "result 1" }],
					timestamp: 2,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "br-multi-2",
					content: [{ type: "text", text: "result 2" }],
					timestamp: 3,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "flow-keep",
					content: [{ type: "text", text: "flow result" }],
					timestamp: 4,
				},
			},
		]);

		const result = stripBatchReadToolCalls(snapshot);

		// Both batch_read toolResults dropped
		expect(result).not.toContain("br-multi-1");
		expect(result).not.toContain("br-multi-2");
		expect(result).not.toContain("result 1");
		expect(result).not.toContain("result 2");

		// Flow call and result preserved
		expect(result).toContain("flow-keep");
		expect(result).toContain("flow result");
	});
});

// ===========================================================================
// 3. role: "toolResult" vs role: "tool" — explicit role field tests
// ===========================================================================
// The fix changed role checks from "tool" to "toolResult" in:
//   - compressToolResults
//   - stripBatchReadToolCalls
//   - sanitizeForkSnapshot
// These tests explicitly verify the role field behavior.
// ===========================================================================

describe("role field: 'toolResult' is required for matching", () => {
	it("compressToolResults processes tool results with role 'tool' (backward compat)", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "tc-role-1", name: "batch", arguments: { o: [{ o: "read", p: "src/file.ts" }] } },
					],
					timestamp: 1,
				},
			},
			{
				type: "message",
				message: {
					role: "tool", // Legacy format — still matched for backward compat
					toolCallId: "tc-role-1",
					content: "✓ 1 operation: 1 read\n\n--- src/file.ts (42 lines) ---\nline 1\nline 2",
					timestamp: 2,
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());

		// role: "tool" is also matched (backward compat with both "tool" and "toolResult")
		expect(result).toContain("content truncated");
		expect(result).not.toContain("line 1");
	});

	it("compressToolResults processes tool results with role 'toolResult'", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "tc-role-2", name: "batch", arguments: { o: [{ o: "read", p: "src/file.ts" }] } },
					],
					timestamp: 1,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult", // Correct role
					toolCallId: "tc-role-2",
					content: "✓ 1 operation: 1 read\n\n--- src/file.ts (42 lines) ---\nline 1\nline 2",
					timestamp: 2,
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());

		// With role: "toolResult", compressToolResults processes and truncates
		expect(result).toContain("content truncated");
		expect(result).not.toContain("line 1");
	});

	it("stripBatchReadToolCalls drops orphans with role 'tool' (backward compat)", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "br-role-old", name: "batch_read", arguments: {} },
					],
					timestamp: 1,
				},
			},
			{
				type: "message",
				message: {
					role: "tool", // Legacy format — still matched for backward compat
					toolCallId: "br-role-old",
					content: [{ type: "text", text: "orphaned content" }],
					timestamp: 2,
				},
			},
		]);

		const result = stripBatchReadToolCalls(snapshot);

		// batch_read call stripped
		expect(result).not.toContain("\"name\":\"batch_read\"");

		// Orphaned result dropped (backward compat: both "tool" and "toolResult" are matched)
		expect(result).not.toContain("br-role-old");
		expect(result).not.toContain("orphaned content");
	});

	it("stripBatchReadToolCalls drops orphans with role 'toolResult'", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "br-role-new", name: "batch_read", arguments: {} },
					],
					timestamp: 1,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult", // Correct role
					toolCallId: "br-role-new",
					content: [{ type: "text", text: "orphaned content" }],
					timestamp: 2,
				},
			},
		]);

		const result = stripBatchReadToolCalls(snapshot);

		// Call stripped, result dropped
		expect(result).not.toContain("\"name\":\"batch_read\"");
		expect(result).not.toContain("br-role-new");
		expect(result).not.toContain("orphaned content");
	});
});

// ===========================================================================
// 4. Full pipeline: sanitizeForkSnapshot with production JSONL format
// ===========================================================================
// Tests the complete sanitizeForkSnapshot pipeline with realistic JSONL data
// using `id` field on toolCalls and `role: "toolResult"` on tool results.
// ===========================================================================

describe("sanitizeForkSnapshot full pipeline with production JSONL format", () => {
	it("strips batch_read calls + results, preserves flow calls + results, compresses flow results", () => {
		const flowCache = new Map<string, CompressedFlowResult[]>();
		flowCache.set("flow-id-pipeline", [{ type: "scout", status: "accomplished", files: [{ path: "src/a.ts", role: "read" }] }]);

		const header = { version: 1, systemPrompt: "System prompt without sliding tag" };

		const snapshot = makeSnapshot([
			header,
			// User message
			{ type: "message", message: { role: "user", content: "Read the codebase", timestamp: 1 } },
			// Assistant with batch_read (uses `id` field) — should be stripped
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Let me read the files." },
						{ type: "toolCall", id: "br-id-pipeline", name: "batch_read", arguments: { o: [{ o: "read", p: "src/a.ts" }, { o: "read", p: "src/b.ts" }] } },
					],
					timestamp: 2,
				},
			},
			// batch_read tool result (uses role: "toolResult") — should be stripped (orphan)
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "br-id-pipeline",
					content: [{ type: "text", text: "Full file content of a.ts and b.ts that is very long..." }],
					timestamp: 3,
				},
			},
			// Assistant with flow tool call (uses `id` field) — should be preserved
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Delegating to scout flow." },
						{ type: "toolCall", id: "flow-id-pipeline", name: "flow", arguments: { flow: [{ type: "scout", intent: "Map the codebase" }] } },
					],
					timestamp: 4,
				},
			},
			// Flow tool result (uses role: "toolResult") — should be preserved + compressed
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "flow-id-pipeline",
					content: [{ type: "text", text: "Very long flow result that should be compressed into a compact summary..." }],
					timestamp: 5,
				},
			},
			// Assistant summary after flow
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Here is the summary of the codebase." }],
					timestamp: 6,
				},
			},
			// Current user message
			{ type: "message", message: { role: "user", content: "Now implement the feature", timestamp: 7 } },
		]);

		const result = sanitizeForkSnapshot(snapshot, flowCache);

		// (a) batch_read calls stripped from assistant messages
		expect(result).not.toContain("\"name\":\"batch_read\"");

		// (b) batch_read tool results DROPPED to avoid orphaned tool results
		expect(result).not.toContain("br-id-pipeline");
		expect(result).not.toContain("Full file content of a.ts and b.ts");

		// (c) flow tool calls and results preserved
		expect(result).toContain("flow-id-pipeline");
		expect(result).toContain('"name":"flow"');
		expect(result).toContain("Delegating to scout flow.");

		// (d) flow result compressed
		expect(result).toContain("[Flow: scout accomplished]");
		expect(result).toContain("src/a.ts");
		expect(result).not.toContain("Very long flow result");

		// Other messages preserved
		expect(result).toContain("Read the codebase");
		expect(result).toContain("Here is the summary of the codebase.");
		expect(result).toContain("Now implement the feature");
		expect(result).toContain("Let me read the files.");
	});

	it("preserves non-batch_read tool calls and results in pipeline", () => {
		const snapshot = makeSnapshot([
			{ version: 1 },
			{ type: "message", message: { role: "user", content: "Do work", timestamp: 1 } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "bash-id-1", name: "bash", arguments: { command: "ls" } },
					],
					timestamp: 2,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "bash-id-1",
					content: [{ type: "text", text: "file1.ts\nfile2.ts" }],
					timestamp: 3,
				},
			},
		]);

		const result = sanitizeForkSnapshot(snapshot, new Map());

		// bash call and result preserved
		expect(result).toContain("bash-id-1");
		expect(result).toContain("file1.ts");
	});

	it("returns null for null input", () => {
		expect(sanitizeForkSnapshot(null)).toBeNull();
	});

	it("handles snapshot with only batch_read calls (no other tools)", () => {
		const snapshot = makeSnapshot([
			{ version: 1 },
			{ type: "message", message: { role: "user", content: "Read files", timestamp: 1 } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "br-solo", name: "batch_read", arguments: { o: [{ o: "read", p: "x.ts" }] } },
					],
					timestamp: 2,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "br-solo",
					content: [{ type: "text", text: "x.ts content" }],
					timestamp: 3,
				},
			},
		]);

		const result = sanitizeForkSnapshot(snapshot, new Map());

		// batch_read calls stripped from assistant, toolResults dropped
		expect(result).not.toContain("\"name\":\"batch_read\"");
		expect(result).not.toContain("br-solo");
		expect(result).not.toContain("x.ts content");

		// Header and user preserved
		expect(result).toContain("version");
		expect(result).toContain("Read files");
	});

	it("drops tool results with empty/whitespace toolCallId to prevent API rejections", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "tc-normal", name: "bash", arguments: { command: "ls" } },
					],
					timestamp: 1,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc-normal",
					content: [{ type: "text", text: "normal result" }],
					timestamp: 2,
				},
			},
			// Tool result with EMPTY toolCallId — should be dropped
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "",
					content: [{ type: "text", text: "empty id result" }],
					timestamp: 3,
				},
			},
			// Tool result with WHITESPACE toolCallId — should be dropped
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "   ",
					content: [{ type: "text", text: "whitespace id result" }],
					timestamp: 4,
				},
			},
			// Tool result with content-level empty toolCallId — should be dropped
			{
				type: "message",
				message: {
					role: "toolResult",
					content: [
						{ type: "toolResult", toolCallId: "", content: "content-level empty" },
					],
					timestamp: 5,
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());

		// Normal result preserved
		expect(result).toContain("tc-normal");
		expect(result).toContain("normal result");

		// Empty/whitespace ID results dropped
		expect(result).not.toContain("empty id result");
		expect(result).not.toContain("whitespace id result");
		expect(result).not.toContain("content-level empty");
	});

	it("handles assistant message with both batch_read and non-batch_read toolCalls using `id` field", () => {
		const snapshot = makeSnapshot([
			{ version: 1 },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "br-mixed", name: "batch_read", arguments: { o: [{ o: "read", p: "a.ts" }] } },
						{ type: "toolCall", id: "bash-mixed", name: "bash", arguments: { command: "ls" } },
					],
					timestamp: 1,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "br-mixed",
					content: [{ type: "text", text: "a.ts content" }],
					timestamp: 2,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "bash-mixed",
					content: [{ type: "text", text: "ls output" }],
					timestamp: 3,
				},
			},
		]);

		const result = sanitizeForkSnapshot(snapshot, new Map());

		// batch_read call stripped from assistant, toolResult dropped
		expect(result).not.toContain("\"name\":\"batch_read\"");
		expect(result).not.toContain("br-mixed");
		expect(result).not.toContain("a.ts content");

		// bash call + result preserved
		expect(result).toContain("bash-mixed");
		expect(result).toContain("ls output");
	});

	it("forbids orphaned batch_read toolResults — must drop them entirely, never compress-and-keep", () => {
		const snapshot = makeSnapshot([
			{ version: 1 },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "br-orphan-guard", name: "batch_read", arguments: { o: [{ o: "read", p: "src/a.ts" }] } },
					],
					timestamp: 1,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "br-orphan-guard",
					content: [{ type: "text", text: "full content here" }],
					timestamp: 2,
				},
			},
		]);

		const result = stripBatchReadToolCalls(snapshot);

		// HARD CONTRACT: orphaned batch_read toolResults must be COMPLETELY REMOVED.
		// Keeping them (even compressed) creates orphaned tool results that cause
		// child pi processes to fail on startup with "tool_call_id is not found".
		expect(result).not.toContain("br-orphan-guard");
		expect(result).not.toContain("[batch_read]");
		expect(result).not.toContain("full content here");
		expect(result).not.toContain("\"name\":\"batch_read\"");
	});
});

// ===========================================================================
// Assistant usage must survive fork sanitization (child pi replays JSONL)
// ===========================================================================

describe("sanitizeForkSnapshot preserves assistant usage", () => {
	it("keeps message.usage.totalTokens while stripping api/provider/model/stopReason/responseId", () => {
		const snapshot = makeSnapshot([
			{ version: 1 },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					timestamp: 1,
					api: "openai",
					provider: "wafer",
					model: "glm-5.1",
					usage: { input: 10, output: 5, totalTokens: 8821, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					stopReason: "stop",
					responseId: "resp_1",
					responseModel: "glm-5.1",
				},
			},
		]);

		const result = sanitizeForkSnapshot(snapshot, new Map());
		const entries = parseSnapshot(result!);
		const assistant = entries.find((e: any) => e?.message?.role === "assistant");

		expect(assistant?.message?.usage?.totalTokens).toBe(8821);
		expect(assistant?.message?.usage?.input).toBe(10);
		expect(assistant?.message?.api).toBeUndefined();
		expect(assistant?.message?.provider).toBeUndefined();
		expect(assistant?.message?.model).toBeUndefined();
		expect(assistant?.message?.stopReason).toBeUndefined();
		expect(assistant?.message?.responseId).toBeUndefined();
		expect(assistant?.message?.responseModel).toBeUndefined();
	});
});
