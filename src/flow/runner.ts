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
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type FlowConfig, getFlowTier } from "./agents.js";
import { getInheritedCliArgs } from "../snapshot/cli-args.js";
import { processFlowJsonLine, drainStreamingText, drainStreamingEstimate, drainToolCallEstimate, drainCtxEstimate, updateSmoothedTps, drainSmoothedTps, getCtxState } from "../snapshot/runner-events.js";
import {
	type SingleResult,
	type FlowDetails,
	emptyFlowUsage,
	getFlowOutput,
	normalizeFlowResult,
} from "../types/flow.js";
import { parseSharedContext, type CompressionStats } from "../core2/snapshot.js";
import { extractStructuredOutput, generateCommandsFromHistory } from "../snapshot/structured-output.js";
import { computeInitialContextTokens, mergeStreamingContextTokens } from "../tui/context-display.js";
import { logWarn, logError } from '../config/log.js';
import { atomicWriteFileSync } from "../io/atomic-write.js";
import { DEFAULT_COMPLEXITY, getComplexityTimeoutMs, type Complexity } from "./complexity.js";
import type { GoalContext } from "./types.js";
import {
	makeUniqueDumpPath,
	makeUniqueDumpTxtPath,
	cleanupStaleDumps,
	cleanupStaleDebugDumps,
	writeReminderFile,
	getDebugDir,
	resolveDumpMaxAgeHours,
	FLOW_DUMP_SNAPSHOT_ENV,
} from "./dump-io.js";
import {
	registerChildGroup,
	unregisterChildGroup,
	terminateAllChildGroups,
	terminateChildProcess,
	SIGKILL_TIMEOUT_MS,
	isWindows,
} from "./process-lifecycle.js";
import { buildFlowArgs, getOptimizedTools, inheritedCliArgs } from "./flow-args.js";
import { resolveFlowSpawn, writeFlowSessionToTempFile, cleanupFlowTempDir } from "./spawn-utils.js";

export { cleanupStaleDumps } from "./dump-io.js";
export { terminateAllChildGroups } from "./process-lifecycle.js";
export { buildFlowArgs, getOptimizedTools } from "./flow-args.js";

function getEnvInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

const FINISH_KILL_GRACE_MS = getEnvInt("PI_FLOW_FINISH_KILL_GRACE_MS", 5_000);
const AGENT_END_GRACE_MS = getEnvInt("PI_FLOW_AGENT_END_GRACE_MS", 2000);
const FLOW_TIME_BUDGET_WARNING_MS = getEnvInt("PI_FLOW_TIME_BUDGET_WARNING_MS", 2 * 60 * 1000);
const FLOW_FINAL_URGE_MS = getEnvInt("PI_FLOW_FINAL_URGE_MS", 135 * 1000);
const REPORTING_GRACE_MS = getEnvInt("PI_FLOW_REPORTING_GRACE_MS", 90_000);
const SNAP_THRESHOLD_MS = getEnvInt("PI_FLOW_SNAP_THRESHOLD_MS", 120_000);
const FLOW_TOOL_SUMMARY_GRACE_MS = FLOW_FINAL_URGE_MS;
const MAX_STDERR_BYTES = 100 * 1024; // 100KB cap for stderr accumulation
import {
	FLOW_DEPTH_ENV,
	FLOW_MAX_DEPTH_ENV,
	FLOW_STACK_ENV,
	FLOW_PREVENT_CYCLES_ENV,
	FLOW_TOOL_OPTIMIZE_ENV,
} from "./depth.js";
import {
	computeTransitionState,
	buildGuardLine,
	buildFlowListSection,
	buildLineage,
	computeChildPropagation,
} from "./transition.js";

const FLOW_DEADLINE_ENV = "PI_FLOW_DEADLINE_MS";
const FLOW_TOOL_SUMMARY_GRACE_ENV = "PI_FLOW_TOOL_SUMMARY_GRACE_MS";
const PI_OFFLINE_ENV = "PI_OFFLINE";
const FLOW_REMINDER_FILE_ENV = "PI_FLOW_REMINDER_FILE";

const packageJsonPath = path.join(path.dirname(new URL(import.meta.url).pathname), "../..", "package.json");
let pipelineVersion = "0.0.0";
try {
	const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
	pipelineVersion = pkg.version ?? "0.0.0";
} catch (err) {
	logWarn(`[pi-agent-flow] Failed to read package.json: ${err}`);
}

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
		...(ctxEstimate > 0 || actual.contextTokens > 0
			? { contextTokens: mergeStreamingContextTokens(actual, ctxEstimate) }
			: {}),
		...(smoothedTps > 0 ? { smoothedTps } : {}),
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunFlowOptions {
	cwd: string;
	flows: FlowConfig[];
	flowName: string;
	intent: string;
	aim: string;
	acceptance?: string;
	concern?: string;
	taskCwd?: string;
	forkSessionSnapshotJsonl: string | null;
	parentDepth: number;
	parentFlowStack: string[];
	maxDepth: number;
	preventCycles: boolean;
	toolOptimize?: boolean;
	structuredOutput?: boolean;
	model?: string;
	signal?: AbortSignal;
	toolCallId?: string;
	onUpdate?: FlowUpdateCallback;
	makeDetails: (results: SingleResult[]) => FlowDetails;
	complexity?: Complexity;
	goalContext?: GoalContext;
	maxContextTokens?: number;
	tools?: string[];
	preDispatchResults?: string;
	debugMode?: boolean;
	compressionStats?: CompressionStats;
}

export async function runFlow(opts: RunFlowOptions): Promise<SingleResult> {
	const {
		cwd,
		flows,
		flowName,
		intent,
		aim,
		taskCwd,
		forkSessionSnapshotJsonl,
		parentDepth,
		parentFlowStack,
		maxDepth,
		preventCycles,
		toolOptimize = false,
		structuredOutput = true,
		model,
		signal,
		onUpdate,
		makeDetails,
		toolCallId,
	} = opts;

	const normalizedFlowName = flowName.toLowerCase();
	const flow = flows.find((f) => f.name === normalizedFlowName);
	if (!flow) {
		const available = flows.map((f) => `"${f.name}"`).join(", ") || "none";
		const resolvedMaxContextTokens = opts.maxContextTokens ?? inheritedCliArgs.maxContextTokens;
		return {
			type: normalizedFlowName,
			agentSource: "unknown",
			intent,
			aim,
			exitCode: 1,
			messages: [],
			stderr: `Unknown flow: "${flowName}". Available flows: ${available}.`,
			usage: emptyFlowUsage(),
			...(resolvedMaxContextTokens !== undefined ? { maxContextTokens: resolvedMaxContextTokens } : {}),
		};
	}

	const effectiveComplexity = opts.complexity ?? DEFAULT_COMPLEXITY;
	const effectiveTimeout = getComplexityTimeoutMs(effectiveComplexity);
	const startedAtMs = Date.now();
	const deadlineAtMs = effectiveTimeout > 0 ? startedAtMs + effectiveTimeout : undefined;
	const resolvedModel = model ?? flow.model ?? inheritedCliArgs.fallbackModel;
	const resolvedMaxContextTokens = opts.maxContextTokens ?? inheritedCliArgs.maxContextTokens;
	const sharedContext = forkSessionSnapshotJsonl ? parseSharedContext(forkSessionSnapshotJsonl) : undefined;
	const initialContextTokens = computeInitialContextTokens(sharedContext, intent);

	const result: SingleResult = {
		type: normalizedFlowName,
		agentSource: flow.source,
		intent,
		aim,
		acceptance: opts.acceptance,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: {
			...emptyFlowUsage(),
			contextTokens: initialContextTokens,
		},
		model: resolvedModel,
		startedAtMs,
		...(deadlineAtMs !== undefined ? { deadlineAtMs } : {}),
		...(resolvedMaxContextTokens !== undefined ? { maxContextTokens: resolvedMaxContextTokens } : {}),
		...(opts.compressionStats ? { compressionStats: opts.compressionStats } : {}),
	};

	if (initialContextTokens > 0) {
		const ctxState = getCtxState(result);
		ctxState.baseline = initialContextTokens;
	}

	let liveStreamingText = "";
	let liveEstimatedOutputTokens = 0;
	let lastActualOutputTokens = result.usage.output;
	const emitUpdate = () => {
		const streamingDelta = drainStreamingText(result);
		if (streamingDelta) liveStreamingText += streamingDelta;
		const estimatedTokens = drainStreamingEstimate(result);
		const toolCallTokens = drainToolCallEstimate(result);
		if (result.usage.output !== lastActualOutputTokens) {
			lastActualOutputTokens = result.usage.output;
			liveEstimatedOutputTokens = result.usage.output;
		}
		liveEstimatedOutputTokens += estimatedTokens + toolCallTokens;
		const ctxEst = drainCtxEstimate(result);
		updateSmoothedTps(result, estimatedTokens);
		const smoothedTps = drainSmoothedTps(result);
		const elapsedSec = (Date.now() - startedAtMs) / 1000;
		const fallbackTps = elapsedSec > 0.5 && smoothedTps <= 0 ? result.usage.output / elapsedSec : 0;
		const displayTps = smoothedTps > 0 ? smoothedTps : fallbackTps;
		const mergedUsage = mergeStreamingUsage(result.usage, liveEstimatedOutputTokens, ctxEst, displayTps);
		onUpdate?.({
			content: [
				{
					type: "text",
					text: liveStreamingText || getFlowOutput(result.messages) || "(running...)",
				},
			],
			details: makeDetails([{ ...result, usage: mergedUsage, streamingText: liveStreamingText || undefined }]),
			...(toolCallId ? { _toolCallId: toolCallId } : {}),
		});
	};

	let forkSessionTmpDir: string | null = null;
	let forkSessionTmpPath: string | null = null;
	if (forkSessionSnapshotJsonl) {
		const forkTmp = writeFlowSessionToTempFile(flow.name, forkSessionSnapshotJsonl);
		forkSessionTmpDir = forkTmp.dir;
		forkSessionTmpPath = forkTmp.filePath;
	}

	let reminderTmpDir: string | null = null;
	let reminderFilePath: string | null = null;
	if (effectiveTimeout > 0) {
		reminderTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-flow-reminder-"));
		reminderFilePath = path.join(reminderTmpDir, "reminder.txt");
	}

	if (signal?.aborted) {
		result.exitCode = 130;
		result.stopReason = "aborted";
		result.errorMessage = "Flow was aborted.";
		result.stderr = "Flow was aborted.";
		return result;
	}

	try {
		const piArgs = buildFlowArgs(
			flow,
			intent,
			forkSessionTmpPath,
			model,
			parentDepth,
			maxDepth,
			toolOptimize,
			structuredOutput,
			effectiveComplexity,
			effectiveTimeout,
			opts.acceptance,
			opts.concern,
			flows,
			parentFlowStack,
			preventCycles,
			opts.goalContext,
			cwd,
			opts.tools,
			opts.preDispatchResults,
		);

		const promptIndex = piArgs.indexOf("-p");
		const prompt = promptIndex >= 0 ? piArgs[promptIndex + 1] : "";

		result.usage.contextTokens = computeInitialContextTokens(sharedContext, intent, prompt);
		const ctxState = getCtxState(result);
		ctxState.baseline = result.usage.contextTokens;

		if (onUpdate) {
			emitUpdate();
		}

		const dumpPath = process.env[FLOW_DUMP_SNAPSHOT_ENV] || inheritedCliArgs.dumpPath;
		if (dumpPath) {
			cleanupStaleDumps(dumpPath, resolveDumpMaxAgeHours()).catch((err) => {
				logWarn(`[pi-agent-flow] Background cleanupStaleDumps failed: ${err}`);
			});

			const effectiveTier = flow.tier ?? getFlowTier(flow.name);
			const sanitizationHeader = `<!-- pi-agent-flow dump | Flow: ${flow.name} | Tier: ${effectiveTier} | Pipeline: ${pipelineVersion} | Generated: ${new Date().toISOString()} -->`;

			const markdownParts: string[] = [
				sanitizationHeader,
				``,
			];
			if (forkSessionSnapshotJsonl) {
				markdownParts.push(
					`## Session Snapshot (JSONL)`,
					``,
					...forkSessionSnapshotJsonl.split("\n"),
					``,
				);
			}
			markdownParts.push(
				`## Activation Prompt (-p)`,
				``,
				prompt,
			);
			const markdown = markdownParts.join("\n");
			const uniqueDumpPath = makeUniqueDumpPath(dumpPath, flow.name);
			const uniqueTxtPath = makeUniqueDumpTxtPath(uniqueDumpPath);
			try {
				atomicWriteFileSync(uniqueDumpPath, markdown);
				atomicWriteFileSync(uniqueTxtPath, prompt);
				logError(`[pi-agent-flow] Snapshot dumped to ${uniqueDumpPath}`);
			} catch (err) {
				logError(`[pi-agent-flow] Snapshot dump FAILED: ${err}`);
			}
		}

		if (opts.debugMode) {
			cleanupStaleDebugDumps(cwd, resolveDumpMaxAgeHours()).catch((err) => {
				logWarn(`[pi-agent-flow] Background cleanupStaleDebugDumps failed: ${err}`);
			});

			const safeFlowName = flow.name.replace(/[^\w.-]+/g, "_");
			const uniqueSuffix = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
			const debugDir = getDebugDir(cwd, forkSessionSnapshotJsonl);
			fs.mkdirSync(debugDir, { recursive: true });
			const debugPath = path.join(debugDir, `pi-flow-debug-${safeFlowName}-${uniqueSuffix}.txt`);
			try {
				const parts: string[] = [];
				if (forkSessionSnapshotJsonl) {
					parts.push("## Session Snapshot (JSONL)");
					parts.push(forkSessionSnapshotJsonl);
				}
				parts.push("## Activation Prompt (-p)");
				parts.push(prompt);
				atomicWriteFileSync(debugPath, parts.join("\n\n"));
				logWarn(`[pi-agent-flow] Debug prompt written to ${debugPath}`);
			} catch (err) {
				logWarn(`[pi-agent-flow] Debug prompt write FAILED: ${err}`);
			}
		}

		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const { nextDepth, propagatedMaxDepth, propagatedStack } = computeChildPropagation(parentDepth, maxDepth, parentFlowStack, normalizedFlowName);
			const isShortBudget = effectiveTimeout <= SNAP_THRESHOLD_MS;
			const warningMs = isShortBudget
				? Math.floor(effectiveTimeout * 0.5)
				: effectiveTimeout - FLOW_TIME_BUDGET_WARNING_MS;
			const urgeMs = isShortBudget
				? Math.floor(effectiveTimeout * 0.85)
				: effectiveTimeout - FLOW_FINAL_URGE_MS;
			const effectiveGraceMs = isShortBudget
				? Math.max(5_000, Math.floor(effectiveTimeout * 0.15))
				: REPORTING_GRACE_MS;
			const toolSummaryGraceMs = isShortBudget
				? Math.max(3_000, Math.floor(effectiveTimeout * 0.1))
				: Math.min(
					FLOW_TOOL_SUMMARY_GRACE_MS,
					Math.max(0, effectiveTimeout),
					Math.max(effectiveTimeout >= 10_000 ? 1_000 : Math.floor(effectiveTimeout / 2), Math.floor(effectiveTimeout * 0.1)),
				);
			const { command, prefixArgs } = resolveFlowSpawn();
			if (dumpPath) {
				const distDir = path.dirname(new URL(import.meta.url).pathname);
				const srcDir = path.join(distDir, "..", "..", "src");
				const checkStale = (srcFile: string, distFile: string) => {
					try {
						const srcMtime = fs.statSync(path.join(srcDir, srcFile)).mtimeMs;
						const distMtime = fs.statSync(path.join(distDir, distFile)).mtimeMs;
						return srcMtime > distMtime;
					} catch (e) { logWarn(`[pi-agent-flow] checkStale failed for ${srcFile}: ${e}`); return false; }
				};
				if (checkStale("core2/snapshot.ts", "../core2/snapshot.js") || checkStale("flow/runner.ts", "runner.js")) {
					logWarn("⚠️ Source newer than dist — run npm run build for accurate dumps");
				}
			}
			const proc = spawn(command, [...prefixArgs, ...piArgs], {
				cwd: taskCwd ?? cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				detached: !isWindows,
				...(signal ? { signal } : {}),
				env: {
					...process.env,
					[FLOW_DEPTH_ENV]: String(nextDepth),
					[FLOW_MAX_DEPTH_ENV]: String(propagatedMaxDepth),
					[FLOW_STACK_ENV]: JSON.stringify(propagatedStack),
					[FLOW_PREVENT_CYCLES_ENV]: preventCycles ? "1" : "0",
					[FLOW_TOOL_OPTIMIZE_ENV]: toolOptimize ? "1" : "0",
					[PI_OFFLINE_ENV]: "1",
					...(effectiveTimeout > 0 ? {
						[FLOW_DEADLINE_ENV]: String(deadlineAtMs),
						[FLOW_TOOL_SUMMARY_GRACE_ENV]: String(toolSummaryGraceMs),
						[FLOW_REMINDER_FILE_ENV]: reminderFilePath ?? "",
					} : {
						[FLOW_DEADLINE_ENV]: "",
						[FLOW_TOOL_SUMMARY_GRACE_ENV]: "0",
						[FLOW_REMINDER_FILE_ENV]: "",
					}),
				},
			});

			if (proc.pid !== undefined && !isWindows) {
				registerChildGroup(proc.pid, normalizedFlowName);
			}

			let stdinEnded = false;
			const endStdin = () => {
				if (stdinEnded) return;
				stdinEnded = true;
				try { proc.stdin.end(); } catch (e) { logWarn(`[pi-agent-flow] Failed to end child stdin: ${e}`); }
			};
			proc.stdin.on("error", (err) => {
				logWarn(`[pi-agent-flow] Child stdin error: ${err}`);
			});
			proc.stdin.end();

			let abortHandler: (() => void) | undefined;
			let chunks: Buffer[] = []; // Fix P2: Replace O(n^2) string concatenation with Buffer array accumulation
			let didClose = false;
			let settled = false;
			let timeoutFired = false;
			let semanticCompletionTimer: NodeJS.Timeout | undefined;
			let countdownTimer: NodeJS.Timeout | undefined;
			let renderTimer: NodeJS.Timeout | undefined;
			let finishKillTimer: NodeJS.Timeout | undefined;
			let hasNewData = false; // Fix P3: Dirty flag for render optimization
			let stderrTruncated = false; // Fix P2: Prevent redundant stderr re-truncation

			const clearSemanticCompletionTimer = () => {
				if (semanticCompletionTimer) {
					clearTimeout(semanticCompletionTimer);
					semanticCompletionTimer = undefined;
				}
			};

			const clearCountdownTimer = () => {
				if (countdownTimer) {
					clearInterval(countdownTimer);
					countdownTimer = undefined;
				}
			};

			const clearRenderTimer = () => {
				if (renderTimer) {
					clearInterval(renderTimer);
					renderTimer = undefined;
				}
			};

			const terminateChild = () => {
				terminateChildProcess(proc, {
					endStdin,
					timeoutMs: SIGKILL_TIMEOUT_MS,
					skipIfClosed: () => didClose,
				});
			};

			const clearFinishKillTimer = () => {
				if (finishKillTimer) {
					clearTimeout(finishKillTimer);
					finishKillTimer = undefined;
				}
			};

			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				endStdin();
				clearSemanticCompletionTimer();
				clearCountdownTimer();
				clearRenderTimer();
				if (signal && abortHandler) {
					signal.removeEventListener("abort", abortHandler);
				}
				clearFinishKillTimer();
				finishKillTimer = setTimeout(() => {
					if (!didClose) {
						terminateChild();
					}
				}, FINISH_KILL_GRACE_MS);
				finishKillTimer.unref();
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

			let semanticCompletionTimerArmed = false;
			const maybeFinishFromAgentEnd = () => {
				if (!result.sawAgentEnd || didClose || settled || semanticCompletionTimerArmed) return;
				semanticCompletionTimerArmed = true;
				semanticCompletionTimer = setTimeout(() => {
					if (didClose || settled || !result.sawAgentEnd) return;
					const text = Buffer.concat(chunks).toString();
					if (text.trim()) {
						flushBufferedLines(text);
						chunks = [];
					}
					finish(0);
				}, AGENT_END_GRACE_MS);
				semanticCompletionTimer.unref();
			};

			const onStdoutData = (chunk: Buffer) => {
				hasNewData = true; // Fix P3: Set BEFORE data processing to avoid race condition
				chunks.push(chunk);
				const text = Buffer.concat(chunks).toString();
				const lines = text.split(/\r?\n/);
				const remainder = lines.pop() || "";
				chunks = remainder ? [Buffer.from(remainder)] : [];
				for (const line of lines) flushLine(line);
			};

			const onStderrData = (chunk: Buffer) => {
				// Fix P6: Cap stderr accumulation at 100KB to prevent unbounded growth
				if (stderrTruncated) return;
				const chunkStr = chunk.toString();
				if (result.stderr.length + chunkStr.length > MAX_STDERR_BYTES) {
					stderrTruncated = true;
					const keepBytes = Math.max(0, MAX_STDERR_BYTES - 1000);
					result.stderr = result.stderr.slice(0, keepBytes) + "\n... [stderr truncated]";
				} else {
					result.stderr += chunkStr;
				}
			};

			proc.stdout.on("data", onStdoutData);
			proc.stderr.on("data", onStderrData);

			if (onUpdate) {
				renderTimer = setInterval(() => {
					if (didClose || settled) return;
					// Fix P3: Skip render updates when no new streaming data arrived
					if (!hasNewData) return;
					hasNewData = false;
					emitUpdate();
				}, 200);
				renderTimer.unref();
				if (effectiveTimeout > 0) {
					countdownTimer = setInterval(() => {
						if (didClose || settled) return;
						// Fix P3: Skip render updates when no new streaming data arrived
						if (!hasNewData) return;
						hasNewData = false;
						emitUpdate();
					}, 1000);
					countdownTimer.unref();
				}
				emitUpdate();
			}

			proc.on("close", (code) => {
				didClose = true;
				clearFinishKillTimer();
				if (proc.pid !== undefined) {
					unregisterChildGroup(proc.pid);
				}
				const text = Buffer.concat(chunks).toString();
				if (text.trim()) flushBufferedLines(text);
				finish(code ?? 0);
			});

			proc.on("error", (err) => {
				if (!result.stderr.trim()) result.stderr = err.message;
				if (proc.pid !== undefined) unregisterChildGroup(proc.pid); // Fix L1: Unregister child group on spawn error (error event suppresses close)
				finish(1);
			});

			if (signal) {
				abortHandler = () => {
					if (didClose || settled) return;
					wasAborted = true;
					endStdin();
					terminateChild();
				};
				if (signal.aborted) abortHandler();
				else signal.addEventListener("abort", abortHandler, { once: true });
			}

			if (effectiveTimeout > 0) {
				const warningMs = effectiveTimeout - FLOW_TIME_BUDGET_WARNING_MS;
				if (warningMs > 0) {
					const warnTimer = setTimeout(() => {
						if (didClose || settled) return;
						const remainingSec = Math.round(FLOW_TIME_BUDGET_WARNING_MS / 1000);
						const warnMsg = `\n[Flow warning] ${remainingSec}s remaining before hard timeout. The agent should wrap up now.`;
						result.stderr += warnMsg;
						writeReminderFile(reminderFilePath, `[Flow warning] ${remainingSec}s remaining before hard timeout. Wrap up your work and output structured findings.`);
						emitUpdate();
					}, warningMs);
					warnTimer.unref();
				}

				const urgeMs = effectiveTimeout - FLOW_FINAL_URGE_MS;
				if (urgeMs > 0) {
					const urgeTimer = setTimeout(() => {
						if (didClose || settled) return;
						const remainingSec = Math.round(FLOW_FINAL_URGE_MS / 1000);
						const urgeMsg = `\n[Flow warning] ${remainingSec}s remaining before hard timeout. Stop all work and output your structured findings.`;
						result.stderr += urgeMsg;
						writeReminderFile(reminderFilePath, `[Flow urge] ${remainingSec}s remaining before hard timeout. STOP all tool use and output your structured findings NOW.`);
						emitUpdate();
					}, urgeMs);
					urgeTimer.unref();
				}

				const timeoutTimer = setTimeout(() => {
					if (didClose || settled) return;
					timeoutFired = true;
					result.stderr += `\nFlow timed out after ${Math.round(effectiveTimeout / 1000)}s.`;
					emitUpdate();

					const graceTimer = setTimeout(() => {
						if (didClose || settled) return;
						result.stopReason = "timeout";
						result.errorMessage = `Flow timed out after ${Math.round(effectiveTimeout / 1000)}s.`;
						terminateChild();
					}, effectiveGraceMs);
					graceTimer.unref();
				}, effectiveTimeout);
				timeoutTimer.unref();
			}
		});

		result.exitCode = exitCode;

		const finalSmoothedTps = drainSmoothedTps(result);
		const finalElapsedSec = (Date.now() - startedAtMs) / 1000;
		const finalTps = finalSmoothedTps > 0 ? finalSmoothedTps
			: (finalElapsedSec > 0 ? result.usage.output / finalElapsedSec : 0);
		if (finalTps > 0) {
			result.usage.smoothedTps = finalTps;
		}

		const normalized = normalizeFlowResult(result, wasAborted);

		if (structuredOutput) {
			const flowText = getFlowOutput(normalized.messages);
			const extracted = extractStructuredOutput(flowText);
			if (extracted) {
				extracted.commands = generateCommandsFromHistory(normalized.messages);
				normalized.structuredOutput = extracted;
			}
		}

		return normalized;
	} finally {
		cleanupFlowTempDir(forkSessionTmpDir);
		cleanupFlowTempDir(reminderTmpDir);
	}
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

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
