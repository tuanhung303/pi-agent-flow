import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { emptyFlowUsage, type SingleResult } from "../src/types/flow.js";

vi.mock("../src/core/flow.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/flow.js")>();
	return {
		...actual,
		runFlow: vi.fn(async (opts: any): Promise<SingleResult> => ({
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

import { runFlow, type RunFlowOptions } from "../src/core/flow.js";
import { createFlowRunnerFromEnv, DEFAULT_LOCAL_FLOW_RUNNER } from "../src/flow-runner.js";
import {
	HATCHET_FLOW_TASK_NAME,
	HatchetFlowRunner,
	deserializeHatchetFlowPayload,
	runHatchetFlowTask,
	serializeHatchetFlowPayload,
	validateHatchetFlowPayloadSize,
	type HatchetFlowPayload,
} from "../src/hatchet-runner.js";

function options(overrides: Partial<RunFlowOptions> = {}): RunFlowOptions {
	return {
		cwd: "/repo",
		flows: [{ name: "build", description: "Code", systemPrompt: "Prompt", source: "project", filePath: "/repo/.pi/agents/build.md" }],
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
		makeDetails: (results) => ({ mode: "flow", flowStyle: "fork", projectAgentsDir: null, results }),
		...overrides,
	};
}

describe("Hatchet runner", () => {
	const originalSpawnCommand = process.env.PI_FLOW_SPAWN_COMMAND;
	const originalMaxPayloadBytes = process.env.PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES;

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.PI_FLOW_SPAWN_COMMAND;
		delete process.env.PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES;
	});

	afterEach(() => {
		if (originalSpawnCommand === undefined) delete process.env.PI_FLOW_SPAWN_COMMAND;
		else process.env.PI_FLOW_SPAWN_COMMAND = originalSpawnCommand;
		if (originalMaxPayloadBytes === undefined) delete process.env.PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES;
		else process.env.PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES = originalMaxPayloadBytes;
	});

	it("serializes only plain JSON runFlow payload fields", () => {
		const controller = new AbortController();
		const payload = serializeHatchetFlowPayload(options({
			signal: controller.signal,
			onUpdate: vi.fn(),
		}), "/repo/.pi/agents");

		expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
		expect(payload).toMatchObject({
			cwd: "/repo",
			flowName: "build",
			parentFlowStack: ["craft"],
			projectFlowsDir: "/repo/.pi/agents",
		});
		expect("signal" in payload).toBe(false);
		expect("onUpdate" in payload).toBe(false);
		expect("makeDetails" in payload).toBe(false);
	});

	it("submits final-result-only Hatchet task payload", async () => {
		const submitted: Array<{ taskName: string; payload: HatchetFlowPayload }> = [];
		const runner = new HatchetFlowRunner(async (taskName, payload) => {
			submitted.push({ taskName, payload });
			return {
				type: payload.flowName,
				agentSource: "project",
				intent: payload.intent,
				aim: payload.aim,
				exitCode: 0,
				messages: [],
				stderr: "from hatchet",
				usage: emptyFlowUsage(),
			};
		});

		const result = await runner.run(options({ onUpdate: vi.fn() }), { projectFlowsDir: "/repo/.pi/agents" });

		expect(result.stderr).toBe("from hatchet");
		expect(submitted).toHaveLength(1);
		expect(submitted[0].taskName).toBe(HATCHET_FLOW_TASK_NAME);
		expect(submitted[0].payload.projectFlowsDir).toBe("/repo/.pi/agents");
		expect("onUpdate" in submitted[0].payload).toBe(false);
	});

	it("selects Hatchet only when PI_FLOW_RUNNER=hatchet", () => {
		expect(createFlowRunnerFromEnv({} as NodeJS.ProcessEnv)).toBe(DEFAULT_LOCAL_FLOW_RUNNER);
		expect(createFlowRunnerFromEnv({ PI_FLOW_RUNNER: "local" } as NodeJS.ProcessEnv)).toBe(DEFAULT_LOCAL_FLOW_RUNNER);
		expect(createFlowRunnerFromEnv({ PI_FLOW_RUNNER: "hatchet" } as NodeJS.ProcessEnv)).toBeInstanceOf(HatchetFlowRunner);
	});

	it("worker entrypoint reconstructs runFlow options and defaults child spawn command to pi", async () => {
		const payload = serializeHatchetFlowPayload(options({ acceptance: "Done", cwd: process.cwd() }), "/repo/.pi/agents");
		await runHatchetFlowTask(payload);

		expect(process.env.PI_FLOW_SPAWN_COMMAND).toBe("pi");
		expect(runFlow).toHaveBeenCalledTimes(1);
		const calledWith = vi.mocked(runFlow).mock.calls[0][0];
		expect(calledWith.flowName).toBe("build");
		expect(calledWith.acceptance).toBe("Done");
		expect(calledWith.signal).toBeUndefined();
		expect(calledWith.onUpdate).toBeUndefined();
		expect(calledWith.makeDetails([{
			type: "build",
			agentSource: "project",
			intent: "i",
			aim: "a",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		}]).projectAgentsDir).toBe("/repo/.pi/agents");
	});

	it("preserves an explicit worker spawn command", async () => {
		process.env.PI_FLOW_SPAWN_COMMAND = " /custom/pi ";
		const payload = serializeHatchetFlowPayload(options({ cwd: process.cwd() }));

		await runHatchetFlowTask(payload);

		expect(process.env.PI_FLOW_SPAWN_COMMAND).toBe("/custom/pi");
	});

	it("rejects invalid worker spawn commands before running", async () => {
		process.env.PI_FLOW_SPAWN_COMMAND = "pi\nworker";
		const payload = serializeHatchetFlowPayload(options({ cwd: process.cwd() }));

		await expect(runHatchetFlowTask(payload)).rejects.toThrow("PI_FLOW_SPAWN_COMMAND must be a single command");
		expect(runFlow).not.toHaveBeenCalled();
	});

	it("rejects missing worker workspaces before running", async () => {
		const payload = serializeHatchetFlowPayload(options({ cwd: "/definitely/missing/pi-agent-flow" }));

		await expect(runHatchetFlowTask(payload)).rejects.toThrow("current checkout/workspace");
		expect(runFlow).not.toHaveBeenCalled();
	});

	it("rejects oversized Hatchet payloads before submission", async () => {
		process.env.PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES = "10";
		const submit = vi.fn(async () => ({
			type: "build",
			agentSource: "project",
			intent: "i",
			aim: "a",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		}) satisfies SingleResult);
		const runner = new HatchetFlowRunner(submit);

		await expect(runner.run(options({ cwd: process.cwd(), forkSessionSnapshotJsonl: "x".repeat(100) }))).rejects.toThrow("exceeding limit");
		expect(submit).not.toHaveBeenCalled();
	});

	it("validates explicit payload size limits", () => {
		const payload = serializeHatchetFlowPayload(options({ forkSessionSnapshotJsonl: "x".repeat(100) }));

		expect(() => validateHatchetFlowPayloadSize(payload, 10)).toThrow("exceeding limit");
	});

	it("deserializes payload without streaming or cancellation callbacks", () => {
		const payload = serializeHatchetFlowPayload(options({ onUpdate: vi.fn() }));
		const restored = deserializeHatchetFlowPayload(payload);

		expect(restored.onUpdate).toBeUndefined();
		expect(restored.signal).toBeUndefined();
		expect(restored.flowName).toBe("build");
	});

	it("documents the Hatchet payload trust boundary", () => {
		const readme = readFileSync("README.md", "utf8");
		const adr = readFileSync("doc/adr/0003-phase-2-basic-hatchet-backend.md", "utf8");

		expect(readme).toContain("Hatchet payload trust boundary");
		expect(readme).toContain("trusted infrastructure");
		expect(adr).toContain("Hatchet payload trust boundary");
		expect(adr).toContain("trusted infrastructure");
	});
});
