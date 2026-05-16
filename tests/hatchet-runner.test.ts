import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunFlowOptions } from "../src/core/flow.js";
import { runFlow } from "../src/core/flow.js";
import { createFlowRunnerFromEnv, DEFAULT_LOCAL_FLOW_RUNNER } from "../src/flow-runner.js";
import {
	HATCHET_FLOW_TASK_NAME,
	HatchetFlowRunner,
	runHatchetFlowTask,
	submitHatchetTaskWithSdk,
	type HatchetFlowPayload,
} from "../src/hatchet-runner.js";
import {
	DEFAULT_HATCHET_MAX_PAYLOAD_BYTES,
	deserializeHatchetFlowPayload,
	resolveHatchetMaxPayloadBytes,
	serializeHatchetFlowPayload,
	validateHatchetFlowPayloadSize,
} from "../src/hatchet-payload.js";
import { emptyFlowUsage, type SingleResult } from "../src/types/flow.js";
import type { HatchetRunAdapter } from "../src/hatchet-run-adapter.js";

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

function options(overrides: Partial<RunFlowOptions> = {}): RunFlowOptions {
	return {
		cwd: "/repo",
		flows: [
			{
				name: "build",
				description: "Code",
				systemPrompt: "Prompt",
				source: "project",
				filePath: "/repo/.pi/agents/build.md",
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
		makeDetails: (results) => ({ mode: "flow", flowStyle: "fork", projectAgentsDir: null, results }),
		...overrides,
	};
}

describe("Hatchet runner", () => {
	const originalRunner = process.env.PI_FLOW_RUNNER;
	const originalSpawnCommand = process.env.PI_FLOW_SPAWN_COMMAND;
	const originalMaxPayloadBytes = process.env.PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES;

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.PI_FLOW_RUNNER;
		delete process.env.PI_FLOW_SPAWN_COMMAND;
		delete process.env.PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES;
	});

	afterEach(() => {
		if (originalRunner === undefined) delete process.env.PI_FLOW_RUNNER;
		else process.env.PI_FLOW_RUNNER = originalRunner;
		if (originalSpawnCommand === undefined) delete process.env.PI_FLOW_SPAWN_COMMAND;
		else process.env.PI_FLOW_SPAWN_COMMAND = originalSpawnCommand;
		if (originalMaxPayloadBytes === undefined) delete process.env.PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES;
		else process.env.PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES = originalMaxPayloadBytes;
	});

	it("serializes only plain JSON runFlow payload fields", () => {
		const controller = new AbortController();
		const payload = serializeHatchetFlowPayload(
			options({ signal: controller.signal, onUpdate: vi.fn() }),
			"/repo/.pi/agents",
		);
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

		const result = await runner.run(options({ onUpdate: vi.fn() }), {
			projectFlowsDir: "/repo/.pi/agents",
		});

		expect(result.stderr).toBe("from hatchet");
		expect(submitted).toHaveLength(1);
		expect(submitted[0].taskName).toBe(HATCHET_FLOW_TASK_NAME);
		expect(submitted[0].payload.projectFlowsDir).toBe("/repo/.pi/agents");
		expect("onUpdate" in submitted[0].payload).toBe(false);
	});

	it("uses the default SDK probing path for a realistic tasks.run client", async () => {
		const taskRun = vi.fn(async (taskName: string, payload: HatchetFlowPayload) => ({
			type: payload.flowName,
			agentSource: "project",
			intent: payload.intent,
			aim: payload.aim,
			exitCode: 0,
			messages: [],
			stderr: `sdk:${taskName}`,
			usage: emptyFlowUsage(),
		}) satisfies SingleResult);

		class HatchetClient {
			tasks = { run: taskRun };
		}

		const payload = serializeHatchetFlowPayload(options());
		const result = await submitHatchetTaskWithSdk({ HatchetClient }, HATCHET_FLOW_TASK_NAME, payload);
		expect(taskRun).toHaveBeenCalledWith(HATCHET_FLOW_TASK_NAME, payload);
		expect(result.stderr).toBe(`sdk:${HATCHET_FLOW_TASK_NAME}`);
	});

	it("rejects malformed wrapped SDK responses clearly", async () => {
		const taskRun = vi.fn(async () => ({
			result: {
				type: "build",
				agentSource: "project",
				intent: "Implement feature",
				aim: "Implement feature",
				exitCode: 0,
				messages: [],
				stderr: "wrapped",
				usage: emptyFlowUsage(),
			},
		}));

		class HatchetClient {
			tasks = { run: taskRun };
		}

		await expect(
			submitHatchetTaskWithSdk(
				{ HatchetClient },
				HATCHET_FLOW_TASK_NAME,
				serializeHatchetFlowPayload(options()),
			),
		).rejects.toThrow("invalid SingleResult");
	});

	it("rejects malformed Hatchet submitter results before completion is emitted", async () => {
		const updates: any[] = [];
		const runner = new HatchetFlowRunner(async () => ({ result: "wrapped" } as unknown as SingleResult));
		await expect(
			runner.run(options({ onUpdate: (update) => updates.push(update) }), {
				projectFlowsDir: "/repo/.pi/agents",
			}),
		).rejects.toThrow("invalid SingleResult");
		expect(updates.map((update) => update.content[0].text)).toEqual([
			"Hatchet queued/running flow build.",
			"Hatchet failed flow build.",
		]);
	});

	it("selects Hatchet only when PI_FLOW_RUNNER=hatchet", () => {
		expect(createFlowRunnerFromEnv({} as NodeJS.ProcessEnv)).toBe(DEFAULT_LOCAL_FLOW_RUNNER);
		expect(createFlowRunnerFromEnv({ PI_FLOW_RUNNER: "local" } as NodeJS.ProcessEnv)).toBe(DEFAULT_LOCAL_FLOW_RUNNER);
		expect(createFlowRunnerFromEnv({ PI_FLOW_RUNNER: "hatchet" } as NodeJS.ProcessEnv).constructor.name).toBe(
			"HatchetFlowRunner",
		);
	});

	it("emits Hatchet lifecycle updates around final-result submission", async () => {
		const updates: any[] = [];
		const runner = new HatchetFlowRunner(async (_taskName, payload) => ({
			type: payload.flowName,
			agentSource: "project",
			intent: payload.intent,
			aim: payload.aim,
			exitCode: 0,
			messages: [],
			stderr: "done",
			usage: emptyFlowUsage(),
		}));

		await runner.run(options({ onUpdate: (update) => updates.push(update) }), {
			projectFlowsDir: "/repo/.pi/agents",
		});

		expect(updates.map((update) => update.content[0].text)).toEqual([
			"Hatchet queued/running flow build.",
			"Hatchet completed flow build.",
		]);
		expect(updates[0].details.results[0]).toMatchObject({ type: "build", agentSource: "unknown", exitCode: -1 });
		expect(updates[0].details.projectAgentsDir).toBe("/repo/.pi/agents");
		expect(updates[1].details.results[0]).toMatchObject({ type: "build", stderr: "done", exitCode: 0 });
	});

	it("sanitizes failed Hatchet lifecycle updates while rethrowing the original error", async () => {
		const updates: any[] = [];
		const secret = "token=secret-submission-error";
		const runner = new HatchetFlowRunner(async () => {
			throw new Error(secret);
		});

		await expect(
			runner.run(options({ onUpdate: (update) => updates.push(update) }), {
				projectFlowsDir: "/repo/.pi/agents",
			}),
		).rejects.toThrow(secret);
		expect(updates.map((update) => update.content[0].text)).toEqual([
			"Hatchet queued/running flow build.",
			"Hatchet failed flow build.",
		]);
		expect(updates[1].details.results[0]).toMatchObject({
			type: "build",
			stderr: "Hatchet flow failed.",
			errorMessage: "Hatchet submission failed.",
			exitCode: -1,
		});
		expect(JSON.stringify(updates)).not.toContain(secret);
	});

	it("worker entrypoint reconstructs runFlow options and restores worker env after defaulting spawn command", async () => {
		const previousRunner = process.env.PI_FLOW_RUNNER;
		const previousSpawn = process.env.PI_FLOW_SPAWN_COMMAND;
		const payload = serializeHatchetFlowPayload(
			options({ acceptance: "Done", cwd: process.cwd() }),
			"/repo/.pi/agents",
		);

		await runHatchetFlowTask(payload);

		expect(process.env.PI_FLOW_RUNNER).toBe(previousRunner);
		expect(process.env.PI_FLOW_SPAWN_COMMAND).toBe(previousSpawn);
		expect(runFlow).toHaveBeenCalledTimes(1);
		const calledWith = vi.mocked(runFlow).mock.calls[0][0];
		expect(calledWith.flowName).toBe("build");
		expect(calledWith.acceptance).toBe("Done");
		expect(calledWith.signal).toBeUndefined();
		expect(calledWith.onUpdate).toBeUndefined();
		expect(
			calledWith.makeDetails([
				{
					type: "build",
					agentSource: "project",
					intent: "i",
					aim: "a",
					exitCode: 0,
					messages: [],
					stderr: "",
					usage: emptyFlowUsage(),
				},
			]).projectAgentsDir,
		).toBe("/repo/.pi/agents");
	});

	it("restores an explicit worker spawn command after execution", async () => {
		process.env.PI_FLOW_SPAWN_COMMAND = " /custom/pi ";
		const payload = serializeHatchetFlowPayload(options({ cwd: process.cwd() }));
		await runHatchetFlowTask(payload);
		expect(process.env.PI_FLOW_SPAWN_COMMAND).toBe(" /custom/pi ");
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

	it("uses a larger default Hatchet payload cap before requiring overrides", () => {
		expect(DEFAULT_HATCHET_MAX_PAYLOAD_BYTES).toBe(1_500_000);
		expect(DEFAULT_HATCHET_MAX_PAYLOAD_BYTES).toBeGreaterThan(1_043_652);
		expect(resolveHatchetMaxPayloadBytes({} as NodeJS.ProcessEnv)).toBe(DEFAULT_HATCHET_MAX_PAYLOAD_BYTES);
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
		await expect(
			runner.run(options({ cwd: process.cwd(), forkSessionSnapshotJsonl: "x".repeat(100) })),
		).rejects.toThrow("exceeding limit");
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

describe("Hatchet runner adapter", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("adapter submit and getResult round-trip produces the correct result", async () => {
		const singleResult: SingleResult = {
			type: "build",
			agentSource: "project",
			intent: "Implement durable resume",
			aim: "Durable Hatchet resume",
			exitCode: 0,
			messages: [],
			stderr: "done from adapter",
			usage: emptyFlowUsage(),
		};

		const adapter: HatchetRunAdapter = {
			submit: vi.fn(async () => ({ runId: "remote-1" })),
			getResult: vi.fn(async () => ({ status: "completed" as const, result: singleResult })),
		};

		const runner = new HatchetFlowRunner({ adapter });
		const result = await runner.run(options());

		expect(adapter.submit).toHaveBeenCalledOnce();
		expect(adapter.getResult).toHaveBeenCalledWith({ runId: "remote-1" });
		expect(result.stderr).toBe("done from adapter");
	});

	it("adapter failed status causes runner to throw", async () => {
		const adapter: HatchetRunAdapter = {
			submit: vi.fn(async () => ({ runId: "remote-fail" })),
			getResult: vi.fn(async () => ({
				status: "failed" as const,
				errorMessage: "worker crashed",
			})),
		};

		const runner = new HatchetFlowRunner({ adapter });
		await expect(runner.run(options())).rejects.toThrow("worker crashed");
	});

	it("adapter submit error causes runner to throw and emit failure update", async () => {
		const updates: any[] = [];
		const adapter: HatchetRunAdapter = {
			submit: vi.fn(async () => {
				throw new Error("submission failed");
			}),
			getResult: vi.fn(async () => ({ status: "unknown" as const })),
		};

		const runner = new HatchetFlowRunner({ adapter });
		await expect(
			runner.run(options({ onUpdate: (u) => updates.push(u) })),
		).rejects.toThrow("submission failed");

		expect(updates.map((u) => u.content[0].text)).toEqual([
			"Hatchet queued/running flow build.",
			"Hatchet failed flow build.",
		]);
	});
});
