import { describe, it, expect } from "vitest";
import { DEFAULT_TRANSITIONS, getTransitionAdvice, type FlowTransition } from "../src/transitions.js";
import { emptyFlowUsage, type SingleResult } from "../src/types.js";

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		type: "explore",
		agentSource: "project",
		intent: "test intent",
		exitCode: 0,
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "output" }],
			},
		],
		stderr: "",
		usage: emptyFlowUsage(),
		sawAgentEnd: true,
		...overrides,
	};
}

describe("DEFAULT_TRANSITIONS", () => {
	it("contains expected transitions", () => {
		expect(DEFAULT_TRANSITIONS.length).toBeGreaterThan(0);
		const names = DEFAULT_TRANSITIONS.map((t) => `${t.from}->${t.to}`);
		expect(names).toContain("scout->build");
		expect(names).toContain("debug->build");
		expect(names).toContain("build->audit");
		expect(names).toContain("build->debug"); // failure transition
	});

	it("has both success and failure transitions", () => {
		const successes = DEFAULT_TRANSITIONS.filter((t) => t.on === "success");
		const failures = DEFAULT_TRANSITIONS.filter((t) => t.on === "failure");
		expect(successes.length).toBeGreaterThan(0);
		expect(failures.length).toBeGreaterThan(0);
	});
});

describe("getTransitionAdvice", () => {
	it("returns advisory messages for successful flows", () => {
		const results = [makeResult({ type: "scout" })];
		const params = [{ type: "scout", intent: "explore" }];
		const advisors = getTransitionAdvice(params, results);
		expect(advisors.length).toBeGreaterThan(0);
		expect(advisors[0]).toContain("build");
	});

	it("suppresses advice when target flow is already in the batch", () => {
		const results = [makeResult({ type: "scout" })];
		const params = [
			{ type: "scout", intent: "explore" },
			{ type: "build", intent: "implement" },
		];
		const advisors = getTransitionAdvice(params, results);
		// Scout->build should be suppressed since build is in the batch
		expect(advisors.some((a) => a.includes("build"))).toBe(false);
	});

	it("fires failure transition when source flow fails", () => {
		const results = [makeResult({ type: "build", exitCode: 1, sawAgentEnd: false })];
		const params = [{ type: "build", intent: "implement" }];
		const advisors = getTransitionAdvice(params, results);
		expect(advisors.length).toBeGreaterThan(0);
		expect(advisors[0]).toContain("debug");
	});

	it("does not fire failure transition on success", () => {
		const results = [makeResult({ type: "build", exitCode: 0, sawAgentEnd: true })];
		const params = [{ type: "build", intent: "implement" }];
		const advisors = getTransitionAdvice(params, results);
		// build->debug is a failure transition, should not fire
		expect(advisors.some((a) => a.includes("debug"))).toBe(false);
	});

	it("returns empty when no transitions match", () => {
		const results = [makeResult({ type: "unknown_flow" })];
		const params = [{ type: "unknown_flow", intent: "test" }];
		const advisors = getTransitionAdvice(params, results);
		expect(advisors).toEqual([]);
	});

	it("works with custom transitions", () => {
		const custom: FlowTransition[] = [
			{ from: "scout", to: "craft", on: "success", advice: "Go craft." },
		];
		const results = [makeResult({ type: "scout" })];
		const params = [{ type: "scout", intent: "explore" }];
		const advisors = getTransitionAdvice(params, results, custom);
		expect(advisors).toEqual(["Go craft."]);
	});

	it("fires both success and failure transitions for mixed outcomes", () => {
		const results = [
			makeResult({ type: "scout" }),
			makeResult({ type: "build", exitCode: 1, sawAgentEnd: false }),
		];
		const params = [
			{ type: "scout", intent: "explore" },
			{ type: "build", intent: "implement" },
		];
		const advisors = getTransitionAdvice(params, results);
		// Scout success should give advice
		expect(advisors.some((a) => a.includes("build") || a.includes("debug"))).toBe(true);
	});

	it("suppresses all transitions for target already requested", () => {
		const results = [
			makeResult({ type: "scout" }),
			makeResult({ type: "debug", exitCode: 0, sawAgentEnd: true }),
		];
		const params = [
			{ type: "scout", intent: "explore" },
			{ type: "debug", intent: "find bug" },
			{ type: "build", intent: "implement" },
		];
		const advisors = getTransitionAdvice(params, results);
		// Both scout->build and debug->build should be suppressed
		expect(advisors.some((a) => a.includes("build"))).toBe(false);
	});
});
