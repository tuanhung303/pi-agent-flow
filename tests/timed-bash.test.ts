import { describe, it, expect, vi, afterEach } from "vitest";
import { __resetBashToolMock, __setBashToolExecuteImpl, bashToolExecuteCalls } from "@mariozechner/pi-coding-agent";
import { classifyDuration, createTimedBashToolDefinition, formatTimingAppendix, type TimingReport } from "../src/timed-bash.js";

const FLOW_DEADLINE_ENV = "PI_FLOW_DEADLINE_MS";
const FLOW_TOOL_SUMMARY_GRACE_ENV = "PI_FLOW_TOOL_SUMMARY_GRACE_MS";

afterEach(() => {
	vi.useRealTimers();
	delete process.env[FLOW_DEADLINE_ENV];
	delete process.env[FLOW_TOOL_SUMMARY_GRACE_ENV];
	__resetBashToolMock();
});

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

describe("createTimedBashToolDefinition deadline handling", () => {
	it("aborts a running bash command before the flow deadline and asks for final summary", async () => {
		vi.useFakeTimers();
		process.env[FLOW_DEADLINE_ENV] = String(Date.now() + 1_000);
		process.env[FLOW_TOOL_SUMMARY_GRACE_ENV] = "500";

		__setBashToolExecuteImpl(async (_toolCallId, _params, signal: AbortSignal) => {
			return new Promise((resolve) => {
				if (signal.aborted) {
					resolve({ content: [{ type: "text", text: "already aborted" }] });
					return;
				}
				signal.addEventListener("abort", () => {
					resolve({ content: [{ type: "text", text: "aborted by signal" }] });
				}, { once: true });
			});
		});

		const tool = createTimedBashToolDefinition("/tmp");
		const promise = tool.execute("tc1", { command: "sleep 60" }, new AbortController().signal, undefined, {});

		await vi.advanceTimersByTimeAsync(501);
		const result = await promise;

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("aborted by signal");
		expect(result.content[0].text).toContain("[Flow timeout]");
		expect(result.content[0].text).toContain("return structured findings now");
		expect(result.content[0].text).toContain("[Execution time:");
		expect(bashToolExecuteCalls[0][2]).toBeInstanceOf(AbortSignal);
	});

	it("turns a deadline abort rejection into an error tool result for the agent", async () => {
		vi.useFakeTimers();
		process.env[FLOW_DEADLINE_ENV] = String(Date.now() + 1_000);
		process.env[FLOW_TOOL_SUMMARY_GRACE_ENV] = "500";

		__setBashToolExecuteImpl(async (_toolCallId, _params, signal: AbortSignal) => {
			return new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("command aborted")), { once: true });
			});
		});

		const tool = createTimedBashToolDefinition("/tmp");
		const promise = tool.execute("tc1", { command: "sleep 60" }, new AbortController().signal, undefined, {});

		await vi.advanceTimersByTimeAsync(501);
		const result = await promise;

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("command aborted");
		expect(result.content[0].text).toContain("[Flow timeout]");
		expect(result.content[0].text).toContain("Stop running tools");
	});
});
