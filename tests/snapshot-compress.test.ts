import { describe, it, expect } from "vitest";
import { compressToolResults } from "../src/snapshot.js";
import { evictCacheOverflow } from "../src/executor.js";
import { stripStrategicHints } from "../src/tool-utils.js";

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
	it("truncates read content but keeps bash sections verbatim", () => {
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
		expect(result).toContain("--- bash [abc] exit 0 ---");
		expect(result).toContain("[Execution time: 0.5s (avg)]");
		expect(result).toContain("output");
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

	it("keeps edit/write/delete sections as-is", () => {
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
		expect(result).toContain("--- edit: src/index.ts (2 blocks) ---");
	});

	it("truncates oversized bash sections in snapshots", () => {
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

		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("--- bash [big] exit 0 ---");
		expect(result).toContain("[Execution time: 0.5s (avg)]");
		expect(result).toContain("output line 1");
		expect(result).toContain("output line 1000");
		// Bash sections are kept verbatim — no truncation marker expected
	});

	it("truncates pending bash sections in snapshots", () => {
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

		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("--- bash [pending1] pending ---");
		expect(result).toContain("pending line 1");
		expect(result).toContain("pending line 1000");
		// Bash sections are kept verbatim — no truncation marker expected
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
		expect(result).toContain("--- bash [abc] exit 0 ---");
		expect(result).toContain("[Execution time: 0.1s]");
		expect(result).toContain("output");
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
		expect(text).toContain("not cached or evicted");
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
