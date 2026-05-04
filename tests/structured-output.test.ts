import { describe, it, expect } from "vitest";
import { extractStructuredOutput, enrichStructuredOutputCommands } from "../src/structured-output.js";
import type { FlowStructuredOutput } from "../src/types.js";
import type { Message } from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// extractStructuredOutput
// ---------------------------------------------------------------------------

describe("extractStructuredOutput", () => {
	const validOutput = {
		version: "1.0",
		status: "complete",
		summary: "Implemented the feature successfully.",
		files: [
			{
				path: "src/example.ts",
				role: "modified",
				description: "Main implementation file",
				snippet: "const x = 1;",
				ranges: [{ start: 10, end: 25, label: "fix" }],
			},
		],
		actions: [
			{
				type: "write",
				description: "Wrote implementation",
				target: "src/example.ts",
				result: "success",
				evidence: "file created",
			},
		],
		commands: [
			{
				command: "npm test",
				tool: "bash",
			},
		],
		notDone: [
			{
				item: "Cross-validate actions against tool calls",
				reason: "Deferred to v2",
				blocker: "No derived tool-call summary exists yet",
				nextStep: "Design validation layer",
			},
		],
		nextSteps: ["Run tests", "Commit changes"],
		reasoning: ["Chose approach A because of X"],
		notes: ["Consider refactoring later"],
	};

	it("returns undefined for empty string", () => {
		expect(extractStructuredOutput("")).toBeUndefined();
	});

	it("returns undefined when no JSON block is present", () => {
		const text = "flow [build] accomplished\n\n[Summary]\nDid some work.";
		expect(extractStructuredOutput(text)).toBeUndefined();
	});

	it("returns undefined for malformed JSON", () => {
		const text = "Done.\n\n```json\n{broken json,}\n```";
		expect(extractStructuredOutput(text)).toBeUndefined();
	});

	it("returns undefined when required fields are missing", () => {
		const text = "Done.\n\n```json\n{ \"version\": \"1.0\" }\n```";
		expect(extractStructuredOutput(text)).toBeUndefined();
	});

	it("returns undefined when status is invalid", () => {
		const text = `Done.

\`\`\`json
${JSON.stringify({ ...validOutput, status: "unknown" })}
\`\`\``;
		expect(extractStructuredOutput(text)).toBeUndefined();
	});

	it("normalizes omitted arrays to empty arrays", () => {
		const partial = {
			version: "1.0",
			status: "complete",
			summary: "Done.",
		};
		const text = `Done.

\`\`\`json
${JSON.stringify(partial)}
\`\`\``;
		const result = extractStructuredOutput(text);
		expect(result).toBeDefined();
		expect(result!.files).toEqual([]);
		expect(result!.actions).toEqual([]);
		expect(result!.commands).toEqual([]);
		expect(result!.notDone).toEqual([]);
		expect(result!.nextSteps).toEqual([]);
		expect(result!.reasoning).toEqual([]);
		expect(result!.notes).toEqual([]);
	});

	it("returns undefined when an optional array field is not an array", () => {
		for (const field of ["files", "actions", "commands", "notDone", "nextSteps", "reasoning", "notes"]) {
			const invalid = {
				version: "1.0",
				status: "complete",
				summary: "Done.",
				[field]: "not an array",
			};
			const text = `Done.

\`\`\`json
${JSON.stringify(invalid)}
\`\`\``;
			expect(extractStructuredOutput(text), field).toBeUndefined();
		}
	});

	it("extracts a valid structured output block", () => {
		const text = `flow [build] accomplished

[Summary]
Did some work.

[Done]
- Completed items.

\`\`\`json
${JSON.stringify(validOutput)}
\`\`\``;
		const result = extractStructuredOutput(text);
		expect(result).toBeDefined();
		expect(result!.version).toBe("1.0");
		expect(result!.status).toBe("complete");
		expect(result!.summary).toBe("Implemented the feature successfully.");
		expect(result!.files).toHaveLength(1);
		expect(result!.files[0].path).toBe("src/example.ts");
		expect(result!.actions).toHaveLength(1);
		expect(result!.commands).toHaveLength(1);
		expect(result!.commands[0]).toEqual({
			command: "npm test",
			tool: "bash",
		});
		expect(result!.notDone).toHaveLength(1);
		expect(result!.notDone[0]).toEqual({
			item: "Cross-validate actions against tool calls",
			reason: "Deferred to v2",
			blocker: "No derived tool-call summary exists yet",
			nextStep: "Design validation layer",
		});
		expect(result!.nextSteps).toHaveLength(2);
		expect(result!.reasoning).toHaveLength(1);
		expect(result!.notes).toHaveLength(1);
	});

	it("keeps backward compatibility with structured output that omits notDone", () => {
		const { notDone: _notDone, commands: _commands, ...legacyOutput } = validOutput;
		const text = `Done.

\`\`\`json
${JSON.stringify(legacyOutput)}
\`\`\``;
		const result = extractStructuredOutput(text);
		expect(result).toBeDefined();
		expect(result!.notDone).toEqual([]);
		expect(result!.summary).toBe(validOutput.summary);
	});

	it("uses the last JSON block when multiple exist", () => {
		const firstBlock = JSON.stringify({ ...validOutput, summary: "First" });
		const secondBlock = JSON.stringify({ ...validOutput, summary: "Second" });
		const text = `First attempt:

\`\`\`json
${firstBlock}
\`\`\`

Second attempt:

\`\`\`json
${secondBlock}
\`\`\``;
		const result = extractStructuredOutput(text);
		expect(result).toBeDefined();
		expect(result!.summary).toBe("Second");
	});

	it("preserves extensions when present", () => {
		const withExtensions = {
			...validOutput,
			extensions: { rootCause: "Null pointer exception" },
		};
		const text = `Done.

\`\`\`json
${JSON.stringify(withExtensions)}
\`\`\``;
		const result = extractStructuredOutput(text);
		expect(result).toBeDefined();
		expect(result!.extensions).toEqual({ rootCause: "Null pointer exception" });
	});

	it("omits extensions when not present", () => {
		const text = `Done.

\`\`\`json
${JSON.stringify(validOutput)}
\`\`\``;
		const result = extractStructuredOutput(text);
		expect(result).toBeDefined();
		expect(result!.extensions).toBeUndefined();
	});

	it("handles all valid status values", () => {
		for (const status of ["complete", "partial", "blocked", "failed"]) {
			const text = `Done.

\`\`\`json
${JSON.stringify({ ...validOutput, status })}
\`\`\``;
			const result = extractStructuredOutput(text);
			expect(result).toBeDefined();
			expect(result!.status).toBe(status);
		}
	});

	it("trims whitespace from summary", () => {
		const spaced = { ...validOutput, summary: "  Spaced summary  " };
		const text = `Done.

\`\`\`json
${JSON.stringify(spaced)}
\`\`\``;
		const result = extractStructuredOutput(text);
		expect(result).toBeDefined();
		expect(result!.summary).toBe("Spaced summary");
	});

	it("trims whitespace from version", () => {
		const spaced = { ...validOutput, version: "  1.0  " };
		const text = `Done.

\`\`\`json
${JSON.stringify(spaced)}
\`\`\``;
		const result = extractStructuredOutput(text);
		expect(result).toBeDefined();
		expect(result!.version).toBe("1.0");
	});

	it("handles code fence with language tag on same line", () => {
		const text = `Done.

\`\`\`json extra
${JSON.stringify(validOutput)}
\`\`\``;
		// Should not match because the fence has extra text after `json`
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
