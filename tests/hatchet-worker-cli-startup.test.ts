import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyFlowUsage } from "../src/types/flow.js";

vi.mock("@hatchet-dev/typescript-sdk/v1/client/client.js", () => {
	throw new Error("hatchet sdk should not load during worker CLI import");
});

vi.mock("../src/batch/render.js", () => {
	throw new Error("batch/render must not load during worker CLI startup");
});

vi.mock("../src/core/flow.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/flow.js")>();
	return {
		...actual,
		runFlow: vi.fn(async (opts: any) => ({
			type: opts.flowName,
			agentSource: "project",
			intent: opts.intent,
			aim: opts.aim,
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		})),
	};
});

function makePayload() {
	const cwd = process.cwd();
	return {
		cwd,
		flows: [
			{
				name: "build",
				description: "Code",
				systemPrompt: "Prompt",
				source: "project",
				filePath: `${cwd}/.pi/agents/build.md`,
			},
		],
		flowName: "build",
		intent: "Implement feature",
		aim: "Implement feature",
		forkSessionSnapshotJsonl: null,
		parentDepth: 1,
		parentFlowStack: ["craft"],
		maxDepth: 3,
		preventCycles: true,
		toolOptimize: true,
		structuredOutput: true,
		model: "test-model",
		makeDetails: () => ({
			mode: "flow",
			flowStyle: "fork",
			projectAgentsDir: null,
			results: [],
		}),
	};
}

describe("Hatchet worker CLI startup", () => {
	afterEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
	});

	it("can be imported without loading batch render dependencies or the Hatchet SDK client", async () => {
		const cli = await import("../src/hatchet-worker-cli.js");
		expect(cli.resolveHatchetWorkerName({} as NodeJS.ProcessEnv)).toBe("pi-agent-flow-worker");
	});

	it("can execute a Hatchet worker task without loading batch render dependencies", async () => {
		const { serializeHatchetFlowPayload } = await import("../src/hatchet-payload.js");
		const { runHatchetFlowTask } = await import("../src/hatchet-runner.js");
		const payload = serializeHatchetFlowPayload(makePayload() as any);
		const result = await runHatchetFlowTask(payload);
		expect(result.exitCode).toBe(0);
	});
});
