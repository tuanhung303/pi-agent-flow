import { describe, it, expect } from "vitest";
import { compressToolResults } from "../src/snapshot/snapshot.js";
import { evictCacheOverflow } from "../src/core/executor.js";
import { stripStrategicHints } from "../src/steering/tool-utils.js";

// ---------------------------------------------------------------------------
// stripStrategicHints
// ---------------------------------------------------------------------------
describe("stripStrategicHints", () => {
	it("removes strategic hint from text", () => {
		const text = "Some tool result\n\n[Hint: Plan next step. Prioritize batch/parallel tool calls. Execute decisively.]";
		expect(stripStrategicHints(text)).toBe("Some tool result");
	});

	it("leaves text unchanged if no hint", () => {
		const text = "Some tool result without hint";
		expect(stripStrategicHints(text)).toBe(text);
	});

	it("removes multiple hints", () => {
		const text = "A\n\n[Hint: Plan next step.]B\n\n[Hint: Execute decisively.]C";
		expect(stripStrategicHints(text)).toBe("ABC");
	});

	it("handles multiline hints", () => {
		const text = "Result\n\n[Hint: Line 1\nLine 2]";
		expect(stripStrategicHints(text)).toBe("Result");
	});
});

// ---------------------------------------------------------------------------
// compressToolResults — batch / web / ask_user
// ---------------------------------------------------------------------------
function makeSnapshot(lines: any[]): string {
	return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

describe("compressToolResults — batch", () => {
	it("truncates read content and compresses bash sections", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "read", p: "src/file.ts" }, { o: "bash", p: ".", c: "ls" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "2 operations: 1 read, 1 bash\n\n--- src/file.ts (42 lines) ---\nline 1\nline 2\n\n--- bash [abc] exit 0 ---\n[Execution time: 0.5s (avg)]\noutput",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("2 operations: 1 read, 1 bash");
		expect(result).toContain("--- src/file.ts (42 lines, content truncated) ---");
		expect(result).not.toContain("line 1\nline 2");
		const lines = result.trimEnd().split("\n");
		const toolLine = lines.find((l) => l.includes('"role":"toolResult"'))!;
		const parsed = JSON.parse(toolLine);
		const text = parsed.message.content[0].text;
		expect(text).toContain("[bash:ok] abc · exit 0 · 0.5s (avg) · 1 line\n> head:\noutput");
		expect(result).not.toContain("--- bash [abc] exit 0 ---");
	});

	it("truncates context map sections", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "read", p: "src/file.ts" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "1 operation: 1 read\n\n--- src/file.ts context map ---\nTotal lines: 100\nUse targeted reads...",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("--- src/file.ts (context map, truncated) ---");
		expect(result).not.toContain("Use targeted reads");
	});

	it("compresses edit sections to compact format at depth 1", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "edit", p: "src/index.ts" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "1 operation: 1 edit\n\n--- edit: src/index.ts (2 blocks) ---",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("[batch:edit] src/index.ts (2 blocks)");
		expect(result).not.toContain("--- edit: src/index.ts (2 blocks) ---");
	});

	it("compresses write sections to compact format at depth 1", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "write", p: "src/config.ts" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "1 operation: 1 write\n\n--- write: src/config.ts (1234 bytes) ---",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("[batch:write] src/config.ts (1234 bytes)");
		expect(result).not.toContain("--- write: src/config.ts (1234 bytes) ---");
	});

	it("keeps delete sections in existing format", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "delete", p: "src/old.ts" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "1 operation: 1 delete\n\n--- delete: src/old.ts ---",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("--- delete: src/old.ts ---");
	});

	it("compresses oversized bash sections in snapshots at depth 1", () => {
		const longOutput = Array.from({ length: 1000 }, (_, i) => `output line ${i + 1}`).join("\n");
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "bash", p: ".", c: "cat big.log" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "tool",
					toolCallId: "tc1",
					content: `1 operation: 1 bash\n\n--- bash [big] exit 0 ---\n[Execution time: 0.5s (avg)]\n${longOutput}`,
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map(), 1);
		const lines = result.trimEnd().split("\n");
		const toolLine = lines.find((l) => l.includes('"role":"tool"'))!;
		const parsed = JSON.parse(toolLine);
		const text = parsed.message.content[0].text;
		expect(text).toContain("[bash:ok] big · exit 0 · 0.5s (avg) · 1000 lines\n> head:\noutput line 1\noutput line 2\noutput line 3");
		expect(text).not.toContain("output line 1000");
		expect(result).not.toContain("--- bash [big] exit 0 ---");
	});

	it("compresses pending bash sections in snapshots at depth 1", () => {
		const longOutput = Array.from({ length: 1000 }, (_, i) => `pending line ${i + 1}`).join("\n");
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "bash", p: ".", c: "sleep 30", i: "pending1" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "tool",
					toolCallId: "tc1",
					content: `1 operation: 1 bash\n\n--- bash [pending1] pending ---\n[partial output]\n${longOutput}\n[Use batch_bash_poll with i: ["pending1"] to check results]`,
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map(), 1);
		const lines = result.trimEnd().split("\n");
		const toolLine = lines.find((l) => l.includes('"role":"tool"'))!;
		const parsed = JSON.parse(toolLine);
		const text = parsed.message.content[0].text;
		expect(text).toContain("[bash:pending] pending1 · still running · 1000 lines partial\n> head:\npending line 1\npending line 2\npending line 3");
		expect(text).not.toContain("pending line 1000");
		expect(result).not.toContain("--- bash [pending1] pending ---");
	});

	it("does not truncate on --- lines inside file content", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "read", p: "README.md" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "1 operation: 1 read\n\n--- README.md (10 lines) ---\n# Title\n\n---\n\nSome content after horizontal rule\n\n--- bash [abc] exit 0 ---\n[Execution time: 0.1s]\noutput",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("--- README.md (10 lines, content truncated) ---");
		expect(result).not.toContain("Some content after horizontal rule");
		const lines = result.trimEnd().split("\n");
		const toolLine = lines.find((l) => l.includes('"role":"toolResult"'))!;
		const parsed = JSON.parse(toolLine);
		const text = parsed.message.content[0].text;
		expect(text).toContain("[bash:ok] abc · exit 0 · 0.1s · 1 line\n> head:\noutput");
		expect(result).not.toContain("--- bash [abc] exit 0 ---");
	});
});


describe("compressToolResults — W1 write dedup + E1 edit dedup", () => {
	function getBatchText(result: string, tcId: string = "tc1"): string {
		const lines = result.trimEnd().split("\n");
		const toolLine = lines.find((l) =>
			(l.includes('"role":"tool"') || l.includes('"role":"toolResult"')) &&
			l.includes(`"toolCallId":"${tcId}"`)
		)!;
		const parsed = JSON.parse(toolLine);
		return parsed.message.content[0].text;
	}

	it("deduplicates 3 writes to same file → only latest kept", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "write", p: "src/config.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "1 operation: 1 write\n\n--- write: src/config.ts (100 bytes) ---",
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc2", name: "batch", arguments: { o: [{ o: "write", p: "src/config.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc2",
					content: "1 operation: 1 write\n\n--- write: src/config.ts (200 bytes) ---",
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc3", name: "batch", arguments: { o: [{ o: "write", p: "src/config.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc3",
					content: "1 operation: 1 write\n\n--- write: src/config.ts (300 bytes) ---",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		// Latest write preserved
		expect(result).toContain("[batch:write] src/config.ts (300 bytes)");
		// Earlier writes superseded at depth 1 (breadcrumb)
		const tc1Text = getBatchText(result, "tc1");
		const tc2Text = getBatchText(result, "tc2");
		expect(tc1Text).toContain("[batch:write] src/config.ts (superseded)");
		expect(tc2Text).toContain("[batch:write] src/config.ts (superseded)");
		expect(result).not.toContain("(100 bytes)");
		expect(result).not.toContain("(200 bytes)");
	});

	it("write-then-delete → write superseded by later delete", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "write", p: "src/temp.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "1 operation: 1 write\n\n--- write: src/temp.ts (50 bytes) ---",
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc2", name: "batch", arguments: { o: [{ o: "delete", p: "src/temp.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc2",
					content: "1 operation: 1 delete\n\n--- delete: src/temp.ts ---",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		// Write superseded
		const tc1Text = getBatchText(result, "tc1");
		expect(tc1Text).toContain("[batch:write] src/temp.ts (superseded)");
		// Delete kept in original format
		expect(result).toContain("--- delete: src/temp.ts ---");
	});

	it("deduplicates 3 edits to same file → only latest kept", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "edit", p: "src/index.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "1 operation: 1 edit\n\n--- edit: src/index.ts (1 block) ---",
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc2", name: "batch", arguments: { o: [{ o: "edit", p: "src/index.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc2",
					content: "1 operation: 1 edit\n\n--- edit: src/index.ts (2 blocks) ---",
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc3", name: "batch", arguments: { o: [{ o: "edit", p: "src/index.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc3",
					content: "1 operation: 1 edit\n\n--- edit: src/index.ts (3 blocks) ---",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("[batch:edit] src/index.ts (3 blocks)");
		const tc1Text = getBatchText(result, "tc1");
		const tc2Text = getBatchText(result, "tc2");
		expect(tc1Text).toContain("[batch:edit] src/index.ts (superseded)");
		expect(tc2Text).toContain("[batch:edit] src/index.ts (superseded)");
		expect(result).not.toContain("(1 block)");
		expect(result).not.toContain("(2 blocks)");
	});

	it("edit-then-write → edit superseded by later write", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "edit", p: "src/index.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "1 operation: 1 edit\n\n--- edit: src/index.ts (2 blocks) ---",
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc2", name: "batch", arguments: { o: [{ o: "write", p: "src/index.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc2",
					content: "1 operation: 1 write\n\n--- write: src/index.ts (500 bytes) ---",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		const tc1Text = getBatchText(result, "tc1");
		expect(tc1Text).toContain("[batch:edit] src/index.ts (superseded)");
		expect(result).toContain("[batch:write] src/index.ts (500 bytes)");
	});

	it("write-after-delete → both kept", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "delete", p: "src/index.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "1 operation: 1 delete\n\n--- delete: src/index.ts ---",
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc2", name: "batch", arguments: { o: [{ o: "write", p: "src/index.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc2",
					content: "1 operation: 1 write\n\n--- write: src/index.ts (400 bytes) ---",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("--- delete: src/index.ts ---");
		expect(result).toContain("[batch:write] src/index.ts (400 bytes)");
	});

	it("edit-after-write → both kept", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "write", p: "src/index.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "1 operation: 1 write\n\n--- write: src/index.ts (400 bytes) ---",
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc2", name: "batch", arguments: { o: [{ o: "edit", p: "src/index.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc2",
					content: "1 operation: 1 edit\n\n--- edit: src/index.ts (1 block) ---",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("[batch:write] src/index.ts (400 bytes)");
		expect(result).toContain("[batch:edit] src/index.ts (1 block)");
	});

	it("error writes/edits are exempt from dedup", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "write", p: "src/missing.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "1 operation: 1 write\n\n--- write: src/missing.ts ---\nError: ENOENT",
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc2", name: "batch", arguments: { o: [{ o: "write", p: "src/missing.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc2",
					content: "1 operation: 1 write\n\n--- write: src/missing.ts ---\nError: ENOENT",
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc3", name: "batch", arguments: { o: [{ o: "edit", p: "src/bad.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc3",
					content: "1 operation: 1 edit\n\n--- edit: src/bad.ts ---\nError: No changes",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		// Error writes kept verbatim
		expect(result).toContain("--- write: src/missing.ts ---");
		expect(result).toContain("Error: ENOENT");
		// Error edits kept verbatim
		expect(result).toContain("--- edit: src/bad.ts ---");
		expect(result).toContain("Error: No changes");
	});

	it("depth 2+ removes superseded entries entirely", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "write", p: "src/config.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "1 operation: 1 write\n\n--- write: src/config.ts (100 bytes) ---",
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc2", name: "batch", arguments: { o: [{ o: "write", p: "src/config.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc2",
					content: "1 operation: 1 write\n\n--- write: src/config.ts (200 bytes) ---",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map(), 2);
		// Latest write kept at depth 2+ (compact, no bytes)
		expect(result).toContain("[batch:write] src/config.ts");
		expect(result).not.toContain("(200 bytes)");
		// Superseded write removed entirely at depth 2+
		expect(result).not.toContain("(superseded)");
		expect(result).not.toContain("(100 bytes)");
	});
});
describe("compressToolResults — X1 bash compression (depth 1)", () => {
	function getBatchText(result: string): string {
		const lines = result.trimEnd().split("\n");
		const toolLine = lines.find((l) => l.includes('"role":"tool"'))!;
		const parsed = JSON.parse(toolLine);
		return parsed.message.content[0].text;
	}

	it("Scenario 1: successful bash with output", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "bash", p: ".", c: "npm test" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "tool",
					toolCallId: "tc1",
					content: "1 operation: 1 bash\n\n--- bash [npm-test-abc] exit 0 ---\n[Execution time: 2.3s (avg)]\nPASS src/utils/parse.test.ts\nPASS src/core/flow.test.ts\nTests: 15 passed, 15 total",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map(), 1);
		const text = getBatchText(result);
		expect(text).toContain("[bash:ok] npm-test-abc · exit 0 · 2.3s (avg) · 3 lines\n> head:\nPASS src/utils/parse.test.ts\nPASS src/core/flow.test.ts\nTests: 15 passed, 15 total");
	});

	it("Scenario 2: successful bash with large output", () => {
		const longOutput = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "bash", p: ".", c: "npm run build" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "tool",
					toolCallId: "tc1",
					content: `1 operation: 1 bash\n\n--- bash [build-def] exit 0 ---\n[Execution time: 8.1s (long)]\n${longOutput}`,
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map(), 1);
		const text = getBatchText(result);
		expect(text).toContain("[bash:ok] build-def · exit 0 · 8.1s (long) · 100 lines\n> head:\nline 1\nline 2\nline 3");
		expect(text).not.toContain("line 100");
	});

	it("Scenario 3: pending bash", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "bash", p: ".", c: "grep -r foo src/", i: "long-grep-ghi" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "tool",
					toolCallId: "tc1",
					content: '1 operation: 1 bash\n\n--- bash [long-grep-ghi] pending ---\n[partial output]\nsrc/core/flow.ts:234\nsrc/core/agents.ts:89\nsrc/snapshot/snapshot.ts:176\n[Use batch_bash_poll with i: ["long-grep-ghi"] to check results]',
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map(), 1);
		const text = getBatchText(result);
		expect(text).toContain("[bash:pending] long-grep-ghi · still running · 3 lines partial\n> head:\nsrc/core/flow.ts:234\nsrc/core/agents.ts:89\nsrc/snapshot/snapshot.ts:176");
	});

	it("Scenario 4: error bash with stderr", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "bash", p: ".", c: "npm run lint" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "tool",
					toolCallId: "tc1",
					content: "1 operation: 1 bash\n\n--- bash [lint-jkl] error ---\n[Execution time: 1.2s (avg)]\n[stderr]\nsrc/core/flow.ts:45:3: Error: Unexpected token. (eslint)\nsrc/index.ts:12:1: Warning: Missing return type.",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map(), 1);
		const text = getBatchText(result);
		expect(text).toContain("[bash:err] lint-jkl · 1.2s (avg) · 2 lines stderr\n> stderr:\nsrc/core/flow.ts:45:3: Error: Unexpected token. (eslint)\nsrc/index.ts:12:1: Warning: Missing return type.");
	});

	it("Scenario 5: bash with no output", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "bash", p: ".", c: "git status" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "tool",
					toolCallId: "tc1",
					content: "1 operation: 1 bash\n\n--- bash [git-status-mno] exit 0 ---\n[Execution time: 0.1s (normal)]",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map(), 1);
		const text = getBatchText(result);
		expect(text).toContain("[bash:ok] git-status-mno · exit 0 · 0.1s (normal) · 0 lines");
	});

	it("Scenario 6: multi-bash batch result", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "bash", p: ".", c: "node -v", i: "check-node-pqr" }, { o: "bash", p: ".", c: "git status", i: "check-git-stu" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "tool",
					toolCallId: "tc1",
					content: "2 operations: 2 bash\n\n--- bash [check-node-pqr] exit 0 ---\n[Execution time: 0.1s (normal)]\nv20.12.2\n\n--- bash [check-git-stu] exit 0 ---\n[Execution time: 0.2s (normal)]\nOn branch main\nYour branch is up to date with 'origin/main'.",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map(), 1);
		const text = getBatchText(result);
		expect(text).toContain("[bash:ok] check-node-pqr · exit 0 · 0.1s (normal) · 1 line\n> head:\nv20.12.2");
		expect(text).toContain("[bash:ok] check-git-stu · exit 0 · 0.2s (normal) · 2 lines\n> head:\nOn branch main\nYour branch is up to date with 'origin/main'.");
	});

	it("error bash with stdout but no stderr preserves stdout", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "bash", p: ".", c: "node -e 'console.log(\"fail stdout\"); process.exit(1)'" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "tool",
					toolCallId: "tc1",
					content: "1 operation: 1 bash\n\n--- bash [err-stdout] error ---\n[Execution time: 0.3s (avg)]\nfail stdout",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map(), 1);
		const text = getBatchText(result);
		expect(text).toContain("[bash:err] err-stdout · 0.3s (avg) · 1 line stderr\n> stderr:\nfail stdout");
	});

	it("pending bash with no partial output shows 0 lines", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "bash", p: ".", c: "sleep 30", i: "pending-empty" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "tool",
					toolCallId: "tc1",
					content: '1 operation: 1 bash\n\n--- bash [pending-empty] pending ---\n[Use batch_bash_poll with i: ["pending-empty"] to check results]',
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map(), 1);
		const text = getBatchText(result);
		expect(text).toContain("[bash:pending] pending-empty · still running · 0 lines partial");
	});

	it("does not misinterpret --- inside bash output as section headers", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "bash", p: ".", c: "echo '--- hello ---'" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "tool",
					toolCallId: "tc1",
					content: "1 operation: 1 bash\n\n--- bash [echo-test] exit 0 ---\n[Execution time: 0.1s (normal)]\n--- hello ---\ntrailing line",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map(), 1);
		const text = getBatchText(result);
		expect(text).toContain("[bash:ok] echo-test · exit 0 · 0.1s (normal) · 2 lines\n> head:\n--- hello ---\ntrailing line");
		expect(text).not.toContain("(content truncated)");
	});
});

describe("compressToolResults — X1 bash compression (depth 2+)", () => {
	it("Scenario 1: successful bash with output → status only", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "bash", p: ".", c: "npm test" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "tool",
					toolCallId: "tc1",
					content: "1 operation: 1 bash\n\n--- bash [npm-test-abc] exit 0 ---\n[Execution time: 2.3s (avg)]\nPASS src/utils/parse.test.ts\nPASS src/core/flow.test.ts\nTests: 15 passed, 15 total",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map(), 2);
		expect(result).toContain("[bash:ok] npm-test-abc · exit 0");
		expect(result).not.toContain("PASS src/utils/parse.test.ts");
		expect(result).not.toContain("> head:");
	});

	it("Scenario 2: successful bash with large output → status only", () => {
		const longOutput = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "bash", p: ".", c: "npm run build" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "tool",
					toolCallId: "tc1",
					content: `1 operation: 1 bash\n\n--- bash [build-def] exit 0 ---\n[Execution time: 8.1s (long)]\n${longOutput}`,
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map(), 2);
		expect(result).toContain("[bash:ok] build-def · exit 0");
		expect(result).not.toContain("line 1");
		expect(result).not.toContain("> head:");
	});

	it("Scenario 3: pending bash → status only", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "bash", p: ".", c: "grep -r foo src/", i: "long-grep-ghi" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "tool",
					toolCallId: "tc1",
					content: '1 operation: 1 bash\n\n--- bash [long-grep-ghi] pending ---\n[partial output]\nsrc/core/flow.ts:234\nsrc/core/agents.ts:89\nsrc/snapshot/snapshot.ts:176\n[Use batch_bash_poll with i: ["long-grep-ghi"] to check results]',
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map(), 2);
		expect(result).toContain("[bash:pending] long-grep-ghi · still running");
		expect(result).not.toContain("src/core/flow.ts:234");
		expect(result).not.toContain("> head:");
	});

	it("Scenario 4: error bash with stderr → status only", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "bash", p: ".", c: "npm run lint" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "tool",
					toolCallId: "tc1",
					content: "1 operation: 1 bash\n\n--- bash [lint-jkl] error ---\n[Execution time: 1.2s (avg)]\n[stderr]\nsrc/core/flow.ts:45:3: Error: Unexpected token. (eslint)\nsrc/index.ts:12:1: Warning: Missing return type.",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map(), 2);
		expect(result).toContain("[bash:err] lint-jkl");
		expect(result).not.toContain("src/core/flow.ts:45:3");
		expect(result).not.toContain("> stderr:");
	});

	it("Scenario 5: bash with no output → status only", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "bash", p: ".", c: "git status" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "tool",
					toolCallId: "tc1",
					content: "1 operation: 1 bash\n\n--- bash [git-status-mno] exit 0 ---\n[Execution time: 0.1s (normal)]",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map(), 2);
		expect(result).toContain("[bash:ok] git-status-mno · exit 0");
		expect(result).not.toContain("0 lines");
	});

	it("Scenario 6: multi-bash batch result → status only lines", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "bash", p: ".", c: "node -v", i: "check-node-pqr" }, { o: "bash", p: ".", c: "git status", i: "check-git-stu" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "tool",
					toolCallId: "tc1",
					content: "2 operations: 2 bash\n\n--- bash [check-node-pqr] exit 0 ---\n[Execution time: 0.1s (normal)]\nv20.12.2\n\n--- bash [check-git-stu] exit 0 ---\n[Execution time: 0.2s (normal)]\nOn branch main\nYour branch is up to date with 'origin/main'.",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map(), 2);
		expect(result).toContain("[bash:ok] check-node-pqr · exit 0");
		expect(result).toContain("[bash:ok] check-git-stu · exit 0");
		expect(result).not.toContain("v20.12.2");
		expect(result).not.toContain("On branch main");
		expect(result).not.toContain("> head:");
	});
});

describe("compressToolResults — web", () => {
	it("compresses search results", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "web", arguments: { o: [{ o: "search", q: "node.js streams" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "1. Node.js Streams\n   https://nodejs.org/api/stream.html\n   Everything you need to know about streams\n\n2. Stream Handbook\n   https://github.com/substack/stream-handbook\n   How to use streams",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		const lines = result.trimEnd().split("\n");
		const toolLine = lines.find((l) => l.includes('"role":"toolResult"'))!;
		const parsed = JSON.parse(toolLine);
		const text = parsed.message.content[0].text;
		expect(text).toContain('[web:search] "node.js streams" · 2 results · first: Node.js Streams');
		expect(text).not.toContain("https://nodejs.org");
	});

	it("compresses fetch results", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "web", arguments: { o: [{ o: "fetch", u: "https://example.com" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "File: /tmp/session/abc.md\nTitle: Example Page\nContent length: 4200 chars\n\nPreview:\nSome preview text here",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		const lines = result.trimEnd().split("\n");
		const toolLine = lines.find((l) => l.includes('"role":"toolResult"'))!;
		const parsed = JSON.parse(toolLine);
		const text = parsed.message.content[0].text;
		expect(text).toContain("[web:fetch] https://example.com · \"Example Page\" · 4200 chars");
		expect(text).not.toContain("Some preview text");
	});
});

describe("compressToolResults — Q1 web dedup", () => {
	function getWebText(result: string, tcId: string): string {
		const lines = result.trimEnd().split("\n");
		const toolLine = lines.find((l) =>
			(l.includes('"role":"tool"') || l.includes('"role":"toolResult"')) &&
			l.includes(`"toolCallId":"${tcId}"`)
		)!;
		const parsed = JSON.parse(toolLine);
		return parsed.message.content[0].text;
	}

	it("3 identical searches → only latest kept at depth 1", () => {
		const snapshot = makeSnapshot([
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "tc1", name: "web", arguments: { o: [{ o: "search", q: "node.js streams" }] } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "tc1", content: "1. Node.js Streams\n   https://nodejs.org/api/stream.html\n   Everything" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "tc2", name: "web", arguments: { o: [{ o: "search", q: "node.js streams" }] } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "tc2", content: "1. Node.js Streams\n   https://nodejs.org/api/stream.html\n   Everything" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "tc3", name: "web", arguments: { o: [{ o: "search", q: "node.js streams" }] } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "tc3", content: "1. Node.js Streams\n   https://nodejs.org/api/stream.html\n   Everything" } },
		]);

		const result = compressToolResults(snapshot, new Map(), 1);
		// Latest preserved (check parsed text to avoid JSON escaping)
		const tc3Text = getWebText(result, "tc3");
		expect(tc3Text).toContain('[web:search] "node.js streams" · 1 results · first: Node.js Streams');
		expect(tc3Text).not.toContain("(superseded");
		// Earlier superseded
		const tc1Text = getWebText(result, "tc1");
		const tc2Text = getWebText(result, "tc2");
		expect(tc1Text).toContain('[web:search] "node.js streams" (superseded by later search)');
		expect(tc2Text).toContain('[web:search] "node.js streams" (superseded by later search)');
	});

	it("same URL fetched twice → only latest kept", () => {
		const snapshot = makeSnapshot([
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "tc1", name: "web", arguments: { o: [{ o: "fetch", u: "https://example.com/" }] } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "tc1", content: "File: /tmp/abc.md\nTitle: Example\nContent length: 100 chars\n\nPreview: old" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "tc2", name: "web", arguments: { o: [{ o: "fetch", u: "https://example.com" }] } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "tc2", content: "File: /tmp/abc.md\nTitle: Example\nContent length: 200 chars\n\nPreview: new" } },
		]);

		const result = compressToolResults(snapshot, new Map(), 1);
		const tc2Text = getWebText(result, "tc2");
		expect(tc2Text).toContain("[web:fetch] https://example.com · \"Example\" · 200 chars");
		const tc1Text = getWebText(result, "tc1");
		expect(tc1Text).toContain("[web:fetch] https://example.com/ (superseded by later fetch)");
		expect(tc2Text).not.toContain("(superseded");
	});

	it("search + fetch of same URL → treated as independent keys", () => {
		const snapshot = makeSnapshot([
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "tc1", name: "web", arguments: { o: [{ o: "search", q: "example.com homepage" }] } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "tc1", content: "1. Example Domain\n   https://example.com\n   Info" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "tc2", name: "web", arguments: { o: [{ o: "fetch", u: "https://example.com" }] } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "tc2", content: "File: /tmp/abc.md\nTitle: Example Domain\nContent length: 500 chars\n\nPreview:\nMore text" } },
		]);

		const result = compressToolResults(snapshot, new Map(), 1);
		const tc1Text = getWebText(result, "tc1");
		const tc2Text = getWebText(result, "tc2");
		expect(tc1Text).toContain('[web:search] "example.com homepage" · 1 results · first: Example Domain');
		expect(tc2Text).toContain('[web:fetch] https://example.com · "Example Domain" · 500 chars');
		expect(result).not.toContain("(superseded");
	});

	it("depth 2+ rollup", () => {
		const snapshot = makeSnapshot([
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "tc1", name: "web", arguments: { o: [{ o: "search", q: "query A" }] } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "tc1", content: "1. Result A\n   https://a.com\n   Info" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "tc2", name: "web", arguments: { o: [{ o: "search", q: "query B" }] } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "tc2", content: "1. Result B\n   https://b.com\n   Info" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "tc3", name: "web", arguments: { o: [{ o: "fetch", u: "https://c.com" }] } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "tc3", content: "File: /tmp/c.md\nTitle: C\nContent length: 300 chars\n\nPreview:\nText" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "tc4", name: "web", arguments: { o: [{ o: "search", q: "query A" }] } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "tc4", content: "1. Result A updated\n   https://a.com\n   Info" } },
		]);

		const result = compressToolResults(snapshot, new Map(), 2);
		// Rollup summary (no quotes, safe to check in raw JSON)
		expect(result).toContain("[web] 3 unique queries (2 searches, 1 fetch) · latest per query below");
		// Latest results — check parsed text to avoid JSON escaping
		const tc2Text = getWebText(result, "tc2");
		const tc3Text = getWebText(result, "tc3");
		const tc4Text = getWebText(result, "tc4");
		expect(tc2Text).toContain('[web:search] "query B" · 1 results · first: Result B');
		expect(tc3Text).toContain('[web:fetch] https://c.com · "C" · 300 chars');
		expect(tc4Text).toContain('[web:search] "query A" · 1 results · first: Result A updated');
		// Superseded tool result removed entirely (assistant toolCall still present)
		const hasTc1ToolResult = result.trimEnd().split("\n").some((l) =>
			l.includes('"role":"toolResult"') && l.includes('"toolCallId":"tc1"')
		);
		expect(hasTc1ToolResult).toBe(false);
		expect(result).not.toContain("(superseded");
	});

	it("handles empty query without crashing", () => {
		const snapshot = makeSnapshot([
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "tc1", name: "web", arguments: { o: [{ o: "search", q: "" }] } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "tc1", content: "No results" } },
		]);

		const result = compressToolResults(snapshot, new Map(), 1);
		const tc1Text = getWebText(result, "tc1");
		expect(tc1Text).toContain("[web]");
		expect(tc1Text).not.toContain("(superseded");
	});

	it("handles whitespace-only query without marking as superseded", () => {
		const snapshot = makeSnapshot([
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "tc1", name: "web", arguments: { o: [{ o: "search", q: "   " }] } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "tc1", content: "No results" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "tc2", name: "web", arguments: { o: [{ o: "search", q: "   " }] } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "tc2", content: "No results" } },
		]);

		const result = compressToolResults(snapshot, new Map(), 1);
		const tc1Text = getWebText(result, "tc1");
		const tc2Text = getWebText(result, "tc2");
		// Neither should be superseded because empty normalized queries are not indexed
		expect(tc1Text).not.toContain("(superseded");
		expect(tc2Text).not.toContain("(superseded");
	});

	it("handles null ops[0] without crashing", () => {
		const snapshot = makeSnapshot([
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "tc1", name: "web", arguments: { o: [null] } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "tc1", content: "No results" } },
		]);

		const result = compressToolResults(snapshot, new Map(), 1);
		const tc1Text = getWebText(result, "tc1");
		expect(tc1Text).toBeTruthy();
		expect(tc1Text).not.toContain("(superseded");
	});

	it("handles missing args without crashing", () => {
		const snapshot = makeSnapshot([
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "tc1", name: "web", arguments: undefined }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "tc1", content: "No results" } },
		]);

		const result = compressToolResults(snapshot, new Map(), 1);
		const tc1Text = getWebText(result, "tc1");
		expect(tc1Text).toBeTruthy();
		expect(tc1Text).not.toContain("(superseded");
	});

	it("query normalization (case-insensitive, trimmed)", () => {
		const snapshot = makeSnapshot([
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "tc1", name: "web", arguments: { o: [{ o: "search", q: "Node.JS STREAMS" }] } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "tc1", content: "1. Node.js Streams\n   https://nodejs.org\n   Info" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "tc2", name: "web", arguments: { o: [{ o: "search", q: "  node.js streams  " }] } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "tc2", content: "1. Node.js Streams\n   https://nodejs.org\n   Info" } },
		]);

		const result = compressToolResults(snapshot, new Map(), 1);
		// tc2 is latest
		const tc2Text = getWebText(result, "tc2");
		expect(tc2Text).toContain('[web:search] "  node.js streams  " · 1 results · first: Node.js Streams');
		expect(tc2Text).not.toContain("(superseded");
		// tc1 superseded due to normalization
		const tc1Text = getWebText(result, "tc1");
		expect(tc1Text).toContain('[web:search] "Node.JS STREAMS" (superseded by later search)');
	});
});

describe("compressToolResults — ask_user", () => {
	it("compresses answered result", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "ask_user", arguments: { question: "Should we use Docker?" } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "User answered: Yes",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		const lines = result.trimEnd().split("\n");
		const toolLine = lines.find((l) => l.includes('"role":"toolResult"'))!;
		const parsed = JSON.parse(toolLine);
		const text = parsed.message.content[0].text;
		expect(text).toContain('[ask_user] "Should we use Docker?" → "Yes"');
	});

	it("compresses cancelled result", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "ask_user", arguments: { question: "Confirm deletion?" } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "User cancelled",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		const lines = result.trimEnd().split("\n");
		const toolLine = lines.find((l) => l.includes('"role":"toolResult"'))!;
		const parsed = JSON.parse(toolLine);
		const text = parsed.message.content[0].text;
		expect(text).toContain('[ask_user] "Confirm deletion?" → cancelled');
	});

	it("compresses multiline answered result", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "ask_user", arguments: { question: "Any concerns?" } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "User answered: Yes\nAlso update the README",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		const lines = result.trimEnd().split("\n");
		const toolLine = lines.find((l) => l.includes('"role":"toolResult"'))!;
		const parsed = JSON.parse(toolLine);
		const text = parsed.message.content[0].text;
		expect(text).toContain('[ask_user] "Any concerns?" → "Yes\nAlso update the README"');
	});
});

// ---------------------------------------------------------------------------
// compressToolResults — flow cache miss fallback
// ---------------------------------------------------------------------------
describe("evictCacheOverflow", () => {
	it("evicts oldest entries when cache exceeds the cap", () => {
		const cache = new Map();
		for (let i = 0; i < 105; i++) {
			cache.set(`key-${i}`, [{ type: "scout", status: "accomplished" }]);
		}
		expect(cache.size).toBe(105);
		evictCacheOverflow(cache);
		expect(cache.size).toBe(100);
		// Oldest entries (key-0 through key-4) should be gone
		expect(cache.has("key-0")).toBe(false);
		expect(cache.has("key-4")).toBe(false);
		// Newest entries should remain
		expect(cache.has("key-99")).toBe(true);
		expect(cache.has("key-104")).toBe(true);
	});

	it("does nothing when cache is under the cap", () => {
		const cache = new Map();
		for (let i = 0; i < 50; i++) {
			cache.set(`key-${i}`, [{ type: "scout", status: "accomplished" }]);
		}
		evictCacheOverflow(cache);
		expect(cache.size).toBe(50);
		expect(cache.has("key-0")).toBe(true);
	});
});

describe("compressToolResults — edge cases", () => {
	it("handles empty batch result", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "0 operations",
				},
			},
		]);
		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("0 operations");
	});

	it("handles write and edit to same file in the same batch result", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "write", p: "src/index.ts" }, { o: "edit", p: "src/index.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "2 operations: 1 write, 1 edit\n\n--- write: src/index.ts (400 bytes) ---\n\n--- edit: src/index.ts (1 block) ---",
				},
			},
		]);
		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("[batch:write] src/index.ts (400 bytes)");
		expect(result).toContain("[batch:edit] src/index.ts (1 block)");
	});

	it("handles delete then write to same file in the same batch result", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "delete", p: "src/index.ts" }, { o: "write", p: "src/index.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "2 operations: 1 delete, 1 write\n\n--- delete: src/index.ts ---\n\n--- write: src/index.ts (400 bytes) ---",
				},
			},
		]);
		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("--- delete: src/index.ts ---");
		expect(result).toContain("[batch:write] src/index.ts (400 bytes)");
	});

	it("handles mixed ok and error sections in the same batch result", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "write", p: "src/ok.ts" }, { o: "write", p: "src/bad.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "2 operations: 1 write, 1 write\n\n--- write: src/ok.ts (200 bytes) ---\n\n--- write: src/bad.ts ---\nError: ENOENT",
				},
			},
		]);
		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("[batch:write] src/ok.ts (200 bytes)");
		expect(result).toContain("--- write: src/bad.ts ---");
		expect(result).toContain("Error: ENOENT");
	});

	it("handles batch result with only error operations", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "read", p: "missing1.ts" }, { o: "write", p: "missing2.ts" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "2 operations: 2 errors\n\n--- read: missing1.ts ---\nError: ENOENT\n\n--- write: missing2.ts ---\nError: ENOENT",
				},
			},
		]);
		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("--- read: missing1.ts ---");
		expect(result).toContain("Error: ENOENT");
		expect(result).toContain("--- write: missing2.ts ---");
	});
});

describe("compressToolResults — flow cache miss", () => {
	it("renders a placeholder when flow result is not in cache instead of passing bulky output verbatim", () => {
		const bulkyContent = "Flow: 1/1 completed\n\n".repeat(5000); // ~100KB of raw flow output
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "flow", arguments: { flow: [{ type: "scout" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: bulkyContent,
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		const lines = result.trimEnd().split("\n");
		const toolLine = lines.find((l) => l.includes('"role":"toolResult"'))!;
		const parsed = JSON.parse(toolLine);
		const text = parsed.message.content[0].text;
		// Must be the compact placeholder, NOT the bulky original
		expect(text).toContain("[flow] prior result");
		expect(text).toContain("full context unavailable (result not cached at this depth)");
		expect(text.length).toBeLessThan(200);
		expect(text).not.toContain("Flow: 1/1 completed");
	});

	it("uses cached compressed flow result when available", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "flow", arguments: { flow: [{ type: "scout" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "Flow: 1/1 completed\n\nscout accomplished\n\nLots of raw output here...",
				},
			},
		]);

		const cache = new Map([[
			"tc1",
			[{ type: "scout", status: "accomplished", files: [{ path: "src/auth.ts" }], commands: [{ tool: "grep", command: "JWT" }] }],
		]]);

		const result = compressToolResults(snapshot, cache);
		const lines = result.trimEnd().split("\n");
		const toolLine = lines.find((l) => l.includes('"role":"toolResult"'))!;
		const parsed = JSON.parse(toolLine);
		const text = parsed.message.content[0].text;
		expect(text).toContain("[Flow: scout accomplished]");
		expect(text).toContain("src/auth.ts");
		expect(text).toContain("grep: JWT");
	});
});
