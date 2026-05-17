import { describe, it, expect } from "vitest";
import {
	compressToolResults,
	stripBatchReadToolCalls,
	depthToPolicy,
	sanitizeForkSnapshot,
} from "../src/snapshot/snapshot.js";
import { STEERING_HINT } from "../src/steering/sliding-prompt.js";
import type { CompressedFlowResult } from "../src/types/output.js";

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

		expect(result).toContain("preview");
		expect(result).toContain("line 1");
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
				message: { role: "user", content: "Read files from /src/ and /tests/ directories to understand the project layout.", timestamp: 0 },
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

	it("handles assistant with only batch_read `id`-field calls (drops the message)", () => {
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
		expect(assistantMsg).toBeUndefined();
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
		expect(result).toContain("preview");
		expect(result).toContain("line 1");
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
		expect(result).toContain("preview");
		expect(result).toContain("line 1");
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
			{ type: "message", message: { role: "user", content: "Read the codebase starting at /src/index.ts to understand the architecture.", timestamp: 1 } },
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
						{ type: "text", text: "Transitioning to scout flow." },
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
					content: [{ type: "text", text: "Here is the summary of the codebase — see [scout] results." }],
					timestamp: 6,
				},
			},
			// Current user message
			{ type: "message", message: { role: "user", content: "Now implement the feature using /src/feature.ts as the base implementation guide.", timestamp: 7 } },
		]);

		const { result } = sanitizeForkSnapshot(snapshot, flowCache);

		// (a) batch_read calls stripped from assistant messages
		expect(result).not.toContain("\"name\":\"batch_read\"");

		// (b) batch_read tool results DROPPED to avoid orphaned tool results
		expect(result).not.toContain("br-id-pipeline");
		expect(result).not.toContain("Full file content of a.ts and b.ts");

		// (c) flow tool calls and results preserved
		expect(result).toContain("flow-id-pipeline");
		expect(result).toContain('"name":"flow"');
		expect(result).toContain("Transitioning to scout flow.");

		// (d) flow result compressed
		expect(result).toContain("[Flow: scout accomplished]");
		expect(result).toContain("src/a.ts");
		expect(result).not.toContain("Very long flow result");

		// Other messages preserved
		expect(result).toContain("Read the codebase starting at /src/index.ts to understand the architecture.");
		expect(result).toContain("Here is the summary of the codebase — see [scout] results.");
		expect(result).toContain("Now implement the feature using /src/feature.ts as the base implementation guide.");
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

		const { result } = sanitizeForkSnapshot(snapshot, new Map());

		// bash call and result preserved
		expect(result).toContain("bash-id-1");
		expect(result).toContain("file1.ts");
	});

	it("returns null for null input", () => {
		expect(sanitizeForkSnapshot(null).result).toBeNull();
	});

	it("handles snapshot with only batch_read calls (no other tools)", () => {
		const snapshot = makeSnapshot([
			{ version: 1 },
			{ type: "message", message: { role: "user", content: "Read files from /src/ and /tests/ directories to understand the project layout.", timestamp: 1 } },
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

		const { result } = sanitizeForkSnapshot(snapshot, new Map());

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

		const { result } = sanitizeForkSnapshot(snapshot, new Map());

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

		const { result } = sanitizeForkSnapshot(snapshot, new Map());
		const entries = parseSnapshot(result!);
		const assistant = entries.find((e: any) => e?.message?.role === "assistant");

		expect(assistant?.message?.usage?.totalTokens).toBe(8821);
		expect(assistant?.message?.usage?.input).toBeUndefined();
		expect(assistant?.message?.usage?.output).toBeUndefined();
		expect(assistant?.message?.usage?.cacheRead).toBeUndefined();
		expect(assistant?.message?.usage?.cacheWrite).toBeUndefined();
		expect(assistant?.message?.api).toBeUndefined();
		expect(assistant?.message?.provider).toBeUndefined();
		expect(assistant?.message?.model).toBeUndefined();
		expect(assistant?.message?.stopReason).toBeUndefined();
		expect(assistant?.message?.responseId).toBeUndefined();
		expect(assistant?.message?.responseModel).toBeUndefined();
	});
});

// ===========================================================================
// Regression: orphaned parentId after destructive passes
// ===========================================================================

describe("sanitizeForkSnapshot reparentOrphans regression", () => {
	it("fixes parentIds orphaned by stripBatchRead and compressToolResults", () => {
		const snapshot = makeSnapshot([
			{ version: 1 },
			{
				type: "message",
				message: {
					role: "assistant",
					id: "msg-1",
					content: [{ type: "text", text: "Plan" }],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					id: "msg-2",
					parentId: "msg-1",
					content: [
						{ type: "toolCall", id: "br-1", name: "batch_read", arguments: { o: [{ o: "read", p: "a.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					id: "msg-3",
					parentId: "msg-2",
					toolCallId: "br-1",
					content: [{ type: "text", text: "a.ts content" }],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					id: "msg-4",
					parentId: "msg-3",
					content: [{ type: "text", text: "Next step" }],
				},
			},
		]);

		const { result } = sanitizeForkSnapshot(snapshot, new Map());
		const entries = parseSnapshot(result!);

		// batch_read tool call and result should be stripped
		expect(entries.some((e: any) => Array.isArray(e?.message?.content) && e?.message?.content?.some((c: any) => c?.name === "batch_read"))).toBe(false);
		expect(entries.some((e: any) => e?.message?.toolCallId === "br-1")).toBe(false);

		// Collect surviving IDs
		const survivingIds = new Set<string>();
		for (const entry of entries) {
			const id = entry?.message?.id ?? entry?.message?.messageId ?? entry?.id;
			if (typeof id === "string") survivingIds.add(id);
			const parentId = entry?.parentId ?? entry?.parentMessageId ?? entry?.message?.parentId ?? entry?.message?.parentMessageId;
			if (typeof parentId === "string") survivingIds.add(parentId);
		}

		// No parentId should reference a non-existent message
		for (const entry of entries) {
			const parentId = entry?.message?.parentId ?? entry?.message?.parentMessageId;
			if (typeof parentId === "string") {
				expect(survivingIds.has(parentId)).toBe(true);
			}
		}

		// msg-4 should be reparented (parentId msg-3 was dropped, so it should now
		// either point to msg-2 or have no parentId)
		const msg4 = entries.find((e: any) => e?.message?.id === "msg-4");
		expect(msg4).toBeDefined();
		const msg4ParentId = msg4?.message?.parentId ?? msg4?.message?.parentMessageId;
		if (msg4ParentId !== undefined) {
			expect(survivingIds.has(msg4ParentId)).toBe(true);
		}
	});

	it("reparents entry-level parentId when target message is dropped", () => {
		const snapshot = makeSnapshot([
			{ version: 1, id: "session-1" },
			{
				type: "message",
				id: "user-1",
				parentId: "session-1",
				message: { role: "user", content: "hello" },
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: "user-1",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "br-1", name: "batch_read", arguments: { o: [{ o: "read", p: "a.ts" }] } }],
				},
			},
			{
				type: "message",
				id: "tool-1",
				parentId: "assistant-1",
				message: {
					role: "toolResult",
					toolCallId: "br-1",
					content: "a.ts content",
				},
			},
			{
				type: "message",
				id: "assistant-2",
				parentId: "tool-1",
				message: {
					role: "assistant",
					content: "Next",
				},
			},
		]);

		const { result } = sanitizeForkSnapshot(snapshot, new Map());
		const entries = parseSnapshot(result!);

		// batch_read and its result should be gone
		expect(entries.some((e: any) => Array.isArray(e?.message?.content) && e.message.content.some((c: any) => c?.name === "batch_read"))).toBe(false);
		expect(entries.some((e: any) => e?.message?.toolCallId === "br-1")).toBe(false);

		// Collect surviving IDs
		const survivingIds = new Set<string>();
		for (const entry of entries) {
			const id = entry?.message?.id ?? entry?.message?.messageId ?? entry?.id;
			if (typeof id === "string") survivingIds.add(id);
			const parentId = entry?.parentId ?? entry?.parentMessageId ?? entry?.message?.parentId ?? entry?.message?.parentMessageId;
			if (typeof parentId === "string") survivingIds.add(parentId);
		}

		// No parentId should reference a non-existent message
		for (const entry of entries) {
			const entryParentId = entry?.parentId ?? entry?.parentMessageId;
			const msgParentId = entry?.message?.parentId ?? entry?.message?.parentMessageId;
			const parentId = entryParentId ?? msgParentId;
			if (typeof parentId === "string") {
				expect(survivingIds.has(parentId)).toBe(true);
			}
		}

		// assistant-2 should have its entry-level parentId stripped
		const assistant2 = entries.find((e: any) => e?.id === "assistant-2");
		expect(assistant2).toBeDefined();
		expect(assistant2?.parentId).toBeUndefined();
		expect(assistant2?.parentMessageId).toBeUndefined();
		expect(assistant2?.message?.parentId).toBeUndefined();
		expect(assistant2?.message?.parentMessageId).toBeUndefined();
	});

	it("returns passesApplied with individually named sub-passes", () => {
		const snapshot = makeSnapshot([
			{ version: 1, systemPrompt: "You are helpful" },
			{
				type: "message",
				message: {
					role: "system",
					content: STEERING_HINT,
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: "Hello",
					timestamp: 1234567890,
					api: "openai",
					provider: "wafer",
					model: "glm-5.1",
					usage: { totalTokens: 100, cost: { total: 0 } },
					stopReason: "stop",
					responseId: "resp_1",
					responseModel: "glm-5.1",
					reasoning: "I should greet",
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "Result\n\n[Hint: Plan next step.]",
					details: { flowStyle: "scout" },
				},
			},
		]);

		const { result, passesApplied } = sanitizeForkSnapshot(snapshot, new Map());
		expect(result).toBeDefined();

		// Sub-passes that should fire for this snapshot
		expect(passesApplied).toContain("stripSystemPrompt");
		expect(passesApplied).toContain("dropSlidingSystemPrompts");
		expect(passesApplied).toContain("normalizeToolResultRole");
		expect(passesApplied).toContain("stripReasoning");
		expect(passesApplied).toContain("stripTimestamps");
		expect(passesApplied).toContain("stripApiMetadata");
		expect(passesApplied).toContain("stripDetails");
		expect(passesApplied).toContain("stripStrategicHints");

		// Main pipeline passes
		expect(passesApplied).toContain("reparentOrphans");
		expect(passesApplied).toContain("stripBatchRead");
		expect(passesApplied).toContain("compressToolResults");

		// Order: sub-passes first (in insertion order), then main passes
		const reparentIndex1 = passesApplied.indexOf("reparentOrphans");
		const stripBatchIndex = passesApplied.indexOf("stripBatchRead");
		const compressIndex = passesApplied.indexOf("compressToolResults");
		const reparentIndex2 = passesApplied.lastIndexOf("reparentOrphans");

		expect(reparentIndex1).toBeLessThan(stripBatchIndex);
		expect(stripBatchIndex).toBeLessThan(compressIndex);
		expect(compressIndex).toBeLessThan(reparentIndex2);
	});
});

// ---------------------------------------------------------------------------
// 7. STRATEGIC HINTS STRIPPED FROM ALL ROLES
// ---------------------------------------------------------------------------
describe("STRATEGIC HINTS STRIPPED FROM ALL ROLES", () => {
	it("strips [Directive: ...] and [Hint: ...] from assistant, user, and toolResult messages", () => {
		const snapshot = makeSnapshot([
			{ type: "session", id: "session-1", systemPrompt: "You are helpful" },
			{
				type: "message",
				message: {
					role: "assistant",
					content: "Some analysis here with detailed reasoning.\n\n[Directive: Close what you start. Dispatch a [build] or [scout] flow to verify before advancing.]",
					id: "msg-assistant-directive",
				},
			},
			{
				type: "message",
				message: {
					role: "user",
					content: "Please continue with the implementation and ensure all edge cases are covered before submitting the final result for review.\n\n[Directive: Unfinished work detected. Dispatch a [build] or [debug] flow to close the notDone items. Do not start new work until these are resolved.]",
					id: "msg-user-directive",
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "Tool output here.\n\n[Directive: Dispatch the same [build] or [scout] flow to verify uncertainty.]",
					id: "msg-tool-directive",
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: "Legacy hint test with coverage of system architecture.\n\n[Hint: Plan next step.]",
					id: "msg-assistant-hint",
				},
			},
		]);

		const { result, passesApplied } = sanitizeForkSnapshot(snapshot, new Map());
		expect(result).toBeDefined();
		expect(passesApplied).toContain("stripStrategicHints");

		const entries = parseSnapshot(result!);

		const assistantDirective = entries.find((e: any) => e?.message?.id === "msg-assistant-directive");
		const userDirective = entries.find((e: any) => e?.message?.id === "msg-user-directive");
		const toolDirective = entries.find((e: any) => e?.message?.id === "msg-tool-directive");
		const assistantHint = entries.find((e: any) => e?.message?.id === "msg-assistant-hint");

		expect(assistantDirective).toBeDefined();
		expect(userDirective).toBeDefined();
		expect(toolDirective).toBeDefined();
		expect(assistantHint).toBeDefined();

		const assistantDirectiveText = typeof assistantDirective.message.content === "string"
			? assistantDirective.message.content
			: assistantDirective.message.content?.find((p: any) => p.type === "text")?.text ?? "";
		const userDirectiveText = typeof userDirective.message.content === "string"
			? userDirective.message.content
			: userDirective.message.content?.find((p: any) => p.type === "text")?.text ?? "";
		const toolDirectiveText = typeof toolDirective.message.content === "string"
			? toolDirective.message.content
			: toolDirective.message.content?.find((p: any) => p.type === "text")?.text ?? "";
		const assistantHintText = typeof assistantHint.message.content === "string"
			? assistantHint.message.content
			: assistantHint.message.content?.find((p: any) => p.type === "text")?.text ?? "";

		// Assert directives/hints are stripped
		expect(assistantDirectiveText).not.toContain("[Directive: Close what you start.");
		expect(userDirectiveText).not.toContain("[Directive: Unfinished work detected.");
		expect(toolDirectiveText).not.toContain("[Directive: Dispatch the same [build] or [scout] flow");
		expect(assistantHintText).not.toContain("[Hint: Plan next step.]");

		// Assert non-directive parts remain
		expect(assistantDirectiveText).toContain("Some analysis here with detailed reasoning.");
		expect(userDirectiveText).toContain("Please continue with the implementation and ensure all edge cases are covered before submitting the final result for review.");
		expect(toolDirectiveText).toContain("Tool output here.");
		expect(assistantHintText).toContain("Legacy hint test with coverage of system architecture.");
	});
});

// ===========================================================================
// 8. Defense-in-depth: child context whitelist & blacklist guard rail
// ===========================================================================
// This test is a guard rail. If you add a new injection point, it MUST be
// stripped before reaching child flows. If this test fails, either strip the
// new artifact or explicitly add it to the whitelist with a justification
// comment.
// ===========================================================================

describe("DEFENSE IN DEPTH — child context whitelist & blacklist", () => {
	it("only whitelisted fields survive sanitization; blacklisted content is fully stripped", () => {
		const flowCache = new Map<string, CompressedFlowResult[]>();
		flowCache.set("flow-id-guard", [{ type: "build", status: "accomplished" }]);

		const snapshot = makeSnapshot([
			// Session entry with every possible field + extra unknowns
			{
				type: "session",
				id: "sess-parent",
				systemPrompt: "You are in the primary flow.",
				version: "1.2.3",
				timestamp: "2026-05-17T00:00:00.000Z",
				cwd: "/Users/__blitzzz/Documents/GitHub/pi-agent-flow",
				forkedFrom: "sess-grandparent",
				forkedAt: "2026-05-17T00:00:00.000Z",
				parentFlow: "scout",
				depth: 1,
				unknownField1: "should-be-stripped",
				extraMetadata: { foo: "bar" },
			},
			// Steering hint system message — should be dropped entirely
			{
				type: "message",
				message: {
					role: "system",
					content: STEERING_HINT,
					id: "steering-msg",
				},
			},
			// Assistant message with every possible field
			{
				type: "message",
				message: {
					role: "assistant",
					id: "assistant-1",
					parentId: "user-1",
					content: [
						{ type: "text", text: "Planning next step." },
						{ type: "toolCall", id: "batch_read-guard", name: "batch_read", arguments: { o: [{ o: "read", p: "src/a.ts" }] } },
						{ type: "toolCall", id: "flow-id-guard", name: "flow", arguments: { flow: [{ type: "build" }] } },
					],
					timestamp: 1715923200000,
					api: "openai",
					provider: "wafer",
					model: "glm-5.1",
					stopReason: "stop",
					responseId: "resp_guard",
					responseModel: "glm-5.1",
					thinking: "I should plan",
					thinkingSignature: "sig1",
					reasoning: "Plan is good",
					reasoningContent: "Detailed reasoning",
					reasoningSignature: "sig2",
					usage: { input: 100, output: 50, totalTokens: 150, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			},
			// User message with directives and steering hint tags
			{
				type: "message",
				message: {
					role: "user",
					id: "user-1",
					parentId: "assistant-1",
					content: "Implement auth.\n\n[Directive: Close what you start.]\n\n<pi-flow-steering-hint id=\"test\">hint text</pi-flow-steering-hint>",
					timestamp: 1715923201000,
				},
			},
			// ToolResult message with directives, hints, details
			{
				type: "message",
				message: {
					role: "toolResult",
					id: "toolresult-1",
					parentId: "assistant-1",
					toolCallId: "flow-id-guard",
					content: "Flow completed.\n\n[Directive: Verify results.]\n\n[Hint: Plan next step.]",
					timestamp: 1715923202000,
					details: { flowStyle: "build", mode: "fast", results: ["foo"] },
				},
			},
			// batch_read toolResult (orphan, should be dropped)
			{
				type: "message",
				message: {
					role: "toolResult",
					id: "toolresult-br",
					parentId: "assistant-1",
					toolCallId: "batch_read-guard",
					content: [{ type: "text", text: "Full file content here that should be stripped." }],
					timestamp: 1715923203000,
				},
			},
			// Standalone system event — should be dropped
			{ type: "system", content: "Hidden system prompt", id: "sys-1" },
			// model_change — should be dropped
			{ type: "model_change", model: "glm-5.1", id: "mc-1" },
			// thinking_level_change — should be dropped
			{ type: "thinking_level_change", level: 2, id: "tlc-1" },
			// custom_message — should be dropped
			{ type: "custom_message", content: "Hidden continuation hook", id: "cm-1" },
			// Unknown type — should be dropped
			{ type: "unknown_type", content: "Should not leak", id: "unk-1" },
		]);

		const { result } = sanitizeForkSnapshot(snapshot, flowCache, { depth: 1 });

		// ---- 1. CONTENT BLACKLIST: assert NONE of these patterns appear anywhere ----
		const blacklistPatterns = [
			"[Directive:",
			"[Hint:",
			"<pi-flow-steering-hint",
			'"api":',
			'"provider":',
			'"model":',
			'"stopReason":',
			'"responseId":',
			'"responseModel":',
			'"thinking":',
			'"thinkingSignature":',
			'"reasoning":',
			'"reasoningContent":',
			'"reasoningSignature":',
			'"timestamp":',
			'"details":',
			'"cacheRead":',
			'"cacheWrite":',
			'"cost":',
			"batch_read",
		];

		for (const pattern of blacklistPatterns) {
			expect(result).not.toContain(pattern);
		}

		// ---- 2. FIELD WHITELIST: assert each surviving entry only has allowed keys ----
		const entries = parseSnapshot(result!);

		// Allowed outer keys for session/header entries
		const sessionWhitelist = new Set([
			"type", "systemPrompt", "version", "cwd",
			"forkedFrom", "forkedAt", "parentFlow", "depth", "parentId",
		]);

		// Allowed keys for ALL message roles
		const messageBaseWhitelist = new Set([
			"role", "id", "parentId", "content",
		]);

		// Extra allowed keys for assistant
		const assistantExtraWhitelist = new Set([
			"usage", "toolCallId", "toolName", "errorMessage",
			"parentMessageId", "messageId",
		]);

		// Extra allowed keys for tool/toolResult
		const toolExtraWhitelist = new Set([
			"toolCallId", "toolName",
		]);

		for (const entry of entries) {
			// Session/header entry
			if (entry.type === "session" || (!entry.type && !entry.message)) {
				for (const key of Object.keys(entry)) {
					if (!sessionWhitelist.has(key)) {
						throw new Error(
							`Unexpected field '${key}' in session entry of child context — ` +
							`add to whitelist or strip in sanitization`
						);
					}
				}
				continue;
			}

			// Message entry — check message object keys
			if (entry.message) {
				const role = entry.message.role;
				const allowed = new Set(messageBaseWhitelist);
				if (role === "assistant") {
					for (const k of assistantExtraWhitelist) allowed.add(k);
				} else if (role === "tool" || role === "toolResult") {
					for (const k of toolExtraWhitelist) allowed.add(k);
				}

				for (const key of Object.keys(entry.message)) {
					if (!allowed.has(key)) {
						throw new Error(
							`Unexpected field '${key}' in ${role} message of child context — ` +
							`add to whitelist or strip in sanitization`
						);
					}
				}

				// Special check: usage must ONLY contain totalTokens
				if (entry.message.usage && typeof entry.message.usage === "object") {
					for (const uKey of Object.keys(entry.message.usage)) {
						if (uKey !== "totalTokens") {
							throw new Error(
								`Unexpected usage sub-field '${uKey}' in assistant message — ` +
								`strip in sanitization`
							);
						}
					}
				}
			}
		}
	});
});
