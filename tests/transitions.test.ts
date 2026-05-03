import { describe, it, expect, beforeEach } from "vitest";
import { DEFAULT_TRANSITIONS, buildTransitionHooks, type FlowTransition } from "../src/transitions.js";
import { registerHook, runHooks, clearHooks } from "../src/hooks.js";
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

describe("buildTransitionHooks", () => {
	beforeEach(() => {
		clearHooks();
	});

	it("generates hooks from transition matrix", () => {
		const hooks = buildTransitionHooks(DEFAULT_TRANSITIONS);
		expect(hooks.length).toBe(DEFAULT_TRANSITIONS.length);
		for (const hook of hooks) {
			expect(hook.name).toMatch(/^pi-agent-flow\//);
			expect(hook.trigger.flowTypes).toHaveLength(1);
			expect(typeof hook.action).toBe("function");
		}
	});

	it("fires success transition hook when target not requested", () => {
		const hooks = buildTransitionHooks([
			{ from: "scout", to: "build", on: "success", advice: "Go build." },
		]);
		registerHook(hooks[0]);

		const results = [makeResult({ type: "scout" })];
		const advisors = runHooks([{ type: "scout", intent: "explore" }], results);
		expect(advisors).toEqual(["Go build."]);
	});

	it("suppresses when target already requested", () => {
		const hooks = buildTransitionHooks([
			{ from: "scout", to: "build", on: "success", advice: "Go build." },
		]);
		registerHook(hooks[0]);

		const results = [makeResult({ type: "scout" })];
		const params = [
			{ type: "scout", intent: "explore" },
			{ type: "build", intent: "implement" },
		];
		const advisors = runHooks(params, results);
		expect(advisors).toEqual([]);
	});

	it("fires failure transition hook when source flow fails", () => {
		const hooks = buildTransitionHooks([
			{ from: "build", to: "debug", on: "failure", advice: "Build failed. Debug it." },
		]);
		// Failure hooks have onlyOnSuccess: false, so we need to check that
		registerHook(hooks[0]);

		const results = [makeResult({ type: "build", exitCode: 1, sawAgentEnd: false })];
		const advisors = runHooks([{ type: "build", intent: "implement" }], results);
		expect(advisors).toEqual(["Build failed. Debug it."]);
	});

	it("does not fire failure hook on success", () => {
		const hooks = buildTransitionHooks([
			{ from: "build", to: "debug", on: "failure", advice: "Build failed." },
		]);
		registerHook(hooks[0]);

		const results = [makeResult({ type: "build", exitCode: 0, sawAgentEnd: true })];
		const advisors = runHooks([{ type: "build", intent: "implement" }], results);
		expect(advisors).toEqual([]);
	});

	it("generates unique hook names per transition", () => {
		const hooks = buildTransitionHooks(DEFAULT_TRANSITIONS);
		const names = hooks.map((h) => h.name);
		expect(new Set(names).size).toBe(names.length);
	});
});
