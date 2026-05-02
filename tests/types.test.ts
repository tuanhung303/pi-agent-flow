import { describe, it, expect } from "vitest";
import {
	emptyFlowUsage,
	aggregateFlowUsage,
	hasFlowOutput,
	isFlowComplete,
	isFlowSuccess,
	isFlowError,
	normalizeFlowResult,
	getFlowOutput,
	getFlowDisplayItems,
	getLastToolCall,
	getLastAssistantText,
	type SingleResult,
} from "../src/types.js";

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		type: "explore",
		agentSource: "user",
		intent: "test intent",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyFlowUsage(),
		...overrides,
	};
}

function makeAssistantMessage(text: string, extra: Record<string, unknown> = {}) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		...extra,
	};
}

// ---------------------------------------------------------------------------
// emptyFlowUsage
// ---------------------------------------------------------------------------

describe("emptyFlowUsage", () => {
	it("returns all zeros", () => {
		const u = emptyFlowUsage();
		expect(u.input).toBe(0);
		expect(u.output).toBe(0);
		expect(u.cacheRead).toBe(0);
		expect(u.cacheWrite).toBe(0);
		expect(u.cost).toBe(0);
		expect(u.contextTokens).toBe(0);
		expect(u.turns).toBe(0);
		expect(u.toolCalls).toBe(0);
		expect(u.smoothedTps).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// aggregateFlowUsage
// ---------------------------------------------------------------------------

describe("aggregateFlowUsage", () => {
	it("sums usage across results", () => {
		const results = [
			makeResult({ usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 10, cost: 0.01, contextTokens: 500, turns: 2, toolCalls: 3 } }),
			makeResult({ usage: { input: 200, output: 100, cacheRead: 400, cacheWrite: 20, cost: 0.02, contextTokens: 1000, turns: 4, toolCalls: 6 } }),
		];
		const total = aggregateFlowUsage(results);
		expect(total.input).toBe(300);
		expect(total.output).toBe(150);
		expect(total.cacheRead).toBe(600);
		expect(total.cacheWrite).toBe(30);
		expect(total.cost).toBeCloseTo(0.03);
		expect(total.turns).toBe(6);
		expect(total.toolCalls).toBe(9);
	});

	it("returns zeros for empty array", () => {
		const total = aggregateFlowUsage([]);
		expect(total.input).toBe(0);
		expect(total.turns).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// hasFlowOutput / isFlowComplete
// ---------------------------------------------------------------------------

describe("hasFlowOutput", () => {
	it("returns true when messages have text", () => {
		expect(hasFlowOutput({ messages: [makeAssistantMessage("output")] })).toBe(true);
	});

	it("returns false for empty messages", () => {
		expect(hasFlowOutput({ messages: [] })).toBe(false);
	});
});

describe("isFlowComplete", () => {
	it("returns true when sawAgentEnd and has output", () => {
		expect(isFlowComplete({ messages: [makeAssistantMessage("done")], sawAgentEnd: true })).toBe(true);
	});

	it("returns false without sawAgentEnd", () => {
		expect(isFlowComplete({ messages: [makeAssistantMessage("done")], sawAgentEnd: false })).toBe(false);
	});

	it("returns false without output", () => {
		expect(isFlowComplete({ messages: [], sawAgentEnd: true })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// isFlowSuccess / isFlowError
// ---------------------------------------------------------------------------

describe("isFlowSuccess", () => {
	it("exit 0 with output → success", () => {
		const r = makeResult({ exitCode: 0, messages: [makeAssistantMessage("ok")], sawAgentEnd: true });
		expect(isFlowSuccess(r)).toBe(true);
	});

	it("exit -1 (running) → not success", () => {
		const r = makeResult({ exitCode: -1 });
		expect(isFlowSuccess(r)).toBe(false);
	});

	it("exit 1, no agentEnd → error", () => {
		const r = makeResult({ exitCode: 1, messages: [], sawAgentEnd: false });
		expect(isFlowSuccess(r)).toBe(false);
	});

	it("exit 1 + sawAgentEnd + output → success (semantic override)", () => {
		const r = makeResult({ exitCode: 1, messages: [makeAssistantMessage("done")], sawAgentEnd: true });
		expect(isFlowSuccess(r)).toBe(true);
	});

	it("exit 0 + stopReason error → error", () => {
		const r = makeResult({ exitCode: 0, stopReason: "error" });
		expect(isFlowSuccess(r)).toBe(false);
	});

	it("exit 0 + stopReason aborted → error", () => {
		const r = makeResult({ exitCode: 0, stopReason: "aborted" });
		expect(isFlowSuccess(r)).toBe(false);
	});
});

describe("isFlowError", () => {
	it("mirrors isFlowSuccess", () => {
		const success = makeResult({ exitCode: 0, messages: [makeAssistantMessage("ok")], sawAgentEnd: true });
		const error = makeResult({ exitCode: 1 });
		expect(isFlowError(success)).toBe(false);
		expect(isFlowError(error)).toBe(true);
	});

	it("running (-1) is not error", () => {
		const r = makeResult({ exitCode: -1 });
		expect(isFlowError(r)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// normalizeFlowResult
// ---------------------------------------------------------------------------

describe("normalizeFlowResult", () => {
	it("exit 0 → stays success", () => {
		const r = makeResult({ exitCode: 0 });
		normalizeFlowResult(r, false);
		expect(r.exitCode).toBe(0);
	});

	it("exit 1 + sawAgentEnd → semantic override → exit 0", () => {
		const r = makeResult({ exitCode: 1, messages: [makeAssistantMessage("done")], sawAgentEnd: true });
		normalizeFlowResult(r, false);
		expect(r.exitCode).toBe(0);
	});

	it("exit 1, no agentEnd → stays error", () => {
		const r = makeResult({ exitCode: 1, stderr: "fail" });
		normalizeFlowResult(r, false);
		expect(r.exitCode).toBe(1);
		expect(r.stopReason).toBe("error");
	});

	it("wasAborted + semanticSuccess → exit 0", () => {
		const r = makeResult({
			exitCode: 130,
			stopReason: "aborted",
			errorMessage: "Flow was aborted.",
			messages: [makeAssistantMessage("finished")],
			sawAgentEnd: true,
			stderr: "",
		});
		normalizeFlowResult(r, true);
		expect(r.exitCode).toBe(0);
		expect(r.stopReason).toBeUndefined();
		expect(r.errorMessage).toBeUndefined();
	});

	it("wasAborted + no semantic → exit 130", () => {
		const r = makeResult({ exitCode: -1, messages: [], stderr: "" });
		normalizeFlowResult(r, true);
		expect(r.exitCode).toBe(130);
		expect(r.stopReason).toBe("aborted");
		expect(r.errorMessage).toBe("Flow was aborted.");
	});

	it("exit > 0 + semanticSuccess → exit 0", () => {
		const r = makeResult({
			exitCode: 1,
			stopReason: "error",
			messages: [makeAssistantMessage("ok")],
			sawAgentEnd: true,
			stderr: "some error",
		});
		normalizeFlowResult(r, false);
		expect(r.exitCode).toBe(0);
		expect(r.stopReason).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// getFlowOutput
// ---------------------------------------------------------------------------

describe("getFlowOutput", () => {
	it("extracts text from messages", () => {
		expect(getFlowOutput([makeAssistantMessage("hello")])).toBe("hello");
	});

	it("returns empty for no messages", () => {
		expect(getFlowOutput([])).toBe("");
	});

	it("returns last assistant text", () => {
		const msgs = [makeAssistantMessage("first"), makeAssistantMessage("last")];
		expect(getFlowOutput(msgs)).toBe("last");
	});
});

// ---------------------------------------------------------------------------
// getLastToolCall
// ---------------------------------------------------------------------------

describe("getLastToolCall", () => {
	it("returns undefined for empty messages", () => {
		expect(getLastToolCall([])).toBeUndefined();
	});

	it("returns undefined when no tool calls exist", () => {
		const messages = [makeAssistantMessage("thinking...")];
		expect(getLastToolCall(messages)).toBeUndefined();
	});

	it("returns the last tool call from messages", () => {
		const messages = [
			{
				role: "assistant" as const,
				content: [
					{ type: "toolCall" as const, name: "read", toolCallId: "1", arguments: { file_path: "src/a.ts" } },
					{ type: "text" as const, text: "reading file" },
					{ type: "toolCall" as const, name: "bash", toolCallId: "2", arguments: { command: "npm test" } },
				],
			},
		];
		const result = getLastToolCall(messages);
		expect(result).toEqual({ type: "toolCall", name: "bash", args: { command: "npm test" } });
	});

	it("returns last tool call from multiple messages", () => {
		const messages = [
			{
				role: "assistant" as const,
				content: [
					{ type: "toolCall" as const, name: "read", toolCallId: "1", arguments: { file_path: "src/a.ts" } },
				],
			},
			{
				role: "assistant" as const,
				content: [
					{ type: "text" as const, text: "done" },
				],
			},
			{
				role: "assistant" as const,
				content: [
					{ type: "toolCall" as const, name: "grep", toolCallId: "3", arguments: { pattern: "TODO", path: "src" } },
				],
			},
		];
		const result = getLastToolCall(messages);
		expect(result).toEqual({ type: "toolCall", name: "grep", args: { pattern: "TODO", path: "src" } });
	});

	it("skips non-assistant messages", () => {
		const messages = [
			{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
			{
				role: "assistant" as const,
				content: [
					{ type: "toolCall" as const, name: "bash", toolCallId: "1", arguments: { command: "ls" } },
				],
			},
		];
		const result = getLastToolCall(messages);
		expect(result).toEqual({ type: "toolCall", name: "bash", args: { command: "ls" } });
	});
});

// ---------------------------------------------------------------------------
// getLastAssistantText
// ---------------------------------------------------------------------------

describe("getLastAssistantText", () => {
	it("returns empty string for empty messages", () => {
		expect(getLastAssistantText([])).toBe("");
	});

	it("returns empty string when no text exists", () => {
		const messages = [
			{
				role: "assistant" as const,
				content: [
					{ type: "toolCall" as const, name: "bash", toolCallId: "1", arguments: { command: "ls" } },
				],
			},
		];
		expect(getLastAssistantText(messages)).toBe("");
	});

	it("returns last assistant text", () => {
		const messages = [
			makeAssistantMessage("first message"),
			makeAssistantMessage("last message"),
		];
		expect(getLastAssistantText(messages)).toBe("last message");
	});

	it("returns text from mixed content", () => {
		const messages = [
			{
				role: "assistant" as const,
				content: [
					{ type: "text" as const, text: "thinking..." },
					{ type: "toolCall" as const, name: "bash", toolCallId: "1", arguments: { command: "ls" } },
					{ type: "text" as const, text: "Found the migration config." },
				],
			},
		];
		expect(getLastAssistantText(messages)).toBe("Found the migration config.");
	});

	it("skips non-assistant messages", () => {
		const messages = [
			{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
			makeAssistantMessage("assistant reply"),
		];
		expect(getLastAssistantText(messages)).toBe("assistant reply");
	});

	it("skips whitespace-only text", () => {
		const messages = [
			{
				role: "assistant" as const,
				content: [
					{ type: "text" as const, text: "   " },
					{ type: "text" as const, text: "real content" },
				],
			},
		];
		expect(getLastAssistantText(messages)).toBe("real content");
	});
});

// ---------------------------------------------------------------------------
// getFlowDisplayItems
// ---------------------------------------------------------------------------

describe("getFlowDisplayItems", () => {
	it("extracts text and toolCall items", () => {
		const messages = [
			{
				role: "assistant" as const,
				content: [
					{ type: "text" as const, text: "thinking..." },
					{ type: "toolCall" as const, name: "bash", toolCallId: "1", arguments: { command: "ls" } },
				],
			},
		];
		const items = getFlowDisplayItems(messages);
		expect(items).toHaveLength(2);
		expect(items[0]).toEqual({ type: "text", text: "thinking..." });
		expect(items[1]).toEqual({ type: "toolCall", name: "bash", args: { command: "ls" } });
	});

	it("skips non-assistant messages", () => {
		const messages = [
			{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
		];
		expect(getFlowDisplayItems(messages)).toHaveLength(0);
	});

	it("returns empty for empty messages", () => {
		expect(getFlowDisplayItems([])).toHaveLength(0);
	});
});
