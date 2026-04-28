import { describe, it, expect } from "vitest";
import {
	formatTokens,
	formatFixedTokens,
	formatFlowTypeName,
	truncateChars,
	tailText,
	formatCompactStats,
	formatFlowUsage,
} from "../render-utils.js";
import { renderFlowResult } from "../render.js";
import { emptyFlowUsage, type SingleResult, type FlowDetails } from "../types.js";
import type { Text, Container } from "@mariozechner/pi-tui";

// Helper to extract text from Text or Container objects
function extractText(node: Text | Container): string {
	if ("text" in node && typeof node.text === "string") {
		return node.text;
	}
	if ("children" in node && Array.isArray(node.children)) {
		return node.children.map((child: any) => extractText(child)).join("\n");
	}
	return String(node);
}

// ---------------------------------------------------------------------------
// truncateChars
// ---------------------------------------------------------------------------

describe("truncateChars", () => {
	it("short text → unchanged", () => {
		expect(truncateChars("hello", 40)).toBe("hello");
	});

	it("exactly max → unchanged", () => {
		const text = "a".repeat(40);
		expect(truncateChars(text, 40)).toBe(text);
	});

	it("long text → head ... tail format", () => {
		const text = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP";
		const result = truncateChars(text, 40);
		expect(result).toContain(" ... ");
		// head = ceil(40*0.6) = 24, tail = 40-24-3 = 13, total = 24+5+13 = 42
		// The function guarantees head+tail content fits, delimiter may push slightly over
		const [head, tail] = result.split(" ... ");
		expect(text.startsWith(head)).toBe(true);
		expect(text.endsWith(tail)).toBe(true);
	});

	it("preserves head and tail content", () => {
		const text = "Find every occurrence of ingestion_data in the codebase and check all references";
		const result = truncateChars(text, 40);
		expect(result).toContain(" ... ");
		const [head, tail] = result.split(" ... ");
		expect(text.startsWith(head)).toBe(true);
		expect(text.endsWith(tail)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// tailText
// ---------------------------------------------------------------------------

describe("tailText", () => {
	it("short text → unchanged", () => {
		expect(tailText("hello world", 40)).toBe("hello world");
	});

	it("newlines → flattened to spaces", () => {
		expect(tailText("hello\nworld", 40)).toBe("hello world");
		expect(tailText("line1\r\nline2", 40)).toBe("line1 line2");
		expect(tailText("a\tb\tc", 40)).toBe("a b c");
	});

	it("multiple spaces → collapsed", () => {
		expect(tailText("a   b   c", 40)).toBe("a b c");
	});

	it("long text → last N chars", () => {
		const text = "this is a long streaming text that keeps going and going";
		const result = tailText(text, 25);
		expect(result.length).toBeLessThanOrEqual(25);
		expect(result).toBe(text.slice(-25));
	});

	it("newlines in long text → flattened then truncated", () => {
		const text = "first line\nsecond line\nthird line\nfourth line";
		const result = tailText(text, 20);
		expect(result.length).toBeLessThanOrEqual(20);
		expect(result).not.toContain("\n");
	});

	it("trims leading/trailing whitespace", () => {
		expect(tailText("  hello  ", 40)).toBe("hello");
	});
});

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

describe("formatTokens", () => {
	it("< 1000 → raw number", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(500)).toBe("500");
		expect(formatTokens(999)).toBe("999");
	});

	it("1000-9999 → one decimal k", () => {
		expect(formatTokens(1000)).toBe("1.0k");
		expect(formatTokens(1500)).toBe("1.5k");
		expect(formatTokens(7800)).toBe("7.8k");
	});

	it("10000-999999 → rounded k", () => {
		expect(formatTokens(10000)).toBe("10k");
		expect(formatTokens(150000)).toBe("150k");
		expect(formatTokens(999000)).toBe("999k");
	});

	it(">= 1000000 → M", () => {
		expect(formatTokens(1000000)).toBe("1.0M");
		expect(formatTokens(2500000)).toBe("2.5M");
	});
});

// ---------------------------------------------------------------------------
// formatFixedTokens
// ---------------------------------------------------------------------------

describe("formatFixedTokens", () => {
	it("< 1000 → right-aligned to 5 chars", () => {
		expect(formatFixedTokens(0)).toBe("    0");
		expect(formatFixedTokens(100)).toBe("  100");
		expect(formatFixedTokens(500)).toBe("  500");
		expect(formatFixedTokens(999)).toBe("  999");
	});

	it("1000-99999 → XX.Xk format (5 chars)", () => {
		expect(formatFixedTokens(1000)).toBe(" 1.0k");
		expect(formatFixedTokens(1300)).toBe(" 1.3k");
		expect(formatFixedTokens(12400)).toBe("12.4k");
		expect(formatFixedTokens(32000)).toBe("32.0k");
		expect(formatFixedTokens(99900)).toBe("99.9k");
	});

	it("100000-999999 → shift to 0.XXM", () => {
		expect(formatFixedTokens(100000)).toBe("0.10M");
		expect(formatFixedTokens(950500)).toBe("0.95M");
		expect(formatFixedTokens(999000)).toBe("1.00M");
	});

	it(">= 1000000 → X.XXM format", () => {
		expect(formatFixedTokens(1000000)).toBe("1.00M");
		expect(formatFixedTokens(2500000)).toBe("2.50M");
	});
});

// ---------------------------------------------------------------------------
// formatFlowTypeName
// ---------------------------------------------------------------------------

describe("formatFlowTypeName", () => {
	it("short name → padded with dots", () => {
		expect(formatFlowTypeName("debug")).toBe("DEBUG.....");
		expect(formatFlowTypeName("code")).toBe("CODE......");
	});

	it("medium name → partial padding", () => {
		expect(formatFlowTypeName("architect")).toBe("ARCHITECT.");
		expect(formatFlowTypeName("explore")).toBe("EXPLORE...");
	});

	it("exact length → no padding", () => {
		expect(formatFlowTypeName("brainstorm")).toBe("BRAINSTORM");
	});

	it("already uppercase", () => {
		expect(formatFlowTypeName("DEBUG")).toBe("DEBUG.....");
	});
});

// ---------------------------------------------------------------------------
// formatCompactStats
// ---------------------------------------------------------------------------

describe("formatCompactStats", () => {
	it("full usage → correct format with brackets", () => {
		const usage = { input: 2000, output: 500, cacheRead: 30000, contextTokens: 21000 };
		const result = formatCompactStats(usage, "K2.6");
		expect(result).toBe("[ 2.0k↑   500↓ cr:30.0k ctx:21.0k] ─ K2.6");
	});

	it("minimal usage → shows 0 for output", () => {
		const usage = { input: 100 };
		const result = formatCompactStats(usage);
		expect(result).toBe("[  100↑     0↓]");
	});

	it("no usage → shows 0 placeholders", () => {
		expect(formatCompactStats({})).toBe("[    0↑     0↓]");
	});

	it("only model → placeholders + model", () => {
		expect(formatCompactStats({}, "gpt-4o")).toBe("[    0↑     0↓] ─ gpt-4o");
	});

	it("tokens only → no separator", () => {
		const usage = { input: 5000, output: 1000 };
		expect(formatCompactStats(usage)).toBe("[ 5.0k↑  1.0k↓]");
	});

	it("cache + context → lowercase cr, no separator", () => {
		const usage = { cacheRead: 8000, contextTokens: 6000 };
		expect(formatCompactStats(usage)).toBe("[    0↑     0↓ cr: 8.0k ctx: 6.0k]");
	});
});

// ---------------------------------------------------------------------------
// formatFlowUsage
// ---------------------------------------------------------------------------

describe("formatFlowUsage", () => {
	it("full usage → all parts joined by spaces", () => {
		const usage = {
			toolCalls: 5,
			turns: 3,
			input: 12000,
			output: 800,
			cacheRead: 50000,
			contextTokens: 20000,
		};
		const result = formatFlowUsage(usage, "K2.6");
		expect(result).toBe("5 calls 3 turns ↑12k ↓800 CR:50k ctx:20k model:K2.6");
	});

	it("single turn → no plural", () => {
		expect(formatFlowUsage({ turns: 1 })).toBe("1 turn");
	});

	it("multiple turns → plural", () => {
		expect(formatFlowUsage({ turns: 2 })).toBe("2 turns");
	});

	it("only toolCalls and turns", () => {
		expect(formatFlowUsage({ toolCalls: 10, turns: 5 })).toBe("10 calls 5 turns");
	});
});

// ---------------------------------------------------------------------------
// Activity Panel Rendering
// ---------------------------------------------------------------------------

function makeTheme() {
	const fg = (color: string, text: string) => text;
	const bg = (color: string, text: string) => text;
	const bold = (s: string) => s;
	return { fg, bg, bold };
}

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

function makeToolCallMessage(toolName: string, args: Record<string, unknown>, text?: string) {
	const content: Array<any> = [];
	if (text) content.push({ type: "text", text });
	content.push({ type: "toolCall", name: toolName, toolCallId: "1", arguments: args });
	return { role: "assistant" as const, content };
}

function makeTextMessage(text: string) {
	return { role: "assistant" as const, content: [{ type: "text" as const, text }] };
}

describe("activity panel rendering", () => {
	it("renders single flow with DIR, EXE, LOG lines", () => {
		const result = makeResult({
			type: "debug",
			intent: "Trace the BigQuery 400 error",
			messages: [
				makeToolCallMessage("bash", { command: "bq_schema_analyzer(table='events_raw')" }, "analyzing schema"),
				makeTextMessage("Found the migration config."),
			],
			usage: { input: 9800, output: 1300, cacheRead: 42000, cacheWrite: 0, cost: 0, contextTokens: 10000, turns: 2, toolCalls: 1 },
			model: "mimo-v2.5-pro",
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme()) as Text;
		const text = (rendered as any).text || rendered.toString();
		expect(text).toContain("DEBUG.....");
		expect(text).toContain("DIR:");
		expect(text).toContain("EXE:");
		expect(text).toContain("LOG:");
	});

	it("renders multi-flow with tree connectors", () => {
		const result1 = makeResult({
			type: "debug",
			intent: "Trace the BigQuery 400 error",
			messages: [
				makeToolCallMessage("bash", { command: "bq_schema_analyzer" }, "analyzing"),
				makeTextMessage("Found the migration config."),
			],
			usage: { input: 9800, output: 1300, cacheRead: 42000, cacheWrite: 0, cost: 0, contextTokens: 10000, turns: 2, toolCalls: 1 },
			model: "mimo-v2.5-pro",
		});
		const result2 = makeResult({
			type: "explore",
			intent: "Map the view rebuild code",
			messages: [
				makeToolCallMessage("find", { query: "view_rebuild", dir: "./src" }, "searching"),
				makeTextMessage("Let me also check scripts."),
			],
			usage: { input: 20000, output: 1700, cacheRead: 51000, cacheWrite: 0, cost: 0, contextTokens: 20000, turns: 3, toolCalls: 1 },
			model: "mimo-v2.5-pro",
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result1, result2] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme());
		// Container has children, extract text from them
		const text = extractText(rendered);
		expect(text).toContain("├─");
		expect(text).toContain("└─");
		expect(text).toContain("│");
		expect(text).toContain("DEBUG.....");
		expect(text).toContain("EXPLORE...");
	});

	it("truncates long DIR text", () => {
		const longIntent = "A" + "b".repeat(100) + "Z";
		const result = makeResult({
			intent: longIntent,
			messages: [makeTextMessage("done")],
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme()) as Text;
		const text = (rendered as any).text || rendered.toString();
		expect(text).toContain("...");
	});

	it("shows [n/a] when no log text", () => {
		const result = makeResult({
			messages: [],
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme()) as Text;
		const text = (rendered as any).text || rendered.toString();
		expect(text).toContain("[n/a]");
	});
});
