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
		it("appends reminder to the latest user message only", async () => {
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
			expect((modified[2] as any).content).toBe(
				"second prompt\n\n[reminder_flow: If the answer is in context, reply; otherwise, delegate to the appropriate flow.]",
			);
		});

		it("strips reminder from earlier user messages and moves it to latest", async () => {
			const reminder = "\n\n[reminder_flow: If the answer is in context, reply; otherwise, delegate to the appropriate flow.]";
			const pi = createMockPi();
			registerExtension(pi as any);

			const messages = [
				{ role: "user" as const, content: `first prompt${reminder}`, timestamp: 1 },
				{ role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }], timestamp: 2, api: "openai", provider: "openai", model: "gpt-4", usage: {} as any, stopReason: "stop" as const },
				{ role: "user" as const, content: "second prompt", timestamp: 3 },
			];

			const results = await pi.trigger("context", { messages });
			const modified = results[0]?.messages ?? messages;

			expect((modified[0] as any).content).toBe("first prompt");
			expect((modified[2] as any).content).toBe(`second prompt${reminder}`);
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

			expect((modified[0] as any).content[0].text).toBe("first prompt");
			expect((modified[1] as any).content[0].text).toBe(
				"second prompt\n\n[reminder_flow: If the answer is in context, reply; otherwise, delegate to the appropriate flow.]",
			);
			expect((modified[1] as any).content[1].type).toBe("image");
		});

		it("returns undefined when there are no user messages", async () => {
			const pi = createMockPi();
			registerExtension(pi as any);

			const messages = [
				{ role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }], timestamp: 1, api: "openai", provider: "openai", model: "gpt-4", usage: {} as any, stopReason: "stop" as const },
			];

			const results = await pi.trigger("context", { messages });
			expect(results[0]).toBeUndefined();
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
		expect(calledWith).toEqual(["batch", "bash", "flow", "web"]);
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

	it("re-applies batch+bash+flow+web on turn_start when optimized", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "1";

		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));
		const afterSession = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls.length;

		// Simulate a registry refresh
		await pi.trigger("turn_start");

		expect(pi.setActiveTools).toHaveBeenCalledTimes(afterSession + 1);
		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls.at(-1)[0];
		expect(lastCall).toEqual(["batch", "bash", "flow", "web"]);
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
		expect(calledWith).toEqual(["batch", "bash", "flow", "web"]);
	});

	it("registers batch globally and includes it in main agent active tools", async () => {
		process.env.PI_FLOW_TOOL_OPTIMIZE = "1";

		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		// batch IS registered and active in main agent
		expect(pi.getTool("batch")).toBeDefined();

		// Main agent active tools include batch when optimized
		const lastCall = pi.setActiveTools.mock.calls[pi.setActiveTools.mock.calls.length - 1][0];
		expect(lastCall).toEqual(["batch", "bash", "flow", "web"]);
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
		expect(modified.systemPrompt).not.toContain("pi-web steering");
	});
});
