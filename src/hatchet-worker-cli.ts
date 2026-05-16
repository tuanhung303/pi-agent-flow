#!/usr/bin/env node
import {
	applyLocalHatchetTlsStrategyDefault,
	createHatchetFlowTaskDeclaration,
	HATCHET_FLOW_TASK_NAME,
} from "./hatchet-runner.js";
import { pathToFileURL } from "node:url";
export const PI_FLOW_HATCHET_WORKER_NAME_ENV = "PI_FLOW_HATCHET_WORKER_NAME";
export const PI_FLOW_HATCHET_WORKER_SLOTS_ENV = "PI_FLOW_HATCHET_WORKER_SLOTS";
export const DEFAULT_HATCHET_WORKER_NAME = "pi-agent-flow-worker";
export const DEFAULT_HATCHET_WORKER_SLOTS = 3;
export const DEFAULT_HATCHET_WORKER_READY_TIMEOUT_MS = 60_000;
export interface HatchetWorkerLike {
	start(): Promise<void>;
	waitUntilReady(timeoutMs?: number): Promise<void>;
}
export interface HatchetWorkerClientLike {
	task<I, O>(options: { name: string; retries?: number; fn: (input: I) => Promise<O> | O }): { run(input: I): Promise<O> };
	worker(name: string, options?: unknown): Promise<HatchetWorkerLike>;
}
export interface HatchetWorkerConfig {
	name: string;
	slots: number;
}
export interface HatchetWorkerLogger {
	info(message: string): void;
	error(message: string): void;
}
export interface HatchetWorkerCliMainOptions {
	env?: NodeJS.ProcessEnv;
	logger?: HatchetWorkerLogger;
	client?: HatchetWorkerClientLike;
}
async function loadHatchetWorkerClient(): Promise<HatchetWorkerClientLike> {
	const sdk = await import("@hatchet-dev/typescript-sdk/v1/client/client.js");
	const clientFactory = (sdk as Record<string, unknown>).HatchetClient ?? (sdk as Record<string, unknown>).Hatchet ?? sdk.default;
	if (typeof clientFactory === "function") return new (clientFactory as new () => HatchetWorkerClientLike)();
	throw new Error("Hatchet SDK loaded, but no supported client constructor was found.");
}
export function resolveHatchetWorkerName(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env[PI_FLOW_HATCHET_WORKER_NAME_ENV]?.trim();
	return configured || DEFAULT_HATCHET_WORKER_NAME;
}
export function resolveHatchetWorkerSlots(env: NodeJS.ProcessEnv = process.env): number {
	const configured = env[PI_FLOW_HATCHET_WORKER_SLOTS_ENV]?.trim();
	if (!configured) return DEFAULT_HATCHET_WORKER_SLOTS;
	if (!/^\d+$/.test(configured)) {
		throw new Error(`${PI_FLOW_HATCHET_WORKER_SLOTS_ENV} must be a positive integer. Received ${JSON.stringify(configured)}.`);
	}
	const slots = Number.parseInt(configured, 10);
	if (!Number.isSafeInteger(slots) || slots < 1) {
		throw new Error(`${PI_FLOW_HATCHET_WORKER_SLOTS_ENV} must be a positive integer. Received ${JSON.stringify(configured)}.`);
	}
	return slots;
}
export function resolveHatchetWorkerConfig(env: NodeJS.ProcessEnv = process.env): HatchetWorkerConfig {
	return { name: resolveHatchetWorkerName(env), slots: resolveHatchetWorkerSlots(env) };
}
export async function createHatchetFlowWorker(client: HatchetWorkerClientLike, env: NodeJS.ProcessEnv = process.env): Promise<{ worker: HatchetWorkerLike; config: HatchetWorkerConfig }> {
	applyLocalHatchetTlsStrategyDefault(env);
	const config = resolveHatchetWorkerConfig(env);
	const piAgentFlowRunFlow = createHatchetFlowTaskDeclaration(client);
	const worker = await client.worker(config.name, { workflows: [piAgentFlowRunFlow], slots: config.slots });
	return { worker, config };
}
export async function startHatchetFlowWorker(client: HatchetWorkerClientLike, env: NodeJS.ProcessEnv = process.env, logger: HatchetWorkerLogger = console): Promise<void> {
	const { worker, config } = await createHatchetFlowWorker(client, env);
	const startPromise = worker.start();
	const stopBeforeReady = (async (): Promise<never> => {
		await startPromise;
		throw new Error(`Hatchet worker ${JSON.stringify(config.name)} stopped before reporting ready.`);
	})();
	await Promise.race([worker.waitUntilReady(DEFAULT_HATCHET_WORKER_READY_TIMEOUT_MS), stopBeforeReady]);
	logger.info(`Hatchet worker ready for ${HATCHET_FLOW_TASK_NAME} (name=${config.name}, slots=${config.slots}).`);
	await startPromise;
}
export async function main(options: HatchetWorkerCliMainOptions = {}): Promise<void> {
	const env = options.env ?? process.env;
	const logger = options.logger ?? console;
	try {
		const client = options.client ?? await loadHatchetWorkerClient();
		await startHatchetFlowWorker(client, env, logger);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		logger.error(`Failed to start Hatchet worker for ${HATCHET_FLOW_TASK_NAME}: ${detail}`);
		process.exitCode = 1;
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	void main();
}
