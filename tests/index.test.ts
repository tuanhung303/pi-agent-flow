import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerExtension from "../index.js";
import { runFlow, mapFlowConcurrent } from "../flow.js";
import { emptyFlowUsage, type SingleResult } from "../types.js";

vi.mock("../flow.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../flow.js")>();
	return {
		...actual,
		runFlow: vi.fn(),
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

		const reminder = "\n\n[reminder_flow: If the answer is in context, reply; otherwise, delegate to the appropriate flow.]";
		const slidingPrompt = "<pi-flow-sliding-system>\nold routing prompt\n</pi-flow-sliding-system>";
		const sessionBranch = [
			{ type: "message", message: { role: "system", content: slidingPrompt, timestamp: 0 } },
			{ type: "message", message: { role: "user", content: `Keep this product requirement${reminder}`, timestamp: 1 } },
			{
				type: "message",
				message: {
					role: "assistant",
					thinking: "SECRET_THINKING_FIELD",
					reasoning: "SECRET_REASONING_FIELD",
					content: [
						{ type: "thinking", text: "SECRET_THINKING_PART" },
						{ type: "reasoning", text: "SECRET_REASONING_PART" },
						{ type: "text", text: `Normal assistant context${slidingPrompt}` },
					],
					timestamp: 2,
				},
			},
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", toolCallId: "bash-call-1", arguments: { command: "echo normal" } }], timestamp: 3 } },
			{ type: "message", message: { role: "tool", toolCallId: "bash-call-1", name: "bash", content: [{ type: "text", text: "normal bash output" }], timestamp: 4 } },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "flow", toolCallId: "flow-call-1", arguments: { flow: [{ type: "scout", intent: "Prior flow" }] } }], timestamp: 5 } },
			{ type: "message", message: { role: "tool", toolCallId: "flow-call-1", name: "flow", content: [{ type: "text", text: "prior flow result should be inherited" }], timestamp: 6 } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Implementation summary after delegation" }], timestamp: 7 } },
			{ type: "message", message: { role: "user", content: "Current request should be inherited", timestamp: 8 } },
		];

		const tool = pi.getTool("flow");
		await tool.execute(
			"call-1",
			{ flow: [{ type: "scout", intent: "Discover things", aim: "Discover codebase" }], confirmProjectFlows: false },
			new AbortController().signal,
			undefined,
			{
				...makeMockCtx(tmpDir),
				sessionManager: {
					getHeader: () => ({ version: 1 }),
					getBranch: () => sessionBranch,
				},
			},
		);

		expect(runFlow).toHaveBeenCalledTimes(1);
		const snapshot = vi.mocked(runFlow).mock.calls[0][0].forkSessionSnapshotJsonl;
		expect(snapshot).toContain("Keep this product requirement");
		expect(snapshot).toContain("Normal assistant context");
		expect(snapshot).toContain("bash-call-1");
		expect(snapshot).toContain("normal bash output");
		expect(snapshot).toContain("Implementation summary after delegation");
		expect(snapshot).toContain("flow-call-1");
		expect(snapshot).toContain('"name":"flow"');
		expect(snapshot).toContain("prior flow result should be inherited");
		expect(snapshot).toContain("Current request should be inherited");
		expect(snapshot).not.toContain("SECRET_THINKING_FIELD");
		expect(snapshot).not.toContain("SECRET_REASONING_FIELD");
		expect(snapshot).not.toContain("SECRET_THINKING_PART");
		expect(snapshot).not.toContain("SECRET_REASONING_PART");
		expect(snapshot).not.toContain("<pi-flow-sliding-system>");
		expect(snapshot).not.toContain("</pi-flow-sliding-system>");
		expect(snapshot).not.toContain("[reminder_flow:");
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

		const slidingPrompt = "<pi-flow-sliding-system>old routing prompt</pi-flow-sliding-system>";
		const header = { version: 1, meta: { keep: "header formatting" } };
		const unchangedUser = { type: "message", message: { role: "user", content: "Unchanged requirement", timestamp: 1 } };
		const unchangedAssistant = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Unchanged answer" }], timestamp: 2 } };
		const changedAssistant = { type: "message", message: { role: "assistant", reasoning: "SECRET_REASONING", content: [{ type: "text", text: "Visible answer" }], timestamp: 3 } };
		const droppedSystem = { type: "message", message: { role: "system", content: slidingPrompt, timestamp: 4 } };
		const unchangedTool = { type: "message", message: { role: "tool", toolCallId: "tool-1", content: [{ type: "text", text: "Unchanged tool result" }], timestamp: 5 } };
		const sessionBranch = [unchangedUser, unchangedAssistant, changedAssistant, droppedSystem, unchangedTool];

		const tool = pi.getTool("flow");
		await tool.execute(
			"call-1",
			{ flow: [{ type: "scout", intent: "Discover things", aim: "Discover codebase" }], confirmProjectFlows: false },
			new AbortController().signal,
			undefined,
			{
				...makeMockCtx(tmpDir),
				sessionManager: {
					getHeader: () => header,
					getBranch: () => sessionBranch,
				},
			},
		);

		const snapshot = vi.mocked(runFlow).mock.calls[0][0].forkSessionSnapshotJsonl;
		const lines = snapshot.trimEnd().split("\n");

		expect(lines).toContain(JSON.stringify(header));
		expect(lines).toContain(JSON.stringify(unchangedUser));
		expect(lines).toContain(JSON.stringify(unchangedAssistant));
		expect(lines).toContain(JSON.stringify(unchangedTool));
		expect(lines).not.toContain(JSON.stringify(changedAssistant));
		expect(lines).not.toContain(JSON.stringify(droppedSystem));
		expect(snapshot).toContain("Visible answer");
		expect(snapshot).not.toContain("SECRET_REASONING");
		expect(snapshot).not.toContain("<pi-flow-sliding-system>");
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
			{ type: "message", message: { role: "user", content: "Original requirement", timestamp: 1 } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Text before delegation." },
						{ type: "toolCall", name: "flow", toolCallId: "flow-call-2", arguments: { flow: [{ type: "debug", intent: "Prior debug" }] } },
						{ type: "text", text: "Text after delegation." },
					],
					timestamp: 2,
				},
			},
			{ type: "message", message: { role: "tool", content: [{ type: "toolResult", toolCallId: "flow-call-2", content: "FLOW_RESULT_PAYLOAD" }], timestamp: 3 } },
			{ type: "message", message: { role: "user", content: "Current request should be inherited", timestamp: 4 } },
		];

		const tool = pi.getTool("flow");
		await tool.execute(
			"call-1",
			{ flow: [{ type: "scout", intent: "Discover things", aim: "Discover codebase" }], confirmProjectFlows: false },
			new AbortController().signal,
			undefined,
			{
				...makeMockCtx(tmpDir),
				sessionManager: {
					getHeader: () => ({ version: 1 }),
					getBranch: () => sessionBranch,
				},
			},
		);

		const snapshot = vi.mocked(runFlow).mock.calls[0][0].forkSessionSnapshotJsonl;
		expect(snapshot).toContain("Original requirement");
		expect(snapshot).toContain("Text before delegation.");
		expect(snapshot).toContain("Text after delegation.");
		expect(snapshot).toContain("FLOW_RESULT_PAYLOAD");
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
			{ flow: [{ type: "SCOUT", intent: "Discover things" }], confirmProjectFlows: false },
			new AbortController().signal,
			undefined,
			makeMockCtx(tmpDir),
		);

		expect(result.isError).toBeFalsy();
		expect(runFlow).toHaveBeenCalledTimes(1);
		const runFlowArgs = vi.mocked(runFlow).mock.calls[0][0];
		expect(runFlowArgs.flowName).toBe("scout");
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
		const result = await tool.execute(
			"call-1",
			{ flow: [{ type: "scout", intent: "Discover things", aim: "Discover codebase" }], confirmProjectFlows: false },
			new AbortController().signal,
			undefined,
			makeMockCtx(tmpDir),
		);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Blocked: cycle detected");
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
			{ flow: [{ type: "scout", intent: "Discover things", aim: "Discover codebase" }], confirmProjectFlows: false },
			new AbortController().signal,
			vi.fn(),
			makeMockCtx(tmpDir),
		);

		expect(setIntervalSpy).not.toHaveBeenCalled();
	});

	describe("context event handler", () => {
			it("inserts sliding system prompt before latest user message when toolOptimize is enabled", async () => {
				process.env.PI_FLOW_TOOL_OPTIMIZE = "1";
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
				expect((modified[2] as any).content).toContain("<pi-flow-sliding-system>");
				expect((modified[2] as any).content).toContain("You are operating with pi-agent-flow routing.");
				expect((modified[3] as any).content).toBe("second prompt");
			});

		it("strips legacy reminders from all user messages and inserts sliding prompt when enabled", async () => {
			const reminder = "\n\n[reminder_flow: If the answer is in context, reply; otherwise, delegate to the appropriate flow.]";
			process.env.PI_FLOW_TOOL_OPTIMIZE = "1";
			const pi = createMockPi();
			registerExtension(pi as any);

			const messages = [
				{ role: "user" as const, content: `first prompt${reminder}`, timestamp: 1 },
				{ role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }], timestamp: 2, api: "openai", provider: "openai", model: "gpt-4", usage: {} as any, stopReason: "stop" as const },
				{ role: "user" as const, content: "second prompt", timestamp: 3 },
			];

			const results = await pi.trigger("context", { messages });
			const modified = results[0]?.messages ?? messages;

			// Legacy reminder stripped from first user message
			expect((modified[0] as any).content).toBe("first prompt");
			expect((modified[1] as any).content[0].text).toBe("ok");
			// Sliding system prompt inserted at position of last user message
			expect((modified[2] as any).role).toBe("system");
			expect((modified[2] as any).content).toContain("<pi-flow-sliding-system>");
			expect((modified[3] as any).content).toBe("second prompt");
		});

		it("handles array content (text blocks)", async () => {
			process.env.PI_FLOW_TOOL_OPTIMIZE = "1";
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
			expect((modified[1] as any).content).toContain("<pi-flow-sliding-system>");
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
			{ flow: [{ type: "scout", intent: "Discover things", aim: "Discover codebase" }], confirmProjectFlows: false },
			new AbortController().signal,
			onUpdate,
			makeMockCtx(tmpDir),
		);

		const sameTextCalls = onUpdateCalls.filter(
			(c) => c.content?.[0]?.text === "same text",
		);
		expect(sameTextCalls.length).toBe(1);
	});

	it("registers flow-model-config flag", () => {
		const pi = createMockPi();
		registerExtension(pi as any);

		expect(pi.registerFlag).toHaveBeenCalledWith("flow-model-config", expect.objectContaining({
			description: expect.stringContaining("flow model strategy"),
			type: "string",
		}));
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
			{ flow: [{ type: "scout", intent: "Discover things", aim: "Discover codebase" }], confirmProjectFlows: false },
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
			{ flow: [{ type: "scout", intent: "Discover things", aim: "Discover codebase" }], confirmProjectFlows: false },
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
			{ flow: [{ type: "build", intent: "Fix bug", aim: "Fix bug" }], confirmProjectFlows: false },
			new AbortController().signal,
			undefined,
			makeMockCtx(tmpDir),
		);

		expect(runFlow).toHaveBeenCalledTimes(2);
		// First call with model-a (primary)
		expect(vi.mocked(runFlow).mock.calls[0][0].model).toBe("model-a");
		// Second call with model-b (failover)
		expect(vi.mocked(runFlow).mock.calls[1][0].model).toBe("model-b");
		expect(result.isError).toBeFalsy();
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
			{ flow: [{ type: "build", intent: "Fix bug", aim: "Fix bug" }], confirmProjectFlows: false },
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
			{ flow: [{ type: "build", intent: "Fix bug", aim: "Fix bug" }], confirmProjectFlows: false },
			new AbortController().signal,
			undefined,
			makeMockCtx(tmpDir),
		);

		expect(runFlow).toHaveBeenCalledTimes(2);
		// isError should be set on the result's details, not directly on the return
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
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("restricts main agent to flow+web when toolOptimize is true", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "1";

		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		expect(pi.setActiveTools).toHaveBeenCalled();
		const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledWith).toEqual(["batch_read", "bash", "flow", "web"]);
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
		expect(calledWith).toContain("web");
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

	it("re-applies batch_read+bash+flow+web on turn_start when optimized", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "1";

		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));
		const afterSession = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls.length;

		// Simulate a registry refresh
		await pi.trigger("turn_start");

		expect(pi.setActiveTools).toHaveBeenCalledTimes(afterSession + 1);
		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls.at(-1)[0];
		expect(lastCall).toEqual(["batch_read", "bash", "flow", "web"]);
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
		expect(lastCall).toContain("web");
	});

	it("parses env PI_FLOW_TOOL_OPTIMIZE via parseBoolean (yes/on/no/off)", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "yes";

		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		expect(pi.setActiveTools).toHaveBeenCalled();
		const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(calledWith).toEqual(["batch_read", "bash", "flow", "web"]);
	});

	it("registers batch_read and batch globally; batch_read is active in main agent", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "1";

		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		// Both tools are registered
		expect(pi.getTool("batch_read")).toBeDefined();
		expect(pi.getTool("batch")).toBeDefined();

		// Main agent active tools use batch_read, not batch
		const lastCall = pi.setActiveTools.mock.calls[pi.setActiveTools.mock.calls.length - 1][0];
		expect(lastCall).toEqual(["batch_read", "bash", "flow", "web"]);
		expect(lastCall).not.toContain("batch");
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

	it("registers web tool during extension loading", async () => {
		const pi = createMockPi();
		registerExtension(pi as any);

		const tool = pi.getTool("web");
		expect(tool).toBeDefined();
		expect(tool.name).toBe("web");
	});

	it("includes web tool in active tools on session_start when not optimized", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "0";

		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		expect(pi.setActiveTools).toHaveBeenCalled();
		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls.at(-1)[0];
		expect(lastCall).toContain("web");
	});

	it("adds URL steering when prompt contains a URL", async () => {
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

	it("adds search steering when prompt looks like a web search", async () => {
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

	it("does not modify systemPrompt when web is not needed", async () => {
		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		const result = await pi.trigger("before_agent_start", {
			prompt: "Refactor this function",
			systemPrompt: "You are a helpful assistant.",
		});

		const modified = result[0];
		// Bundled flows are always discovered, so flow instructions are injected
		expect(modified.systemPrompt).toContain("## Flows");
		expect(modified.systemPrompt).toContain("Use inherited context as background while exploring alternatives.");
		expect(modified.systemPrompt).not.toContain("Start from a clean slate with only the intent.");
		expect(modified.systemPrompt).not.toContain("pi-web steering");
	});
});
