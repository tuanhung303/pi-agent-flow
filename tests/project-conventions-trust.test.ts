import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeFlows, type FlowExecutorDeps } from "../src/flow/executor.js";
import { executeSingleFlow } from "../src/flow/execute-single.js";
import { emptyFlowUsage } from "../src/types/flow.js";

vi.mock("../src/flow/execute-single.js", () => ({ executeSingleFlow: vi.fn() }));

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
});
