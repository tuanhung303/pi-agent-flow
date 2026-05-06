import { describe, expect, it } from "vitest";
import type { Message } from "@mariozechner/pi-ai";
import { extractStructuredOutput, enrichStructuredOutputCommands } from "../src/structured-output.js";
import type { FlowStructuredOutput } from "../src/types.js";

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
		// Should not match because the fence has extra text after \`json
		expect(extractStructuredOutput(text)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// enrichStructuredOutputCommands
// ---------------------------------------------------------------------------

describe("enrichStructuredOutputCommands", () => {
	function makeMessage(toolCalls: Array<{ name: string; args: Record<string, unknown> }>): Message {
		return {
			role: "assistant",
			content: toolCalls.map((tc) => ({
				type: "toolCall" as const,
				name: tc.name,
				arguments: tc.args,
			})),
		} as unknown as Message;
	}

	const baseOutput: FlowStructuredOutput = {
		version: "1.0",
		status: "complete",
		summary: "Test summary",
		files: [],
		actions: [],
		commands: [],
		notDone: [],
		nextSteps: [],
		reasoning: [],
		notes: [],
	};

	it("returns original structured output when no bash commands exist in messages", () => {
		const output: FlowStructuredOutput = {
			...baseOutput,
			commands: [{ command: "npm test", tool: "bash" }],
		};
		const messages: Message[] = [];
		const result = enrichStructuredOutputCommands(output, messages);
		expect(result.commands[0].command).toBe("npm test");
	});

	it("replaces paraphrased bash command with verbatim one from message history", () => {
		const output: FlowStructuredOutput = {
			...baseOutput,
			commands: [
				{ command: "curl GAWA baseline", tool: "bash" },
			],
		};
		const messages: Message[] = [
			makeMessage([{ name: "bash", args: { command: "curl -s -X POST https://api.example.com/v1/data -H 'Authorization: Bearer token'" } }]),
		];
		const result = enrichStructuredOutputCommands(output, messages);
		expect(result.commands[0].command).toBe("curl -s -X POST https://api.example.com/v1/data -H 'Authorization: Bearer token'");
	});

	it("replaces multiple bash commands in order", () => {
		const output: FlowStructuredOutput = {
			...baseOutput,
			commands: [
				{ command: "first curl", tool: "bash" },
				{ command: "second grep", tool: "bash" },
				{ command: "npm test", tool: "bash" },
			],
		};
		const messages: Message[] = [
			makeMessage([
				{ name: "bash", args: { command: "curl -s https://first.com" } },
				{ name: "bash", args: { command: "grep -n 'foo' bar.ts" } },
				{ name: "bash", args: { command: "npm test -- --coverage" } },
			]),
		];
		const result = enrichStructuredOutputCommands(output, messages);
		expect(result.commands[0].command).toBe("curl -s https://first.com");
		expect(result.commands[1].command).toBe("grep -n 'foo' bar.ts");
		expect(result.commands[2].command).toBe("npm test -- --coverage");
	});

	it("skips non-bash commands and leaves them untouched", () => {
		const output: FlowStructuredOutput = {
			...baseOutput,
			commands: [
				{ command: "some file edit", tool: "write" },
				{ command: "curl baseline", tool: "bash" },
			],
		};
		const messages: Message[] = [
			makeMessage([{ name: "bash", args: { command: "curl -v http://example.com" } }]),
		];
		const result = enrichStructuredOutputCommands(output, messages);
		expect(result.commands[0].command).toBe("some file edit");
		expect(result.commands[0].tool).toBe("write");
		expect(result.commands[1].command).toBe("curl -v http://example.com");
	});

	it("extracts bash commands nested inside batch operations", () => {
		const output: FlowStructuredOutput = {
			...baseOutput,
			commands: [
				{ command: "batch setup", tool: "bash" },
			],
		};
		const messages: Message[] = [
			makeMessage([
				{
					name: "batch",
					args: {
						o: [
							{ o: "bash", command: "echo 'step 1'" },
							{ o: "read", p: "file.txt" },
							{ o: "bash", command: "echo 'step 2'" },
						],
					},
				},
			]),
		];
		const result = enrichStructuredOutputCommands(output, messages);
		expect(result.commands[0].command).toBe("echo 'step 1'");
	});

	it("does not mutate the original structured output object", () => {
		const output: FlowStructuredOutput = {
			...baseOutput,
			commands: [{ command: "original", tool: "bash" }],
		};
		const messages: Message[] = [
			makeMessage([{ name: "bash", args: { command: "replaced" } }]),
		];
		const result = enrichStructuredOutputCommands(output, messages);
		expect(result.commands[0].command).toBe("replaced");
		expect(output.commands[0].command).toBe("original");
	});

	it("stops replacing when actual bash commands are exhausted", () => {
		const output: FlowStructuredOutput = {
			...baseOutput,
			commands: [
				{ command: "first", tool: "bash" },
				{ command: "second", tool: "bash" },
				{ command: "third", tool: "bash" },
			],
		};
		const messages: Message[] = [
			makeMessage([{ name: "bash", args: { command: "only-one" } }]),
		];
		const result = enrichStructuredOutputCommands(output, messages);
		expect(result.commands[0].command).toBe("only-one");
		expect(result.commands[1].command).toBe("second");
		expect(result.commands[2].command).toBe("third");
	});
});

describe("enrichStructuredOutputCommands with executionTime", () => {
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
			role: "tool",
			toolCallId,
			content: [{ type: "text", text }],
		} as unknown as Message;
	}

	const baseOutput: FlowStructuredOutput = {
		version: "1.0",
		status: "complete",
		summary: "Test summary",
		files: [],
		actions: [],
		commands: [],
		notDone: [],
		nextSteps: [],
		reasoning: [],
		notes: [],
	};

	it("extracts executionTime from matching tool result", () => {
		const output: FlowStructuredOutput = {
			...baseOutput,
			commands: [{ command: "npm test", tool: "bash" }],
		};
		const messages: Message[] = [
			makeAssistantMessage([{ name: "bash", args: { command: "npm test" }, toolCallId: "tc_1" }]),
			makeToolResultMessage("tc_1", "some output\n\n[Execution time: 3.5s (normal)]"),
		];
		const result = enrichStructuredOutputCommands(output, messages);
		expect(result.commands[0].command).toBe("npm test");
		expect(result.commands[0].executionTime).toBe("3.5s (normal)");
	});

	it("leaves executionTime undefined when timing is missing", () => {
		const output: FlowStructuredOutput = {
			...baseOutput,
			commands: [{ command: "npm test", tool: "bash" }],
		};
		const messages: Message[] = [
			makeAssistantMessage([{ name: "bash", args: { command: "npm test" }, toolCallId: "tc_1" }]),
			makeToolResultMessage("tc_1", "some output without timing"),
		];
		const result = enrichStructuredOutputCommands(output, messages);
		expect(result.commands[0].command).toBe("npm test");
		expect(result.commands[0].executionTime).toBeUndefined();
	});

	it("matches multiple bash commands with executionTime in order", () => {
		const output: FlowStructuredOutput = {
			...baseOutput,
			commands: [
				{ command: "first", tool: "bash" },
				{ command: "second", tool: "bash" },
			],
		};
		const messages: Message[] = [
			makeAssistantMessage([
				{ name: "bash", args: { command: "echo 1" }, toolCallId: "tc_1" },
				{ name: "bash", args: { command: "echo 2" }, toolCallId: "tc_2" },
			]),
			makeToolResultMessage("tc_1", "out1\n\n[Execution time: 1.0s (normal)]"),
			makeToolResultMessage("tc_2", "out2\n\n[Execution time: 2.0s (avg) — user feedback: consider improving the current commands or find a better solution]"),
		];
		const result = enrichStructuredOutputCommands(output, messages);
		expect(result.commands[0].command).toBe("echo 1");
		expect(result.commands[0].executionTime).toBe("1.0s (normal)");
		expect(result.commands[1].command).toBe("echo 2");
		expect(result.commands[1].executionTime).toBe("2.0s (avg) — user feedback: consider improving the current commands or find a better solution");
	});

	it("does not add executionTime for batch-nested bash commands", () => {
		const output: FlowStructuredOutput = {
			...baseOutput,
			commands: [{ command: "batch setup", tool: "bash" }],
		};
		const messages: Message[] = [
			makeAssistantMessage([
				{
					name: "batch",
					args: {
						o: [
							{ o: "bash", command: "echo 'step 1'" },
							{ o: "read", p: "file.txt" },
							{ o: "bash", command: "echo 'step 2'" },
						],
					},
					toolCallId: "tc_batch",
				},
			]),
			makeToolResultMessage("tc_batch", "batch output\n\n[Execution time: 5.0s (normal)]"),
		];
		const result = enrichStructuredOutputCommands(output, messages);
		expect(result.commands[0].command).toBe("echo 'step 1'");
		expect(result.commands[0].executionTime).toBeUndefined();
	});
});
