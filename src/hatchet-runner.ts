import type { RunFlowOptions } from "./flow.js";
import type { FlowRunContext, FlowRunner } from "./flow-runner.js";
import {
	HATCHET_FLOW_TASK_NAME,
	deserializeHatchetFlowPayload,
	resolveHatchetSpawnCommand,
	serializeHatchetFlowPayload,
	validateHatchetFlowPayloadSize,
	validateHatchetWorkerPayload,
	type HatchetFlowPayload,
} from "./hatchet-payload.js";
import { emptyFlowUsage, type FlowDetails, type SingleResult } from "./types.js";
export {
	DEFAULT_HATCHET_MAX_PAYLOAD_BYTES,
	HATCHET_FLOW_TASK_NAME,
	PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES_ENV,
	deserializeHatchetFlowPayload,
	resolveHatchetMaxPayloadBytes,
	resolveHatchetSpawnCommand,
	serializeHatchetFlowPayload,
	validateHatchetFlowPayloadSize,
	validateHatchetWorkerPayload,
} from "./hatchet-payload.js";
export type { HatchetFlowPayload } from "./hatchet-payload.js";
export const PI_FLOW_HATCHET_RESULT_TIMEOUT_MS_ENV = "PI_FLOW_HATCHET_RESULT_TIMEOUT_MS";
export const DEFAULT_HATCHET_RESULT_TIMEOUT_MS = 600_000;
export const DEFAULT_HATCHET_TASK_EXECUTION_TIMEOUT_MS = 3_600_000;
export const HATCHET_CLIENT_TLS_STRATEGY_ENV = "HATCHET_CLIENT_TLS_STRATEGY";
export const HATCHET_CLIENT_LOCAL_TLS_STRATEGY = "none";
export interface HatchetTaskContext {
	abortController: AbortController;
	cancelled: boolean;
	rethrowIfCancelled(err: unknown): void;
}
export interface HatchetTaskDeclaration {
	run(input: unknown): Promise<unknown>;
}
export interface HatchetTaskClient {
	task<I, O>(options: {
		name: string;
		retries?: number;
		executionTimeout?: string;
		scheduleTimeout?: string;
		fn: (input: I, ctx?: HatchetTaskContext) => Promise<O> | O;
	}): HatchetTaskDeclaration;
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
function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export function validateSingleResult(value: unknown, source = "Hatchet result"): SingleResult {
	if (!isRecord(value)) {
		throw new Error(`${source} returned an invalid SingleResult: expected an object.`);
	}
	for (const field of ["type", "agentSource", "intent", "aim", "stderr"] as const) {
		if (typeof value[field] !== "string") {
			throw new Error(`${source} returned an invalid SingleResult: ${JSON.stringify(field)} must be a string.`);
		}
	}
	if (!(["user", "project", "bundled", "unknown"] as const).includes(value.agentSource as any)) {
		throw new Error(
			`${source} returned an invalid SingleResult: "agentSource" must be one of user, project, bundled, or unknown.`,
		);
	}
	if (typeof value.exitCode !== "number" || !Number.isFinite(value.exitCode)) {
		throw new Error(`${source} returned an invalid SingleResult: "exitCode" must be a finite number.`);
	}
	if (!Array.isArray(value.messages)) {
		throw new Error(`${source} returned an invalid SingleResult: "messages" must be an array.`);
	}
	if (!isRecord(value.usage)) {
		throw new Error(`${source} returned an invalid SingleResult: "usage" must be an object.`);
	}
	for (const field of [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"cost",
		"contextTokens",
		"turns",
		"toolCalls",
	] as const) {
		if (typeof value.usage[field] !== "number" || !Number.isFinite(value.usage[field])) {
			throw new Error(
				`${source} returned an invalid SingleResult: ${JSON.stringify(`usage.${field}`)} must be a finite number.`,
			);
		}
	}
	if (
		value.usage.smoothedTps !== undefined &&
		(typeof value.usage.smoothedTps !== "number" || !Number.isFinite(value.usage.smoothedTps))
	) {
		throw new Error(
			`${source} returned an invalid SingleResult: "usage.smoothedTps" must be a finite number when present.`,
		);
	}
	for (const field of ["acceptance", "model", "stopReason", "errorMessage", "streamingText"] as const) {
		if (value[field] !== undefined && typeof value[field] !== "string") {
			throw new Error(`${source} returned an invalid SingleResult: ${JSON.stringify(field)} must be a string when present.`);
		}
	}
	if (value.sawAgentEnd !== undefined && typeof value.sawAgentEnd !== "boolean") {
		throw new Error(`${source} returned an invalid SingleResult: "sawAgentEnd" must be a boolean when present.`);
	}
	for (const field of ["startedAtMs", "deadlineAtMs"] as const) {
		if (value[field] !== undefined && (typeof value[field] !== "number" || !Number.isFinite(value[field]))) {
			throw new Error(`${source} returned an invalid SingleResult: ${JSON.stringify(field)} must be a finite number when present.`);
		}
	}
	if (value.structuredOutput !== undefined && !isRecord(value.structuredOutput)) {
		throw new Error(`${source} returned an invalid SingleResult: "structuredOutput" must be an object when present.`);
	}
	return value as unknown as SingleResult;
}
export function resolveHatchetResultTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[PI_FLOW_HATCHET_RESULT_TIMEOUT_MS_ENV]?.trim();
	if (!raw) return DEFAULT_HATCHET_RESULT_TIMEOUT_MS;
	if (!/^\d+$/.test(raw)) {
		throw new Error(`${PI_FLOW_HATCHET_RESULT_TIMEOUT_MS_ENV} must be a positive integer millisecond timeout.`);
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${PI_FLOW_HATCHET_RESULT_TIMEOUT_MS_ENV} must be a positive integer millisecond timeout.`);
	}
	return value;
}
export function resolveHatchetTaskExecutionTimeoutMs(): number {
	return DEFAULT_HATCHET_TASK_EXECUTION_TIMEOUT_MS;
}
function formatHatchetTimeout(ms: number): string {
	return `${Math.max(1, Math.ceil(ms / 1000))}s`;
}
async function awaitHatchetResult<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => {
					reject(
						new Error(
							`Hatchet did not return a result for ${HATCHET_FLOW_TASK_NAME} within ${timeoutMs}ms. Check Hatchet connectivity and ensure a worker is registered for ${HATCHET_FLOW_TASK_NAME}. Adjust ${PI_FLOW_HATCHET_RESULT_TIMEOUT_MS_ENV} if longer waits are expected.`,
						),
					);
				}, timeoutMs);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
function parseHatchetHost(value: string | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (!trimmed.includes("://")) {
		if (trimmed.startsWith("[")) {
			const end = trimmed.indexOf("]");
			return end > 1 ? trimmed.slice(1, end) : null;
		}
		const match = /^(?<host>[^:]+)(?::\d+)?$/.exec(trimmed);
		return match?.groups?.host ?? null;
	}
	try {
		return new URL(trimmed).hostname || null;
	} catch {
		return null;
	}
}
export function applyLocalHatchetTlsStrategyDefault(env: NodeJS.ProcessEnv = process.env): void {
	if (env[HATCHET_CLIENT_TLS_STRATEGY_ENV]?.trim()) return;
	const host = parseHatchetHost(env.HATCHET_CLIENT_HOST_PORT) ?? parseHatchetHost(env.HATCHET_CLIENT_API_URL);
	if (host === "127.0.0.1") env[HATCHET_CLIENT_TLS_STRATEGY_ENV] = HATCHET_CLIENT_LOCAL_TLS_STRATEGY;
}
function getProperty(obj: unknown, key: string): unknown {
	return obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
}
function asFunction<T extends (...args: any[]) => any>(value: unknown): T | undefined {
	return typeof value === "function" ? (value as T) : undefined;
}
async function createHatchetClient(factory: (...args: unknown[]) => Promise<unknown>): Promise<unknown> {
	try {
		return new (factory as unknown as { new(): unknown })();
	} catch {
		return await factory();
	}
}
export function createHatchetFlowTaskDeclaration(client: HatchetTaskClient): HatchetTaskDeclaration {
	const taskTimeout = formatHatchetTimeout(resolveHatchetTaskExecutionTimeoutMs());
	return client.task<HatchetFlowPayload, SingleResult>({
		name: HATCHET_FLOW_TASK_NAME,
		retries: 0,
		executionTimeout: taskTimeout,
		scheduleTimeout: taskTimeout,
		fn: (input) => runHatchetFlowTask(input),
	});
}
export async function submitHatchetTaskWithClient(
	client: HatchetTaskClient,
	payload: HatchetFlowPayload,
): Promise<SingleResult> {
	const declaration = createHatchetFlowTaskDeclaration(client);
	return validateSingleResult(await declaration.run(payload), `Hatchet task ${HATCHET_FLOW_TASK_NAME}`);
}
async function loadHatchetSdk(): Promise<HatchetSdkModule> {
	try {
		return await import("@hatchet-dev/typescript-sdk/v1/index.js");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`PI_FLOW_RUNNER=hatchet requires optional package @hatchet-dev/typescript-sdk. Install and configure Hatchet before using this backend. (${message})`,
		);
	}
}
export async function submitHatchetTaskWithSdk(
	sdk: HatchetSdkModule,
	taskName: string,
	payload: HatchetFlowPayload,
): Promise<SingleResult> {
	const clientFactory =
		asFunction(getProperty(sdk, "HatchetClient")) ??
		asFunction(getProperty(sdk, "Hatchet")) ??
		asFunction(getProperty(sdk, "default"));
	const client = clientFactory ? await createHatchetClient(clientFactory) : (getProperty(sdk, "hatchet") ?? sdk);
	if (typeof getProperty(client, "task") === "function" && taskName === HATCHET_FLOW_TASK_NAME) {
		return submitHatchetTaskWithClient(client as HatchetTaskClient, payload);
	}
	const directRun = asFunction<(taskName: string, payload: HatchetFlowPayload) => Promise<unknown>>(
		getProperty(client, "run"),
	);
	if (directRun) return validateSingleResult(await directRun(taskName, payload), "Hatchet SDK result");
	const workflows = getProperty(client, "workflows") ?? getProperty(client, "workflow");
	const workflowRun = asFunction<(taskName: string, payload: HatchetFlowPayload) => Promise<unknown>>(
		getProperty(workflows, "run"),
	);
	if (workflowRun) return validateSingleResult(await workflowRun(taskName, payload), "Hatchet SDK result");
	const tasks = getProperty(client, "tasks") ?? getProperty(client, "task");
	const taskRun =
		asFunction<(taskName: string, payload: HatchetFlowPayload) => Promise<unknown>>(getProperty(tasks, "run")) ??
		asFunction<(taskName: string, payload: HatchetFlowPayload) => Promise<unknown>>(getProperty(tasks, "execute"));
	if (taskRun) return validateSingleResult(await taskRun(taskName, payload), "Hatchet SDK result");
	throw new Error(
		"Hatchet SDK loaded, but no supported task submission method was found. Expected client.run, client.workflows.run, or client.tasks.run.",
	);
}
async function defaultSubmitHatchetTask(taskName: string, payload: HatchetFlowPayload): Promise<SingleResult> {
	return await submitHatchetTaskWithSdk(await loadHatchetSdk(), taskName, payload);
}
export async function main(options: RunFlowOptions): Promise<SingleResult> {
	const runner = new HatchetFlowRunner();
	return await runner.run(options);
}
function makeHatchetLifecycleResult(
	options: RunFlowOptions,
	status: string,
	errorMessage?: string,
): SingleResult {
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
function emitHatchetLifecycleUpdate(
	options: RunFlowOptions,
	projectFlowsDir: string | null,
	text: string,
	result: SingleResult,
): void {
	options.onUpdate?.({ content: [{ type: "text", text }], details: makeFlowDetails(projectFlowsDir)([result]) });
}
export class HatchetFlowRunner implements FlowRunner {
	constructor(private readonly submitTask: HatchetSubmitter = defaultSubmitHatchetTask) {}
	async run(options: RunFlowOptions, context?: FlowRunContext): Promise<SingleResult> {
		const projectFlowsDir = context?.projectFlowsDir ?? null;
		const payload = serializeHatchetFlowPayload(options, projectFlowsDir);
		validateHatchetFlowPayloadSize(payload);
		const timeoutMs = resolveHatchetResultTimeoutMs();
		emitHatchetLifecycleUpdate(
			options,
			projectFlowsDir,
			`Hatchet queued/running flow ${payload.flowName}.`,
			makeHatchetLifecycleResult(options, "queued/running"),
		);
		try {
			const result = validateSingleResult(
				await awaitHatchetResult(this.submitTask(HATCHET_FLOW_TASK_NAME, payload), timeoutMs),
				"Hatchet runner result",
			);
			emitHatchetLifecycleUpdate(options, projectFlowsDir, `Hatchet completed flow ${payload.flowName}.`, result);
			return result;
		} catch (error) {
			emitHatchetLifecycleUpdate(
				options,
				projectFlowsDir,
				`Hatchet failed flow ${payload.flowName}.`,
				makeHatchetFailureLifecycleResult(options),
			);
			throw error;
		}
	}
}
export async function runHatchetFlowTask(payload: HatchetFlowPayload): Promise<SingleResult> {
	const originalRunner = process.env.PI_FLOW_RUNNER;
	const originalSpawn = process.env.PI_FLOW_SPAWN_COMMAND;
	process.env.PI_FLOW_RUNNER = "local";
	process.env.PI_FLOW_SPAWN_COMMAND = resolveHatchetSpawnCommand(process.env);
	try {
		validateHatchetWorkerPayload(payload);
		const { runFlow } = await import("./flow.js");
		return validateSingleResult(await runFlow(deserializeHatchetFlowPayload(payload)), "Hatchet worker result");
	} finally {
		if (originalRunner === undefined) delete process.env.PI_FLOW_RUNNER;
		else process.env.PI_FLOW_RUNNER = originalRunner;
		if (originalSpawn === undefined) delete process.env.PI_FLOW_SPAWN_COMMAND;
		else process.env.PI_FLOW_SPAWN_COMMAND = originalSpawn;
	}
}
