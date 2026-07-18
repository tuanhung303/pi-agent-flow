import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeFlows, type FlowExecutorDeps } from "../src/flow/executor.js";
import { executeSingleFlow } from "../src/flow/execute-single.js";
import { emptyFlowUsage } from "../src/types/flow.js";
import { createTraceTool } from "../src/tools/trace.js";
import { runFlowWithLiveSession } from "../src/flow/flow-live.js";

vi.mock("../src/flow/execute-single.js", () => ({ executeSingleFlow: vi.fn() }));
vi.mock("../src/flow/flow-live.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/flow/flow-live.js")>()),
	runFlowWithLiveSession: vi.fn(),
}));

const projectConventionPath = "/repo/.pi/agents/_conventions.md";

function makeDeps(overrides: Partial<FlowExecutorDeps> = {}): FlowExecutorDeps {
	return {
		flows: [{
			name: "build",
			description: "Build",
			systemPrompt: "Build prompt.",
			source: "bundled",
			filePath: "/package/agents/build.md",
			tier: "flash",
		}],
		currentDepth: 0,
		maxDepth: 0,
		ancestorFlowStack: [],
		preventCycles: true,
		toolOptimize: false,
		structuredOutput: false,
		cwd: "/repo",
		loadedFlowModelConfigs: { selectedName: "test", configs: {}, strategy: {} },
		maxConcurrency: 1,
		defaultComplexity: "snap",
		makeDetails: (results) => ({ mode: "flow", flowStyle: "fork", projectAgentsDir: null, results }),
		getFlag: () => undefined,
		tierOverrideResolver: () => undefined,
		forkSessionSnapshotJsonl: null,
		projectFlowsDir: "/repo/.pi/agents",
		sessionManager: { getHeader: () => ({}), getBranch: () => [], getSessionId: () => "test" },
		hasUI: true,
		uiConfirm: vi.fn(async () => true),
		debugMode: false,
		conventions: "PROJECT_CONVENTION",
		conventionsSource: "project",
		conventionsPath: projectConventionPath,
		fallbackConventions: "USER_CONVENTION",
		...overrides,
	};
}

async function execute(deps: FlowExecutorDeps) {
	return executeFlows(deps, [{ type: "build", intent: "Build it", aim: "Build", complexity: "snap" }], "call-1", 0);
}

const bundledAudit = {
	name: "audit",
	description: "Bundled audit",
	systemPrompt: "BUNDLED_AUDIT",
	source: "bundled" as const,
	filePath: "/package/agents/audit.md",
	tier: "flash" as const,
};

function makeGeneratedProjectAuditDeps(overrides: Partial<FlowExecutorDeps> = {}): FlowExecutorDeps {
	const base = makeDeps({
		conventions: "USER_CONVENTION",
		conventionsSource: "user",
		flows: [
			{
				name: "build",
				description: "Build",
				systemPrompt: "Build prompt.",
				source: "bundled",
				filePath: "/package/agents/build.md",
				tier: "flash",
			},
			{ ...bundledAudit, source: "project", systemPrompt: "PROJECT_AUDIT", filePath: "/repo/.pi/agents/audit.md" },
		],
		fallbackFlows: [bundledAudit],
	});
	return { ...base, ...overrides };
}

async function executeWithGeneratedAudit(deps: FlowExecutorDeps) {
	return executeFlows(deps, [{ type: "build", intent: "Build it", aim: "Build", complexity: "simple" }], "call-audit", 1);
}

describe("project convention trust gate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(executeSingleFlow).mockImplementation(async (_deps, item) => ({
			type: item.type,
			agentSource: "bundled",
			intent: item.intent,
			aim: item.aim,
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		}));
	});

	it("injects approved project conventions into a bundled flow", async () => {
		const deps = makeDeps();
		await execute(deps);

		expect(deps.uiConfirm).toHaveBeenCalledWith(
			"Run project-local flows?",
			expect.stringContaining(`Conventions: ${projectConventionPath}`),
		);
		expect(vi.mocked(executeSingleFlow).mock.calls[0][0].conventions).toBe("PROJECT_CONVENTION");
	});

	it("falls back when the confirmation is declined", async () => {
		const deps = makeDeps({ uiConfirm: vi.fn(async () => false) });
		await execute(deps);

		expect(vi.mocked(executeSingleFlow)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(executeSingleFlow).mock.calls[0][0].conventions).toBe("USER_CONVENTION");
	});

	it("blocks project conventions in non-UI mode by falling back", async () => {
		const deps = makeDeps({ hasUI: false });
		await execute(deps);

		expect(deps.uiConfirm).not.toHaveBeenCalled();
		expect(vi.mocked(executeSingleFlow).mock.calls[0][0].conventions).toBe("USER_CONVENTION");
	});

	it("omits conventions when no lower-scope fallback exists", async () => {
		const deps = makeDeps({ hasUI: false, fallbackConventions: undefined });
		await execute(deps);

		expect(vi.mocked(executeSingleFlow).mock.calls[0][0].conventions).toBeUndefined();
	});

	it("allows explicit trusted opt-out without prompting", async () => {
		const deps = makeDeps({ hasUI: false, confirmProjectFlows: false });
		await execute(deps);

		expect(deps.uiConfirm).not.toHaveBeenCalled();
		expect(vi.mocked(executeSingleFlow).mock.calls[0][0].conventions).toBe("PROJECT_CONVENTION");
	});

	it.each(["bundled", "user"] as const)("does not confirm %s conventions", async (source) => {
		const deps = makeDeps({ conventions: `${source}_CONVENTION`, conventionsSource: source, conventionsPath: `/safe/${source}/_conventions.md` });
		await execute(deps);

		expect(deps.uiConfirm).not.toHaveBeenCalled();
		expect(vi.mocked(executeSingleFlow).mock.calls[0][0].conventions).toBe(`${source}_CONVENTION`);
	});

	it("confirms a generated project audit before it spawns", async () => {
		const deps = makeGeneratedProjectAuditDeps();
		await executeWithGeneratedAudit(deps);

		expect(deps.uiConfirm).toHaveBeenCalledWith("Run project-local flows?", expect.stringContaining("Flows: audit"));
		expect(vi.mocked(executeSingleFlow).mock.calls).toHaveLength(2);
		expect(vi.mocked(executeSingleFlow).mock.calls[1][0].flows.find((flow) => flow.name === "audit")?.source).toBe("project");
	});

	it("falls back to the bundled audit when generated project audit approval is declined", async () => {
		const deps = makeGeneratedProjectAuditDeps({ uiConfirm: vi.fn(async () => false) });
		await executeWithGeneratedAudit(deps);

		expect(vi.mocked(executeSingleFlow).mock.calls).toHaveLength(2);
		const audit = vi.mocked(executeSingleFlow).mock.calls[1][0].flows.find((flow) => flow.name === "audit");
		expect(audit?.source).toBe("bundled");
		expect(audit?.systemPrompt).toBe("BUNDLED_AUDIT");
	});

	it("blocks a generated project audit in non-UI mode by using the bundled fallback", async () => {
		const deps = makeGeneratedProjectAuditDeps({ hasUI: false });
		await executeWithGeneratedAudit(deps);

		expect(deps.uiConfirm).not.toHaveBeenCalled();
		expect(vi.mocked(executeSingleFlow).mock.calls[1][0].flows.find((flow) => flow.name === "audit")?.source).toBe("bundled");
	});

	it("allows a generated project audit without prompting when explicitly trusted", async () => {
		const deps = makeGeneratedProjectAuditDeps({ hasUI: false, confirmProjectFlows: false });
		await executeWithGeneratedAudit(deps);

		expect(deps.uiConfirm).not.toHaveBeenCalled();
		expect(vi.mocked(executeSingleFlow).mock.calls[1][0].flows.find((flow) => flow.name === "audit")?.source).toBe("project");
	});

	it("does not confirm a bundled generated audit", async () => {
		const deps = makeGeneratedProjectAuditDeps({
			flows: [makeGeneratedProjectAuditDeps().flows[0], bundledAudit],
		});
		await executeWithGeneratedAudit(deps);

		expect(deps.uiConfirm).not.toHaveBeenCalled();
	});
});

async function invokeTrace(options: { approved?: boolean; hasUI?: boolean; confirmProjectFlows?: boolean; projectOverride?: boolean }) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-project-trace-"));
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-user-agents-"));
	const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	if (options.projectOverride !== false) {
		const projectAgents = path.join(cwd, ".pi", "agents");
		fs.mkdirSync(projectAgents, { recursive: true });
		fs.writeFileSync(path.join(projectAgents, "trace.md"), "---\nname: trace\ndescription: Project trace\ntier: lite\n---\nPROJECT_TRACE", "utf8");
	}
	const confirm = vi.fn(async () => options.approved ?? true);
	vi.mocked(runFlowWithLiveSession).mockResolvedValue({
		type: "trace",
		agentSource: "bundled",
		intent: "Trace",
		aim: "",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyFlowUsage(),
	} as any);
	const tool = createTraceTool({
		getSettings: () => ({ toolOptimize: false, structuredOutput: false, bodyVerbosity: "lite" }),
		getDepthConfig: () => ({ currentDepth: 0, maxDepth: 3, ancestorFlowStack: [], preventCycles: true }),
		fallbackModel: "fireworks/kimi-k2p6-turbo",
	});
	try {
		await tool.execute("trace-trust", { confirmProjectFlows: options.confirmProjectFlows }, new AbortController().signal, undefined, {
			cwd,
			hasUI: options.hasUI ?? true,
			ui: { confirm },
			sessionManager: { getHeader: () => ({}), getBranch: () => [], getSessionId: () => "trace-test" },
		} as any);
		return { confirm, runOptions: vi.mocked(runFlowWithLiveSession).mock.calls[0][2] };
	} finally {
		if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
}

describe("project trace trust gate", () => {
	beforeEach(() => vi.clearAllMocks());

	it("confirms a project trace override before it runs", async () => {
		const result = await invokeTrace({});
		expect(result.confirm).toHaveBeenCalledWith("Run project-local flows?", expect.stringContaining("Flows: trace"));
		expect(result.runOptions.flows.find((flow) => flow.name === "trace")?.source).toBe("project");
	});

	it("falls back to bundled trace when project trace approval is declined", async () => {
		const result = await invokeTrace({ approved: false });
		const trace = result.runOptions.flows.find((flow) => flow.name === "trace");
		expect(trace?.source).toBe("bundled");
		expect(trace?.systemPrompt).not.toContain("PROJECT_TRACE");
	});

	it("uses bundled trace in non-UI mode", async () => {
		const result = await invokeTrace({ hasUI: false });
		expect(result.confirm).not.toHaveBeenCalled();
		expect(result.runOptions.flows.find((flow) => flow.name === "trace")?.source).toBe("bundled");
	});

	it("allows an explicitly trusted project trace without prompting", async () => {
		const result = await invokeTrace({ hasUI: false, confirmProjectFlows: false });
		expect(result.confirm).not.toHaveBeenCalled();
		expect(result.runOptions.flows.find((flow) => flow.name === "trace")?.source).toBe("project");
	});

	it("does not confirm a bundled trace", async () => {
		const result = await invokeTrace({ projectOverride: false });
		expect(result.confirm).not.toHaveBeenCalled();
	});
});
