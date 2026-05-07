import { describe, it, expect, vi } from "vitest";
import {
	formatFixedTokens,
	formatFlowTypeName,
	truncateChars,
	tailText,
	formatCompactStats,
	formatCompactTokenPair,
	formatCountdown,
	visibleLength,
	getTruncationBudget,
	contentBudget,
} from "../src/render-utils.js";
import { renderFlowResult } from "../src/render.js";
import { emptyFlowUsage, type SingleResult, type FlowDetails } from "../src/types.js";
import type { Text, Container, TruncatedText } from "@mariozechner/pi-tui";

// Helper to extract text from Text, TruncatedText, or Container objects
function extractText(node: Text | Container | TruncatedText): string {
	if ("text" in node && typeof node.text === "string") {
		return node.text;
	}
	if ("children" in node && Array.isArray(node.children)) {
		return node.children.map((child: any) => extractText(child)).join("\n");
	}
	return String(node);
}

// ---------------------------------------------------------------------------
// visibleLength
// ---------------------------------------------------------------------------

describe("visibleLength", () => {
	it("plain text → length unchanged", () => {
		expect(visibleLength("hello")).toBe(5);
	});

	it("ANSI-colored text → visible chars only", () => {
		const colored = "\x1b[32mhello\x1b[39m";
		expect(visibleLength(colored)).toBe(5);
	});

	it("multiple ANSI sequences → correct visible count", () => {
		const colored = "\x1b[2m$ \x1b[22m\x1b[32mdeploy_dags.sh\x1b[39m";
		expect(visibleLength(colored)).toBe(16); // "$ deploy_dags.sh"
	});

	it("empty string → 0", () => {
		expect("").toBe("");
		expect(visibleLength("")).toBe(0);
	});

	it("only ANSI codes → 0 visible", () => {
		expect(visibleLength("\x1b[32m\x1b[39m")).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// truncateChars (ANSI-aware)
// ---------------------------------------------------------------------------

describe("truncateChars", () => {
	it("short text → unchanged", () => {
		expect(truncateChars("hello", 40)).toBe("hello");
	});

	it("exactly max → unchanged", () => {
		const text = "a".repeat(40);
		expect(truncateChars(text, 40)).toBe(text);
	});

	it("long text → head... format", () => {
		const text = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP";
		const result = truncateChars(text, 40);
		expect(result).toContain("...");
		expect(result.endsWith("...")).toBe(true);
		const head = result.slice(0, -3);
		expect(text.startsWith(head)).toBe(true);
	});

	it("preserves head content", () => {
		const text = "Find every occurrence of ingestion_data in the codebase and check all references";
		const result = truncateChars(text, 40);
		expect(result).toContain("...");
		expect(result.endsWith("...")).toBe(true);
		const head = result.slice(0, -3);
		expect(text.startsWith(head)).toBe(true);
	});

	it("short ANSI text → unchanged (no truncation)", () => {
		const colored = "\x1b[32mhello\x1b[39m";
		expect(truncateChars(colored, 10)).toBe(colored);
	});

	it("long ANSI text → truncated at visible boundaries", () => {
		const cmd = "bash deploy_dags.sh && echo 'Syntax is OK. Now let me run the deploy script'";
		const colored = "\x1b[2m$ \x1b[22m\x1b[32m" + cmd + "\x1b[39m";
		const result = truncateChars(colored, 40);
		// Should not contain raw ANSI escape fragments
		expect(visibleLength(result)).toBeLessThanOrEqual(40);
		// Should contain the ellipsis
		expect(result).toContain("...");
	});

	it("ANSI codes preserved in kept portions", () => {
		const colored = "\x1b[31m" + "a".repeat(30) + "\x1b[32m" + "b".repeat(30) + "\x1b[39m";
		const result = truncateChars(colored, 40);
		// The result should contain ANSI codes from the head portion (kept)
		expect(result).toContain("\x1b[31m");
	});

	it("no reset code after content", () => {
		const colored = "\x1b[32m" + "a".repeat(60) + "\x1b[39m";
		const result = truncateChars(colored, 40);
		// The reset code is in the tail (dropped) — outer wrapper provides styling
		expect(result).not.toContain("\x1b[39m");
		expect(result).toContain("...");
	});

	it("multi-byte ANSI sequences not split", () => {
		// Truecolor ANSI: \x1b[38;2;R;G;Bm
		const colored = "\x1b[38;2;255;128;0m" + "x".repeat(60) + "\x1b[39m";
		const result = truncateChars(colored, 40);
		// Reset code is in the tail (dropped)
		expect(result).not.toContain("\x1b[39m");
		expect(result).toContain("...");
		// Visible length should be reasonable
		expect(visibleLength(result)).toBeLessThanOrEqual(40);
	});

	it("does not treat plain 'm' as ANSI terminator when truncating from start", () => {
		// ANSI prefix followed by many 'm' chars — old bug would skip all 'm's
		const colored = "\x1b[32m" + "echo " + "m".repeat(60) + "\x1b[39m";
		const result = truncateChars(colored, 40);
		expect(visibleLength(result)).toBeLessThanOrEqual(40);
		expect(result).toContain("...");
		// Should contain some 'm' chars (they are visible content, not ANSI)
		expect(result).toContain("m");
	});

	it("head-truncation keeps start of string", () => {
		const text = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP";
		const result = truncateChars(text, 40);
		expect(result).toContain("...");
		expect(result.endsWith("...")).toBe(true);
		// First 37 chars of original should be preserved
		expect(result.slice(0, -3)).toBe(text.slice(0, 37));
	});

	it("handles max < 3 without ellipsis", () => {
		const text = "abcdefghijklmnopqrstuvwxyz";
		const result = truncateChars(text, 2);
		expect(visibleLength(result)).toBeLessThanOrEqual(2);
		expect(result).not.toContain("...");
	});

	it("handles max = 3 with ellipsis", () => {
		const text = "abcdefghijklmnopqrstuvwxyz";
		const result = truncateChars(text, 3);
		expect(result).toBe("...");
	});
});

// ---------------------------------------------------------------------------
// getTruncationBudget
// ---------------------------------------------------------------------------

describe("getTruncationBudget", () => {
	it("returns terminal width minus prefix length", () => {
		const originalColumns = process.stdout.columns;
		try {
			(process.stdout as any).columns = 100;
			expect(getTruncationBudget(10)).toBe(90);

			(process.stdout as any).columns = 60;
			expect(getTruncationBudget(8)).toBe(52);
		} finally {
			(process.stdout as any).columns = originalColumns;
		}
	});

	it("floors terminal width at 40", () => {
		const originalColumns = process.stdout.columns;
		try {
			(process.stdout as any).columns = 30;
			expect(getTruncationBudget(0)).toBe(40);

			(process.stdout as any).columns = 20;
			expect(getTruncationBudget(10)).toBe(30);
		} finally {
			(process.stdout as any).columns = originalColumns;
		}
	});

	it("defaults to 80 when columns is undefined", () => {
		const originalColumns = process.stdout.columns;
		try {
			(process.stdout as any).columns = undefined;
			expect(getTruncationBudget(10)).toBe(70);
		} finally {
			(process.stdout as any).columns = originalColumns;
		}
	});
});

// ---------------------------------------------------------------------------
// contentBudget
// ---------------------------------------------------------------------------

describe("contentBudget", () => {
	it("returns 60 minus prefix length", () => {
		expect(contentBudget(0)).toBe(60);
		expect(contentBudget(10)).toBe(50);
		expect(contentBudget(15)).toBe(45);
	});

	it("floors at 8", () => {
		expect(contentBudget(52)).toBe(8);
		expect(contentBudget(60)).toBe(8);
		expect(contentBudget(100)).toBe(8);
	});

	it("exact boundary: prefix 51 gives 9", () => {
		expect(contentBudget(51)).toBe(9);
	});

	it("exact boundary: prefix 52 gives 8", () => {
		expect(contentBudget(52)).toBe(8);
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
		expect(visibleLength(result)).toBeLessThanOrEqual(25);
		expect(result).toBe(text.slice(-25));
	});

	it("newlines in long text → flattened then truncated", () => {
		const text = "first line\nsecond line\nthird line\nfourth line";
		const result = tailText(text, 20);
		expect(visibleLength(result)).toBeLessThanOrEqual(20);
		expect(result).not.toContain("\n");
	});

	it("trims leading/trailing whitespace", () => {
		expect(tailText("  hello  ", 40)).toBe("hello");
	});

	it("ANSI-colored long text → last N visible chars, codes preserved", () => {
		const colored = "\x1b[32m" + "a".repeat(60) + "\x1b[39m";
		const result = tailText(colored, 20);
		expect(visibleLength(result)).toBeLessThanOrEqual(20);
		// Should contain the closing ANSI code from the tail
		expect(result).toContain("\x1b[39m");
	});

	it("ANSI text with mixed content → correct visible truncation", () => {
		const colored = "\x1b[2mfirst part\x1b[22m \x1b[32msecond part\x1b[39m";
		const result = tailText(colored, 15);
		expect(visibleLength(result)).toBeLessThanOrEqual(15);
	});
});

// ---------------------------------------------------------------------------
// formatFixedTokens
// ---------------------------------------------------------------------------

describe("formatFixedTokens", () => {
	it("< 1000 → space-padded to 5 chars", () => {
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
	it("short name → padded with spaces", () => {
		expect(formatFlowTypeName("debug")).toBe("debug");
		expect(formatFlowTypeName("code")).toBe("code ");
	});

	it("medium name → partial padding", () => {
		expect(formatFlowTypeName("craft")).toBe("craft");
		expect(formatFlowTypeName("scout")).toBe("scout");
	});

	it("exact length → no padding", () => {
		expect(formatFlowTypeName("ideas")).toBe("ideas");
	});

	it("uppercase input → lowercased", () => {
		expect(formatFlowTypeName("DEBUG")).toBe("debug");
	});
});

// ---------------------------------------------------------------------------
// formatCompactTokenPair / formatCountdown
// ---------------------------------------------------------------------------

describe("formatCompactTokenPair", () => {
	it("formats only input and output tokens", () => {
		expect(formatCompactTokenPair({ input: 46700, output: 4600 })).toBe("↑ 46.7k · ↓  4.6k");
	});
});

describe("formatCountdown", () => {
	it("formats remaining milliseconds as a clock", () => {
		expect(formatCountdown(576_000)).toBe("09:36");
		expect(formatCountdown(0)).toBe("00:00");
		expect(formatCountdown(-100)).toBe("00:00");
	});
});

// ---------------------------------------------------------------------------
// formatCompactStats
// ---------------------------------------------------------------------------

describe("formatCompactStats", () => {
	it("full usage → dashboard format", () => {
		const usage = { input: 2000, output: 500, toolCalls: 4, contextTokens: 21000 };
		const result = formatCompactStats(usage, "K2.6");
		expect(result).toBe("↑  2.0k · ↓   500 · tps:     - · ctx: 21.0k · K2.6");
	});

	it("minimal usage → shows 0 for all metrics", () => {
		const usage = { input: 100 };
		const result = formatCompactStats(usage);
		expect(result).toBe("↑   100 · ↓     0 · tps:     - · ctx:     0");
	});

	it("no usage → shows placeholders", () => {
		expect(formatCompactStats({})).toBe("↑     0 · ↓     0 · tps:     - · ctx:     0");
	});

	it("only model → placeholders + model", () => {
		expect(formatCompactStats({}, "gpt-4o")).toBe("↑     0 · ↓     0 · tps:     - · ctx:     0 · gpt-4o");
	});

	it("strips provider prefix from model", () => {
		expect(formatCompactStats({}, "github-copilot/gpt-5.5")).toBe(
			"↑     0 · ↓     0 · tps:     - · ctx:     0 · gpt-5.5",
		);
	});

	it("tokens only → all metrics shown", () => {
		const usage = { input: 5000, output: 1000 };
		expect(formatCompactStats(usage)).toBe("↑  5.0k · ↓  1.0k · tps:     - · ctx:     0");
	});

	it("with context tokens", () => {
		const usage = { input: 0, output: 0, toolCalls: 3, contextTokens: 6000 };
		expect(formatCompactStats(usage)).toBe("↑     0 · ↓     0 · tps:     - · ctx:  6.0k");
	});

	it("with smoothedTps value", () => {
		const usage = { input: 2000, output: 500, contextTokens: 21000, smoothedTps: 42.3 };
		const result = formatCompactStats(usage, "K2.6");
		expect(result).toBe("↑  2.0k · ↓   500 · tps:  42.3 · ctx: 21.0k · K2.6");
	});

	it("with zero smoothedTps shows dash", () => {
		const usage = { input: 1000, output: 500, smoothedTps: 0 };
		const result = formatCompactStats(usage);
		expect(result).toBe("↑  1.0k · ↓   500 · tps:     - · ctx:     0");
	});

	it("narrows when maxWidth is tight", () => {
		const usage = { input: 2000, output: 500, contextTokens: 21000, smoothedTps: 42.3 };
		const result = formatCompactStats(usage, "K2.6", 35);
		expect(visibleLength(result)).toBeLessThanOrEqual(35);
		expect(result).toContain("↑  2.0k");
	});

	it("drops model and context when maxWidth is very tight", () => {
		const usage = { input: 2000, output: 500, contextTokens: 21000, smoothedTps: 42.3 };
		const result = formatCompactStats(usage, "K2.6", 25);
		expect(visibleLength(result)).toBeLessThanOrEqual(25);
		expect(result).not.toContain("K2.6");
		expect(result).not.toContain("ctx");
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
		type: "scout",
		agentSource: "user",
		intent: "test intent",
		aim: "test aim",
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
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("debug");
		expect(text).toContain("aim:");
		expect(text).toContain("├─ act:");
		expect(text).toContain("msg:");
	});

	it("renders in-progress aim with a live countdown prefix", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-07T00:00:00.000Z"));
		try {
			const now = Date.now();
			const result = makeResult({
				exitCode: -1,
				startedAtMs: now,
				deadlineAtMs: now + 576_000,
				messages: [makeTextMessage("Still working")],
			});
			const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result] };
			const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
			const text = extractText(rendered);
			expect(text).toContain("aim: [09:36] - test aim");
		} finally {
			vi.useRealTimers();
		}
	});

	it("renders msg with compact input/output token prefix", () => {
		const result = makeResult({
			messages: [makeTextMessage("Flow timed out after 600s.")],
			usage: { input: 46_700, output: 4_600, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 50_000, turns: 2, toolCalls: 0 },
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("msg: [↑ 46.7k · ↓  4.6k] - Flow timed out after 600s.");
	});

	it("renders multi-flow aim countdown and msg token prefixes", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-07T00:00:00.000Z"));
		try {
			const now = Date.now();
			const result = makeResult({
				exitCode: -1,
				startedAtMs: now,
				deadlineAtMs: now + 45_000,
				streamingText: "Deploy still running",
				usage: { input: 46_700, output: 4_600, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 50_000, turns: 2, toolCalls: 0 },
			});
			const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result, makeResult({ type: "debug" })] };
			const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
			const text = extractText(rendered);
			expect(text).toContain("aim: [00:45] - test aim");
			expect(text).toContain("msg: [↑ 46.7k · ↓  4.6k] - Deploy still running");
		} finally {
			vi.useRealTimers();
		}
	});

	it("renders act line with count prefix [N]", () => {
		const result = makeResult({
			type: "scout",
			intent: "Map the codebase",
			messages: [
				makeToolCallMessage("read", { file_path: "src/index.ts" }),
				makeToolCallMessage("grep", { pattern: "TODO", path: "src" }),
				makeToolCallMessage("bash", { command: "npm test" }),
			],
			usage: { input: 5000, output: 800, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 6000, turns: 3, toolCalls: 3 },
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("act: [3] -");
	});

	it("renders ghost dashboard during zero state", () => {
		const rendered = renderFlowResult(
			{ content: [{ type: "text", text: "Starting..." }], details: undefined },
			false,
			makeTheme(),
			{ flow: [{ type: "code", intent: "Refactor the auth module", aim: "Refactor auth module" }] },
		);
		const text = extractText(rendered);
		expect(text).toContain("code");
		expect(text).toContain("aim:");
		expect(text).toContain("Refactor auth module");
		expect(text).toContain("↑     0");
		expect(text).toContain("↓     0");
		expect(text).toContain("tps:     -");
		expect(text).toContain("ctx:     0");
		expect(text).toContain("Starting...");
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
			type: "scout",
			intent: "Map the view rebuild code",
			messages: [
				makeToolCallMessage("find", { query: "view_rebuild", dir: "./src" }, "searching"),
				makeTextMessage("Let me also check scripts."),
			],
			usage: { input: 20000, output: 1700, cacheRead: 51000, cacheWrite: 0, cost: 0, contextTokens: 20000, turns: 3, toolCalls: 1 },
			model: "mimo-v2.5-pro",
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result1, result2] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("├─");
		expect(text).toContain("└─");
		expect(text).toContain("│");
		expect(text).toContain("debug");
		expect(text).toContain("scout");
	});

	it("shows live streaming text in multi-flow collapsed rows", () => {
		const streaming = "streaming message currently arriving character by character";
		const result = makeResult({
			type: "scout",
			intent: "Map the view rebuild code",
			messages: [makeTextMessage("stale completed text")],
			exitCode: -1,
			streamingText: streaming,
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result, makeResult({ type: "debug" })] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		const scoutBlock = text.split("debug")[0];
		const expectedBudget = contentBudget(visibleLength("│  └─ msg: [↑     0 · ↓     0] - "));
		expect(scoutBlock).toContain(tailText(streaming, expectedBudget));
		expect(scoutBlock).not.toContain("stale completed text");
	});

	it("includes long DIR text in TruncatedText", () => {
		const longAim = "A" + "b".repeat(100) + "Z";
		const result = makeResult({
			intent: longAim,
			aim: longAim,
			messages: [makeTextMessage("done")],
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("aim:");
		// Content is pre-truncated to contentBudget(10) = 50 chars
		const dirLine = text.split("\n").find((l: string) => l.includes("aim:"));
		expect(dirLine).toContain("...");
	});

	it("includes long EXE text in TruncatedText", () => {
		const longCmd = "a".repeat(100);
		const result = makeResult({
			intent: "test",
			messages: [
				makeToolCallMessage("bash", { command: longCmd }),
				makeTextMessage("done"),
			],
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		const exeLine = text.split("\n").find((l: string) => l.includes("├─ act:"));
		expect(exeLine).toBeDefined();
		// The act line should exist and be non-empty
		expect(exeLine!.length).toBeGreaterThan(5);
	});

	it("flattens multi-line bash commands to single line", () => {
		const result = makeResult({
			intent: "test",
			messages: [
				makeToolCallMessage("bash", { command: "echo hello\necho world\nls -la" }),
				makeTextMessage("done"),
			],
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		const exeLine = text.split("\n").find((l: string) => l.includes("├─ act:"));
		expect(exeLine).toBeDefined();
		// Should not contain newlines in the act line itself
		expect(exeLine).not.toContain("\n");
		// The act line should contain the flattened command
		expect(exeLine!.includes("echo") || exeLine!.includes("bash")).toBe(true);
	});

	it("shows [n/a] when no log text", () => {
		const result = makeResult({
			messages: [],
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("[n/a]");
	});

	it("passes full EXE text to TruncatedText in single flow collapsed", () => {
		const originalColumns = process.stdout.columns;
		try {
			(process.stdout as any).columns = 40; // narrow terminal
			const longCmd = "a".repeat(55);
			const result = makeResult({
				intent: "test",
				messages: [
					makeToolCallMessage("bash", { command: longCmd }),
					makeTextMessage("done"),
				],
			});
			const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result] };
			const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
			const text = extractText(rendered);
			const exeLine = text.split("\n").find((l: string) => l.includes("├─ act:"));
			expect(exeLine).toBeDefined();
			// The act line should exist and be non-empty
			expect(exeLine!.length).toBeGreaterThan(5);
		} finally {
			(process.stdout as any).columns = originalColumns;
		}
	});

	it("passes full DIR text to TruncatedText in multi-flow collapsed", () => {
		const originalColumns = process.stdout.columns;
		try {
			(process.stdout as any).columns = 40; // narrow terminal
			const longAim = "b".repeat(55);
			const result = makeResult({
				intent: longAim,
				aim: longAim,
				messages: [makeTextMessage("done")],
			});
			const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result, makeResult()] };
			const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
			const text = extractText(rendered);
			const dirLine = text.split("\n").find((l: string) => l.includes("aim:"));
			expect(dirLine).toBeDefined();
			// Content is pre-truncated to contentBudget(10) = 50 chars
			expect(dirLine).toContain("...");
			expect(visibleLength(dirLine.split("aim:")[1].trim())).toBeLessThanOrEqual(50);
		} finally {
			(process.stdout as any).columns = originalColumns;
		}
	});

	it("shows the live tail of streaming msg text in single flow collapsed", () => {
		const originalColumns = process.stdout.columns;
		try {
			(process.stdout as any).columns = 40; // narrow terminal
			const longStreaming = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRST";
			const result = makeResult({
				intent: "test",
				messages: [],
			});
			const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result] };
			const rendered = renderFlowResult({ content: [{ type: "text", text: longStreaming }], details }, false, makeTheme(), undefined);
			const text = extractText(rendered);
			const logLine = text.split("\n").find((l: string) => l.includes("msg:"));
			expect(logLine).toBeDefined();
			// Content is a moving tail window so new characters visibly shift into view.
			const expectedPrefix = "[↑     0 · ↓     0] - ";
			expect(logLine).toContain(`msg: ${expectedPrefix}`);
			const logContent = logLine.split(expectedPrefix)[1].trim();
			const expectedBudget = contentBudget(visibleLength("└─ msg: [↑     0 · ↓     0] - "));
			expect(logContent).toBe(tailText(longStreaming, expectedBudget));
			expect(visibleLength(logContent)).toBeLessThanOrEqual(expectedBudget);
		} finally {
			(process.stdout as any).columns = originalColumns;
		}
	});
});

describe("expanded view rendering", () => {
	it("single expanded shows type name not icon", () => {
		const result = makeResult({
			type: "debug",
			intent: "Trace the BigQuery 400 error",
			messages: [makeTextMessage("Found the migration config.")],
			usage: { input: 9800, output: 1300, cacheRead: 42000, cacheWrite: 0, cost: 0, contextTokens: 10000, turns: 2, toolCalls: 1 },
			model: "mimo-v2.5-pro",
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, true, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("debug");
		expect(text).not.toContain("✓");
		expect(text).not.toContain("✗");
		expect(text).not.toContain("(user)");
	});

	it("single expanded stats use bracket format with context inline", () => {
		const result = makeResult({
			type: "debug",
			intent: "Trace the BigQuery 400 error",
			messages: [makeTextMessage("Found the migration config.")],
			usage: { input: 9800, output: 1300, cacheRead: 42000, cacheWrite: 0, cost: 0, contextTokens: 10000, turns: 2, toolCalls: 1 },
			model: "mimo-v2.5-pro",
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, true, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("↑  9.8k · ↓  1.3k · tps:     - · ctx: 10.0k · mimo-v2.5-pro");
	});

	it("context tokens on separate line", () => {
		const result = makeResult({
			type: "debug",
			intent: "Trace the BigQuery 400 error",
			messages: [makeTextMessage("Found the migration config.")],
			usage: { input: 9800, output: 1300, cacheRead: 42000, cacheWrite: 0, cost: 0, contextTokens: 10000, turns: 2, toolCalls: 1 },
			model: "mimo-v2.5-pro",
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, true, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("ctx: 10.0k");
	});

	it("single expanded renders structured notDone details", () => {
		const result = makeResult({
			type: "build",
			intent: "Implement structured output",
			structuredOutput: {
				version: "1.0",
				status: "partial",
				summary: "Implemented most structured output work.",
				files: [],
				actions: [],
				notDone: [
					{
						item: "Cross-validation",
						reason: "Deferred",
						blocker: "Needs tool-call summary",
						nextStep: "Design validation layer",
					},
				],
				commands: [],
				nextSteps: [],
				reasoning: [],
				notes: [],
			},
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, true, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("Not Done: Cross-validation");
		expect(text).toContain("reason: Deferred");
		expect(text).toContain("blocker: Needs tool-call summary");
		expect(text).toContain("next: Design validation layer");
	});

	it("multi expanded summary shows count only", () => {
		const result1 = makeResult({
			type: "debug",
			intent: "Trace the BigQuery 400 error",
			messages: [makeTextMessage("Found the migration config.")],
			usage: { input: 9800, output: 1300, cacheRead: 42000, cacheWrite: 0, cost: 0, contextTokens: 10000, turns: 2, toolCalls: 1 },
			model: "mimo-v2.5-pro",
		});
		const result2 = makeResult({
			type: "scout",
			intent: "Map the view rebuild code",
			messages: [makeTextMessage("Let me also check scripts.")],
			usage: { input: 20000, output: 1700, cacheRead: 51000, cacheWrite: 0, cost: 0, contextTokens: 20000, turns: 3, toolCalls: 1 },
			model: "mimo-v2.5-pro",
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result1, result2] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, true, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("2 flows");
		expect(text).not.toContain("✓");
		expect(text).not.toContain("✗");
	});

	it("multi expanded per-flow uses formatFlowTypeName", () => {
		const result1 = makeResult({
			type: "debug",
			intent: "Trace the BigQuery 400 error",
			messages: [makeTextMessage("Found the migration config.")],
			usage: { input: 9800, output: 1300, cacheRead: 42000, cacheWrite: 0, cost: 0, contextTokens: 10000, turns: 2, toolCalls: 1 },
			model: "mimo-v2.5-pro",
		});
		const result2 = makeResult({
			type: "scout",
			intent: "Map the view rebuild code",
			messages: [makeTextMessage("Let me also check scripts.")],
			usage: { input: 20000, output: 1700, cacheRead: 51000, cacheWrite: 0, cost: 0, contextTokens: 20000, turns: 3, toolCalls: 1 },
			model: "mimo-v2.5-pro",
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result1, result2] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, true, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("debug");
		expect(text).toContain("scout");
	});
});

describe("formatFlowToolCall — batch", () => {
	it("renders single read operation", () => {
		const result = makeResult({
			type: "scout",
			intent: "Read files",
			messages: [
				makeToolCallMessage("batch", { o: [
					{ o: "read", p: "src/index.ts" },
				] }),
			],
			usage: emptyFlowUsage(),
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("batch");
		expect(text).toContain("read");
		expect(text).toContain("index.ts");
	});

	it("renders multiple operations", () => {
		const result = makeResult({
			type: "code",
			intent: "Refactor",
			messages: [
				makeToolCallMessage("batch", { o: [
					{ o: "read", p: "src/a.ts" },
					{ o: "edit", p: "src/b.ts", e: [{ f: "old", r: "new" }] },
				] }),
			],
			usage: emptyFlowUsage(),
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("batch");
		expect(text).toContain("a.ts");
		expect(text).toContain("b.ts");
	});

	it("renders edit with multiple blocks", () => {
		const result = makeResult({
			type: "code",
			intent: "Multi-edit",
			messages: [
				makeToolCallMessage("batch", { o: [
					{
						o: "edit",
						p: "src/foo.ts",
						e: [
							{ f: "a", r: "b" },
							{ f: "c", r: "d" },
						],
					},
				] }),
			],
			usage: emptyFlowUsage(),
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("batch");
		expect(text).toContain("2 blocks");
	});

	it("renders many operations with truncation", () => {
		const result = makeResult({
			type: "code",
			intent: "Bulk changes",
			messages: [
				makeToolCallMessage("batch", { o: [
					{ o: "read", p: "a.ts" },
					{ o: "read", p: "b.ts" },
					{ o: "read", p: "c.ts" },
					{ o: "read", p: "d.ts" },
				] }),
			],
			usage: emptyFlowUsage(),
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("batch");
		expect(text).toContain("+2 more");
	});

	it("renders empty operations", () => {
		const result = makeResult({
			type: "scout",
			intent: "Empty",
			messages: [
				makeToolCallMessage("batch", { o: [] }),
			],
			usage: emptyFlowUsage(),
		});
		const details: FlowDetails = { mode: "flow", delegationMode: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("batch (empty)");
	});
});
