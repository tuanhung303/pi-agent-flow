import { describe, it, expect } from "vitest";
import { parseSharedContext } from "../src/core2/snapshot.js";

describe("parseSharedContext", () => {
	it("returns undefined for null input", () => {
		expect(parseSharedContext(null)).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		expect(parseSharedContext("")).toBeUndefined();
	});

	it("returns undefined when no messages exist", () => {
		const jsonl = JSON.stringify({ type: "setting", name: "model" });
		expect(parseSharedContext(jsonl)).toBeUndefined();
	});

	it("counts messages and captures first user text", () => {
		const lines = [
			JSON.stringify({ type: "message", message: { role: "system", content: "hello" } }),
			JSON.stringify({ type: "message", message: { role: "user", content: "do the thing" } }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: "ok" } }),
		];
		const result = parseSharedContext(lines.join("\n"));
		expect(result).toEqual({
			messageCount: 3,
			userMessageCount: 1,
			assistantMessageCount: 1,
			toolCalls: {},
			totalTokens: 0,
			preview: "do the thing",
		});
	});

	it("keeps full user text without truncation", () => {
		const longText = "a".repeat(80);
		const lines = [
			JSON.stringify({ type: "message", message: { role: "user", content: longText } }),
		];
		const result = parseSharedContext(lines.join("\n"));
		expect(result?.preview).toBe(longText);
		expect(result?.userMessageCount).toBe(1);
		expect(result?.assistantMessageCount).toBe(0);
	});

	it("extracts preview from structured user content array block", () => {
		const lines = [
			JSON.stringify({
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "image", image: "base64..." },
						{ type: "text", text: "this is user text" }
					]
				}
			}),
		];
		const result = parseSharedContext(lines.join("\n"));
		expect(result?.preview).toBe("this is user text");
		expect(result?.userMessageCount).toBe(1);
	});

	it("skips invalid JSONL lines gracefully", () => {
		const lines = [
			"not json",
			JSON.stringify({ type: "message", message: { role: "user", content: "valid" } }),
			"",
			"{ bad json",
		];
		const result = parseSharedContext(lines.join("\n"));
		expect(result).toEqual({
			messageCount: 1,
			userMessageCount: 1,
			assistantMessageCount: 0,
			toolCalls: {},
			totalTokens: 0,
			preview: "valid",
		});
	});

	it("returns preview without user text when no user role present", () => {
		const lines = [
			JSON.stringify({ type: "message", message: { role: "system", content: "hello" } }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: "ok" } }),
		];
		const result = parseSharedContext(lines.join("\n"));
		expect(result).toEqual({
			messageCount: 2,
			userMessageCount: 0,
			assistantMessageCount: 1,
			toolCalls: {},
			totalTokens: 0,
			preview: "",
		});
	});

	it("handles CRLF line endings correctly", () => {
		const lines = [
			JSON.stringify({ type: "message", message: { role: "user", content: "crlf test" } }),
		];
		const result = parseSharedContext(lines.join("\r\n"));
		expect(result).toEqual({
			messageCount: 1,
			userMessageCount: 1,
			assistantMessageCount: 0,
			toolCalls: {},
			totalTokens: 0,
			preview: "crlf test",
		});
	});

	it("aggregates tool calls from toolCalls array and content blocks", () => {
		const lines = [
			JSON.stringify({ type: "message", message: { role: "user", content: "run some tools" } }),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "ok" },
						{ type: "toolCall", name: "bash", toolCall: { name: "bash" } },
					],
					toolCalls: [{ name: "read", function: { name: "read" } }],
					usage: { totalTokens: 42 },
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "batch", toolCall: { name: "batch" } }],
					tool_calls: [{ name: "bash", function: { name: "bash" } }],
					usage: { totalTokens: 18 },
				},
			}),
		];
		const result = parseSharedContext(lines.join("\n"));
		expect(result).toEqual({
			messageCount: 3,
			userMessageCount: 1,
			assistantMessageCount: 2,
			toolCalls: { bash: 2, read: 1, batch: 1 },
			totalTokens: 18,
			preview: "run some tools",
		});
	});

	it("counts only complete canonical interactions in assistant messages", () => {
		const canonical = (tool: string, result: string) =>
			`[Historical tool interaction]\nTool: ${tool}\nArguments:\n{}\n\nResult:\n${result}\n[/Historical tool interaction]`;
		const lines = [
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: `${canonical("bash", "ok")}\nTool: ignored` },
						{ type: "text", text: canonical("flow", "done") },
					],
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: "[Historical tool interaction]\nTool: trace\nArguments:\n{}\n\nResult:\nincomplete",
				},
			}),
			JSON.stringify({
				type: "message",
				message: { role: "user", content: canonical("read", "pasted example") },
			}),
			JSON.stringify({
				type: "message",
				message: { role: "system", content: canonical("write", "pasted example") },
			}),
		];

		const result = parseSharedContext(lines.join("\n"));
		expect(result?.toolCalls).toEqual({ bash: 1, flow: 1 });
	});

	it("captures the last assistant message's cumulative totalTokens", () => {
		const lines = [
			JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: "ok", usage: { totalTokens: 15 } } }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: "done", usage: { totalTokens: 25 } } }),
		];
		const result = parseSharedContext(lines.join("\n"));
		expect(result?.totalTokens).toBe(25);
		expect(result?.userMessageCount).toBe(1);
		expect(result?.assistantMessageCount).toBe(2);
	});

	it("captures the totalTokens from top-level entry.usage", () => {
		const lines = [
			JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: "ok" }, usage: { totalTokens: 42000 } }),
		];
		const result = parseSharedContext(lines.join("\n"));
		expect(result?.totalTokens).toBe(42000);
	});

	it("derives totalTokens from slim usage input+output when totalTokens is absent", () => {
		const lines = [
			JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					usage: { input: 18000, output: 2400, cacheRead: 500, cacheWrite: 0 },
				},
			}),
		];
		const result = parseSharedContext(lines.join("\n"));
		expect(result?.totalTokens).toBe(20900);
	});
});
