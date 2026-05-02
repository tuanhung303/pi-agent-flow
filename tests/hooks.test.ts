import { describe, it, expect, beforeEach } from "vitest";
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

describe("hook registry", () => {
	beforeEach(() => {
		clearHooks();
	});

	it("registerHook adds a hook", () => {
		registerHook({
			name: "test/hook",
			trigger: { flowTypes: ["build"] },
			action: () => ({ content: "advice", priority: 0 }),
		});

		const results = [makeResult({ type: "build" })];
		const advisors = runHooks([{ type: "build", intent: "fix" }], results);
		expect(advisors).toEqual(["advice"]);
	});

	it("registerHook replaces a hook with the same name", () => {
		registerHook({
			name: "test/hook",
			trigger: { flowTypes: ["build"] },
			action: () => ({ content: "first", priority: 0 }),
		});
		registerHook({
			name: "test/hook",
			trigger: { flowTypes: ["build"] },
			action: () => ({ content: "second", priority: 0 }),
		});

		const results = [makeResult({ type: "build" })];
		const advisors = runHooks([{ type: "build", intent: "fix" }], results);
		expect(advisors).toEqual(["second"]);
	});

	it("clearHooks removes all hooks", () => {
		registerHook({
			name: "test/hook",
			trigger: { flowTypes: ["build"] },
			action: () => ({ content: "advice", priority: 0 }),
		});
		clearHooks();

		const results = [makeResult({ type: "build" })];
		const advisors = runHooks([{ type: "build", intent: "fix" }], results);
		expect(advisors).toEqual([]);
	});
});

describe("runHooks", () => {
	beforeEach(() => {
		clearHooks();
	});

	it("returns empty when no hooks match", () => {
		registerHook({
			name: "test/code-hook",
			trigger: { flowTypes: ["build"] },
			action: () => ({ content: "advice", priority: 0 }),
		});

		const results = [makeResult({ type: "explore" })];
		const advisors = runHooks([{ type: "explore", intent: "find" }], results);
		expect(advisors).toEqual([]);
	});

	it("matches flow types case-insensitively", () => {
		registerHook({
			name: "test/hook",
			trigger: { flowTypes: ["BUILD"] },
			action: () => ({ content: "matched", priority: 0 }),
		});

		const results = [makeResult({ type: "build" })];
		const advisors = runHooks([{ type: "build", intent: "fix" }], results);
		expect(advisors).toEqual(["matched"]);
	});

	it("skips hook when result is not successful (onlyOnSuccess=true)", () => {
		registerHook({
			name: "test/hook",
			trigger: { flowTypes: ["build"], onlyOnSuccess: true },
			action: () => ({ content: "advice", priority: 0 }),
		});

		// exitCode 1 without sawAgentEnd = error
		const results = [makeResult({ type: "build", exitCode: 1, sawAgentEnd: false })];
		const advisors = runHooks([{ type: "build", intent: "fix" }], results);
		expect(advisors).toEqual([]);
	});

	it("fires hook when result is successful (onlyOnSuccess=true)", () => {
		registerHook({
			name: "test/hook",
			trigger: { flowTypes: ["build"], onlyOnSuccess: true },
			action: () => ({ content: "advice", priority: 0 }),
		});

		const results = [makeResult({ type: "build", exitCode: 0, sawAgentEnd: true })];
		const advisors = runHooks([{ type: "build", intent: "fix" }], results);
		expect(advisors).toEqual(["advice"]);
	});

	it("fires hook regardless of success when onlyOnSuccess=false", () => {
		registerHook({
			name: "test/hook",
			trigger: { flowTypes: ["build"], onlyOnSuccess: false },
			action: () => ({ content: "always", priority: 0 }),
		});

		const results = [makeResult({ type: "build", exitCode: 1, sawAgentEnd: false })];
		const advisors = runHooks([{ type: "build", intent: "fix" }], results);
		expect(advisors).toEqual(["always"]);
	});

	it("defaults onlyOnSuccess to true", () => {
		registerHook({
			name: "test/hook",
			trigger: { flowTypes: ["build"] }, // no onlyOnSuccess specified
			action: () => ({ content: "advice", priority: 0 }),
		});

		// Failed result should not trigger
		const failed = [makeResult({ type: "build", exitCode: 1, sawAgentEnd: false })];
		expect(runHooks([{ type: "build", intent: "fix" }], failed)).toEqual([]);

		// Successful result should trigger
		const success = [makeResult({ type: "build", exitCode: 0, sawAgentEnd: true })];
		expect(runHooks([{ type: "build", intent: "fix" }], success)).toEqual(["advice"]);
	});

	it("sorts advisors by priority", () => {
		registerHook({
			name: "test/low",
			trigger: { flowTypes: ["build"] },
			action: () => ({ content: "low", priority: 5 }),
		});
		registerHook({
			name: "test/high",
			trigger: { flowTypes: ["build"] },
			action: () => ({ content: "high", priority: 20 }),
		});
		registerHook({
			name: "test/zero",
			trigger: { flowTypes: ["build"] },
			action: () => ({ content: "zero", priority: 0 }),
		});

		const results = [makeResult({ type: "build" })];
		const advisors = runHooks([{ type: "build", intent: "fix" }], results);
		expect(advisors).toEqual(["zero", "low", "high"]);
	});

	it("skips when hook action returns null", () => {
		registerHook({
			name: "test/skip",
			trigger: { flowTypes: ["build"] },
			action: () => null,
		});

		const results = [makeResult({ type: "build" })];
		const advisors = runHooks([{ type: "build", intent: "fix" }], results);
		expect(advisors).toEqual([]);
	});

	it("skips when no results match trigger flowTypes", () => {
		registerHook({
			name: "test/hook",
			trigger: { flowTypes: ["build"] },
			action: () => ({ content: "advice", priority: 0 }),
		});

		const results = [makeResult({ type: "explore" })];
		const advisors = runHooks([{ type: "explore", intent: "find" }], results);
		expect(advisors).toEqual([]);
	});

	it("returns empty when no hooks are registered", () => {
		const results = [makeResult({ type: "build" })];
		const advisors = runHooks([{ type: "build", intent: "fix" }], results);
		expect(advisors).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Built-in hooks
// ---------------------------------------------------------------------------

// Re-register built-in hooks after clearHooks in beforeEach
// by importing the module fresh. Since clearHooks is called in beforeEach,
// the built-in hooks are removed. We need to re-import.
// Solution: don't clear in this describe; use a separate approach.

describe("built-in code-to-review hook", () => {
	beforeEach(() => {
		clearHooks();
	});

	it("suggests audit after successful build flow", () => {
		// Manually register the built-in hook
		registerHook({
			name: "pi-agent-flow/build-to-audit",
			trigger: { flowTypes: ["build"], onlyOnSuccess: true },
			action: (ctx) => {
				const reviewWasRequested = ctx.params.some(
					(p) => p.type.toLowerCase() === "audit",
				);
				if (reviewWasRequested) return null;
				return {
					content: "Consider running a [audit] flow to audit the changes for security, correctness, and code quality.",
					priority: 10,
				};
			},
		});

		const results = [makeResult({ type: "build" })];
		const advisors = runHooks([{ type: "build", intent: "implement feature" }], results);
		expect(advisors).toHaveLength(1);
		expect(advisors[0]).toContain("[audit]");
	});

	it("suppresses when audit was already in the batch", () => {
		registerHook({
			name: "pi-agent-flow/build-to-audit",
			trigger: { flowTypes: ["build"], onlyOnSuccess: true },
			action: (ctx) => {
				const reviewWasRequested = ctx.params.some(
					(p) => p.type.toLowerCase() === "audit",
				);
				if (reviewWasRequested) return null;
				return {
					content: "Consider running a [audit] flow.",
					priority: 10,
				};
			},
		});

		const results = [makeResult({ type: "build" })];
		const params = [
			{ type: "build", intent: "implement" },
			{ type: "audit", intent: "audit" },
		];
		const advisors = runHooks(params, results);
		expect(advisors).toEqual([]);
	});

	it("does not fire on failed code flow", () => {
		registerHook({
			name: "pi-agent-flow/build-to-audit",
			trigger: { flowTypes: ["build"], onlyOnSuccess: true },
			action: (ctx) => {
				const reviewWasRequested = ctx.params.some(
					(p) => p.type.toLowerCase() === "audit",
				);
				if (reviewWasRequested) return null;
				return {
					content: "Consider running a [audit] flow.",
					priority: 10,
				};
			},
		});

		const results = [makeResult({ type: "build", exitCode: 1, sawAgentEnd: false })];
		const advisors = runHooks([{ type: "build", intent: "implement" }], results);
		expect(advisors).toEqual([]);
	});
});

describe("built-in debug-to-code hook", () => {
	beforeEach(() => {
		clearHooks();
	});

	it("suggests build after successful debug flow", () => {
		registerHook({
			name: "pi-agent-flow/debug-to-build",
			trigger: { flowTypes: ["debug"], onlyOnSuccess: true },
			action: (ctx) => {
				const codeWasRequested = ctx.params.some(
					(p) => p.type.toLowerCase() === "build",
				);
				if (codeWasRequested) return null;
				return {
					content: "The root cause has been identified. Consider running a [build] flow to implement the fix.",
					priority: 10,
				};
			},
		});

		const results = [makeResult({ type: "debug" })];
		const advisors = runHooks([{ type: "debug", intent: "find bug" }], results);
		expect(advisors).toHaveLength(1);
		expect(advisors[0]).toContain("[build]");
		expect(advisors[0]).toContain("root cause");
	});

	it("suppresses when build was already in the batch", () => {
		registerHook({
			name: "pi-agent-flow/debug-to-build",
			trigger: { flowTypes: ["debug"], onlyOnSuccess: true },
			action: (ctx) => {
				const codeWasRequested = ctx.params.some(
					(p) => p.type.toLowerCase() === "build",
				);
				if (codeWasRequested) return null;
				return {
					content: "Consider running a [build] flow.",
					priority: 10,
				};
			},
		});

		const results = [makeResult({ type: "debug" })];
		const params = [
			{ type: "debug", intent: "find bug" },
			{ type: "build", intent: "fix it" },
		];
		const advisors = runHooks(params, results);
		expect(advisors).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Integration test: both built-in hooks active simultaneously
// ---------------------------------------------------------------------------

describe("multiple hooks active", () => {
	beforeEach(() => {
		clearHooks();
	});

	it("fires both build→audit and debug→build when both flows succeed independently", () => {
		// Register both hooks
		registerHook({
			name: "pi-agent-flow/build-to-audit",
			trigger: { flowTypes: ["build"], onlyOnSuccess: true },
			action: (ctx) => {
				if (ctx.params.some((p) => p.type.toLowerCase() === "audit")) return null;
				return { content: "review advice", priority: 10 };
			},
		});
		registerHook({
			name: "pi-agent-flow/debug-to-build",
			trigger: { flowTypes: ["debug"], onlyOnSuccess: true },
			action: (ctx) => {
				if (ctx.params.some((p) => p.type.toLowerCase() === "build")) return null;
				return { content: "code advice", priority: 5 };
			},
		});

		// Only a code flow in this batch (debug-to-code won't trigger since no debug result)
		const results = [makeResult({ type: "build" })];
		const params = [{ type: "build", intent: "implement" }];
		const advisors = runHooks(params, results);
		expect(advisors).toEqual(["review advice"]);
	});

	it("fires code-to-review but suppresses debug-to-code when code is already in batch", () => {
		registerHook({
			name: "pi-agent-flow/build-to-audit",
			trigger: { flowTypes: ["build"], onlyOnSuccess: true },
			action: (ctx) => {
				if (ctx.params.some((p) => p.type.toLowerCase() === "audit")) return null;
				return { content: "review advice", priority: 10 };
			},
		});
		registerHook({
			name: "pi-agent-flow/debug-to-build",
			trigger: { flowTypes: ["debug"], onlyOnSuccess: true },
			action: (ctx) => {
				if (ctx.params.some((p) => p.type.toLowerCase() === "build")) return null;
				return { content: "code advice", priority: 5 };
			},
		});

		const results = [
			makeResult({ type: "build" }),
			makeResult({ type: "debug" }),
		];
		const params = [
			{ type: "build", intent: "implement" },
			{ type: "debug", intent: "investigate" },
		];
		// debug-to-code: code is in params → suppressed
		// code-to-review: review is NOT in params → fires
		const advisors = runHooks(params, results);
		expect(advisors).toEqual(["review advice"]);
	});

	it("suppresses both hooks when targets already in batch", () => {
		registerHook({
			name: "pi-agent-flow/build-to-audit",
			trigger: { flowTypes: ["build"], onlyOnSuccess: true },
			action: (ctx) => {
				if (ctx.params.some((p) => p.type.toLowerCase() === "audit")) return null;
				return { content: "review advice", priority: 10 };
			},
		});
		registerHook({
			name: "pi-agent-flow/debug-to-build",
			trigger: { flowTypes: ["debug"], onlyOnSuccess: true },
			action: (ctx) => {
				if (ctx.params.some((p) => p.type.toLowerCase() === "build")) return null;
				return { content: "code advice", priority: 5 };
			},
		});

		const results = [
			makeResult({ type: "build" }),
			makeResult({ type: "debug" }),
		];
		const params = [
			{ type: "build", intent: "implement" },
			{ type: "debug", intent: "investigate" },
			{ type: "audit", intent: "audit" },
		];
		// debug-to-code: code is in batch → suppressed
		// code-to-review: review is in batch → suppressed
		const advisors = runHooks(params, results);
		expect(advisors).toEqual([]);
	});
});

describe("built-in audit-to-scout hook", () => {
	beforeEach(() => {
		clearHooks();
	});

	it("suggests scout after successful audit flow", () => {
		registerHook({
			name: "pi-agent-flow/audit-to-scout",
			trigger: { flowTypes: ["audit"], onlyOnSuccess: true },
			action: (ctx) => {
				const scoutWasRequested = ctx.params.some(
					(p) => p.type.toLowerCase() === "scout",
				);
				if (scoutWasRequested) return null;
				return {
					content:
						"Audit complete. Consider running a [scout] flow to trace the audit findings across the codebase.",
					priority: 15,
				};
			},
		});

		const results = [makeResult({ type: "audit" })];
		const advisors = runHooks([{ type: "audit", intent: "audit code" }], results);
		expect(advisors).toHaveLength(1);
		expect(advisors[0]).toContain("[scout]");
		expect(advisors[0]).toContain("Audit complete");
	});

	it("suppresses when scout was already in the batch", () => {
		registerHook({
			name: "pi-agent-flow/audit-to-scout",
			trigger: { flowTypes: ["audit"], onlyOnSuccess: true },
			action: (ctx) => {
				const scoutWasRequested = ctx.params.some(
					(p) => p.type.toLowerCase() === "scout",
				);
				if (scoutWasRequested) return null;
				return {
					content:
						"Audit complete. Consider running a [scout] flow to trace the audit findings across the codebase.",
					priority: 15,
				};
			},
		});

		const results = [makeResult({ type: "audit" })];
		const params = [
			{ type: "audit", intent: "audit code" },
			{ type: "scout", intent: "review findings" },
		];
		const advisors = runHooks(params, results);
		expect(advisors).toEqual([]);
	});

	it("does not fire on failed audit flow", () => {
		registerHook({
			name: "pi-agent-flow/audit-to-scout",
			trigger: { flowTypes: ["audit"], onlyOnSuccess: true },
			action: (ctx) => {
				const scoutWasRequested = ctx.params.some(
					(p) => p.type.toLowerCase() === "scout",
				);
				if (scoutWasRequested) return null;
				return {
					content:
						"Audit complete. Consider running a [scout] flow to trace the audit findings across the codebase.",
					priority: 15,
				};
			},
		});

		const results = [makeResult({ type: "audit", exitCode: 1, sawAgentEnd: false })];
		const advisors = runHooks([{ type: "audit", intent: "audit code" }], results);
		expect(advisors).toEqual([]);
	});
});

describe("audit hooks integration", () => {
	beforeEach(() => {
		clearHooks();
	});

	it("fires audit-to-scout when audit succeeds", () => {
		registerHook({
			name: "pi-agent-flow/audit-to-scout",
			trigger: { flowTypes: ["audit"], onlyOnSuccess: true },
			action: (ctx) => {
				if (ctx.params.some((p) => p.type.toLowerCase() === "scout")) return null;
				return { content: "scout advice", priority: 15 };
			},
		});

		const results = [makeResult({ type: "audit" })];
		const params = [{ type: "audit", intent: "audit" }];
		const advisors = runHooks(params, results);
		expect(advisors).toEqual(["scout advice"]);
	});

	it("suppresses audit-to-scout when scout already in batch", () => {
		registerHook({
			name: "pi-agent-flow/audit-to-scout",
			trigger: { flowTypes: ["audit"], onlyOnSuccess: true },
			action: (ctx) => {
				if (ctx.params.some((p) => p.type.toLowerCase() === "scout")) return null;
				return { content: "scout advice", priority: 15 };
			},
		});

		const results = [makeResult({ type: "audit" })];
		const params = [
			{ type: "audit", intent: "audit" },
			{ type: "scout", intent: "review" },
		];
		const advisors = runHooks(params, results);
		expect(advisors).toEqual([]);
	});
});
