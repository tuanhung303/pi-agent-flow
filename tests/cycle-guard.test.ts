import { describe, expect, it } from "vitest";
import { shouldFailover } from "../src/flow/cycle-guard.js";
import { emptyFlowUsage, type SingleResult } from "../src/types/flow.js";

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		type: "build",
		agentSource: "bundled",
		intent: "test",
		aim: "test",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyFlowUsage(),
		...overrides,
	};
}

describe("shouldFailover", () => {
	it("fails over on provider resource-not-found errors even with exit code 0", () => {
		const result = makeResult({
			stopReason: "error",
			errorMessage: '404 {"error":{"message":"The requested resource was not found","type":"resource_not_found_error"}}}',
		});

		expect(shouldFailover(result)).toBe(true);
	});

	it("fails over on known Kimi tool_call_id 400 errors", () => {
		const result = makeResult({
			stopReason: "error",
			errorMessage: "400 invalid tool_call_id is not found",
		});

		expect(shouldFailover(result)).toBe(true);
	});

	it("does not fail over on arbitrary 404 text", () => {
		const result = makeResult({
			stopReason: "error",
			stderr: "tool output mentioned HTTP 404 while checking a website",
		});

		expect(shouldFailover(result)).toBe(false);
	});

	it("does not fail over on bad settings", () => {
		const result = makeResult({
			exitCode: 1,
			stderr: "Bad settings: all configured flow models are invalid.",
		});

		expect(shouldFailover(result)).toBe(false);
	});

	it("does not fail over on benign 'requested resource was not found' text without a 404 token", () => {
		const result = makeResult({
			stopReason: "error",
			stderr:
				"The user said the requested resource was not found in our internal docs.",
		});

		expect(shouldFailover(result)).toBe(false);
	});

	it("does not fail over on bare English phrase even with 200 OK response", () => {
		const result = makeResult({
			stopReason: "error",
			stderr:
				"GET /api/notes -> 200 OK (The requested resource was not found on this server)",
		});

		expect(shouldFailover(result)).toBe(false);
	});

	it("does fail over on English phrase paired with an explicit 404 token", () => {
		const result = makeResult({
			stopReason: "error",
			stderr:
				"GET /v1/models/missing -> 404 The requested resource was not found.",
		});

		expect(shouldFailover(result)).toBe(true);
	});
});
