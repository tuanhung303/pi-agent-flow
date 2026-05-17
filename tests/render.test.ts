import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	formatFixedTokens,
	formatFlowTypeName,
	truncateChars,
	tailText,
	formatCompactStats,
	formatTps,
	formatCountdown,
	lowerFirstWord,
	visibleLength,
	getTruncationBudget,
	stripAnsi,
} from "../src/tui/render-utils.js";
import { renderFlowCall, renderFlowResult, renderSingleFlowResult, resetAnonymousFlowIdCounter } from "../src/tui/render.js";
import { scrambleManager, DynamicScrambleText } from "../src/tui/scramble/index.js";
import { emptyFlowUsage, type SingleResult, type FlowDetails } from "../src/types/flow.js";
import type { Text, TruncatedText } from "@mariozechner/pi-tui";
import { Container } from "@mariozechner/pi-tui";

// Helper to extract text from Text, TruncatedText, Container, or DynamicScrambleText objects
function extractText(node: Text | Container | TruncatedText | DynamicScrambleText): string {
	let raw: string;
	if (node instanceof DynamicScrambleText) {
		raw = node.render(80).join("\n");
	} else if ("text" in node && typeof node.text === "string") {
		raw = node.text;
	} else if ("children" in node && Array.isArray(node.children)) {
		raw = node.children.map((child: any) => extractText(child)).join("\n");
	} else {
		raw = String(node);
	}
	return stripAnsi(raw);
}

// ---------------------------------------------------------------------------
// visibleLength
// ---------------------------------------------------------------------------

// Reset scramble state between render tests so glitch animations don't leak across test boundaries.
beforeEach(() => {
	scrambleManager.setAnimationConfig({ enabled: true, glitch: true });
	scrambleManager.clear();
	resetAnonymousFlowIdCounter();
});

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
			expect(getTruncationBudget(10)).toBe(87);

			(process.stdout as any).columns = 60;
			expect(getTruncationBudget(8)).toBe(49);
		} finally {
			(process.stdout as any).columns = originalColumns;
		}
	});

	it("floors terminal width at 20", () => {
		const originalColumns = process.stdout.columns;
		try {
			(process.stdout as any).columns = 30;
			expect(getTruncationBudget(0)).toBe(27);

			(process.stdout as any).columns = 15;
			// width floored to 20, then 20 - 10 = 10, but floor of 8 means 10
			expect(getTruncationBudget(10)).toBe(8);
		} finally {
			(process.stdout as any).columns = originalColumns;
		}
	});

	it("floors result at 8 (readable minimum)", () => {
		const originalColumns = process.stdout.columns;
		try {
			(process.stdout as any).columns = 40;
			// 40 - 35 = 5, but floor is 8
			expect(getTruncationBudget(35)).toBe(8);
			expect(getTruncationBudget(40)).toBe(8);
			expect(getTruncationBudget(100)).toBe(8);

			(process.stdout as any).columns = 100;
			// 100 - 95 = 5, but floor is 8
			expect(getTruncationBudget(95)).toBe(8);

			// with padding: 100 - 92 - 3 = 5, floored to 8
			expect(getTruncationBudget(92)).toBe(8);
			// 100 - 91 - 3 = 6, also floored to 8
			expect(getTruncationBudget(91)).toBe(8);
		} finally {
			(process.stdout as any).columns = originalColumns;
		}
	});

	it("defaults to 80 when columns is undefined", () => {
		const originalColumns = process.stdout.columns;
		try {
			(process.stdout as any).columns = undefined;
			expect(getTruncationBudget(10)).toBe(67);
		} finally {
			(process.stdout as any).columns = originalColumns;
		}
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

describe("formatCountdown", () => {
	it("formats remaining milliseconds as a clock", () => {
		expect(formatCountdown(576_000)).toBe("09:36");
		expect(formatCountdown(0)).toBe("00:00");
		expect(formatCountdown(-100)).toBe("00:00");
	});
});

// ---------------------------------------------------------------------------
// lowerFirstWord
// ---------------------------------------------------------------------------

describe("lowerFirstWord", () => {
	it("lowercases the first word only", () => {
		expect(lowerFirstWord("Refactor auth module")).toBe("refactor auth module");
	});

	it("leaves already-lowercase text unchanged", () => {
		expect(lowerFirstWord("test aim")).toBe("test aim");
	});

	it("handles single word", () => {
		expect(lowerFirstWord("Hello")).toBe("hello");
	});

	it("handles empty string", () => {
		expect(lowerFirstWord("")).toBe("");
	});

	it("preserves leading whitespace", () => {
		expect(lowerFirstWord("  Hello World")).toBe("  hello World");
	});
});

// ---------------------------------------------------------------------------
// formatTps
// ---------------------------------------------------------------------------

describe("formatTps", () => {
	it("returns dash for undefined", () => {
		expect(formatTps(undefined)).toBe("---- t/s");
	});
	it("returns dash for zero", () => {
		expect(formatTps(0)).toBe("---- t/s");
	});
	it("returns dash for negative", () => {
		expect(formatTps(-5)).toBe("---- t/s");
	});
	it("shows one decimal when value < 100", () => {
		expect(formatTps(76.2)).toBe("76.2 t/s");
	});
	it("shows integer when value >= 100", () => {
		expect(formatTps(142.7)).toBe("143 t/s");
	});
	it("shows integer when value is exactly 100", () => {
		expect(formatTps(100)).toBe("100 t/s");
	});
});

// ---------------------------------------------------------------------------
// formatCompactStats
// ---------------------------------------------------------------------------

describe("formatCompactStats", () => {
	it("full usage → dashboard format", () => {
		const usage = { input: 2000, output: 500, toolCalls: 4, contextTokens: 21000 };
		const result = formatCompactStats(usage, "K2.6");
		expect(result).toBe("▲  2.0k - ---- t/s - 21.0k - k2.6");
	});

	it("minimal usage → shows 0 for all metrics", () => {
		const usage = { input: 100 };
		const result = formatCompactStats(usage);
		expect(result).toBe("▲   100 - ---- t/s -     0");
	});

	it("no usage → shows placeholders", () => {
		expect(formatCompactStats({})).toBe("▲     0 - ---- t/s -     0");
	});

	it("only model → placeholders + model", () => {
		expect(formatCompactStats({}, "gpt-4o")).toBe("▲     0 - ---- t/s -     0 - gpt-4o");
	});

	it("strips provider prefix from model", () => {
		expect(formatCompactStats({}, "github-copilot/gpt-5.5")).toBe(
			"▲     0 - ---- t/s -     0 - gpt-5.5",
		);
	});

	it("tokens only → all metrics shown", () => {
		const usage = { input: 5000, output: 1000 };
		expect(formatCompactStats(usage)).toBe("▲  5.0k - ---- t/s -     0");
	});

	it("with context tokens", () => {
		const usage = { input: 0, output: 0, toolCalls: 3, contextTokens: 6000 };
		expect(formatCompactStats(usage)).toBe("▲     0 - ---- t/s -  6.0k");
	});

	it("with smoothedTps value", () => {
		const usage = { input: 2000, output: 500, contextTokens: 21000, smoothedTps: 42.3 };
		const result = formatCompactStats(usage, "K2.6");
		expect(result).toBe("▲  2.0k - 42.3 t/s - 21.0k - k2.6");
	});

	it("can skip token counts for compact flow headers", () => {
		const usage = { input: 2000, output: 500, contextTokens: 21000, smoothedTps: 42.3 };
		const result = formatCompactStats(usage, "K2.6", undefined, { skipTokens: true });
		expect(result).toBe("42.3 t/s - 21.0k - k2.6");
	});

	it("with skipContext omits context tokens from runtime parts", () => {
		const usage = { input: 2000, output: 500, contextTokens: 21000, smoothedTps: 42.3 };
		const result = formatCompactStats(usage, "K2.6", undefined, { skipTokens: true, skipContext: true });
		expect(result).toBe("42.3 t/s - k2.6");
	});

	it("with hideModel omits model name", () => {
		const usage = { input: 2000, output: 500, contextTokens: 21000, smoothedTps: 42.3 };
		const result = formatCompactStats(usage, "K2.6", undefined, { skipTokens: true, hideModel: true });
		expect(result).toBe("42.3 t/s - 21.0k");
	});

	it("with skipContext and hideModel shows only tps", () => {
		const usage = { input: 2000, output: 500, contextTokens: 21000, smoothedTps: 42.3 };
		const result = formatCompactStats(usage, undefined, undefined, { skipTokens: true, skipContext: true, hideModel: true });
		expect(result).toBe("42.3 t/s");
	});

	it("with zero smoothedTps shows dash", () => {
		const usage = { input: 1000, output: 500, smoothedTps: 0 };
		const result = formatCompactStats(usage);
		expect(result).toBe("▲  1.0k - ---- t/s -     0");
	});

	it("with high smoothedTps rounds to integer", () => {
		const usage = { input: 2000, output: 500, contextTokens: 21000, smoothedTps: 142.7 };
		const result = formatCompactStats(usage, "K2.6");
		expect(result).toBe("▲  2.0k - 143 t/s - 21.0k - k2.6");
	});

	it("with exactly 100 smoothedTps rounds to integer", () => {
		const usage = { input: 2000, output: 500, contextTokens: 21000, smoothedTps: 100 };
		const result = formatCompactStats(usage);
		expect(result).toBe("▲  2.0k - 100 t/s - 21.0k");
	});

	it("narrows when maxWidth is tight", () => {
		const usage = { input: 2000, output: 500, contextTokens: 21000, smoothedTps: 42.3 };
		const result = formatCompactStats(usage, "K2.6", 35);
		expect(visibleLength(result)).toBeLessThanOrEqual(35);
		expect(result).toContain("▲  2.0k");
	});

	it("drops model and context when maxWidth is very tight", () => {
		const usage = { input: 2000, output: 500, contextTokens: 21000, smoothedTps: 42.3 };
		const result = formatCompactStats(usage, "K2.6", 25);
		expect(visibleLength(result)).toBeLessThanOrEqual(25);
		expect(result).not.toContain("k2.6");
		expect(result).not.toContain("21.0k");
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
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("debug");
		expect(text).toContain("aim ▸");
		expect(text).toContain("├─ cmd ▸");
		expect(text).toContain("msg ▸");
	});

	it("renders in-progress aim without countdown prefix", () => {
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
			const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
			const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
			const text = extractText(rendered);
			expect(text).toContain("aim ▸");
			expect(text).not.toContain("aim ▸ 09:36");
		} finally {
			vi.useRealTimers();
		}
	});

	it("renders msg with compact input/output token prefix", () => {
		const result = makeResult({
			messages: [makeTextMessage("Flow timed out after 600s.")],
			usage: { input: 46_700, output: 4_600, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 50_000, turns: 2, toolCalls: 0 },
		});
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		const headerLine = text.split("\n")[0];
		expect(headerLine).toContain("scout");
		expect(headerLine).toContain("50.0k");
		expect(headerLine).not.toContain("▲ 46.7k");
		expect(text).toContain("msg ▸ Flow timed out after 600s.");
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
			const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result, makeResult({ type: "debug" })] };
			scrambleManager.setAnimationConfig({ enabled: false, glitch: false });
			const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
			const text = extractText(rendered);
			const firstHeaderLine = text.split("\n")[0];
			expect(firstHeaderLine).toContain("scout");
			expect(firstHeaderLine).toContain("50.0k");
			expect(firstHeaderLine).not.toContain("▲ 46.7k");
			// Aim prefix is static, content may be scrambled
			expect(text).toContain("aim ▸");
			expect(text).not.toContain("aim ▸ 00:45");
			// Msg prefix is static, content may be scrambled
			expect(text).toContain("msg ▸");
			expect(text).not.toContain("msg ▸ ▲");
		} finally {
			vi.useRealTimers();
		}
	});

	it("renders cmd line without tool call count suffix on aim line", () => {
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
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("cmd ▸");
		expect(text).toContain("aim ▸");
		expect(text).not.toContain("(3)");
	});

	it("renders ghost dashboard during zero state", () => {
		const rendered = renderFlowResult(
			{ content: [{ type: "text", text: "Starting..." }], details: undefined },
			false,
			makeTheme(),
			{ flow: [{ type: "code", intent: "Refactor the auth module", aim: "Refactor auth module" }] },
		);
		const text = extractText(rendered);
		const headerLine = text.split("\n")[0];
		// Header is scrambled on first render for in-progress flows
		expect(headerLine.length).toBeGreaterThan(0);
		expect(text).toContain("aim ▸");
		// Header stats are scrambled on first render, don't assert exact tps text
		expect(text).not.toContain("ctx:");
		expect(text).toContain("msg ▸");
	});

	it("hides acceptance line in collapsed view", () => {
		const result = makeResult({
			acceptance: "Done when tests pass",
			messages: [makeToolCallMessage("read", { file_path: "src/index.ts" })],
			usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 500, turns: 1, toolCalls: 1 },
		});
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).not.toContain("acceptance:");
		expect(text).not.toContain("Done when tests pass");
	});

	it("hides acceptance line in activity panel", () => {
		const result1 = makeResult({ type: "scout", acceptance: "Code mapped" });
		const result2 = makeResult({ type: "build", acceptance: "Build shipped" });
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result1, result2] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).not.toContain("acceptance:");
		expect(text).not.toContain("Code mapped");
		expect(text).not.toContain("Build shipped");
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
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result1, result2] };
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
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result, makeResult({ type: "debug" })] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		const scoutBlock = text.split("debug")[0];
		const expectedBudget = getTruncationBudget(visibleLength("│  └─ msg ▸ "));
		expect(scoutBlock).toContain("msg ▸");
		expect(scoutBlock).not.toContain("stale completed text");
	});

	it("passes the live tail window to msg animation in multi-flow collapsed rows", () => {
		const originalColumns = process.stdout.columns;
		try {
			(process.stdout as any).columns = 40;
			const longStreaming = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRST";
			const result = makeResult({
				type: "scout",
				intent: "Map the view rebuild code",
				messages: [makeTextMessage("stale completed text")],
				exitCode: -1,
				streamingText: longStreaming,
			});
			const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result, makeResult({ type: "debug" })] };
			const expectedBudget = getTruncationBudget(visibleLength("│  └─ msg ▸ "));
			const expectedTail = tailText(longStreaming, expectedBudget);
			const spy = vi.spyOn(scrambleManager, "updateMsg");

			const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
			extractText(rendered);

			expect(spy).toHaveBeenCalledWith(expect.any(String), expectedTail, expect.any(Number), false, undefined, true);
			expect(spy).not.toHaveBeenCalledWith(expect.any(String), longStreaming, expect.any(Number), false, undefined, true);
			spy.mockRestore();
		} finally {
			(process.stdout as any).columns = originalColumns;
		}
	});

	it("includes long DIR text in TruncatedText", () => {
		const longAim = "A" + "b".repeat(100) + "Z";
		const result = makeResult({
			intent: longAim,
			aim: longAim,
			messages: [makeTextMessage("done")],
		});
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("aim ▸");
		// Content is pre-truncated dynamically based on terminal width
		const dirLine = text.split("\n").find((l: string) => l.includes("aim ▸"));
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
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		const exeLine = text.split("\n").find((l: string) => l.includes("├─ cmd ▸"));
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
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		const exeLine = text.split("\n").find((l: string) => l.includes("├─ cmd ▸"));
		expect(exeLine).toBeDefined();
		// Should not contain newlines in the act line itself
		expect(exeLine).not.toContain("\n");
		// The act line should contain the flattened command
		expect(exeLine!.includes("echo") || exeLine!.includes("bash")).toBe(true);
	});

	it("shows empty msg line when streamingText is empty and no other text sources exist", () => {
		const result = makeResult({
			messages: [],
		});
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("├─ cmd ▸ [n/a]");
		expect(text).toContain("└─ msg ▸");
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
			const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
			const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
			const text = extractText(rendered);
			const exeLine = text.split("\n").find((l: string) => l.includes("├─ cmd ▸"));
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
			const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result, makeResult()] };
			const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
			const text = extractText(rendered);
			const dirLine = text.split("\n").find((l: string) => l.includes("aim ▸"));
			expect(dirLine).toBeDefined();
			// Content is pre-truncated dynamically based on terminal width (columns=40)
			expect(dirLine).toContain("...");
			const expectedBudget = getTruncationBudget(visibleLength("│  ├─ aim ▸ "));
			expect(visibleLength(dirLine.split("aim ▸")[1].trim())).toBeLessThanOrEqual(expectedBudget);
		} finally {
			(process.stdout as any).columns = originalColumns;
		}
	});

	it("passes the live tail window to msg animation in single flow collapsed", () => {
		const originalColumns = process.stdout.columns;
		try {
			(process.stdout as any).columns = 40;
			const longStreaming = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRST";
			const result = makeResult({
				intent: "test",
				messages: [],
				exitCode: -1,
			});
			const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
			const expectedBudget = getTruncationBudget(visibleLength("└─ msg ▸ "));
			const expectedTail = tailText(longStreaming, expectedBudget);
			const spy = vi.spyOn(scrambleManager, "updateMsg");

			const rendered = renderFlowResult({ content: [{ type: "text", text: longStreaming }], details }, false, makeTheme(), undefined);
			extractText(rendered);

			expect(spy).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Number), false, undefined, true);
			const actualTail = spy.mock.calls[0][1];
			expect(longStreaming.endsWith(actualTail)).toBe(true);
			expect(actualTail.length).toBeLessThanOrEqual(expectedTail.length);
			expect(spy).not.toHaveBeenCalledWith(expect.any(String), longStreaming, expect.any(Number), false, undefined, true);
			spy.mockRestore();
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
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, true, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("debug");
		expect(text).not.toContain("✔");
		expect(text).not.toContain("✖");
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
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, true, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("▲  9.8k - ---- t/s - 10.0k - mimo-v2.5-pro");
	});

	it("context tokens on separate line", () => {
		const result = makeResult({
			type: "debug",
			intent: "Trace the BigQuery 400 error",
			messages: [makeTextMessage("Found the migration config.")],
			usage: { input: 9800, output: 1300, cacheRead: 42000, cacheWrite: 0, cost: 0, contextTokens: 10000, turns: 2, toolCalls: 1 },
			model: "mimo-v2.5-pro",
		});
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, true, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("10.0k");
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
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
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
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result1, result2] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, true, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("2 flows");
		expect(text).not.toContain("✔");
		expect(text).not.toContain("✖");
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
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result1, result2] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, true, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("debug");
		expect(text).toContain("scout");
	});

	it("renders acceptance section in single expanded view", () => {
		const result = makeResult({
			type: "scout",
			intent: "Map the codebase",
			acceptance: "Done when all files found",
			messages: [makeTextMessage("Found 12 files.")],
			usage: { input: 5000, output: 800, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 6000, turns: 2, toolCalls: 1 },
		});
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, true, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("acceptance");
		expect(text).toContain("Done when all files found");
	});

	it("renders acceptance in multi expanded per-flow view", () => {
		const result1 = makeResult({ type: "debug", acceptance: "Bug fixed" });
		const result2 = makeResult({ type: "scout", acceptance: "Code mapped" });
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result1, result2] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, true, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("Bug fixed");
		expect(text).toContain("Code mapped");
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
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
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
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
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
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
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
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
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
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("batch (empty)");
	});

	it("renders bash operation as bash: <cmd> not bash bash", () => {
		const result = makeResult({
			type: "build",
			intent: "Run tests",
			messages: [
				makeToolCallMessage("batch", { o: [
					{ o: "bash", c: "npm test", p: "bash" },
				] }),
			],
			usage: emptyFlowUsage(),
		});
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("bash: npm test");
		expect(text).not.toContain("bash bash");
	});

	it("renders multiple bash operations with truncation", () => {
		const result = makeResult({
			type: "build",
			intent: "Run commands",
			messages: [
				makeToolCallMessage("batch", { o: [
					{ o: "bash", c: "npm run lint", p: "bash" },
					{ o: "bash", c: "npm run test", p: "bash" },
					{ o: "bash", c: "npm run build", p: "bash" },
					{ o: "read", p: "src/index.ts" },
				] }),
			],
			usage: emptyFlowUsage(),
		});
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("bash: npm run lint");
		expect(text).toContain("+2 more");
	});

	it("deduplicates consecutive identical operations", () => {
		const result = makeResult({
			type: "scout",
			intent: "Read files",
			messages: [
				makeToolCallMessage("batch", { o: [
					{ o: "read", p: "src/a.ts" },
					{ o: "read", p: "src/a.ts" },
					{ o: "read", p: "src/a.ts" },
					{ o: "edit", p: "src/b.ts", e: [{ f: "old", r: "new" }] },
				] }),
			],
			usage: emptyFlowUsage(),
		});
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
		const rendered = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const text = extractText(rendered);
		expect(text).toContain("read src/a.ts×3");
	});

	it("collapsed view passes empty streamingText to scrambleManager instead of falling back to stale summary", () => {
		const summary = "This is the stale summary";
		const result = makeResult({
			type: "build",
			intent: "Implement feature",
			exitCode: -1,
			structuredOutput: {
				version: "1.0",
				status: "partial",
				summary,
				files: [],
				actions: [],
				notDone: [],
				commands: [],
				nextSteps: [],
				reasoning: [],
				notes: [],
			},
		});
		const spy = vi.spyOn(scrambleManager, "updateMsg");
		const rendered = renderSingleFlowResult(result, false, makeTheme(), "");
		expect(spy).not.toHaveBeenCalled();
		extractText(rendered as any);
		expect(spy).toHaveBeenCalledWith(expect.any(String), "", expect.any(Number), false, undefined, true);
		spy.mockRestore();
	});

	it("expanded view passes empty streamingText to scrambleManager instead of falling back to stale summary", () => {
		const summary = "This is the stale summary";
		const result = makeResult({
			type: "build",
			intent: "Implement feature",
			exitCode: -1,
			structuredOutput: {
				version: "1.0",
				status: "partial",
				summary,
				files: [],
				actions: [],
				notDone: [],
				commands: [],
				nextSteps: [],
				reasoning: [],
				notes: [],
			},
		});
		const spy = vi.spyOn(scrambleManager, "updateMsg");
		const rendered = renderSingleFlowResult(result, true, makeTheme(), "");
		expect(spy).not.toHaveBeenCalled();
		extractText(rendered as any);
		expect(spy).toHaveBeenCalledWith(expect.any(String), "", expect.any(Number), false, undefined, true);
		spy.mockRestore();
	});

	it("does not leak streamingText into msg line for completed flow when structuredOutput and flowOutput are missing", () => {
		const streamingText = "Internal raw model text with JSON fragments";
		const result = makeResult({
			exitCode: 0,
			messages: [],
			structuredOutput: undefined,
		});
		const rendered = renderSingleFlowResult(result, false, makeTheme(), streamingText);
		const text = extractText(rendered);
		expect(text).not.toContain(streamingText);
		expect(text).toContain("└─ msg ▸");
	});

	it("collapsed view does not fall back to flowOutput when streamingText is empty", () => {
		const flowOutput = "flow output from messages";
		const result = makeResult({
			type: "build",
			intent: "Implement feature",
			exitCode: -1,
			messages: [makeTextMessage(flowOutput)],
		});
		const rendered = renderSingleFlowResult(result, false, makeTheme(), "");
		const text = extractText(rendered);
		expect(text).not.toContain(flowOutput);
	});
});

// ---------------------------------------------------------------------------
// In-place mutation pattern — container reuse
// ---------------------------------------------------------------------------

describe("in-place mutation pattern", () => {
	it("renderFlowResult reuses cached container via __rootContainer", () => {
		const state: Record<string, any> = {};
		const args = { flow: [{ type: "scout", intent: "test" }], state };
		const result = makeResult();
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };

		const rendered1 = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), args);
		const rendered2 = renderFlowResult({ content: [{ type: "text", text: "updated" }], details }, false, makeTheme(), args);

		expect(rendered1).toBe(rendered2);
		expect(state.__rootContainer).toBe(rendered1);
	});

	it("transfers all children during container reuse even when addChild removes from source", () => {
		// Simulate real pi-tui behavior where addChild removes the child from its old parent.
		const originalAddChild = Container.prototype.addChild;
		Container.prototype.addChild = function (child: any) {
			if (child.parent && child.parent !== this) {
				const idx = child.parent.children.indexOf(child);
				if (idx !== -1) child.parent.children.splice(idx, 1);
			}
			child.parent = this;
			this.children.push(child);
		};

		try {
			const state: Record<string, any> = {};
			const args = { flow: [{ type: "scout", intent: "test" }], state };
			const result = makeResult({
				messages: [
					makeToolCallMessage("bash", { command: "echo 1" }),
					makeTextMessage("line 1"),
					makeToolCallMessage("read", { file_path: "src/a.ts" }),
					makeTextMessage("line 2"),
				],
			});
			const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };

			const rendered1 = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), args);
			const rendered2 = renderFlowResult({ content: [{ type: "text", text: "updated" }], details }, false, makeTheme(), args);

			expect(rendered1).toBe(rendered2);
			const text = extractText(rendered2);
			// All tool calls and text lines from the new render must be present.
			expect(text).toContain("read");
			expect(text).toContain("line 2");
			// Verify all 4 children (header, aim, act, msg) were transferred to the reused root.
			expect((rendered2 as any).children.length).toBe(4);
		} finally {
			Container.prototype.addChild = originalAddChild;
		}
	});

	it("renderFlowResult works without state (backwards compatible)", () => {
		const result = makeResult();
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };

		const rendered1 = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);
		const rendered2 = renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), undefined);

		expect(rendered1).not.toBe(rendered2);
	});

	it("renderFlowCall reuses cached container via __rootContainer", () => {
		const state: Record<string, any> = {};
		const args = { flow: [{ type: "scout", intent: "test" }], state };

		const rendered1 = renderFlowCall(args, makeTheme());
		const rendered2 = renderFlowCall(args, makeTheme());

		expect(rendered1).toBe(rendered2);
		expect(state.__rootContainer).toBe(rendered1);
	});

	it("renderFlowCall works without state (backwards compatible)", () => {
		const args = { flow: [{ type: "scout", intent: "test" }] };

		const rendered1 = renderFlowCall(args, makeTheme());
		const rendered2 = renderFlowCall(args, makeTheme());

		// Without state, each call returns a new Text object
		expect(rendered1).not.toBe(rendered2);
	});

	it("generates distinct anonymous ids for separate tool calls to avoid scramble collisions", () => {
		const state1: Record<string, any> = {};
		const state2: Record<string, any> = {};

		const result1 = makeResult();
		const details1: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result1] };

		const result2 = makeResult({ type: "build", intent: "Fix bug" });
		const details2: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result2] };

		renderFlowResult({ content: [{ type: "text", text: "" }], details: details1 }, false, makeTheme(), { state: state1 });
		renderFlowResult({ content: [{ type: "text", text: "" }], details: details2 }, false, makeTheme(), { state: state2 });

		expect(state1.__flowId).toBeDefined();
		expect(state2.__flowId).toBeDefined();
		expect(state1.__flowId).not.toBe(state2.__flowId);
	});

	it("reuses the same anonymous id on subsequent renders of the same tool call", () => {
		const state: Record<string, any> = {};
		const args = { state };

		const result = makeResult();
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };

		renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), args);
		const firstId = state.__flowId;

		renderFlowResult({ content: [{ type: "text", text: "updated" }], details }, false, makeTheme(), args);
		const secondId = state.__flowId;

		expect(secondId).toBe(firstId);
	});

	it("uses args.toolCallId when result._toolCallId is absent", () => {
		const state: Record<string, any> = {};
		const args = { state, toolCallId: "call_custom_123" };

		const result = makeResult();
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };

		renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), args);

		// The resolved id is now stored in state so it stays stable across re-renders.
		expect(state.__flowId).toBe("call_custom_123");
		// Verify scramble state was created under the custom id.
		const textResult = scrambleManager.updateText("call_custom_123", "header", "test", Date.now(), true, true);
		expect(textResult.isAnimating).toBe(false);
	});

	it("uses result._toolCallId as the scramble id and stores it in state", () => {
		const state: Record<string, any> = {};
		const args = { state };
		const result = makeResult();
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };

		renderFlowResult({ content: [{ type: "text", text: "" }], details, _toolCallId: "call_prod_456" } as any, false, makeTheme(), args);

		expect(state.__flowId).toBe("call_prod_456");
		const textResult = scrambleManager.updateText("call_prod_456", "header", "test", Date.now(), true, true);
		expect(textResult.isAnimating).toBe(false);
	});

	it("uses args.id when result._toolCallId and args.toolCallId are absent", () => {
		const state: Record<string, any> = {};
		const args = { state, id: "fallback_id_999" };
		const result = makeResult();
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };

		renderFlowResult({ content: [{ type: "text", text: "" }], details }, false, makeTheme(), args);

		expect(state.__flowId).toBe("fallback_id_999");
		const textResult = scrambleManager.updateText("fallback_id_999", "header", "test", Date.now(), true, true);
		expect(textResult.isAnimating).toBe(false);
	});

	it("generates a stable anonymous id for ghost state and reuses it when results arrive", () => {
		const state: Record<string, any> = {};
		const args = { state, flow: [{ type: "scout", intent: "Ghost test", aim: "Ghost test" }] };

		// First render: no details (ghost state)
		renderFlowResult({ content: [{ type: "text", text: "Starting..." }] }, false, makeTheme(), args);
		const ghostId = state.__flowId;
		expect(ghostId).toBeDefined();
		expect(ghostId).toMatch(/^flow-\d+$/);

		// Second render: still ghost
		renderFlowResult({ content: [{ type: "text", text: "Still going..." }] }, false, makeTheme(), args);
		expect(state.__flowId).toBe(ghostId);

		// Third render: real result arrives — must keep same id to avoid scramble reset
		const result = makeResult();
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result] };
		renderFlowResult({ content: [{ type: "text", text: "Done" }], details }, false, makeTheme(), args);
		expect(state.__flowId).toBe(ghostId);
	});

	it("assigns distinct scramble ids to parallel flows in a batch", () => {
		const state: Record<string, any> = {};
		const args = { state };
		const result1 = makeResult({ type: "scout", intent: "Map code" });
		const result2 = makeResult({ type: "build", intent: "Ship fix" });
		const details: FlowDetails = { mode: "flow", flowStyle: "fork", projectAgentsDir: null, results: [result1, result2] };

		renderFlowResult({ content: [{ type: "text", text: "" }], details, _toolCallId: "call_batch_789" } as any, false, makeTheme(), args);

		// Per-flow scramble ids are baseId#0, baseId#1
		const id0Result = scrambleManager.updateText("call_batch_789#0", "header", "test", Date.now(), true, true);
		const id1Result = scrambleManager.updateText("call_batch_789#1", "header", "test", Date.now(), true, true);
		expect(id0Result.isAnimating).toBe(false);
		expect(id1Result.isAnimating).toBe(false);
	});
});
