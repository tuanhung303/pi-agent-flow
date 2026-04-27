import { describe, it, expect } from "vitest";
import {
	formatTokens,
	truncateChars,
	tailText,
	formatCompactStats,
	formatFlowUsage,
} from "../render-utils.js";

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
// formatCompactStats
// ---------------------------------------------------------------------------

describe("formatCompactStats", () => {
	it("full usage → correct format with placeholders", () => {
		const usage = { input: 2000, output: 500, cacheRead: 30000, contextTokens: 21000 };
		const result = formatCompactStats(usage, "K2.6");
		expect(result).toBe("↑2.0k ↓500 cr:30k ctx:21k K2.6");
	});

	it("minimal usage → shows 0 for output", () => {
		const usage = { input: 100 };
		const result = formatCompactStats(usage);
		expect(result).toBe("↑100 ↓0");
	});

	it("no usage → shows 0 placeholders", () => {
		expect(formatCompactStats({})).toBe("↑0 ↓0");
	});

	it("only model → placeholders + model", () => {
		expect(formatCompactStats({}, "gpt-4o")).toBe("↑0 ↓0 gpt-4o");
	});

	it("tokens only → no separator", () => {
		const usage = { input: 5000, output: 1000 };
		expect(formatCompactStats(usage)).toBe("↑5.0k ↓1.0k");
	});

	it("cache + context → lowercase cr, no separator", () => {
		const usage = { cacheRead: 8000, contextTokens: 6000 };
		expect(formatCompactStats(usage)).toBe("↑0 ↓0 cr:8.0k ctx:6.0k");
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
		expect(result).toBe("5 calls 3 turns ↑12k ↓800 CR:50k ctx:20k K2.6");
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
