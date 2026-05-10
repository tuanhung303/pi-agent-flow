import { describe, it, expect } from "vitest";
import { compressToolResults } from "../src/snapshot.js";

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
					role: "tool",
					toolCallId: "tc1",
					content: "✓ 1 operation: 1 read\n\n--- README.md file summary ---\nThis is a plain text file.\nIt has multiple lines.\nSome more content here.",
				},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("--- README.md (file summary, truncated) ---");
		expect(result).not.toContain("This is a plain text file");
		expect(result).not.toContain("It has multiple lines");
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
						role: "tool",
						toolCallId: "tc1",
						content: "✓ 1 operation: 1 read\n\n--- data.csv ---\nheader1,header2\nvalue1,value2\nvalue3,value4",
					},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("--- data.csv (content truncated) ---");
		expect(result).not.toContain("header1,header2");
		expect(result).not.toContain("value1,value2");
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
						role: "tool",
						toolCallId: "tc1",
						content: "✓ 1 operation: 1 read\n\n--- src/file.ts (42 lines) ---\nline 1\nline 2",
					},
			},
		]);

		const result = compressToolResults(snapshot, new Map());
		expect(result).toContain("--- src/file.ts (42 lines, content truncated) ---");
		expect(result).not.toContain("line 1");
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
					role: "tool",
					toolCallId: "tc1",
					content: "✗ 1 error: read missing.txt: No such file\n\n--- read: missing.txt ---\nError: ENOENT: no such file or directory",
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
		const toolUtils = await import("fs").then(m => m.default.readFileSync("src/tool-utils.ts", "utf-8"));
		expect(toolUtils).not.toContain("export function stripStrategicHintsFromMessages");
	});

	it("sanitizeForkSnapshot still strips hints (children don't need them)", async () => {
		const { sanitizeForkSnapshot } = await import("../src/snapshot.js");
		const snapshot = JSON.stringify({ type: "message", message: { role: "tool", content: "Result\n\n[Hint: Plan next step.]" } }) + "\n";
		const result = sanitizeForkSnapshot(snapshot);
		expect(result).not.toContain("[Hint:");
		expect(result).toContain("Result");
	});
});
