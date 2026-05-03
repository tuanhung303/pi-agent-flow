import { describe, it, expect } from "vitest";
import { classifyDuration, formatTimingAppendix, type TimingReport } from "../src/timed-bash.js";

describe("classifyDuration", () => {
	it("classifies < 10s as normal", () => {
		const r = classifyDuration(5_000);
		expect(r.tier).toBe("normal");
		expect(r.seconds).toBe(5);
		expect(r.label).toBe("5.0s (normal)");
	});

	it("classifies 10-30s as avg", () => {
		const r = classifyDuration(15_000);
		expect(r.tier).toBe("avg");
		expect(r.label).toBe("15.0s (avg) — user feedback: consider improving the current commands or find a better solution");
	});

	it("classifies 30-60s as long", () => {
		const r = classifyDuration(45_000);
		expect(r.tier).toBe("long");
		expect(r.label).toContain("long");
		expect(r.label).toContain("improving the whole scripts");
	});

	it("classifies 60s-5m as extreme_long", () => {
		const r = classifyDuration(120_000);
		expect(r.tier).toBe("extreme_long");
		expect(r.label).toContain("extreme long");
		expect(r.label).toContain("should consider to improve the whole scripts");
	});

	it("classifies >= 5m as very_long", () => {
		const r = classifyDuration(600_000);
		expect(r.tier).toBe("very_long");
		expect(r.label).toContain("very long");
		expect(r.label).toContain("only run when everything tested with other means");
	});

	it("handles boundary at exactly 10s", () => {
		const r = classifyDuration(10_000);
		expect(r.tier).toBe("avg");
	});

	it("handles boundary at exactly 30s", () => {
		const r = classifyDuration(30_000);
		expect(r.tier).toBe("long");
	});

	it("handles boundary at exactly 60s", () => {
		const r = classifyDuration(60_000);
		expect(r.tier).toBe("extreme_long");
	});

	it("handles boundary at exactly 300s", () => {
		const r = classifyDuration(300_000);
		expect(r.tier).toBe("very_long");
	});
});

describe("formatTimingAppendix", () => {
	it("formats a normal report", () => {
		const r: TimingReport = { tier: "normal", seconds: 3.5, label: "3.5s (normal)" };
		expect(formatTimingAppendix(r)).toBe("\n\n[Execution time: 3.5s (normal)]");
	});
});
