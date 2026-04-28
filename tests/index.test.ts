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
		delete process.env.PI_FLOW_MAX_DEPTH;
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
				fileName: "explore.md",
				content: `---\nname: explore\ndescription: Discovery\n---\nPrompt.`,
			},
		]);

		const pi = createMockPi();
		registerExtension(pi as any);

		// Trigger session_start to populate discoveredFlows
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		const tool = pi.getTool("flow");
		expect(tool).toBeDefined();

		vi.mocked(runFlow).mockResolvedValue({
			type: "explore",
			agentSource: "project",
			intent: "Test",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		});

		const result = await tool.execute(
			"call-1",
			{ flow: [{ type: "EXPLORE", intent: "Discover things" }], confirmProjectFlows: false },
			new AbortController().signal,
			undefined,
			makeMockCtx(tmpDir),
		);

		expect(result.isError).toBeFalsy();
		expect(runFlow).toHaveBeenCalledTimes(1);
		const runFlowArgs = vi.mocked(runFlow).mock.calls[0][0];
		expect(runFlowArgs.flowName).toBe("explore");
	});

	it("detects cycles case-insensitively", async () => {
		setupFlowsDir([
			{
				fileName: "explore.md",
				content: `---\nname: explore\ndescription: Discovery\n---\nPrompt.`,
			},
		]);

		process.env.PI_FLOW_STACK = JSON.stringify(["Explore"]);
		process.env.PI_FLOW_DEPTH = "1";

		const pi = createMockPi();
		registerExtension(pi as any);

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		const tool = pi.getTool("flow");
		const result = await tool.execute(
			"call-1",
			{ flow: [{ type: "explore", intent: "Discover things" }], confirmProjectFlows: false },
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
				fileName: "explore.md",
				content: `---\nname: explore\ndescription: Discovery\n---\nPrompt.`,
			},
		]);

		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		const tool = pi.getTool("flow");
		const setIntervalSpy = vi.spyOn(global, "setInterval");

		vi.mocked(runFlow).mockResolvedValue({
			type: "explore",
			agentSource: "project",
			intent: "Test",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		});

		await tool.execute(
			"call-1",
			{ flow: [{ type: "explore", intent: "Discover things" }], confirmProjectFlows: false },
			new AbortController().signal,
			vi.fn(),
			makeMockCtx(tmpDir),
		);

		expect(setIntervalSpy).not.toHaveBeenCalled();
	});

	it("deduplicates identical streaming text in onUpdate", async () => {
		setupFlowsDir([
			{
				fileName: "explore.md",
				content: `---\nname: explore\ndescription: Discovery\n---\nPrompt.`,
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
			{ flow: [{ type: "explore", intent: "Discover things" }], confirmProjectFlows: false },
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
