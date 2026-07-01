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

	it("does not fail over on generic invalid tool errors", () => {
		const result = makeResult({
			exitCode: 1,
			stderr: "invalid tool definition in manifest",
		});

		expect(shouldFailover(result)).toBe(false);
	});

	it("does not fail over on benign text without a 404 token or type marker", () => {
		// The negative-space guarantee: if stderr mentions a non-404 error
		// (here, 503) but does not contain 404 / resource_not_found_error /
		// the English phrase, the failover branch must not trigger.
		const result = makeResult({
			stopReason: "error",
			stderr: "Upstream returned HTTP 503 for /v1/chat/completions",
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

	it("does fail over on a bare 404 token when stderr also has a provider API path", () => {
		// Bedrock-style proxy footers emit "HTTP 404" without the canonical
		// English phrase. The /v1/... path makes the stderr look like a
		// provider/API context, so this branch must trigger failover.
		// (Bare 404 with no API/envelope/type/phrase context must NOT trigger —
		// see the next test.)
		const result = makeResult({
			stopReason: "error",
			stderr: "Upstream returned HTTP 404 for /v1/chat/completions",
		});

		expect(shouldFailover(result)).toBe(true);
	});

	it("does not fail over on bare 404 in tool output (no provider/API context)", () => {
		// Regression guard: a child tool that fetched a missing URL prints
		// "HTTP 404 while checking a website" to stderr. There is no API path,
		// no resource_not_found_error type, no English phrase — this is just
		// tool output noise and must not cause model failover.
		const result = makeResult({
			stopReason: "error",
			stderr: "tool output mentioned HTTP 404 while checking a website",
		});

		expect(shouldFailover(result)).toBe(false);
	});

	it("does fail over on the JSON envelope even without an explicit 404 digit", () => {
		// Some providers serialize the error envelope but never print a literal
		// 404 digit. The original 025f090 regex shape must trigger failover.
		const result = makeResult({
			stopReason: "error",
			stderr: 'API error: {"type":"resource_not_found_error","message":"model X not found"}',
		});

		expect(shouldFailover(result)).toBe(true);
	});

	it("does fail over on the bare machine type marker alone", () => {
		// Provider logs that print just the type without a JSON envelope or 404.
		const result = makeResult({
			stopReason: "error",
			stderr: "provider returned resource_not_found_error for missing model id",
		});

		expect(shouldFailover(result)).toBe(true);
	});

	it("does not fail over when flow is complete even if 404 token is present", () => {
		// sawAgentEnd + assistant text → isFlowComplete. 404 text here is just
		// incidental output and must not cause the wrapper to loop.
		const result = makeResult({
			stopReason: "end_turn",
			sawAgentEnd: true,
			messages: [{ role: "assistant", content: [{ type: "text", text: "404 means not found" }] }],
			stderr: "GET / -> 404 The requested resource was not found.",
		});

		expect(shouldFailover(result)).toBe(false);
	});
});
