import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeSingleFlow } from "../src/flow/execute-single.js";
import { runFlow } from "../src/flow/runner.js";
import { emptyFlowUsage } from "../src/types/flow.js";
import { _clearSettingsCache } from "../src/config/config.js";
import type { FlowExecutorDeps, ExecuteFlowParams } from "../src/flow/executor.js";
import type { SingleResult } from "../src/types/flow.js";

vi.mock("../src/flow/runner.js", () => ({
	runFlow: vi.fn(),
}));

function makeDeps(overrides: Partial<FlowExecutorDeps> = {}): FlowExecutorDeps {
	return {
		flows: [{
			name: "scout",
			description: "Explore",
			systemPrompt: "scout",
			source: "bundled",
			filePath: "/agents/scout.md",
			tier: "lite",
		}],
		currentDepth: 0,
		maxDepth: 3,
		ancestorFlowStack: [],
		preventCycles: true,
		toolOptimize: true,
		structuredOutput: false,
		cwd: "/tmp",
		loadedFlowModelConfigs: {
			selectedName: "balance",
			configs: {},
			strategy: { lite: { primary: "openai/gpt-4o", failover: ["openai/gpt-4o-mini"] } },
		},
		maxConcurrency: 4,
		defaultComplexity: "snap",
		signal: undefined,
		onUpdate: undefined,
		makeDetails: (results) => ({ mode: "flow", flowStyle: "fork", projectAgentsDir: null, results }),
		getFlag: () => undefined,
		tierOverrideResolver: () => undefined,
		fallbackModel: undefined,
		forkSessionSnapshotJsonl: null,
		projectFlowsDir: null,
		sessionManager: { getHeader: () => null, getBranch: () => [], getSessionId: () => "s1" },
		hasUI: false,
		uiConfirm: async () => true,
		debugMode: false,
		subAgentMaxRetries: 2,
		subAgentBaseDelayMs: 10,
		...overrides,
	};
}

describe("executeSingleFlow invalid model guard", () => {
	let tmpDir: string;
	let originalHome: string | undefined;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-exec-invalid-test-"));
		originalHome = process.env.HOME;
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.HOME = tmpDir;
		process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, ".pi", "agent");
		_clearSettingsCache();
		vi.clearAllMocks();
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		if (originalAgentDir !== undefined) {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		} else {
			delete process.env.PI_CODING_AGENT_DIR;
		}
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeModelsJson(content: Record<string, unknown>) {
		const dir = process.env.PI_CODING_AGENT_DIR!;
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify(content, null, 2), "utf-8");
	}

	it("fails fast without calling runFlow when every configured model is missing from models.json", async () => {
		writeModelsJson({
			providers: {
				openai: {
					models: [{ id: "gpt-4o", contextWindow: 128000 }],
				},
			},
		});

		const allResults: SingleResult[] = [{
			type: "scout",
			agentSource: "bundled",
			intent: "test",
			aim: "test aim",
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		}];
		const item: ExecuteFlowParams = {
			type: "scout",
			intent: "test",
			aim: "test aim",
			complexity: "snap",
		};

		const loadedFlowModelConfigs = {
			selectedName: "balance",
			configs: {},
			strategy: { lite: { primary: "openai/gpt-5", failover: ["openai/gpt-5.5"] } },
		};
		const result = await executeSingleFlow(
			makeDeps({ loadedFlowModelConfigs }),
			item,
			allResults,
			0,
			"call-1",
			() => {},
			loadedFlowModelConfigs,
		);

		expect(vi.mocked(runFlow)).not.toHaveBeenCalled();
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/Bad settings: all configured flow models are missing from models\.json/);
		expect(result.errorMessage).toMatch(/Bad settings: all configured flow models are missing from models\.json/);
		expect(result.model).toBe("openai/gpt-5");
	});

	it("still runs when at least one configured model is known", async () => {
		writeModelsJson({
			providers: {
				openai: {
					models: [
						{ id: "gpt-4o", contextWindow: 128000 },
						{ id: "gpt-4o-mini", contextWindow: 128000 },
					],
				},
			},
		});

		const runFlowMock = vi.mocked(runFlow);
		runFlowMock.mockResolvedValue({
			type: "scout",
			agentSource: "bundled",
			intent: "test",
			aim: "test aim",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
			stderr: "",
			usage: emptyFlowUsage(),
			model: "openai/gpt-4o-mini",
		});

		const allResults: SingleResult[] = [{
			type: "scout",
			agentSource: "bundled",
			intent: "test",
			aim: "test aim",
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		}];
		const item: ExecuteFlowParams = {
			type: "scout",
			intent: "test",
			aim: "test aim",
			complexity: "snap",
		};

		const deps = makeDeps();
		const result = await executeSingleFlow(deps, item, allResults, 0, "call-1", () => {}, deps.loadedFlowModelConfigs);

		expect(runFlowMock).toHaveBeenCalled();
		expect(result.exitCode).toBe(0);
	});
});
