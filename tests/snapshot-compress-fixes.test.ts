import { describe, it, expect } from "vitest";
import { compressToolResults, depthToPolicy } from "../src/snapshot/snapshot.js";

function makeSnapshot(lines: any[]): string {
	return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

describe("compressToolResults — file summary", () => {
	it("truncates file summary sections", () => {
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
					content: "✔ 1 operation: 1 read\n\n--- README.md file summary ---\nThis is a plain text file.\nIt has multiple lines.\nSome more content here.",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("--- README.md (file summary, truncated) ---");
		expect(result).not.toContain("This is a plain text file");
		expect(result).not.toContain("It has multiple lines");
	});
});

describe("compressToolResults — read preview at depth 1", () => {
	it("shows first/last 2 lines with truncation marker for reads > 4 lines", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "read", p: "src/long.ts" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "1 operation: 1 read\n\n--- src/long.ts (6 lines) ---\nline 1\nline 2\nline 3\nline 4\nline 5\nline 6",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map(), depthToPolicy(1));
		expect(result).toContain("--- src/long.ts (6 lines, preview) ---");
		expect(result).toContain("line 1\\nline 2\\n[...2 lines truncated...]\\nline 5\\nline 6");
	});

	it("shows full content for reads <= 4 lines without truncation marker", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "read", p: "src/short.ts" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "1 operation: 1 read\n\n--- src/short.ts (4 lines) ---\na\nb\nc\nd",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map(), depthToPolicy(1));
		expect(result).toContain("--- src/short.ts (4 lines, preview) ---");
		expect(result).toContain("a\\nb\\nc\\nd");
		expect(result).not.toContain("lines truncated");
	});

	it("truncates to header-only at depth 2+", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "read", p: "src/deep.ts" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "1 operation: 1 read\n\n--- src/deep.ts (10 lines) ---\nline 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map(), depthToPolicy(2));
		expect(result).toContain("--- src/deep.ts (10 lines, content truncated) ---");
		expect(result).not.toContain("line 1");
		expect(result).not.toContain("lines truncated");
	});
});

describe("compressToolResults — reads without line count", () => {
	it("truncates file reads without line count", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "read", p: "data.csv" }] } }],
					},
			},
			{
				type: "message",
					message: {
						role: "toolResult",
						toolCallId: "tc1",
						content: "✔ 1 operation: 1 read\n\n--- data.csv ---\nheader1,header2\nvalue1,value2\nvalue3,value4",
					},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("--- data.csv (preview) ---");
		expect(result).toContain("header1,header2");
		expect(result).toContain("value1,value2");
	});

	it("still truncates reads with line count (existing behavior)", () => {
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
						content: "✔ 1 operation: 1 read\n\n--- src/file.ts (42 lines) ---\nline 1\nline 2",
					},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("--- src/file.ts (42 lines, preview) ---");
		expect(result).toContain("line 1");
		expect(result).toContain("line 2");
	});
});

describe("compressToolResults — error sections preserved", () => {
	it("preserves read error sections (not truncated by fallback regex)", () => {
		const snapshot = makeSnapshot([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "tc1", name: "batch", arguments: { o: [{ o: "read", p: "missing.txt" }] } },
				],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "✖ 1 error: read missing.txt: No such file\n\n--- read: missing.txt ---\nError: ENOENT: no such file or directory",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("--- read: missing.txt ---");
		expect(result).toContain("Error: ENOENT");
	});
});

describe("context handler — strategic hints not stripped", () => {
	it("stripStrategicHintsFromMessages is removed from the public API", async () => {
		const toolUtils = await import("fs").then(m => m.default.readFileSync("src/steering/tool-utils.ts", "utf-8"));
		expect(toolUtils).not.toContain("export function stripStrategicHintsFromMessages");
	});

	it("sanitizeForkSnapshot still strips hints (children don't need them)", async () => {
		const { sanitizeForkSnapshot } = await import("../src/snapshot/snapshot.js");
		const snapshot = JSON.stringify({ type: "message", message: { role: "toolResult", content: "Result\n\n[Hint: Plan next step.]" } }) + "\n";
		const { result } = sanitizeForkSnapshot(snapshot);
		expect(result).not.toContain("[Hint:");
		expect(result).toContain("Result");
	});
});
