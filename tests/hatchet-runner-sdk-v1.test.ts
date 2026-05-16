import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunFlowOptions } from "../src/flow.js";
import { runFlow } from "../src/flow.js";
import {
	DEFAULT_HATCHET_WORKER_READY_TIMEOUT_MS,
	main,
	resolveHatchetWorkerConfig,
} from "../src/hatchet-worker-cli.js";
import {
	HATCHET_CLIENT_LOCAL_TLS_STRATEGY,
	HATCHET_CLIENT_TLS_STRATEGY_ENV,
	HatchetFlowRunner,
	HATCHET_FLOW_TASK_NAME,
	runHatchetFlowTask,
	submitHatchetTaskWithClient,
	validateSingleResult,
} from "../src/hatchet-runner.js";
import { serializeHatchetFlowPayload } from "../src/hatchet-payload.js";
import { emptyFlowUsage, type SingleResult } from "../src/types.js";

vi.mock("../src/flow.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/flow.js")>();
	return {
		...actual,
		runFlow: vi.fn(async (opts: any): Promise<SingleResult> => {
			expect(process.env.PI_FLOW_RUNNER).toBe("local");
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
		}),
	};
});

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		type: "build",
		agentSource: "project",
		intent: "i",
		aim: "a",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyFlowUsage(),
		...overrides,
	};
}

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

describe("Hatchet v1 runner path", () => {
	const originalTimeout = process.env.PI_FLOW_HATCHET_RESULT_TIMEOUT_MS;
	const originalSpawn = process.env.PI_FLOW_SPAWN_COMMAND;
	const originalTls = process.env[HATCHET_CLIENT_TLS_STRATEGY_ENV];

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.PI_FLOW_HATCHET_RESULT_TIMEOUT_MS;
		delete process.env.PI_FLOW_SPAWN_COMMAND;
		delete process.env[HATCHET_CLIENT_TLS_STRATEGY_ENV];
	});

	afterEach(() => {
		if (originalTimeout === undefined) delete process.env.PI_FLOW_HATCHET_RESULT_TIMEOUT_MS;
		else process.env.PI_FLOW_HATCHET_RESULT_TIMEOUT_MS = originalTimeout;
		if (originalSpawn === undefined) delete process.env.PI_FLOW_SPAWN_COMMAND;
		else process.env.PI_FLOW_SPAWN_COMMAND = originalSpawn;
		if (originalTls === undefined) delete process.env[HATCHET_CLIENT_TLS_STRATEGY_ENV];
		else process.env[HATCHET_CLIENT_TLS_STRATEGY_ENV] = originalTls;
	});

	it("v1 SDK import path does not emit the deprecated step-module warning", () => {
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", "await import('@hatchet-dev/typescript-sdk/v1/index.js')"], {
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stderr).not.toContain("Deprecation warning: The v0 sdk");
	});

	it("submits a valid Hatchet task result via the registered task API", async () => {
		const task = { run: vi.fn(async () => makeResult()) };
		const client = { task: vi.fn(() => task) };
		const payload = serializeHatchetFlowPayload(options(), "/repo/.pi/agents");
		const result = await submitHatchetTaskWithClient(client as any, payload);
		expect(client.task).toHaveBeenCalledWith(
			expect.objectContaining({
				name: HATCHET_FLOW_TASK_NAME,
				retries: 0,
				executionTimeout: "3600s",
				scheduleTimeout: "3600s",
			}),
		);
		expect(result).toMatchObject({ type: "build", agentSource: "project", exitCode: 0 });
	});

	it("returns the Hatchet runner result when the submitter resolves", async () => {
		const runner = new HatchetFlowRunner(async () => makeResult({ stderr: "from hatchet" }));
		const result = await runner.run(options());
		expect(result.stderr).toBe("from hatchet");
		expect(runFlow).not.toHaveBeenCalled();
	});

	it("times out when a worker never returns a result", async () => {
		process.env.PI_FLOW_HATCHET_RESULT_TIMEOUT_MS = "5";
		vi.useFakeTimers();
		try {
			const runner = new HatchetFlowRunner(async () => await new Promise<SingleResult>(() => {}));
			const resultPromise = expect(runner.run(options())).rejects.toThrow("did not return a result");
			await vi.advanceTimersByTimeAsync(5);
			await resultPromise;
		} finally {
			vi.useRealTimers();
		}
	});

	it("worker task entrypoint forces local child flow execution and restores env", async () => {
		const previousRunner = process.env.PI_FLOW_RUNNER;
		const previousSpawn = process.env.PI_FLOW_SPAWN_COMMAND;
		const payload = serializeHatchetFlowPayload(options({ cwd: process.cwd() }), "/repo/.pi/agents");
		await runHatchetFlowTask(payload);
		expect(runFlow).toHaveBeenCalledTimes(1);
		expect(process.env.PI_FLOW_RUNNER).toBe(previousRunner);
		expect(process.env.PI_FLOW_SPAWN_COMMAND).toBe(previousSpawn);
	});

	it("validates SingleResult shape at the trust boundary", () => {
		expect(() => validateSingleResult({ nope: true }, "test boundary")).toThrow("invalid SingleResult");
		expect(validateSingleResult(makeResult(), "test boundary")).toMatchObject({ type: "build", agentSource: "project" });
	});

	it("worker entrypoint registers the Hatchet task and starts the worker", async () => {
		const task = { run: vi.fn(async () => makeResult()) };
		const worker = { start: vi.fn(async () => {}), waitUntilReady: vi.fn(async () => {}) };
		const client = { task: vi.fn(() => task), worker: vi.fn(async () => worker) };
		const logger = { info: vi.fn(), error: vi.fn() };
		const env = {
			HATCHET_CLIENT_API_URL: "http://127.0.0.1:7077",
			PI_FLOW_HATCHET_WORKER_NAME: "demo",
			PI_FLOW_HATCHET_WORKER_SLOTS: "2",
		} as NodeJS.ProcessEnv;
		await main({ client: client as any, env, logger });
		expect(client.task).toHaveBeenCalledWith(expect.objectContaining({ executionTimeout: "3600s", scheduleTimeout: "3600s" }));
		expect(client.task).toHaveBeenCalled();
		expect(client.worker).toHaveBeenCalledWith("demo", { workflows: [task], slots: 2 });
		expect(worker.waitUntilReady).toHaveBeenCalledWith(DEFAULT_HATCHET_WORKER_READY_TIMEOUT_MS);
		expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Hatchet worker ready"));
		expect(env[HATCHET_CLIENT_TLS_STRATEGY_ENV]).toBe(HATCHET_CLIENT_LOCAL_TLS_STRATEGY);
		void resolveHatchetWorkerConfig(env);
	});

	it("applies the local TLS strategy for bare host-port env values", async () => {
		const task = { run: vi.fn(async () => makeResult()) };
		const worker = { start: vi.fn(async () => {}), waitUntilReady: vi.fn(async () => {}) };
		const client = { task: vi.fn(() => task), worker: vi.fn(async () => worker) };
		const env = {
			HATCHET_CLIENT_HOST_PORT: "127.0.0.1:7077",
			PI_FLOW_HATCHET_WORKER_NAME: "demo-host-port",
		} as NodeJS.ProcessEnv;
		await main({ client: client as any, env, logger: { info: vi.fn(), error: vi.fn() } });
		expect(env[HATCHET_CLIENT_TLS_STRATEGY_ENV]).toBe(HATCHET_CLIENT_LOCAL_TLS_STRATEGY);
		void resolveHatchetWorkerConfig(env);
	});
});
