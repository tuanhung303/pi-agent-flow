import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerExtension from "../src/index.js";
import { runFlow } from "../src/flow/runner.js";
import { emptyFlowUsage } from "../src/types/flow.js";
import { buildTraceEvidenceIds, collectExecutedToolCallIds, extractTraceStructuredOutput, resolveToolEvidence, unwrapMarkdownCodeBlock } from "../src/snapshot/trace-output.js";

vi.mock("../src/flow/runner.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/flow/runner.js")>();
	return {
		...actual,
		runFlow: vi.fn(),
	};
});

function createMockPi() {
	const handlers: Record<string, Function[]> = {};
	const tools: any[] = [];

	return {
		registerFlag: vi.fn(),
		on: vi.fn((event, handler) => {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
		}),
		registerTool: vi.fn((tool) => {
			tools.push(tool);
		}),
		setActiveTools: vi.fn(),
		getActiveTools: vi.fn(() => ["read", "write", "edit", "bash", "find", "grep", "ls", "flow", "web"]),
		getFlag: vi.fn(),
		emit: vi.fn(),
		registerCommand: vi.fn(),
		sendUserMessage: vi.fn(),
		trigger: (event: string, ...args: any[]) =>
			Promise.all((handlers[event] || []).map((h) => h(...args))),
		getTool: (name: string) => tools.find((t) => t.name === name),
	};
}

function makeMockCtx(cwd: string) {
	return {
		cwd,
		sessionManager: {
			getHeader: () => ({}),
			getBranch: () => [],
			getSessionId: () => 'test-session-id',
		},
		hasUI: false,
		ui: { confirm: vi.fn() },
	};
}

describe("Trace Structured Output Parser & Resolver", () => {
	describe("extractTraceStructuredOutput", () => {
		it("correctly parses valid trace structured output JSON block", () => {
			const text = "Some assistant response before.\n```json\n{\n  \"note\": \"This is a note.\",\n  \"tool_ids\": [\"call_1\", \"call_2\"]\n}\n```";
			const result = extractTraceStructuredOutput(text);
			expect(result).toEqual({
				note: "This is a note.",
				tool_ids: ["call_1", "call_2"],
			});
		});

		it("unwraps markdown code block wrappers from note and tool_ids", () => {
			const text = "Some response.\n```json\n{\n  \"note\": \"```markdown\\nfile content\\n```\",\n  \"tool_ids\": [\"call_1\", \"```\\ncall_2\\n```\"]\n}\n```";
			const result = extractTraceStructuredOutput(text);
			expect(result).toEqual({
				note: "file content",
				tool_ids: ["call_1", "call_2"],
			});
		});

		it("returns undefined for missing or malformed JSON blocks", () => {
			expect(extractTraceStructuredOutput("no JSON block here")).toBeUndefined();
			expect(extractTraceStructuredOutput("```json\ninvalid-json\n```")).toBeUndefined();
		});

		it("returns undefined for missing required fields or incorrect types", () => {
			expect(extractTraceStructuredOutput("```json\n{\n  \"tool_ids\": [\"call_1\"]\n}\n```")).toBeUndefined();
			expect(extractTraceStructuredOutput("```json\n{\n  \"note\": 123,\n  \"tool_ids\": [\"call_1\"]\n}\n```")).toBeUndefined();
			expect(extractTraceStructuredOutput("```json\n{\n  \"note\": \"test\",\n  \"tool_ids\": \"not-an-array\"\n}\n```")).toBeUndefined();
		});
	});

	describe("unwrapMarkdownCodeBlock", () => {
		it("strips triple-backtick fence with language tag", () => {
			expect(unwrapMarkdownCodeBlock("```markdown\nfile content\n```")).toBe("file content");
			expect(unwrapMarkdownCodeBlock("```js\nconst x = 1;\n```")).toBe("const x = 1;");
		});

		it("strips triple-backtick fence without language tag", () => {
			expect(unwrapMarkdownCodeBlock("```\nplain text\n```")).toBe("plain text");
		});

		it("handles leading and trailing whitespace", () => {
			expect(unwrapMarkdownCodeBlock("  ```markdown\nfile content\n```  ")).toBe("file content");
			expect(unwrapMarkdownCodeBlock("\n```\nabc\n```\n")).toBe("abc");
		});

		it("returns original when no complete fence exists", () => {
			expect(unwrapMarkdownCodeBlock("just plain text")).toBe("just plain text");
			expect(unwrapMarkdownCodeBlock("```markdown\nno closing fence")).toBe("```markdown\nno closing fence");
			expect(unwrapMarkdownCodeBlock("no opening fence\n```")).toBe("no opening fence\n```");
		});

		it("returns original for legitimate inline backticks", () => {
			expect(unwrapMarkdownCodeBlock("some `code` here")).toBe("some `code` here");
			expect(unwrapMarkdownCodeBlock("text ``` not a fence")).toBe("text ``` not a fence");
		});

		it("preserves nested code blocks inside the outer fence", () => {
			const inner = "# Title\n\n```js\nconst x = 1;\n```\n\nMore text";
			const wrapped = "```markdown\n" + inner + "\n```";
			expect(unwrapMarkdownCodeBlock(wrapped)).toBe(inner);
		});

		it("returns original for empty string", () => {
			expect(unwrapMarkdownCodeBlock("")).toBe("");
		});

		it("returns original for fence-only string", () => {
			expect(unwrapMarkdownCodeBlock("```")).toBe("```");
			expect(unwrapMarkdownCodeBlock("```\n```")).toBe("```\n```");
		});
	});

	describe("resolveToolEvidence", () => {
		it("collects executed tool call IDs in order, deduplicated across ID shapes", () => {
			const messages: any[] = [
				{ role: "assistant", content: [{ type: "toolCall", id: "native" }, { type: "text", text: "ignored" }] },
				{ role: "assistant", content: [{ type: "toolCall", toolCallId: "camel" }, { type: "toolCall", tool_call_id: "snake" }] },
				{ role: "assistant", content: [{ type: "toolCall", id: "native" }] },
			];
			expect(collectExecutedToolCallIds(messages)).toEqual(["native", "camel", "snake"]);
		});

		it("keeps all executed IDs when reported IDs are empty or malformed and appends unique parent IDs", () => {
			const messages: any[] = [
				{ role: "assistant", content: [{ type: "toolCall", id: "live_one" }, { type: "toolCall", toolCallId: "live_two" }] },
			];
			expect(buildTraceEvidenceIds(messages, [])).toEqual(["live_one", "live_two"]);
			expect(buildTraceEvidenceIds(messages, "malformed")).toEqual(["live_one", "live_two"]);
			expect(buildTraceEvidenceIds(messages, ["live_two", "parent_one", "parent_one"])).toEqual([
				"live_one", "live_two", "parent_one",
			]);
		});

		it("resolves evidence from pre-dispatch or live flow messages", () => {
			const messages: any[] = [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_abc",
							name: "batch",
							arguments: { o: [{ o: "read", p: "src/index.ts" }] },
						},
					],
				},
				{
					role: "tool",
					toolCallId: "call_abc",
					content: [
						{
							type: "text",
							text: "import foo from 'bar';",
						},
					],
				},
			];

			const evidence = resolveToolEvidence(["call_abc"], messages, []);
			expect(evidence).toContain("## Verbatim Evidence");
			expect(evidence).toContain("### batch [call_abc]");
			expect(evidence).toContain("**Args:**");
			expect(evidence).toContain('"o": [');
			expect(evidence).toContain("import foo from 'bar';");
		});

		it("resolves evidence from parent branch history", () => {
			const parentBranch: any[] = [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								toolCallId: "call_parent",
								name: "bash",
								arguments: { command: "git status" },
							},
						],
					},
				},
				{
					type: "message",
					message: {
						role: "tool",
						toolCallId: "call_parent",
						content: "On branch main\nnothing to commit, working tree clean",
					},
				},
			];

			const evidence = resolveToolEvidence(["call_parent"], [], parentBranch);
			expect(evidence).toContain("### bash [call_parent]");
			expect(evidence).toContain("git status");
			expect(evidence).toContain("On branch main");
		});

		it("silently ignores missing tool IDs", () => {
			const evidence = resolveToolEvidence(["non_existent"], [], []);
			expect(evidence).toBe("");
		});

		it("uses a 4-backtick fence when result contains nested code blocks", () => {
			const messages: any[] = [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_abc",
							name: "batch",
							arguments: { o: [{ o: "read", p: "src/index.ts" }] },
						},
					],
				},
				{
					role: "tool",
					toolCallId: "call_abc",
					content: [
						{
							type: "text",
							text: "Here is some code:\n```typescript\nconst x = 1;\n```",
						},
					],
				},
			];

			const evidence = resolveToolEvidence(["call_abc"], messages, []);
			expect(evidence).toContain("## Verbatim Evidence");
			expect(evidence).toContain("```typescript");
			expect(evidence).toContain("const x = 1;");
			const outputSection = evidence.split("**Output:**")[1];
			expect(outputSection).toBeDefined();
			expect(outputSection).toContain("````text");
			expect(outputSection).toContain("````");
			const lines = outputSection.split("\n");
			const openingFence = lines.find((l) => l.startsWith("````"));
			expect(openingFence).toBe("````text");
		});

		it("preserves a 3-backtick fence when result has no nested code blocks", () => {
			const messages: any[] = [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_abc",
							name: "bash",
							arguments: { command: "echo hello" },
						},
					],
				},
				{
					role: "tool",
					toolCallId: "call_abc",
					content: [{ type: "text", text: "hello\nworld" }],
				},
			];

			const evidence = resolveToolEvidence(["call_abc"], messages, []);
			const outputSection = evidence.split("**Output:**")[1];
			expect(outputSection).toContain("```text");
			expect(outputSection).toContain("```");
		});

		it("reads the evidence cap from the environment", () => {
			const previous = process.env.PI_FLOW_TRACE_EVIDENCE_MAX_BYTES;
			process.env.PI_FLOW_TRACE_EVIDENCE_MAX_BYTES = "400";
			try {
				const messages: any[] = [
					{ role: "assistant", content: [{ type: "toolCall", id: "first", name: "bash", arguments: { command: "echo first" } }] },
					{ role: "tool", toolCallId: "first", content: "first output" },
					{ role: "assistant", content: [{ type: "toolCall", id: "second", name: "bash", arguments: { command: "echo second" } }] },
					{ role: "tool", toolCallId: "second", content: "second output ".repeat(100) },
				];
				const evidence = resolveToolEvidence(["first", "second"], messages, []);
				expect(evidence).toContain("[Evidence truncated: 1 more tool call(s) omitted]");
				expect(Buffer.byteLength(evidence, "utf-8")).toBeLessThanOrEqual(400);
			} finally {
				if (previous === undefined) delete process.env.PI_FLOW_TRACE_EVIDENCE_MAX_BYTES;
				else process.env.PI_FLOW_TRACE_EVIDENCE_MAX_BYTES = previous;
			}
		});

		it("caps evidence at whole entry boundaries and reports omitted calls", () => {
			const messages: any[] = [
				{ role: "assistant", content: [{ type: "toolCall", id: "first", name: "bash", arguments: { command: "echo first" } }] },
				{ role: "tool", toolCallId: "first", content: "first output" },
				{ role: "assistant", content: [{ type: "toolCall", id: "second", name: "bash", arguments: { command: "echo second" } }] },
				{ role: "tool", toolCallId: "second", content: "second output ".repeat(100) },
			];
			const evidence = resolveToolEvidence(["first", "second"], messages, [], 400);
			expect(evidence).toContain("### bash [first]");
			expect(evidence).not.toContain("### bash [second]");
			expect(evidence).toContain("[Evidence truncated: 1 more tool call(s) omitted]");
			expect(Buffer.byteLength(evidence, "utf-8")).toBeLessThanOrEqual(400);
		});

		it("promotes an environment cap of 1 to the mandatory heading-and-marker minimum", () => {
			const previous = process.env.PI_FLOW_TRACE_EVIDENCE_MAX_BYTES;
			process.env.PI_FLOW_TRACE_EVIDENCE_MAX_BYTES = "1";
			try {
				const messages: any[] = [
					{ role: "assistant", content: [{ type: "toolCall", id: "oversized", name: "bash", arguments: { command: "echo oversized" } }] },
					{ role: "tool", toolCallId: "oversized", content: "output ".repeat(100) },
				];
				const marker = "[Evidence truncated: 1 more tool call(s) omitted]";
				const effectiveMinimum = Buffer.byteLength(`## Verbatim Evidence\n\n${marker}`, "utf-8");
				const evidence = resolveToolEvidence(["oversized"], messages, []);
				expect(evidence).toBe(`## Verbatim Evidence\n\n${marker}`);
				expect(Buffer.byteLength(evidence, "utf-8")).toBe(effectiveMinimum);
			} finally {
				if (previous === undefined) delete process.env.PI_FLOW_TRACE_EVIDENCE_MAX_BYTES;
				else process.env.PI_FLOW_TRACE_EVIDENCE_MAX_BYTES = previous;
			}
		});

		it("promotes environment caps smaller than the heading-and-marker minimum", () => {
			const previous = process.env.PI_FLOW_TRACE_EVIDENCE_MAX_BYTES;
			const marker = "[Evidence truncated: 1 more tool call(s) omitted]";
			const effectiveMinimum = Buffer.byteLength(`## Verbatim Evidence\n\n${marker}`, "utf-8");
			process.env.PI_FLOW_TRACE_EVIDENCE_MAX_BYTES = String(effectiveMinimum - 1);
			try {
				const messages: any[] = [
					{ role: "assistant", content: [{ type: "toolCall", id: "first", name: "bash", arguments: { command: "echo first" } }] },
					{ role: "tool", toolCallId: "first", content: "first output".repeat(100) },
				];
				const evidence = resolveToolEvidence(["first"], messages, []);
				expect(evidence).toBe(`## Verbatim Evidence\n\n${marker}`);
				expect(Buffer.byteLength(evidence, "utf-8")).toBe(effectiveMinimum);
			} finally {
				if (previous === undefined) delete process.env.PI_FLOW_TRACE_EVIDENCE_MAX_BYTES;
				else process.env.PI_FLOW_TRACE_EVIDENCE_MAX_BYTES = previous;
			}
		});

		it("omits an oversized first entry without breaking the evidence heading format", () => {
			const messages: any[] = [
				{ role: "assistant", content: [{ type: "toolCall", id: "oversized", name: "batch", arguments: { o: [{ o: "read", p: "large.ts" }] } }] },
				{ role: "tool", toolCallId: "oversized", content: "x".repeat(10_000) },
			];
			const evidence = resolveToolEvidence(["oversized"], messages, [], 100);
			expect(evidence).toBe("## Verbatim Evidence\n\n[Evidence truncated: 1 more tool call(s) omitted]");
			expect(evidence).not.toContain("### batch [oversized]");
		});
	});
});

describe("Trace Tool Execution Integration", () => {
	let tmpDir: string;
	let originalCwd: string;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-trace-test-"));
		originalCwd = process.cwd();
		process.chdir(tmpDir);
	});

	afterAll(() => {
		process.chdir(originalCwd);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	beforeEach(() => {
		vi.clearAllMocks();
	});

	function setupFlowsDir() {
		const agentsDir = path.join(tmpDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentsDir, "trace.md"),
			`---
name: trace
description: Verbatim trace mode
tier: lite
---
Prompt`,
			"utf-8"
		);
	}

	it("executes trace tool, runs pre-dispatch, parses structured JSON, and returns resolved evidence", async () => {
		setupFlowsDir();

		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		// Mock runFlow to return assistant response with JSON structured output block
		vi.mocked(runFlow).mockResolvedValue({
			type: "trace",
			agentSource: "project",
			intent: "Read index",
			aim: "",
			exitCode: 0,
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							toolCallId: "call_live_read",
							name: "batch",
							arguments: { o: [{ o: "read", p: "src/index.ts" }] },
						},
					],
				},
				{
					role: "tool",
					toolCallId: "call_live_read",
					content: "const a = 123;",
				},
				{
					role: "assistant",
					content: [
						{
							type: "text",
							text: "```json\n{\n  \"note\": \"We found the definition of a in src/index.ts.\",\n  \"tool_ids\": [\"pre_dispatch_batch_0\", \"call_live_read\", \"missing_id\"]\n}\n```",
						},
					],
				},
			],
			stderr: "",
			usage: emptyFlowUsage(),
		});

		const tool = pi.getTool("trace");
		const result = await tool.execute(
			"call-trace-1",
			{
				intent: "Read index",
				dispatch: [
					{
						tool: "batch",
						ops: [{ o: "read", p: "package.json" }],
					},
				],
			},
			new AbortController().signal,
			vi.fn(),
			makeMockCtx(tmpDir)
		);

		expect(result.failed).toBeFalsy();
		expect(runFlow).toHaveBeenCalledTimes(1);

		const responseText = result.content[0].text;
		// Must start with the note
		expect(responseText).toContain("We found the definition of a in src/index.ts.");
		
		// Must resolve the pre-dispatch batch call
		expect(responseText).toContain("### batch [pre_dispatch_batch_0]");
		// Must resolve the live batch call
		expect(responseText).toContain("### batch [call_live_read]");
		expect(responseText).toContain("const a = 123;");
		// Must silently ignore missing_id
		expect(responseText).not.toContain("missing_id");
	});

	it("returns executed-call evidence when the trace output is malformed", async () => {
		setupFlowsDir();
		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		vi.mocked(runFlow).mockResolvedValue({
			type: "trace", agentSource: "project", intent: "Read index", aim: "", exitCode: 0,
			messages: [
				{ role: "assistant", content: [{ type: "toolCall", tool_call_id: "call_snake", name: "batch", arguments: { o: [{ o: "read", p: "src/index.ts" }] } }] },
				{ role: "tool", tool_call_id: "call_snake", content: "const deterministic = true;" },
				{ role: "assistant", content: [{ type: "text", text: "not structured JSON" }] },
			], stderr: "", usage: emptyFlowUsage(),
		});

		const result = await pi.getTool("trace").execute("call-trace-malformed", { intent: "Read index" }, new AbortController().signal, vi.fn(), makeMockCtx(tmpDir));
		expect(result.content[0].text).toContain("not structured JSON");
		expect(result.content[0].text).toContain("## Verbatim Evidence");
		expect(result.content[0].text).toContain("### batch [call_snake]");
		expect(result.content[0].text).toContain("const deterministic = true;");
	});
});
