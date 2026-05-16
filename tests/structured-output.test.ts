import { describe, expect, it } from "vitest";
import type { Message } from "@mariozechner/pi-ai";
import { extractStructuredOutput, generateCommandsFromHistory } from "../src/snapshot/structured-output.js";
import type { FlowStructuredOutput } from "../src/types/output.js";

describe("extractStructuredOutput", () => {
	it("returns undefined for empty text", () => {
		expect(extractStructuredOutput("")).toBeUndefined();
		expect(extractStructuredOutput("   ")).toBeUndefined();
	});

	it("extracts valid structured output from a JSON code block", () => {
		const text = `
Some response text here.

\`\`\`json
{
  "version": "1.0",
  "status": "complete",
  "summary": "Did the thing."
}
\`\`\`
`;
		const result = extractStructuredOutput(text);
		expect(result).toBeDefined();
		expect(result!.version).toBe("1.0");
		expect(result!.status).toBe("complete");
		expect(result!.summary).toBe("Did the thing.");
	});

	it("ignores non-JSON code blocks", () => {
		const text = `
\`\`\`bash
echo hello
\`\`\`

\`\`\`json
{
  "version": "1.0",
  "status": "partial",
  "summary": "Half done."
}
\`\`\`
`;
		const result = extractStructuredOutput(text);
		expect(result!.status).toBe("partial");
	});

	it("uses the last JSON block when multiple are present", () => {
		const text = `
\`\`\`json
{"version":"1.0","status":"complete","summary":"First"}
\`\`\`

\`\`\`json
{"version":"1.0","status":"blocked","summary":"Second"}
\`\`\`
`;
		const result = extractStructuredOutput(text);
		expect(result!.status).toBe("blocked");
		expect(result!.summary).toBe("Second");
	});

	it("returns undefined for invalid JSON inside the block", () => {
		const text = `
\`\`\`json
not json at all
\`\`\`
`;
		expect(extractStructuredOutput(text)).toBeUndefined();
	});

	it("returns undefined when required fields are missing", () => {
		const text = `
\`\`\`json
{"version":"1.0","status":"complete"}
\`\`\`
`;
		expect(extractStructuredOutput(text)).toBeUndefined();
	});

	it("returns undefined for an invalid status value", () => {
		const text = `
\`\`\`json
{"version":"1.0","status":"unknown","summary":"Bad status."}
\`\`\`
`;
		expect(extractStructuredOutput(text)).toBeUndefined();
	});

	it("normalizes omitted arrays to empty arrays", () => {
		const text = `
\`\`\`json
{"version":"1.0","status":"complete","summary":"Minimal."}
\`\`\`
`;
		const result = extractStructuredOutput(text);
		expect(result!.files).toEqual([]);
		expect(result!.actions).toEqual([]);
		expect(result!.commands).toEqual([]);
		expect(result!.notDone).toEqual([]);
		expect(result!.nextSteps).toEqual([]);
		expect(result!.reasoning).toEqual([]);
		expect(result!.notes).toEqual([]);
	});

	it("trims string fields", () => {
		const text = `
\`\`\`json
{"version":"  1.0  ","status":"complete","summary":"  Trim me  "}
\`\`\`
`;
		const result = extractStructuredOutput(text);
		expect(result!.version).toBe("1.0");
		expect(result!.summary).toBe("Trim me");
	});

	it("parses extensions when present", () => {
		const text = `
\`\`\`json
{"version":"1.0","status":"complete","summary":"With extensions.","extensions":{"foo":"bar"}}
\`\`\`
`;
		const result = extractStructuredOutput(text);
		expect(result!.extensions).toEqual({ foo: "bar" });
	});

	it("returns undefined when the JSON block is missing", () => {
		const text = "Just some plain text without any code blocks.";
		expect(extractStructuredOutput(text)).toBeUndefined();
	});

	it("returns undefined when the fence label is not exactly 'json'", () => {
		const text = `
\`\`\`json5
{"version":"1.0","status":"complete","summary":"Wrong fence."}
\`\`\`
`;
		expect(extractStructuredOutput(text)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// generateCommandsFromHistory
// ---------------------------------------------------------------------------

describe("generateCommandsFromHistory", () => {
	function makeAssistantMessage(toolCalls: Array<{ name: string; args: Record<string, unknown>; toolCallId?: string }>): Message {
		return {
			role: "assistant",
			content: toolCalls.map((tc) => ({
				type: "toolCall" as const,
				name: tc.name,
				arguments: tc.args,
				...(tc.toolCallId ? { toolCallId: tc.toolCallId } : {}),
			})),
		} as unknown as Message;
	}

	function makeToolResultMessage(toolCallId: string, text: string): Message {
		return {
			role: "toolResult",
			toolCallId,
			content: [{ type: "text", text }],
		} as unknown as Message;
	}

	it("returns empty array when no bash commands exist in messages", () => {
		expect(generateCommandsFromHistory([])).toEqual([]);
		expect(generateCommandsFromHistory([makeAssistantMessage([{ name: "grep", args: { pattern: "foo" } }])])).toEqual([]);
	});

	it("extracts standalone bash command", () => {
		const messages: Message[] = [
			makeAssistantMessage([{ name: "bash", args: { command: "npm test" } }]),
		];
		const result = generateCommandsFromHistory(messages);
		expect(result).toHaveLength(1);
		expect(result[0].command).toBe("npm test");
		expect(result[0].tool).toBe("bash");
		expect(result[0].executionTime).toBeUndefined();
	});

	it("extracts standalone bash command with executionTime", () => {
		const messages: Message[] = [
			makeAssistantMessage([{ name: "bash", args: { command: "npm test" }, toolCallId: "tc_1" }]),
			makeToolResultMessage("tc_1", "some output\n\n[Execution time: 3.5s (normal)]"),
		];
		const result = generateCommandsFromHistory(messages);
		expect(result).toHaveLength(1);
		expect(result[0].command).toBe("npm test");
		expect(result[0].executionTime).toBe("3.5s (normal)");
	});

	it("extracts multiple standalone bash commands in order", () => {
		const messages: Message[] = [
			makeAssistantMessage([
				{ name: "bash", args: { command: "echo 1" }, toolCallId: "tc_1" },
				{ name: "bash", args: { command: "echo 2" }, toolCallId: "tc_2" },
			]),
			makeToolResultMessage("tc_1", "out1\n\n[Execution time: 1.0s (normal)]"),
			makeToolResultMessage("tc_2", "out2\n\n[Execution time: 2.0s (slow)]"),
		];
		const result = generateCommandsFromHistory(messages);
		expect(result).toHaveLength(2);
		expect(result[0].command).toBe("echo 1");
		expect(result[0].executionTime).toBe("1.0s (normal)");
		expect(result[1].command).toBe("echo 2");
		expect(result[1].executionTime).toBe("2.0s (slow)");
	});

	it("extracts bash commands nested inside batch operations with timing", () => {
		const messages: Message[] = [
			makeAssistantMessage([
				{
					name: "batch",
					args: {
						o: [
							{ o: "bash", command: "echo 'step 1'", i: "b1" },
							{ o: "read", p: "file.txt" },
							{ o: "bash", command: "echo 'step 2'", i: "b2" },
						],
					},
					toolCallId: "tc_batch",
				},
			]),
			makeToolResultMessage("tc_batch", "--- bash [b1] exit 0 ---\n[Execution time: 0.5s (normal)]\nstep 1\n--- bash [b2] exit 0 ---\n[Execution time: 0.3s (normal)]\nstep 2"),
		];
		const result = generateCommandsFromHistory(messages);
		expect(result).toHaveLength(2);
		expect(result[0].command).toBe("echo 'step 1'");
		expect(result[0].executionTime).toBe("0.5s (normal)");
		expect(result[1].command).toBe("echo 'step 2'");
		expect(result[1].executionTime).toBe("0.3s (normal)");
	});

	it("defers pending batch bash ops to batch_bash_poll", () => {
		const messages: Message[] = [
			makeAssistantMessage([
				{
					name: "batch",
					args: {
						o: [
							{ o: "bash", command: "echo 'step 1'", i: "b1" },
						],
					},
					toolCallId: "tc_batch",
				},
			]),
			// b1 is pending — no [Execution time] marker
			makeToolResultMessage("tc_batch", "--- bash [b1] pending ---\n[partial output]\nrunning..."),
		];
		const result = generateCommandsFromHistory(messages);
		// Pending ops are deferred — no entry emitted until poll
		expect(result).toHaveLength(0);
	});

	it("emits deferred pending batch bash via batch_bash_poll with timing", () => {
		const messages: Message[] = [
			// Batch call: b1 pending, b2 completed
			makeAssistantMessage([
				{
					name: "batch",
					args: {
						o: [
							{ o: "bash", command: "long-running-cmd", i: "b1" },
							{ o: "bash", command: "quick-cmd", i: "b2" },
						],
					},
					toolCallId: "tc_batch",
				},
			]),
			makeToolResultMessage("tc_batch", "--- bash [b1] pending ---\n[partial output]\nrunning...\n--- bash [b2] exit 0 ---\n[Execution time: 0.3s (normal)]\ndone"),
			// Poll for b1
			makeAssistantMessage([
				{
					name: "batch_bash_poll",
					args: { i: ["b1"] },
					toolCallId: "tc_poll",
				},
			]),
			makeToolResultMessage("tc_poll", "--- [b1] exit 0 ---\n[Execution time: 15.2s (slow)]\nfull output here"),
		];
		const result = generateCommandsFromHistory(messages);
		expect(result).toHaveLength(2);
		// b2 was completed in batch — emitted first
		expect(result[0].command).toBe("quick-cmd");
		expect(result[0].executionTime).toBe("0.3s (normal)");
		// b1 was deferred, then completed via poll — emitted second with timing
		expect(result[1].command).toBe("long-running-cmd");
		expect(result[1].executionTime).toBe("15.2s (slow)");
	});

	it("deduplicates: poll does not re-emit batch ops already emitted with timing", () => {
		const messages: Message[] = [
			makeAssistantMessage([
				{
					name: "batch",
					args: {
						o: [
							{ o: "bash", command: "quick-cmd", i: "b1" },
						],
					},
					toolCallId: "tc_batch",
				},
			]),
			// b1 completed in batch with timing
			makeToolResultMessage("tc_batch", "--- bash [b1] exit 0 ---\n[Execution time: 0.3s (normal)]\ndone"),
			// Unnecessary poll for same ID
			makeAssistantMessage([
				{
					name: "batch_bash_poll",
					args: { i: ["b1"] },
					toolCallId: "tc_poll",
				},
			]),
			makeToolResultMessage("tc_poll", "--- [b1] exit 0 ---\n[Execution time: 0.3s (normal)]\ndone"),
		];
		const result = generateCommandsFromHistory(messages);
		expect(result).toHaveLength(1);
		expect(result[0].command).toBe("quick-cmd");
		expect(result[0].executionTime).toBe("0.3s (normal)");
	});

	it("deduplicates: multiple polls for same ID only emit once", () => {
		const messages: Message[] = [
			makeAssistantMessage([
				{
					name: "batch",
					args: {
						o: [
							{ o: "bash", command: "slow-cmd", i: "b1" },
						],
					},
					toolCallId: "tc_batch",
				},
			]),
			makeToolResultMessage("tc_batch", "--- bash [b1] pending ---\n[partial output]\nrunning..."),
			// First poll: still pending
			makeAssistantMessage([
				{
					name: "batch_bash_poll",
					args: { i: ["b1"] },
					toolCallId: "tc_poll1",
				},
			]),
			makeToolResultMessage("tc_poll1", "--- [b1] still running ---\n[output so far]\npartial..."),
			// Second poll: completed
			makeAssistantMessage([
				{
					name: "batch_bash_poll",
					args: { i: ["b1"] },
					toolCallId: "tc_poll2",
				},
			]),
			makeToolResultMessage("tc_poll2", "--- [b1] exit 0 ---\n[Execution time: 30.0s (very long) — user feedback: consider to improve, only run when everything tested with other means]\nfull output"),
		];
		const result = generateCommandsFromHistory(messages);
		expect(result).toHaveLength(1);
		expect(result[0].command).toBe("slow-cmd");
		expect(result[0].executionTime).toBe("30.0s (very long) — user feedback: consider to improve, only run when everything tested with other means");
	});

	it("skips poll IDs that were never in a batch call", () => {
		const messages: Message[] = [
			makeAssistantMessage([
				{
					name: "batch_bash_poll",
					args: { i: ["unknown_id"] },
					toolCallId: "tc_poll",
				},
			]),
			makeToolResultMessage("tc_poll", "--- [unknown_id] exit 0 ---\n[Execution time: 0.1s (normal)]\ndone"),
		];
		const result = generateCommandsFromHistory(messages);
		expect(result).toEqual([]);
	});

	it("handles mixed tool calls (bash + batch + poll)", () => {
		const messages: Message[] = [
			makeAssistantMessage([
				{ name: "bash", args: { command: "standalone cmd" }, toolCallId: "tc_1" },
			]),
			makeToolResultMessage("tc_1", "output\n\n[Execution time: 1.0s (normal)]"),
			makeAssistantMessage([
				{
					name: "batch",
					args: {
						o: [
							{ o: "bash", command: "batch cmd 1", i: "b1" },
							{ o: "edit", p: "file.ts" },
							{ o: "bash", command: "batch cmd 2", i: "b2" },
						],
					},
					toolCallId: "tc_batch",
				},
			]),
			makeToolResultMessage("tc_batch", "--- bash [b1] exit 0 ---\n[Execution time: 0.5s (normal)]\nout1\n--- bash [b2] exit 0 ---\n[Execution time: 0.8s (normal)]\nout2"),
		];
		const result = generateCommandsFromHistory(messages);
		expect(result).toHaveLength(3);
		expect(result[0].command).toBe("standalone cmd");
		expect(result[0].executionTime).toBe("1.0s (normal)");
		expect(result[1].command).toBe("batch cmd 1");
		expect(result[1].executionTime).toBe("0.5s (normal)");
		expect(result[2].command).toBe("batch cmd 2");
		expect(result[2].executionTime).toBe("0.8s (normal)");
	});

	it("ignores non-bash tool calls", () => {
		const messages: Message[] = [
			makeAssistantMessage([
				{ name: "grep", args: { pattern: "foo", path: "." } },
				{ name: "find", args: { pattern: "*.ts", path: "src" } },
				{ name: "ls", args: { path: "." } },
			]),
		];
		const result = generateCommandsFromHistory(messages);
		expect(result).toEqual([]);
	});

	it("skips bash commands with empty command string", () => {
		const messages: Message[] = [
			makeAssistantMessage([
				{ name: "bash", args: { command: "" } },
				{ name: "bash", args: { command: "echo hi" } },
			]),
		];
		const result = generateCommandsFromHistory(messages);
		expect(result).toHaveLength(1);
		expect(result[0].command).toBe("echo hi");
	});
});
