import { statSync } from "node:fs";
import { runFlow, type RunFlowOptions } from "./core/flow.js";
import type { FlowRunner, FlowRunContext } from "./flow-runner.js";
import type { FlowConfig } from "./core/agents.js";
import type { AgentSessionMode } from "./core/session-mode.js";
import { emptyFlowUsage, type FlowDetails, type SingleResult } from "./types/flow.js";

/**
 * Hatchet task name used by the parent runner and worker entrypoint.
 * Payloads cross the Hatchet queue trust boundary and may contain sensitive session context.
 */
export const HATCHET_FLOW_TASK_NAME = "pi-agent-flow.runFlow";

/**
 * Environment variable that overrides the maximum serialized Hatchet task payload size in bytes.
 * Raising this limit should only be done for trusted private queues with appropriate retention controls.
 */
export const PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES_ENV = "PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES";

/**
 * Default maximum serialized Hatchet task payload size.
 * The limit bounds session-snapshot exposure and catches accidental oversized queue messages early.
 */
export const DEFAULT_HATCHET_MAX_PAYLOAD_BYTES = 1_000_000;

/**
 * JSON-safe payload submitted to Hatchet for one flow attempt.
 * All fields originate from the local parent executor; consumers must treat queued payloads as sensitive.
 */
export interface HatchetFlowPayload {
	/** Working directory used by the worker the flow. */
	cwd: string;
	/** Resolved flow definitions selected by the parent process. */
	flows: FlowConfig[];
	/** Name of the flow to run. */
	flowName: string;
	/** User-facing intent passed to the flow. */
	intent: string;
	/** Short aim label for the flow attempt. */
	aim: string;
	/** Optional acceptance criteria supplied by the parent. */
	acceptance?: string;
	/** Optional task-specific working directory. */
	taskCwd?: string;
	/** Serialized forked session snapshot; may contain sensitive conversation or tool context. */
	forkSessionSnapshotJsonl: string | null;
	/** Parent flow depth used for delegation guards. */
	parentDepth: number;
	/** Ancestor flow stack used for cycle prevention. */
	parentFlowStack: string[];
	/** Maximum allowed delegation depth. */
	maxDepth: number;
	/** Whether cycle prevention is enabled for the run. */
	preventCycles: boolean;
	/** Optional tool optimization mode selected by the parent. */
	toolOptimize?: boolean;
	/** Optional structured-output setting selected by the parent. */
	structuredOutput?: boolean;
	/** Optional model override for the flow attempt. */
	model?: string;
	/** Optional session timeout/profile mode. */
	sessionMode?: AgentSessionMode;
	/** Project-local flow directory discovered by the parent, or null when unavailable. */
	projectFlowsDir: string | null;
}

interface HatchetSdkModule {
	[key: string]: unknown;
}

type HatchetSubmitter = (taskName: string, payload: HatchetFlowPayload) => Promise<SingleResult>;

function makeFlowDetails(projectFlowsDir: string | null): (results: SingleResult[]) => FlowDetails {
	return (results) => ({
		mode: "flow",
		flowStyle: "fork",
		projectAgentsDir: projectFlowsDir,
		results,
	});
}

function stringifyHatchetPayload(payload: HatchetFlowPayload): string {
	return JSON.stringify(payload);
}

function assertJsonSerializable(payload: HatchetFlowPayload): void {
	JSON.parse(stringifyHatchetPayload(payload));
}

/**
 * Resolves the maximum Hatchet payload size from environment configuration.
 * @param env Environment map to inspect; reads PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES and defaults to process.env.
 * @returns Positive byte limit, or the built-in default when unset; throws for invalid configured values.
 */
export function resolveHatchetMaxPayloadBytes(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES_ENV]?.trim();
	if (!raw) return DEFAULT_HATCHET_MAX_PAYLOAD_BYTES;
	if (!/^\d+$/.test(raw)) throw new Error(`${PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES_ENV} must be a positive integer byte limit.`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES_ENV} must be a positive integer byte limit.`);
	return value;
}

/**
 * Validates the serialized Hatchet payload size before crossing the queue trust boundary.
 * @param payload JSON-safe flow task payload.
 * @param maxBytes Maximum allowed serialized UTF-8 size in bytes.
 * @returns Nothing when the payload is within bounds; throws with remediation guidance when too large.
 */
export function validateHatchetFlowPayloadSize(payload: HatchetFlowPayload, maxBytes = resolveHatchetMaxPayloadBytes()): void {
	const sizeBytes = Buffer.byteLength(stringifyHatchetPayload(payload), "utf8");
	if (sizeBytes > maxBytes) {
		throw new Error(`Hatchet flow payload is ${sizeBytes} bytes, exceeding limit ${maxBytes}. Reduce inherited context or raise ${PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES_ENV} only for trusted private queues with suitable retention controls.`);
	}
}

function assertWorkerDirectory(label: string, dir: string): void {
	try {
		const stat = statSync(dir);
		if (stat.isDirectory()) return;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Hatchet worker ${label} "${dir}" is not accessible. Ensure the worker has a current checkout/workspace before running queued flows. (${message})`);
	}
	throw new Error(`Hatchet worker ${label} "${dir}" is not a directory. Ensure the worker has a current checkout/workspace before running queued flows.`);
}

/**
 * Validates worker-local filesystem assumptions before executing a queued flow.
 * @param payload JSON-safe flow task payload received from Hatchet.
 * @returns Nothing when required directories are available; throws actionable diagnostics otherwise.
 */
export function validateHatchetWorkerPayload(payload: HatchetFlowPayload): void {
	assertWorkerDirectory("cwd", payload.cwd);
	if (payload.taskCwd !== undefined) assertWorkerDirectory("taskCwd", payload.taskCwd);
}

/**
 * Resolves and validates the worker child-process spawn command.
 * @param env Environment map to inspect; reads PI_FLOW_SPAWN_COMMAND and defaults to process.env.
 * @returns Trimmed spawn command, defaulting to pi; throws when contains control-line separators.
 */
export function resolveHatchetSpawnCommand(env: NodeJS.ProcessEnv = process.env): string {
	const command = env.PI_FLOW_SPAWN_COMMAND?.trim() || "pi";
	if (/[\0\r\n]/.test(command)) throw new Error("PI_FLOW_SPAWN_COMMAND must be a single command without NUL or newline characters.");
	return command;
}

/**
 * Converts runFlow options into a JSON-safe Hatchet queue payload.
 * @param options Complete runFlow-compatible options from the trusted parent executor.
 * @param projectFlowsDir Project-local flow directory to preserve, or null when unavailable.
 * @returns Serializable payload for HATCHET_FLOW_TASK_NAME; throws if JSON serialization fails.
 */
export function serializeHatchetFlowPayload(options: RunFlowOptions, projectFlowsDir: string | null = null): HatchetFlowPayload {
	const payload: HatchetFlowPayload = {
		cwd: options.cwd,
		flows: options.flows,
		flowName: options.flowName,
		intent: options.intent,
		aim: options.aim,
		...(options.acceptance !== undefined ? { acceptance: options.acceptance } : {}),
		...(options.taskCwd !== undefined ? { taskCwd: options.taskCwd } : {}),
		forkSessionSnapshotJsonl: options.forkSessionSnapshotJsonl,
		parentDepth: options.parentDepth,
		parentFlowStack: [...options.parentFlowStack],
		maxDepth: options.maxDepth,
		preventCycles: options.preventCycles,
		...(options.toolOptimize !== undefined ? { toolOptimize: options.toolOptimize } : {}),
		...(options.structuredOutput !== undefined ? { structuredOutput: options.structuredOutput } : {}),
		...(options.model !== undefined ? { model: options.model } : {}),
		...(options.sessionMode !== undefined ? { sessionMode: options.sessionMode } : {}),
		projectFlowsDir,
	};
	assertJsonSerializable(payload);
	return payload;
}

/**
 * Reconstructs runFlow options from a Hatchet queue payload.
 * @param payload JSON-safe payload received by a trusted worker from Hatchet.
 * @returns RunFlowOptions with worker-local makeDetails restored; throws if serialization validation fails.
 */
export function deserializeHatchetFlowPayload(payload: HatchetFlowPayload): RunFlowOptions {
	assertJsonSerializable(payload);
	return {
		cwd: payload.cwd,
		flows: payload.flows,
		flowName: payload.flowName,
		intent: payload.intent,
		aim: payload.aim,
		acceptance: payload.acceptance,
		taskCwd: payload.taskCwd,
		forkSessionSnapshotJsonl: payload.forkSessionSnapshotJsonl,
		parentDepth: payload.parentDepth,
		parentFlowStack: payload.parentFlowStack,
		maxDepth: payload.maxDepth,
		preventCycles: payload.preventCycles,
		toolOptimize: payload.toolOptimize,
		structuredOutput: payload.structuredOutput,
		model: payload.model,
		sessionMode: payload.sessionMode,
		makeDetails: makeFlowDetails(payload.projectFlowsDir),
	};
}

async function loadHatchetSdk(): Promise<HatchetSdkModule> {
	try {
		return await import("@hatchet-dev/typescript-sdk");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`PI_FLOW_RUNNER=hatchet requires optional package @hatchet-dev/typescript-sdk. Install and configure Hatchet before using this backend. (${message})`);
	}
}

function getProperty(obj: unknown, key: string): unknown {
	return obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
}

function asAsyncFunction(value: unknown): ((...args: unknown[]) => Promise<unknown>) | undefined {
	return typeof value === "function" ? value as (...args: unknown[]) => Promise<unknown> : undefined;
}

async function createHatchetClient(factory: (...args: unknown[]) => Promise<unknown>): Promise<unknown> {
	try {
		return new (factory as unknown as { new(): unknown })();
	} catch {
		return await factory();
	}
}

async function defaultSubmitHatchetTask(taskName: string, payload: HatchetFlowPayload): Promise<SingleResult> {
	const sdk = await loadHatchetSdk();
	const clientFactory = asAsyncFunction(getProperty(sdk, "HatchetClient"))
		?? asAsyncFunction(getProperty(sdk, "Hatchet"))
		?? asAsyncFunction(getProperty(sdk, "default"));
	const client = clientFactory ? await createHatchetClient(clientFactory) : getProperty(sdk, "hatchet") ?? sdk;
	const directRun = asAsyncFunction(getProperty(client, "run"));
	if (directRun) return await directRun(taskName, payload) as SingleResult;
	const workflows = getProperty(client, "workflows") ?? getProperty(client, "workflow");
	const workflowRun = asAsyncFunction(getProperty(workflows, "run"));
	if (workflowRun) return await workflowRun(taskName, payload) as SingleResult;
	const tasks = getProperty(client, "tasks") ?? getProperty(client, "task");
	const taskRun = asAsyncFunction(getProperty(tasks, "run")) ?? asAsyncFunction(getProperty(tasks, "execute"));
	if (taskRun) return await taskRun(taskName, payload) as SingleResult;
	throw new Error("Hatchet SDK loaded, but no supported task submission method was found. Expected client.run, client.workflows.run, or client.tasks.run.");
}

function makeHatchetLifecycleResult(options: RunFlowOptions, status: string, errorMessage?: string): SingleResult {
	return {
		type: options.flowName.toLowerCase(),
		agentSource: "unknown",
		intent: options.intent,
		aim: options.aim,
		acceptance: options.acceptance,
		exitCode: -1,
		messages: [],
		stderr: `Hatchet flow ${status}.`,
		usage: emptyFlowUsage(),
		model: options.model,
		startedAtMs: Date.now(),
		errorMessage,
	};
}

function makeHatchetFailureLifecycleResult(options: RunFlowOptions): SingleResult {
	return makeHatchetLifecycleResult(options, "failed", "Hatchet submission failed.");
}

function emitHatchetLifecycleUpdate(options: RunFlowOptions, projectFlowsDir: string | null, text: string, result: SingleResult): void {
	options.onUpdate?.({
		content: [{ type: "text", text }],
		details: makeFlowDetails(projectFlowsDir)([result]),
	});
}

/**
 * FlowRunner implementation that submits final-result-only flow attempts to Hatchet.
 * Constructor injection is used by tests; the default submitter loads the optional Hatchet SDK lazily.
 */
export class HatchetFlowRunner implements FlowRunner {
	/**
	 * Creates a Hatchet-backed runner.
	 * @param submitTask Queue submission function; defaults to the optional Hatchet SDK adapter.
	 */
	constructor(private readonly submitTask: HatchetSubmitter = defaultSubmitHatchetTask) {}

	/**
	 * Serializes the run options and submits one Hatchet task, crossing the queue trust boundary.
	 * @param options Complete runFlow-compatible options for the attempt.
	 * @param context Optional parent context containing projectFlowsDir.
	 * @returns The final result returned by the Hatchet task.
	 */
	async run(options: RunFlowOptions, context?: FlowRunContext): Promise<SingleResult> {
		const projectFlowsDir = context?.projectFlowsDir ?? null;
		const payload = serializeHatchetFlowPayload(options, projectFlowsDir);
		validateHatchetFlowPayloadSize(payload);
		emitHatchetLifecycleUpdate(options, projectFlowsDir, `Hatchet queued/running flow ${payload.flowName}.`, makeHatchetLifecycleResult(options, "queued/running"));
		try {
			const result = await this.submitTask(HATCHET_FLOW_TASK_NAME, payload);
			emitHatchetLifecycleUpdate(options, projectFlowsDir, `Hatchet completed flow ${payload.flowName}.`, result);
			return result;
		} catch (error) {
			emitHatchetLifecycleUpdate(options, projectFlowsDir, `Hatchet failed flow ${payload.flowName}.`, makeHatchetFailureLifecycleResult(options));
			throw error;
		}
	}
}

/**
 * Hatchet worker task entrypoint for final-result-only flow runs.
 * @param payload JSON-safe payload received from a trusted Hatchet queue; may contain sensitive context.
 * @returns The SingleResult produced by runFlow after restoring worker-local options.
 */
export async function runHatchetFlowTask(payload: HatchetFlowPayload): Promise<SingleResult> {
	process.env.PI_FLOW_SPAWN_COMMAND = resolveHatchetSpawnCommand(process.env);
	validateHatchetWorkerPayload(payload);
	return runFlow(deserializeHatchetFlowPayload(payload));
}
