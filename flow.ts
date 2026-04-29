/**
 * Flow process runner (fork-only).
 *
 * Spawns isolated pi processes with forked session context
 * and streams results back via callbacks.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { type FlowConfig, getFlowTier } from "./agents.js";
import { parseFlowCliArgs } from "./runner-cli.js";
import { processFlowJsonLine, drainStreamingText, drainStreamingEstimate, drainCtxEstimate, updateSmoothedTps, drainSmoothedTps } from "./runner-events.js";
import {
	type SingleResult,
	type FlowDetails,
	emptyFlowUsage,
	getFlowOutput,
	normalizeFlowResult,
} from "./types.js";

const isWindows = process.platform === "win32";
const SIGKILL_TIMEOUT_MS = 5000;
const AGENT_END_GRACE_MS = 250;
const FLOW_DEPTH_ENV = "PI_FLOW_DEPTH";
const FLOW_MAX_DEPTH_ENV = "PI_FLOW_MAX_DEPTH";
const FLOW_STACK_ENV = "PI_FLOW_STACK";
const FLOW_PREVENT_CYCLES_ENV = "PI_FLOW_PREVENT_CYCLES";
const PI_OFFLINE_ENV = "PI_OFFLINE";

type FlowUpdateCallback = (partial: AgentToolResult<FlowDetails>) => void;

/**
 * Merge actual usage with streaming estimates.
 * Uses Math.max for output to avoid double-counting.
 * Uses Math.max for contextTokens so the ctx estimate (baseline + streaming)
 * smoothly increments during active streaming.
 */
function mergeStreamingUsage(
	actual: SingleResult["usage"],
	estimatedOutputTokens: number,
	ctxEstimate: number,
	smoothedTps: number,
): SingleResult["usage"] {
	if (estimatedOutputTokens <= 0 && ctxEstimate <= 0 && smoothedTps <= 0) return actual;
	return {
		...actual,
		...(estimatedOutputTokens > 0 ? { output: Math.max(actual.output, estimatedOutputTokens) } : {}),
		...(ctxEstimate > 0 ? { contextTokens: Math.max(actual.contextTokens, ctxEstimate) } : {}),
		...(smoothedTps > 0 ? { smoothedTps } : {}),
	};
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/**
 * Derive the spawn command from the current process context so child invocations
 * work on Unix and Windows without going through a shell wrapper.
 */
function resolveFlowSpawn(): { command: string; prefixArgs: string[] } {
	const isNode = /[\\/]node(?:\.exe)?$/i.test(process.execPath);
	if (isNode && process.argv[1]) {
		return { command: process.execPath, prefixArgs: [process.argv[1]] };
	}
	return { command: process.execPath, prefixArgs: [] };
}

// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------

function writeFlowSessionToTempFile(
	flowName: string,
	sessionJsonl: string,
): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-"));
	const safeName = flowName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `flow-${safeName}.jsonl`);
	fs.writeFileSync(filePath, sessionJsonl, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

function cleanupFlowTempDir(dir: string | null): void {
	if (!dir) return;
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

// ---------------------------------------------------------------------------
// Build pi CLI arguments (fork-only)
// ---------------------------------------------------------------------------

const inheritedCliArgs = parseFlowCliArgs(process.argv);

function buildFlowArgs(
	flow: FlowConfig,
	intent: string,
	forkSessionPath: string | null,
	tieredModels?: { lite?: string; flash?: string; full?: string },
): string[] {
	const args: string[] = [
		"--mode",
		"json",
		...inheritedCliArgs.extensionArgs,
		...inheritedCliArgs.alwaysProxy,
		"-p",
	];

	// Fork mode: always use --session
	if (forkSessionPath) {
		args.push("--session", forkSessionPath);
	}

	const tier = getFlowTier(flow.name);
	const tierModel = tieredModels?.[tier] ?? inheritedCliArgs.tieredModels?.[tier];
	const model = flow.model ?? tierModel ?? inheritedCliArgs.fallbackModel;
	if (model) args.push("--model", model);

	const thinking = flow.thinking ?? inheritedCliArgs.fallbackThinking;
	if (thinking) args.push("--thinking", thinking);

	if (flow.tools && flow.tools.length > 0) {
		args.push("--tools", flow.tools.join(","));
	} else if (flow.tools === undefined) {
		if (inheritedCliArgs.fallbackTools !== undefined) {
			args.push("--tools", inheritedCliArgs.fallbackTools);
		} else if (inheritedCliArgs.fallbackNoTools) {
			args.push("--no-tools");
		}
	}

	// No --append-system-prompt: child inherits parent's system prompt for cache hits.
	// Flow instructions go in the intent message instead.

	const flowDirectives =
		`=== flow directive ===\n` +
		`You are a flow state executing a mission. The conversation history above is background context — use it for reference, but your sole focus is the intent below.\n` +
		`=== end flow directive ===`;

	const flowInstructions = flow.systemPrompt.trim()
		? `\n\n=== system directive ===\n${flow.systemPrompt.trim()}\n=== end system directive ===`
		: "";

	args.push(`${flowDirectives}${flowInstructions}\n\nIntent: ${intent}`);
	return args;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunFlowOptions {
	/** Fallback working directory when the intent doesn't specify one. */
	cwd: string;
	/** All available flow configs. */
	flows: FlowConfig[];
	/** Name of the flow to run. */
	flowName: string;
	/** Intent description. */
	intent: string;
	/** Optional override working directory. */
	taskCwd?: string;
	/** Serialized parent session snapshot for fork mode. Null when the flow starts with a clean slate. */
	forkSessionSnapshotJsonl: string | null;
	/** Current delegation depth of the caller process. */
	parentDepth: number;
	/** Delegation stack from the caller process (ancestor flow names). */
	parentFlowStack: string[];
	/** Maximum allowed delegation depth to propagate to child processes. */
	maxDepth: number;
	/** Whether cycle prevention should be enforced in child processes. */
	preventCycles: boolean;
	/** Tiered model overrides (lite/flash/full). */
	tieredModels?: { lite?: string; flash?: string; full?: string };
	/** Abort signal for cancellation. */
	signal?: AbortSignal;
	/** Streaming update callback. */
	onUpdate?: FlowUpdateCallback;
	/** Factory to wrap results into FlowDetails. */
	makeDetails: (results: SingleResult[]) => FlowDetails;
}

/**
 * Spawn a single flow process with forked session context.
 *
 * Returns a SingleResult even on failure (exitCode > 0, stderr populated).
 */
export async function runFlow(opts: RunFlowOptions): Promise<SingleResult> {
	const {
		cwd,
		flows,
		flowName,
		intent,
		taskCwd,
		forkSessionSnapshotJsonl,
		parentDepth,
		parentFlowStack,
		maxDepth,
		preventCycles,
		signal,
		onUpdate,
		makeDetails,
	} = opts;

	const normalizedFlowName = flowName.toLowerCase();
	const flow = flows.find((f) => f.name === normalizedFlowName);
	if (!flow) {
		const available = flows.map((f) => `"${f.name}"`).join(", ") || "none";
		return {
			type: normalizedFlowName,
			agentSource: "unknown",
			intent,
			exitCode: 1,
			messages: [],
			stderr: `Unknown flow: "${flowName}". Available flows: ${available}.`,
			usage: emptyFlowUsage(),
		};
	}

	const resolvedModel = flow.model ?? inheritedCliArgs.fallbackModel;
	const result: SingleResult = {
		type: normalizedFlowName,
		agentSource: flow.source,
		intent,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyFlowUsage(),
		model: resolvedModel,
	};

	const emitUpdate = () => {
		const streaming = drainStreamingText(result);
		const estimatedTokens = drainStreamingEstimate(result);
		const ctxEst = drainCtxEstimate(result);
		updateSmoothedTps(result, estimatedTokens);
		const smoothedTps = drainSmoothedTps(result);
		const mergedUsage = mergeStreamingUsage(result.usage, estimatedTokens, ctxEst, smoothedTps);
		onUpdate?.({
			content: [
				{
					type: "text",
					text: streaming || getFlowOutput(result.messages) || "(running...)",
				},
			],
			details: makeDetails([{ ...result, usage: mergedUsage }]),
		});
	};

	// Write forked session snapshot to temp file only when provided
	let forkSessionTmpDir: string | null = null;
	let forkSessionTmpPath: string | null = null;
	if (forkSessionSnapshotJsonl) {
		const forkTmp = writeFlowSessionToTempFile(flow.name, forkSessionSnapshotJsonl);
		forkSessionTmpDir = forkTmp.dir;
		forkSessionTmpPath = forkTmp.filePath;
	}

	try {
		const piArgs = buildFlowArgs(
			flow,
			intent,
			forkSessionTmpPath,
			opts.tieredModels,
		);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const nextDepth = Math.max(0, Math.floor(parentDepth)) + 1;
			const propagatedMaxDepth = Math.max(0, Math.floor(maxDepth));
			const propagatedStack = [...parentFlowStack, normalizedFlowName];
			const { command, prefixArgs } = resolveFlowSpawn();
			const proc = spawn(command, [...prefixArgs, ...piArgs], {
				cwd: taskCwd ?? cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					[FLOW_DEPTH_ENV]: String(nextDepth),
					[FLOW_MAX_DEPTH_ENV]: String(propagatedMaxDepth),
					[FLOW_STACK_ENV]: JSON.stringify(propagatedStack),
					[FLOW_PREVENT_CYCLES_ENV]: preventCycles ? "1" : "0",
					[PI_OFFLINE_ENV]: "1",
				},
			});

			proc.stdin.on("error", () => {
				/* ignore broken pipe on fast exits */
			});
			proc.stdin.end();

			let buffer = "";
			let didClose = false;
			let settled = false;
			let abortHandler: (() => void) | undefined;
			let semanticCompletionTimer: NodeJS.Timeout | undefined;

			const clearSemanticCompletionTimer = () => {
				if (semanticCompletionTimer) {
					clearTimeout(semanticCompletionTimer);
					semanticCompletionTimer = undefined;
				}
			};

			const terminateChild = () => {
				if (isWindows) {
					if (proc.pid !== undefined) {
						const killer = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
							stdio: "ignore",
						});
						killer.unref();
					}
					return;
				}

				proc.kill("SIGTERM");
				const sigkillTimer = setTimeout(() => {
					if (!didClose) proc.kill("SIGKILL");
				}, SIGKILL_TIMEOUT_MS);
				sigkillTimer.unref();
			};

			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				clearSemanticCompletionTimer();
				if (signal && abortHandler) {
					signal.removeEventListener("abort", abortHandler);
				}
				resolve(code);
			};

			const flushLine = (line: string) => {
				if (processFlowJsonLine(line, result)) emitUpdate();
				maybeFinishFromAgentEnd();
			};

			const flushBufferedLines = (text: string) => {
				for (const line of text.split(/\r?\n/)) {
					if (line.trim()) flushLine(line);
				}
			};

			const maybeFinishFromAgentEnd = () => {
				if (!result.sawAgentEnd || didClose || settled) return;
				clearSemanticCompletionTimer();
				semanticCompletionTimer = setTimeout(() => {
					if (didClose || settled || !result.sawAgentEnd) return;
					if (buffer.trim()) {
						flushBufferedLines(buffer);
						buffer = "";
					}
					proc.stdout.removeListener("data", onStdoutData);
					proc.stderr.removeListener("data", onStderrData);
					finish(0);
					terminateChild();
				}, AGENT_END_GRACE_MS);
				semanticCompletionTimer.unref();
			};

			const onStdoutData = (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split(/\r?\n/);
				buffer = lines.pop() || "";
				for (const line of lines) flushLine(line);
			};

			const onStderrData = (chunk: Buffer) => {
				result.stderr += chunk.toString();
			};

			proc.stdout.on("data", onStdoutData);
			proc.stderr.on("data", onStderrData);

			proc.on("close", (code) => {
				didClose = true;
				if (buffer.trim()) flushBufferedLines(buffer);
				finish(code ?? 0);
			});

			proc.on("error", (err) => {
				if (!result.stderr.trim()) result.stderr = err.message;
				finish(1);
			});

			// Abort handling
			if (signal) {
				abortHandler = () => {
					if (didClose || settled) return;
					wasAborted = true;
					terminateChild();
				};
				if (signal.aborted) abortHandler();
				else signal.addEventListener("abort", abortHandler, { once: true });
			}
		});

		result.exitCode = exitCode;
		return normalizeFlowResult(result, wasAborted);
	} finally {
		cleanupFlowTempDir(forkSessionTmpDir);
	}
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

/**
 * Map over items with a bounded number of concurrent workers.
 */
export async function mapFlowConcurrent<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;

	const worker = async () => {
		while (true) {
			const i = nextIndex++;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
	};

	await Promise.all(Array.from({ length: limit }, () => worker()));
	return results;
}
