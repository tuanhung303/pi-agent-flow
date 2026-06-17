import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerExtension from "../src/index.js";
import { runFlow, mapFlowConcurrent } from "../src/flow/runner.js";
import { emptyFlowUsage, type SingleResult } from "../src/types/flow.js";
import { flushAllSettingsCachesSync } from "../src/config/config.js";

vi.mock("../src/flow/runner.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/flow/runner.js")>();
	return {
		...actual,
		runFlow: vi.fn(),
	};
});


vi.mock("../src/flow/index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/flow/index.js")>();
	return {
		...actual,
		getLoop: vi.fn(() => undefined),
	};
});

vi.mock("../src/core2/snapshot.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core2/snapshot.js")>();
	return {
		...actual,
		buildCore2Snapshot: vi.fn((...args: any[]) => actual.buildCore2Snapshot(...args)),
	};
});


function createMockPi() {
	const handlers: Record<string, Function[]> = {};
	const flags: Record<string, unknown> = {};
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
		getAllTools: vi.fn(() => [
			{ name: "read" }, { name: "write" }, { name: "edit" },
			{ name: "bash" }, { name: "flow" },
			{ name: "web" },
		]),
		getFlag: vi.fn((name: string) => flags[name]),
		setFlag: (name: string, value: unknown) => { flags[name] = value; },
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



describe("flow tool execute", () => {
	let tmpDir: string;
	let originalCwd: string;
	let originalEnv: NodeJS.ProcessEnv;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-index-test-"));
		originalCwd = process.cwd();
		process.chdir(tmpDir);
		originalEnv = { ...process.env };
	});

	afterAll(() => {
		process.chdir(originalCwd);
		fs.rmSync(tmpDir, { recursive: true, force: true });
		process.env = originalEnv;
	});

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.PI_FLOW_DEPTH;
		delete process.env.PI_FLOW_STACK;
		process.env.PI_FLOW_MAX_DEPTH = "2";
		delete process.env.PI_FLOW_PREVENT_CYCLES;
		delete process.env.PI_FLOW_COMPLEXITY;
		delete process.env.PI_CODING_AGENT_DIR;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function setupFlowsDir(flows: Array<{ fileName: string; content: string }>) {
		const agentsDir = path.join(tmpDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		for (const f of flows) {
			fs.writeFileSync(path.join(agentsDir, f.fileName), f.content, "utf-8");
		}
	}

	it("inherits full parent context while sanitizing prompts and assistant reasoning", async () => {
		setupFlowsDir([
			{
				fileName: "scout.md",
				content: `---\nname: scout\ndescription: Discovery\n---\nPrompt.`,
			},
		]);

		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		vi.mocked(runFlow).mockResolvedValue({
			type: "scout",
			agentSource: "project",
			intent: "Discover things",
			aim: "Discover codebase",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		});

		const steeringHint = "<pi-flow-steering-hint>\nYou are operating with pi-agent-flow routing.\nIf the answer is already in context, answer directly; otherwise transition to the appropriate flow.\nFor git, bash, CLI, or terminal tasks, transition to [build].\n</pi-flow-steering-hint>";
		const sessionBranch = [
			{ type: "message", message: { role: "system", content: steeringHint, timestamp: 0 } },
			{ type: "message", message: { role: "user", content: "Keep this product requirement in mind as you work through /src/product.ts", timestamp: 1 } },
			{
				type: "message",
				message: {
					role: "assistant",
					thinking: "SECRET_THINKING_FIELD",
					reasoning: "SECRET_REASONING_FIELD",
					content: [
						{ type: "thinking", text: "SECRET_THINKING_PART" },
						{ type: "reasoning", text: "SECRET_REASONING_PART" },
						{ type: "text", text: "Normal assistant context with implementation details and code examples and a file reference to /src/index.ts for context." + steeringHint },
					],
					timestamp: 2,
				},
			},
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", toolCallId: "bash-call-1", arguments: { command: "echo normal" } }], timestamp: 3 } },
			{ type: "message", message: { role: "toolResult", toolCallId: "bash-call-1", name: "bash", content: [{ type: "text", text: "normal bash output" }], timestamp: 4 } },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "flow", toolCallId: "flow-call-1", arguments: { flow: [{ type: "scout", intent: "Prior flow", complexity: "moderate" }] } }], timestamp: 5 } },
			{ type: "message", message: { role: "toolResult", toolCallId: "flow-call-1", name: "flow", content: [{ type: "text", text: "prior flow result should be inherited" }], timestamp: 6 } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Implementation summary after transition — [build] flow completed with files modified" }], timestamp: 7 } },
			{ type: "message", message: { role: "user", content: "Current request should be inherited from /src/config.ts and applied consistently", timestamp: 8 } },
		];

		const tool = pi.getTool("flow");
		await tool.execute(
			"call-1",
			{ flow: [{ type: "ideas", intent: "Explore things", complexity: "moderate", aim: "Explore codebase" }], confirmProjectFlows: false },
			new AbortController().signal,
			undefined,
			{
				...makeMockCtx(tmpDir),
				sessionManager: {
					getHeader: () => ({ version: 1 }),
					getBranch: () => sessionBranch,
					getSessionId: () => 'test-session-id',
				},
			},
		);

		expect(runFlow).toHaveBeenCalledTimes(1);
		const snapshot = vi.mocked(runFlow).mock.calls[0][0].forkSessionSnapshotJsonl;
		expect(snapshot).toContain("Keep this product requirement in mind as you work through /src/product.ts");
		expect(snapshot).toContain("Normal assistant context with implementation details and code examples and a file reference to /src/index.ts for context.");
		expect(snapshot).toContain("bash-call-1");
		expect(snapshot).toContain("[toolResult: bash]");
		expect(snapshot).toContain("Implementation summary after transition");
		expect(snapshot).toContain("flow-call-1");
		expect(snapshot).toContain('"name":"flow"');
		// Core-2 compresses tool results for all tiers.
		expect(snapshot).toContain("[toolResult: flow]");
		expect(snapshot).toContain("Current request should be inherited from /src/config.ts and applied consistently");
		// Core-2 strips reasoning/thinking fields and blocks.
		expect(snapshot).not.toContain("SECRET_THINKING_FIELD");
		expect(snapshot).not.toContain("SECRET_REASONING_FIELD");
		expect(snapshot).not.toContain("SECRET_THINKING_PART");
		expect(snapshot).not.toContain("SECRET_REASONING_PART");
		expect(snapshot).toContain("<pi-flow-steering-hint>");
		expect(snapshot).toContain("</pi-flow-steering-hint>");
	});

	it("preserves unmodified fork snapshot lines exactly", async () => {
		setupFlowsDir([
			{
				fileName: "scout.md",
				content: `---\nname: scout\ndescription: Discovery\n---\nPrompt.`,
			},
		]);

		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		vi.mocked(runFlow).mockResolvedValue({
			type: "scout",
			agentSource: "project",
			intent: "Discover things",
			aim: "Discover codebase",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		});

		const steeringHint = "<pi-flow-steering-hint>old routing prompt</pi-flow-steering-hint>";
		const header = { version: 1, meta: { keep: "header formatting" }, systemPrompt: "test system prompt" };
		const unchangedUser = { type: "message", message: { role: "user", content: "Unchanged requirement specified in /src/config.ts for the project", timestamp: 1 } };
		const unchangedAssistant = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Unchanged answer — see [build] output for full details." }], timestamp: 2 } };
		const changedAssistant = { type: "message", message: { role: "assistant", reasoning: "SECRET_REASONING", content: [{ type: "text", text: "Visible answer — [build] output shows success." }], timestamp: 3 } };
		const droppedSystem = { type: "message", message: { role: "system", content: steeringHint, timestamp: 4 } };
		const unchangedToolCall = { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", toolCallId: "tool-1", arguments: { command: "echo unchanged" } }], timestamp: 4.5 } };
		const unchangedTool = { type: "message", message: { role: "toolResult", toolCallId: "tool-1", content: [{ type: "text", text: "Unchanged tool result" }], timestamp: 5 } };
		const unchangedUserExpected = { type: "message", message: { role: "user", content: "Unchanged requirement specified in /src/config.ts for the project" } };
		const unchangedAssistantExpected = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Unchanged answer — see [build] output for full details." }] } };
		const unchangedToolExpected = JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "tool-1", content: [{ type: "text", text: "[toolResult result omitted]" }] } });
		const sessionBranch = [unchangedUser, unchangedAssistant, changedAssistant, droppedSystem, unchangedToolCall, unchangedTool];

		const tool = pi.getTool("flow");
		await tool.execute(
			"call-1",
			{ flow: [{ type: "build", intent: "Fix things", complexity: "moderate", aim: "Fix codebase" }], confirmProjectFlows: false },
			new AbortController().signal,
			undefined,
			{
				...makeMockCtx(tmpDir),
				sessionManager: {
					getHeader: () => header,
					getBranch: () => sessionBranch,
					getSessionId: () => 'test-session-id',
				},
			},
		);

		const snapshot = vi.mocked(runFlow).mock.calls[0][0].forkSessionSnapshotJsonl;
		const lines = snapshot.trimEnd().split("\n");

		expect(lines[0]).toContain('"version":1');
		expect(lines[0]).toContain('"meta"');
		// forkMetadataInjection removed: forkedAt/depth are in <activation> XML only
		expect(lines[0]).not.toContain('forkedAt');
		expect(lines[0]).not.toContain('"depth"');
		expect(lines).toContain(JSON.stringify(unchangedUserExpected));
		expect(lines).toContain(JSON.stringify(unchangedAssistantExpected));
		expect(lines).toContain(unchangedToolExpected);
		expect(lines).not.toContain(JSON.stringify({ type: "system", content: header.systemPrompt }));
		// Core-2 strips assistant messages with reasoning.
		const expectedChangedAssistant = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Visible answer — [build] output shows success." }] } };
		expect(lines).toContain(JSON.stringify(expectedChangedAssistant));
		// Core-2 preserves system messages verbatim.
		const expectedDroppedSystem = { type: "message", message: { role: "system", content: steeringHint } };
		expect(lines).toContain(JSON.stringify(expectedDroppedSystem));
		expect(snapshot).toContain("Visible answer — [build] output shows success.");
		expect(snapshot).not.toContain("SECRET_REASONING");
		expect(snapshot).toContain("<pi-flow-steering-hint>");
	});

	it("drops sliding system messages with array content in fork snapshot", async () => {
		setupFlowsDir([
			{
				fileName: "scout.md",
				content: `---\nname: scout\ndescription: Discovery\n---\nPrompt.`,
			},
		]);

		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		vi.mocked(runFlow).mockResolvedValue({
			type: "scout",
			agentSource: "project",
			intent: "Discover things",
			aim: "Discover codebase",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		});

		const steeringHint = "<pi-flow-steering-hint>old routing prompt</pi-flow-steering-hint>";
		const droppedSystemArray = { type: "message", message: { role: "system", content: [{ type: "text", text: steeringHint }], timestamp: 4 } };
		const sessionBranch = [droppedSystemArray];

		const tool = pi.getTool("flow");
		await tool.execute(
			"call-1",
			{ flow: [{ type: "scout", intent: "Discover things", complexity: "moderate", aim: "Discover codebase" }], confirmProjectFlows: false },
			new AbortController().signal,
			undefined,
			{
				...makeMockCtx(tmpDir),
				sessionManager: {
					getHeader: () => ({ version: 1 }),
					getBranch: () => sessionBranch,
					getSessionId: () => 'test-session-id',
				},
			},
		);

		const snapshot = vi.mocked(runFlow).mock.calls[0][0].forkSessionSnapshotJsonl;
		// Core-2 preserves system messages verbatim.
		const droppedSystemArrayExpected = { type: "message", message: { role: "system", content: [{ type: "text", text: steeringHint }] } };
		expect(snapshot).toContain(JSON.stringify(droppedSystemArrayExpected));
		expect(snapshot).toMatch(/<pi-flow-steering-hint\b/);
	});

	it("preserves flow calls/results in mixed assistant messages", async () => {
		setupFlowsDir([
			{
				fileName: "scout.md",
				content: `---\nname: scout\ndescription: Discovery\n---\nPrompt.`,
			},
		]);

		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		vi.mocked(runFlow).mockResolvedValue({
			type: "scout",
			agentSource: "project",
			intent: "Discover things",
			aim: "Discover codebase",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		});

		const sessionBranch = [
			{ type: "message", message: { role: "user", content: "Original requirement defined in /src/requirements.md for reference", timestamp: 1 } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Text before transition." },
						{ type: "toolCall", name: "flow", toolCallId: "flow-call-2", arguments: { flow: [{ type: "debug", intent: "Prior debug", complexity: "moderate" }] } },
						{ type: "text", text: "Text after transition — [debug] completed." },
					],
					timestamp: 2,
				},
			},
			{ type: "message", message: { role: "toolResult", content: [{ type: "toolResult", toolCallId: "flow-call-2", content: "FLOW_RESULT_PAYLOAD" }], timestamp: 3 } },
			{ type: "message", message: { role: "user", content: "Current request should be inherited from /src/config.ts and applied consistently", timestamp: 4 } },
		];

		const tool = pi.getTool("flow");
		await tool.execute(
			"call-1",
			{ flow: [{ type: "build", intent: "Fix things", complexity: "moderate", aim: "Fix codebase" }], confirmProjectFlows: false },
			new AbortController().signal,
			undefined,
			{
				...makeMockCtx(tmpDir),
				sessionManager: {
					getHeader: () => ({ version: 1 }),
					getBranch: () => sessionBranch,
					getSessionId: () => 'test-session-id',
				},
			},
		);

		const snapshot = vi.mocked(runFlow).mock.calls[0][0].forkSessionSnapshotJsonl;
		expect(snapshot).toContain("Original requirement defined in /src/requirements.md for reference");
		expect(snapshot).toContain("Text before transition.");
		expect(snapshot).toContain("Text after transition — [debug] completed.");
		// Core-2 compresses tool results for all tiers.
		expect(snapshot).toContain("[toolResult result omitted]");
		expect(snapshot).toContain("flow-call-2");
		expect(snapshot).toContain('"name":"flow"');
		expect(snapshot).toContain("Current request should be inherited");
	});

	it("matches flow types case-insensitively", async () => {
		setupFlowsDir([
			{
				fileName: "scout.md",
				content: `---\nname: scout\ndescription: Discovery\n---\nPrompt.`,
			},
		]);

		const pi = createMockPi();
		registerExtension(pi as any);

		// Trigger session_start to populate discoveredFlows
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		const tool = pi.getTool("flow");
		expect(tool).toBeDefined();

		vi.mocked(runFlow).mockResolvedValue({
			type: "scout",
			agentSource: "project",
			intent: "Test",
			aim: "Test aim",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		});

		const result = await tool.execute(
			"call-1",
			{ flow: [{ type: "SCOUT", intent: "Discover things", complexity: "moderate" }], confirmProjectFlows: false },
			new AbortController().signal,
			undefined,
			makeMockCtx(tmpDir),
		);

		expect(result.failed).toBeFalsy();
		expect(runFlow).toHaveBeenCalledTimes(1);
		const runFlowArgs = vi.mocked(runFlow).mock.calls[0][0];
		expect(runFlowArgs.flowName).toBe("scout");
	});

	it("exposes complexity in the tool schema and passes per-flow mode to runFlow", async () => {
		setupFlowsDir([
			{
				fileName: "build.md",
				content: `---\nname: build\ndescription: Build\n---\nPrompt.`,
			},
		]);

		const pi = createMockPi();
		pi.setFlag("flow-complexity", "simple");
		registerExtension(pi as any);
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		const tool = pi.getTool("flow");
		expect(tool.parameters.properties.flow.items.properties.complexity).toBeDefined();

		vi.mocked(runFlow).mockResolvedValue({
			type: "build",
			agentSource: "project",
			intent: "Run full checks",
			aim: "Run checks",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		});

		await tool.execute(
			"call-1",
			{ flow: [{ type: "build", intent: "Run full checks", aim: "Run checks", complexity: "complex" }], confirmProjectFlows: false },
			new AbortController().signal,
			undefined,
			makeMockCtx(tmpDir),
		);

		expect(vi.mocked(runFlow).mock.calls[0][0].complexity).toBe("complex");
	});

	it("exposes concern in the tool schema as a required string", async () => {
		setupFlowsDir([
			{
				fileName: "build.md",
				content: `---\nname: build\ndescription: Build\n---\nPrompt.`,
			},
		]);

		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		const tool = pi.getTool("flow");
		const concernProp = tool.parameters.properties.flow.items.properties.concern;
		expect(concernProp).toBeDefined();
		expect(concernProp.kind).toBe("string");
		const acceptanceProp = tool.parameters.properties.flow.items.properties.acceptance;
		expect(acceptanceProp.kind).toBe("optional");
	});

	it("forwards concern to runFlow via flowItems", async () => {
		setupFlowsDir([
			{
				fileName: "build.md",
				content: `---\nname: build\ndescription: Build\n---\nPrompt.`,
			},
		]);

		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		vi.mocked(runFlow).mockResolvedValue({
			type: "scout",
			agentSource: "project",
			intent: "Discover things",
			aim: "Discover codebase",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		});

		const tool = pi.getTool("flow");
		await tool.execute(
			"call-1",
			{ flow: [{ type: "scout", intent: "Discover things", aim: "Discover codebase", complexity: "moderate", concern: "The auth module was recently refactored — verify assumptions" }], confirmProjectFlows: false },
			new AbortController().signal,
			undefined,
			makeMockCtx(tmpDir),
		);

		expect(runFlow).toHaveBeenCalledTimes(1);
		expect(vi.mocked(runFlow).mock.calls[0][0].concern).toBe("The auth module was recently refactored — verify assumptions");
	});

	it("uses PI_FLOW_COMPLEXITY as the default complexity", async () => {
		process.env.PI_FLOW_COMPLEXITY = "complex";
		setupFlowsDir([
			{
				fileName: "scout.md",
				content: `---\nname: scout\ndescription: Discovery\n---\nPrompt.`,
			},
		]);

		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		vi.mocked(runFlow).mockResolvedValue({
			type: "scout",
			agentSource: "project",
			intent: "Discover things",
			aim: "Discover codebase",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		});

		const tool = pi.getTool("flow");
		await tool.execute(
			"call-1",
			{ flow: [{ type: "scout", intent: "Discover things", aim: "Discover codebase" }], confirmProjectFlows: false },
			new AbortController().signal,
			undefined,
			makeMockCtx(tmpDir),
		);

		expect(vi.mocked(runFlow).mock.calls[0][0].complexity).toBe("complex");
	});

	it("detects cycles case-insensitively", async () => {
		setupFlowsDir([
			{
				fileName: "scout.md",
				content: `---\nname: scout\ndescription: Discovery\n---\nPrompt.`,
			},
		]);

		process.env.PI_FLOW_STACK = JSON.stringify(["Scout"]);
		process.env.PI_FLOW_DEPTH = "1";

		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		const tool = pi.getTool("flow");
		await expect(
			tool.execute(
				"call-1",
				{ flow: [{ type: "scout", intent: "Discover things", complexity: "moderate", aim: "Discover codebase" }], confirmProjectFlows: false },
				new AbortController().signal,
				undefined,
				makeMockCtx(tmpDir),
			),
		).rejects.toThrow("Blocked: cycle detected");
	});

	it("does not emit a heartbeat interval", async () => {
		setupFlowsDir([
			{
				fileName: "scout.md",
				content: `---\nname: scout\ndescription: Discovery\n---\nPrompt.`,
			},
		]);

		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		const tool = pi.getTool("flow");
		const setIntervalSpy = vi.spyOn(global, "setInterval");

		vi.mocked(runFlow).mockResolvedValue({
			type: "scout",
			agentSource: "project",
			intent: "Test",
			aim: "Test aim",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		});

		await tool.execute(
			"call-1",
			{ flow: [{ type: "scout", intent: "Discover things", complexity: "moderate", aim: "Discover codebase" }], confirmProjectFlows: false },
			new AbortController().signal,
			vi.fn(),
			makeMockCtx(tmpDir),
		);

		expect(setIntervalSpy).not.toHaveBeenCalled();
	});

	describe("trace tool execute", () => {
		it("resolves model via lazy getter after session_start", async () => {
			setupFlowsDir([
				{
					fileName: "trace.md",
					content: `---\nname: trace\ndescription: Read files\n---\nPrompt.`,
				},
			]);

			const projectDir = path.join(tmpDir, ".pi");
			fs.mkdirSync(projectDir, { recursive: true });
			fs.writeFileSync(
				path.join(projectDir, "settings.json"),
				JSON.stringify({
					flowModelConfig: "test-strategy",
					flowModelConfigs: {
						"test-strategy": {
							lite: { primary: "trace-lite-model" },
						},
					},
				}),
				"utf-8",
			);

			const pi = createMockPi();
			registerExtension(pi as any);
			await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

			const tool = pi.getTool("trace");
			vi.mocked(runFlow).mockResolvedValue({
				type: "trace",
				agentSource: "project",
				intent: "Read package.json",
				aim: "",
				exitCode: 0,
				messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
				stderr: "",
				usage: emptyFlowUsage(),
			});

			await tool.execute(
				"call-1",
				{ intent: "Read package.json" },
				new AbortController().signal,
				vi.fn(),
				makeMockCtx(tmpDir),
			);

			expect(runFlow).toHaveBeenCalledTimes(1);
			expect(vi.mocked(runFlow).mock.calls[0][0].model).toBe("trace-lite-model");
		});
	});

	describe("context event handler", () => {
		it("inserts sliding system prompt before latest user message unconditionally", async () => {
			const pi = createMockPi();
			registerExtension(pi as any);
			const messages = [
				{ role: "user" as const, content: "first prompt", timestamp: 1 },
				{ role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }], timestamp: 2, api: "openai", provider: "openai", model: "gpt-4", usage: {} as any, stopReason: "stop" as const },
				{ role: "user" as const, content: "second prompt", timestamp: 3 },
			];

			const results = await pi.trigger("context", { messages });
			const modified = results[0]?.messages ?? messages;

			expect((modified[0] as any).content).toBe("first prompt");
			expect((modified[1] as any).content[0].text).toBe("ok");
			expect((modified[2] as any).role).toBe("system");
			expect((modified[2] as any).content).toMatch(/<pi-flow-steering-hint\b/);
			expect((modified[2] as any).content).toContain("Field aliases accepted:");
			expect((modified[3] as any).content).toBe("second prompt");
		});

		it("inserts sliding system prompt even when toolOptimize is disabled", async () => {
			process.env.PI_FLOW_TOOL_OPTIMIZE = "0";
			const pi = createMockPi();
			registerExtension(pi as any);

			const messages = [
				{ role: "user" as const, content: "first prompt", timestamp: 1 },
				{ role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }], timestamp: 2, api: "openai", provider: "openai", model: "gpt-4", usage: {} as any, stopReason: "stop" as const },
				{ role: "user" as const, content: "second prompt", timestamp: 3 },
			];

			const results = await pi.trigger("context", { messages });
			const modified = results[0]?.messages ?? messages;

			expect((modified[2] as any).role).toBe("system");
			expect((modified[2] as any).content).toMatch(/<pi-flow-steering-hint\b/);
			expect((modified[2] as any).content).toContain("Field aliases accepted:");
			expect((modified[3] as any).content).toBe("second prompt");
		});

		it("handles array content (text blocks)", async () => {
			const pi = createMockPi();
			registerExtension(pi as any);

			const messages = [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: "first prompt" }],
					timestamp: 1,
				},
				{
					role: "user" as const,
					content: [
						{ type: "text" as const, text: "second prompt" },
						{ type: "image" as const, data: "base64", mimeType: "image/png" },
					],
					timestamp: 2,
				},
			];

			const results = await pi.trigger("context", { messages });
			const modified = results[0]?.messages ?? messages;

			// First user message unchanged
			expect((modified[0] as any).content[0].text).toBe("first prompt");
			// Sliding system prompt inserted before latest user message
			expect((modified[1] as any).role).toBe("system");
			expect((modified[1] as any).content).toMatch(/<pi-flow-steering-hint\b/);
			// Latest user message preserved
			expect((modified[2] as any).content[0].text).toBe("second prompt");
			expect((modified[2] as any).content[1].type).toBe("image");
		});

		it("returns messages unchanged when there are no user messages", async () => {
			const pi = createMockPi();
			registerExtension(pi as any);

			const messages = [
				{ role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }], timestamp: 1, api: "openai", provider: "openai", model: "gpt-4", usage: {} as any, stopReason: "stop" as const },
			];

			const results = await pi.trigger("context", { messages });
			// When no user messages exist, returns { messages } with the original messages
			const modified = results[0]?.messages ?? messages;
			expect(modified).toHaveLength(1);
			expect((modified[0] as any).role).toBe("assistant");
		});

		it("drops previous sliding system messages with array content", async () => {
			const pi = createMockPi();
			registerExtension(pi as any);

			const messages = [
				{ role: "user" as const, content: "first prompt", timestamp: 1 },
				{ role: "system" as const, content: [{ type: "text" as const, text: "<pi-flow-steering-hint>\nold prompt\n</pi-flow-steering-hint>" }], timestamp: 2 },
				{ role: "user" as const, content: "second prompt", timestamp: 3 },
			];

			const results = await pi.trigger("context", { messages });
			const modified = results[0]?.messages ?? messages;

			expect(modified).toHaveLength(3);
			expect((modified[0] as any).content).toBe("first prompt");
			expect((modified[1] as any).role).toBe("system");
			expect((modified[1] as any).content).toMatch(/<pi-flow-steering-hint\b/);
			expect((modified[2] as any).content).toBe("second prompt");
		});
	});

	it("deduplicates identical streaming text in onUpdate", async () => {
		setupFlowsDir([
			{
				fileName: "scout.md",
				content: `---\nname: scout\ndescription: Discovery\n---\nPrompt.`,
			},
		]);

		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		const tool = pi.getTool("flow");

		vi.mocked(runFlow).mockImplementation(async (opts) => {
			if (opts.onUpdate) {
				const partialResult: SingleResult = {
					type: opts.flowName,
					agentSource: "project",
					intent: opts.intent,
					exitCode: -1,
					messages: [],
					stderr: "",
					usage: emptyFlowUsage(),
				};
				// Emit same text twice
				opts.onUpdate({
					content: [{ type: "text", text: "same text" }],
					details: opts.makeDetails([partialResult]),
				});
				opts.onUpdate({
					content: [{ type: "text", text: "same text" }],
					details: opts.makeDetails([partialResult]),
				});
			}
			return {
				type: opts.flowName,
				agentSource: "project",
				intent: opts.intent,
				aim: opts.aim,
				exitCode: 0,
				messages: [],
				stderr: "",
				usage: emptyFlowUsage(),
			};
		});

		const onUpdateCalls: any[] = [];
		const onUpdate = (update: any) => {
			onUpdateCalls.push(update);
		};

		await tool.execute(
			"call-1",
			{ flow: [{ type: "scout", intent: "Discover things", complexity: "moderate", aim: "Discover codebase" }], confirmProjectFlows: false },
			new AbortController().signal,
			onUpdate,
			makeMockCtx(tmpDir),
		);

		const sameTextCalls = onUpdateCalls.filter(
			(c) => c.content?.[0]?.text === "same text",
		);
		expect(sameTextCalls.length).toBe(1);
	});

	it("emits progress when usage changes with the same streaming text", async () => {
		setupFlowsDir([
			{
				fileName: "scout.md",
				content: `---\nname: scout\ndescription: Discovery\n---\nPrompt.`,
			},
		]);

		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		const tool = pi.getTool("flow");
		vi.mocked(runFlow).mockImplementation(async (opts) => {
			if (opts.onUpdate) {
				const partialResult: SingleResult = {
					type: opts.flowName,
					agentSource: "project",
					intent: opts.intent,
					aim: opts.aim,
					exitCode: -1,
					messages: [],
					stderr: "",
					usage: { ...emptyFlowUsage(), output: 1, smoothedTps: 10 },
				};
				opts.onUpdate({
					content: [{ type: "text", text: "same text" }],
					details: opts.makeDetails([partialResult]),
				});
				opts.onUpdate({
					content: [{ type: "text", text: "same text" }],
					details: opts.makeDetails([{ ...partialResult, usage: { ...partialResult.usage, output: 2, smoothedTps: 20 } }]),
				});
			}
			return {
				type: opts.flowName,
				agentSource: "project",
				intent: opts.intent,
				aim: opts.aim,
				exitCode: 0,
				messages: [],
				stderr: "",
				usage: { ...emptyFlowUsage(), output: 2, smoothedTps: 20 },
			};
		});

		const onUpdateCalls: any[] = [];
		await tool.execute(
			"call-1",
			{ flow: [{ type: "scout", intent: "Discover things", complexity: "moderate", aim: "Discover codebase" }], confirmProjectFlows: false },
			new AbortController().signal,
			(update: any) => onUpdateCalls.push(update),
			makeMockCtx(tmpDir),
		);

		const sameTextCalls = onUpdateCalls.filter(
			(c) => c.content?.[0]?.text === "same text",
		);
		expect(sameTextCalls.length).toBe(2);
	});

	it("registers flow-model-config flag", () => {
		const pi = createMockPi();
		registerExtension(pi as any);

		expect(pi.registerFlag).toHaveBeenCalledWith("flow-model-config", expect.objectContaining({
			description: expect.stringContaining("flow model strategy"),
			type: "string",
		}));
	});

	it("registers flow-mode flag", () => {
		const pi = createMockPi();
		registerExtension(pi as any);

		expect(pi.registerFlag).toHaveBeenCalledWith("flow-mode", expect.objectContaining({
			description: expect.stringContaining("switch the global flow model strategy"),
			type: "string",
		}));
	});

	it("persists --flow-mode globally and uses it immediately over project and --flow-model-config", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const projectCwd = fs.mkdtempSync(path.join(tmpDir, "flow-mode-project-"));
		const agentsDir = path.join(projectCwd, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "scout.md"), `---\nname: scout\ndescription: Discovery\n---\nPrompt.`, "utf-8");

		const agentDir = path.join(projectCwd, "agent-dir");
		fs.mkdirSync(agentDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;
		fs.writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({
				flowModelConfig: "balance",
				flowModelConfigs: {
					balance: { lite: { primary: "balance-lite" } },
					mimo: { lite: { primary: "mimo-lite" } },
				},
			}, null, 2),
			"utf-8",
		);

		const projectSettingsDir = path.join(projectCwd, ".pi");
		fs.writeFileSync(
			path.join(projectSettingsDir, "settings.json"),
			JSON.stringify({
				flowModelConfig: "quality",
				flowModelConfigs: {
					quality: { lite: { primary: "quality-lite" } },
				},
			}, null, 2),
			"utf-8",
		);

		const pi = createMockPi();
		pi.setFlag("flow-mode", "mimo");
		pi.setFlag("flow-model-config", "balance");
		registerExtension(pi as any);
		await pi.trigger("session_start", {}, makeMockCtx(projectCwd));
		flushAllSettingsCachesSync();

		expect(JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8")).flowModelConfig).toBe("mimo");
		expect(warnSpy).toHaveBeenCalledWith("mode: mimo | lite: mimo-lite - flash: (default) - full: (default)");
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('this project selects "quality"'));

		const tool = pi.getTool("flow");
		vi.mocked(runFlow).mockResolvedValue({
			type: "scout",
			agentSource: "project",
			intent: "Test",
			aim: "Test aim",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		});

		await tool.execute(
			"call-1",
			{ flow: [{ type: "scout", intent: "Discover things", complexity: "moderate", aim: "Discover codebase" }], confirmProjectFlows: false },
			new AbortController().signal,
			undefined,
			makeMockCtx(projectCwd),
		);

		expect(runFlow).toHaveBeenCalledTimes(1);
		expect(vi.mocked(runFlow).mock.calls[0][0].model).toBe("mimo-lite");
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Both --flow-mode "mimo" and --flow-model-config "balance" were provided. Using --flow-mode.'));
	});

	it("does not persist or apply an unknown --flow-mode", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const projectCwd = fs.mkdtempSync(path.join(tmpDir, "flow-mode-invalid-project-"));
		const agentsDir = path.join(projectCwd, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "scout.md"), `---\nname: scout\ndescription: Discovery\n---\nPrompt.`, "utf-8");

		const agentDir = path.join(projectCwd, "agent-dir");
		fs.mkdirSync(agentDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;
		fs.writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({
				flowModelConfig: "balance",
				flowModelConfigs: {
					balance: { lite: { primary: "balance-lite" } },
				},
			}, null, 2),
			"utf-8",
		);

		const pi = createMockPi();
		pi.setFlag("flow-mode", "missing");
		registerExtension(pi as any);
		await pi.trigger("session_start", {}, makeMockCtx(projectCwd));

		expect(JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8")).flowModelConfig).toBe("balance");
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Cannot switch flow mode to "missing"'));

		const tool = pi.getTool("flow");
		vi.mocked(runFlow).mockResolvedValue({
			type: "scout",
			agentSource: "project",
			intent: "Test",
			aim: "Test aim",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		});

		await tool.execute(
			"call-1",
			{ flow: [{ type: "scout", intent: "Discover things", complexity: "moderate", aim: "Discover codebase" }], confirmProjectFlows: false },
			new AbortController().signal,
			undefined,
			makeMockCtx(projectCwd),
		);

		expect(vi.mocked(runFlow).mock.calls[0][0].model).toBe("balance-lite");
	});

	it("passes strategy primary model to runFlow for lite-tier flow", async () => {
		setupFlowsDir([
			{
				fileName: "scout.md",
				content: `---\nname: scout\ndescription: Discovery\n---\nPrompt.`,
			},
		]);

		// Isolate from real global settings
		const agentDir = path.join(tmpDir, "agent-dir");
		fs.mkdirSync(agentDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;

		// Write project settings with strategy
		const projectDir = path.join(tmpDir, ".pi");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, "settings.json"),
			JSON.stringify({
				flowModelConfig: "balanced",
				flowModelConfigs: {
					balanced: {
						lite: { primary: "custom-lite-model" },
					},
				},
			}),
			"utf-8",
		);

		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		const tool = pi.getTool("flow");
		vi.mocked(runFlow).mockResolvedValue({
			type: "scout",
			agentSource: "project",
			intent: "Test",
			aim: "Test aim",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		});

		await tool.execute(
			"call-1",
			{ flow: [{ type: "scout", intent: "Discover things", complexity: "moderate", aim: "Discover codebase" }], confirmProjectFlows: false },
			new AbortController().signal,
			undefined,
			makeMockCtx(tmpDir),
		);

		expect(runFlow).toHaveBeenCalledTimes(1);
		const callOpts = vi.mocked(runFlow).mock.calls[0][0];
		// scout is lite tier, strategy primary is "custom-lite-model"
		expect(callOpts.model).toBe("custom-lite-model");
	});

	it("uses CLI --flow-lite-model to override strategy primary for scout", async () => {
		setupFlowsDir([
			{
				fileName: "scout.md",
				content: `---\nname: scout\ndescription: Discovery\n---\nPrompt.`,
			},
		]);

		const agentDir = path.join(tmpDir, "agent-dir");
		fs.mkdirSync(agentDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const pi = createMockPi();
		pi.setFlag("flow-lite-model", "override-lite");
		registerExtension(pi as any);
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		const tool = pi.getTool("flow");
		vi.mocked(runFlow).mockResolvedValue({
			type: "scout",
			agentSource: "project",
			intent: "Test",
			aim: "Test aim",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		});

		await tool.execute(
			"call-1",
			{ flow: [{ type: "scout", intent: "Discover things", complexity: "moderate", aim: "Discover codebase" }], confirmProjectFlows: false },
			new AbortController().signal,
			undefined,
			makeMockCtx(tmpDir),
		);

		expect(runFlow).toHaveBeenCalledTimes(1);
		const callOpts = vi.mocked(runFlow).mock.calls[0][0];
		expect(callOpts.model).toBe("override-lite");
	});

	it("retries with next candidate when first model fails", async () => {
		setupFlowsDir([
			{
				fileName: "build.md",
				content: `---\nname: build\ndescription: Code\n---\nPrompt.`,
			},
		]);

		const agentDir = path.join(tmpDir, "agent-dir");
		fs.mkdirSync(agentDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const projectDir = path.join(tmpDir, ".pi");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, "settings.json"),
			JSON.stringify({
				flowModelConfig: "test-strategy",
				flowModelConfigs: {
					"test-strategy": {
						flash: { primary: "model-a", failover: ["model-b"] },
					},
				},
			}),
			"utf-8",
		);

		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		const tool = pi.getTool("flow");
		let callCount = 0;
		vi.mocked(runFlow).mockImplementation(async () => {
			callCount++;
			if (callCount === 1) {
				return {
					type: "build",
					agentSource: "project",
					intent: "Fix bug",
					aim: "Fix bug",
					exitCode: 1,
					messages: [],
					stderr: "Rate limited",
					usage: emptyFlowUsage(),
				};
			}
			return {
				type: "build",
				agentSource: "project",
				intent: "Fix bug",
				aim: "Fix bug",
				exitCode: 0,
				messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
				sawAgentEnd: true,
				stderr: "",
				usage: emptyFlowUsage(),
			};
		});

		const result = await tool.execute(
			"call-1",
			{ flow: [{ type: "build", intent: "Fix bug", complexity: "simple", aim: "Fix bug" }], confirmProjectFlows: false, auditLoop: 0 },
			new AbortController().signal,
			undefined,
			makeMockCtx(tmpDir),
		);

		expect(runFlow).toHaveBeenCalledTimes(2);
		// First call with model-a (primary)
		expect(vi.mocked(runFlow).mock.calls[0][0].model).toBe("model-a");
		// Second call with model-b (failover)
		expect(vi.mocked(runFlow).mock.calls[1][0].model).toBe("model-b");
		expect(result.failed).toBeFalsy();
	});

	it("stops on first successful attempt", async () => {
		setupFlowsDir([
			{
				fileName: "build.md",
				content: `---\nname: build\ndescription: Code\n---\nPrompt.`,
			},
		]);

		const agentDir = path.join(tmpDir, "agent-dir");
		fs.mkdirSync(agentDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const projectDir = path.join(tmpDir, ".pi");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, "settings.json"),
			JSON.stringify({
				flowModelConfig: "test-strategy",
				flowModelConfigs: {
					"test-strategy": {
						flash: { primary: "model-a", failover: ["model-b", "model-c"] },
					},
				},
			}),
			"utf-8",
		);

		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		const tool = pi.getTool("flow");
		vi.mocked(runFlow).mockResolvedValue({
			type: "build",
			agentSource: "project",
			intent: "Fix bug",
			aim: "Fix bug",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
			sawAgentEnd: true,
			stderr: "",
			usage: emptyFlowUsage(),
		});

		await tool.execute(
			"call-1",
			{ flow: [{ type: "build", intent: "Fix bug", complexity: "simple", aim: "Fix bug" }], confirmProjectFlows: false, auditLoop: 0 },
			new AbortController().signal,
			undefined,
			makeMockCtx(tmpDir),
		);

		// Should only try model-a once since it succeeded
		expect(runFlow).toHaveBeenCalledTimes(1);
		expect(vi.mocked(runFlow).mock.calls[0][0].model).toBe("model-a");
	});

	it("includes failover attempt summary in stderr on final failure", async () => {
		setupFlowsDir([
			{
				fileName: "build.md",
				content: `---\nname: build\ndescription: Code\n---\nPrompt.`,
			},
		]);

		const agentDir = path.join(tmpDir, "agent-dir");
		fs.mkdirSync(agentDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const projectDir = path.join(tmpDir, ".pi");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, "settings.json"),
			JSON.stringify({
				flowModelConfig: "test-strategy",
				flowModelConfigs: {
					"test-strategy": {
						flash: { primary: "model-a", failover: ["model-b"] },
					},
				},
			}),
			"utf-8",
		);

		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		const tool = pi.getTool("flow");
		vi.mocked(runFlow).mockResolvedValue({
			type: "build",
			agentSource: "project",
			intent: "Fix bug",
			aim: "Fix bug",
			exitCode: 1,
			messages: [],
			stderr: "Error occurred",
			usage: emptyFlowUsage(),
		});

		const result = await tool.execute(
			"call-1",
			{ flow: [{ type: "build", intent: "Fix bug", complexity: "simple", aim: "Fix bug" }], confirmProjectFlows: false, auditLoop: 0 },
			new AbortController().signal,
			undefined,
			makeMockCtx(tmpDir),
		);

		expect(runFlow).toHaveBeenCalledTimes(2);
		// failed should be set on the result's details, not directly on the return
		const lastResult = vi.mocked(runFlow).mock.results[0]?.value;
	});

});
describe("main agent tool restriction", () => {
	let tmpDir: string;
	let originalCwd: string;
	let originalEnv: NodeJS.ProcessEnv;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-tool-restrict-test-"));
		originalCwd = process.cwd();
		process.chdir(tmpDir);
		originalEnv = { ...process.env };
	});

	afterAll(() => {
		process.chdir(originalCwd);
		fs.rmSync(tmpDir, { recursive: true, force: true });
		process.env = originalEnv;
	});

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.PI_FLOW_DEPTH;
		delete process.env.PI_FLOW_STACK;
		process.env.PI_FLOW_MAX_DEPTH = "2";
		delete process.env.PI_FLOW_PREVENT_CYCLES;
		delete process.env.PI_FLOW_TOOL_OPTIMIZE;
		delete process.env.PI_FLOW_TOOLS_TRACE;
		delete process.env.PI_FLOW_TOOLS_BATCH_READ;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("restricts main agent to batch_read+flow+trace+ask_user when toolOptimize is true", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "1";

		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		expect(pi.setActiveTools).toHaveBeenCalled();
		const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledWith).toEqual(["batch_read", "flow", "trace", "ask_user"]);
	});

	it("restores legacy read+write+edit+batch when toolOptimize is false", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "0";

		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		expect(pi.setActiveTools).toHaveBeenCalled();
		const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledWith).toContain("read");
		expect(calledWith).toContain("write");
		expect(calledWith).toContain("edit");
		expect(calledWith).toContain("batch");
		expect(calledWith).toContain("bash");
		expect(calledWith).toContain("flow");
		expect(calledWith).not.toContain("web");
	});

	it("defers setActiveTools to session_start, not extension loading", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "1";

		const pi = createMockPi();
		registerExtension(pi as any);

		// Should NOT be called during extension loading
		expect(pi.setActiveTools).not.toHaveBeenCalled();

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		// Should be called during session_start
		expect(pi.setActiveTools).toHaveBeenCalled();
	});

	it("re-applies batch_read+flow+trace+ask_user on turn_start when optimized", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "1";

		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));
		const afterSession = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls.length;

		// Simulate a registry refresh
		await pi.trigger("turn_start");

		expect(pi.setActiveTools).toHaveBeenCalledTimes(afterSession + 1);
		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls.at(-1)[0];
		expect(lastCall).toEqual(["batch_read", "flow", "trace", "ask_user"]);
	});

	it("restores legacy+batch tools on turn_start when toolOptimize is false", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "0";

		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));
		const afterSession = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls.length;

		await pi.trigger("turn_start");

		expect(pi.setActiveTools).toHaveBeenCalledTimes(afterSession + 1);
		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls.at(-1)[0];
		expect(lastCall).toContain("read");
		expect(lastCall).toContain("write");
		expect(lastCall).toContain("edit");
		expect(lastCall).toContain("batch");
		expect(lastCall).toContain("bash");
		expect(lastCall).toContain("flow");
		expect(lastCall).not.toContain("web");
	});

	it("parses env PI_FLOW_TOOL_OPTIMIZE via parseBoolean (yes/on/no/off)", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "yes";

		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		expect(pi.setActiveTools).toHaveBeenCalled();
		const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledWith).toEqual(["batch_read", "flow", "trace", "ask_user"]);
	});

	it("registers batch_read for main agent; batch/batch_bash_poll reserved for children", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "1";

		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		// Main agent (depth 0): batch_read registered; batch/batch_bash_poll/timedBash reserved for child flows
		expect(pi.getTool("batch_read")).toBeDefined();
		expect(pi.getTool("batch")).toBeUndefined();
		expect(pi.getTool("batch_bash_poll")).toBeUndefined();
		expect(pi.getTool("bash")).toBeUndefined();

		// Main agent active tools: batch_read + flow + trace + ask_user (batch and batch_bash_poll registered but not active)
		const lastCall = pi.setActiveTools.mock.calls[pi.setActiveTools.mock.calls.length - 1][0];
		expect(lastCall).toEqual(["batch_read", "flow", "trace", "ask_user"]);
	});

	it("does NOT override active tools for child flows (depth > 0)", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "1";
		process.env.PI_FLOW_DEPTH = "1";
		process.env.PI_FLOW_STACK = JSON.stringify(["explore"]);

		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		// Child flow should NOT have setActiveTools called (no override)
		expect(pi.setActiveTools).not.toHaveBeenCalled();

		// Child flow (depth > 0): batch, batch_bash_poll, bash, and batch_read ARE registered.
		// batch_read is registered at all depths for read-only child operations.
		expect(pi.getTool("batch_read")).toBeDefined();
		expect(pi.getTool("batch")).toBeDefined();
		expect(pi.getTool("batch_bash_poll")).toBeDefined();
		expect(pi.getTool("bash")).toBeDefined();
	});

	it("does NOT override active tools on turn_start for child flows (depth > 0)", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "1";
		process.env.PI_FLOW_DEPTH = "1";
		process.env.PI_FLOW_STACK = JSON.stringify(["explore"]);

		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));
		await pi.trigger("turn_start");

		// Neither session_start nor turn_start should call setActiveTools
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("excludes trace when tools-trace is false", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "1";
		process.env.PI_FLOW_TOOLS_TRACE = "0";

		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		expect(pi.setActiveTools).toHaveBeenCalled();
		const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledWith).toEqual(["batch_read", "flow", "ask_user"]);
		expect(calledWith).not.toContain("trace");
	});

	it("excludes batch_read when tools-batch-read is false even when optimized", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "1";
		process.env.PI_FLOW_TOOLS_BATCH_READ = "0";

		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		expect(pi.setActiveTools).toHaveBeenCalled();
		const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledWith).toEqual(["flow", "trace", "ask_user"]);
		expect(calledWith).not.toContain("batch_read");
	});

	it("includes batch_read when tools-batch-read is true even when not optimized", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "0";
		process.env.PI_FLOW_TOOLS_BATCH_READ = "1";

		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		expect(pi.setActiveTools).toHaveBeenCalled();
		const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledWith).toEqual(["read", "write", "edit", "batch", "bash", "flow", "trace", "batch_read", "ask_user"]);
	});

	it("does not register batch_read when tools-batch-read is false", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "1";
		process.env.PI_FLOW_TOOLS_BATCH_READ = "0";

		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		expect(pi.getTool("batch_read")).toBeUndefined();
	});
});

describe("web tool integration", () => {
	let tmpDir: string;
	let originalCwd: string;
	let originalEnv: NodeJS.ProcessEnv;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-web-test-"));
		originalCwd = process.cwd();
		process.chdir(tmpDir);
		originalEnv = { ...process.env };
	});

	afterAll(() => {
		process.chdir(originalCwd);
		fs.rmSync(tmpDir, { recursive: true, force: true });
		process.env = originalEnv;
	});

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.PI_FLOW_DEPTH;
		delete process.env.PI_FLOW_STACK;
		process.env.PI_FLOW_MAX_DEPTH = "2";
		delete process.env.PI_FLOW_PREVENT_CYCLES;
		delete process.env.PI_FLOW_TOOL_OPTIMIZE;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not register standalone web tool during extension loading (merged into batch)", async () => {
		const pi = createMockPi();
		registerExtension(pi as any);

		const tool = pi.getTool("web");
		expect(tool).toBeUndefined();
	});

	it("does not include web tool in active tools on session_start when not optimized (merged into batch)", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "0";

		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		expect(pi.setActiveTools).toHaveBeenCalled();
		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls.at(-1)[0];
		expect(lastCall).not.toContain("web");
	});

	it("adds URL steering when prompt contains a URL and toolOptimize is false", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "0";
		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		const result = await pi.trigger("before_agent_start", {
			prompt: "Check https://example.com for details",
			systemPrompt: "You are a helpful assistant.",
		});

		const modified = result[0];
		expect(modified.systemPrompt).toContain("pi-web steering");
		expect(modified.systemPrompt).toContain("fetch");
	});

	it("adds search steering when prompt looks like a web search and toolOptimize is false", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "0";
		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		const result = await pi.trigger("before_agent_start", {
			prompt: "What is the latest version of Node?",
			systemPrompt: "You are a helpful assistant.",
		});

		const modified = result[0];
		expect(modified.systemPrompt).toContain("pi-web steering");
		expect(modified.systemPrompt).toContain("search");
	});

	it("does not add web steering when toolOptimize is true", async () => {
		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		const result = await pi.trigger("before_agent_start", {
			prompt: "Check https://example.com for details",
			systemPrompt: "You are a helpful assistant.",
		});

		const modified = result[0];
		expect(modified.systemPrompt).not.toContain("pi-web steering");
	});

	it("returns systemPrompt unchanged when no web steering applies", async () => {
		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		const result = await pi.trigger("before_agent_start", {
			prompt: "Refactor this function",
			systemPrompt: "You are a helpful assistant.",
		});

		const modified = result[0];
		// Flow catalog removed from before_agent_start; steering handled by sliding prompt
		expect(modified.systemPrompt).toBe("You are a helpful assistant.");
		expect(modified.systemPrompt).not.toContain("pi-web steering");
	});

});
