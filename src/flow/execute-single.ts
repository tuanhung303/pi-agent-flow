/**
 * Single flow execution — extracted from executor.ts.
 */

import { runFlow } from "./runner.js";
import { preserveMetadata, shouldFailover, isRetryableConnectionError } from "./cycle-guard.js";
import { publishFlowLiveText, publishFlowLiveTextAtIndex } from "./flow-live.js";
import { setLiveText } from "../tui/scramble/index.js";
import { isFlowSuccess, emptyFlowUsage } from "../types/flow.js";
import { resolveComplexity, getComplexityTimeoutMs } from "./complexity.js";
import { resolveFlowModelCandidates, resolveModelContextWindow } from "../config/config.js";
import type { FlowConfig } from "./agents.js";
import type { SingleResult } from "../types/flow.js";
import type { FlowExecutorDeps, ExecuteFlowParams } from "./executor.js";
import type { LoadedFlowModelConfigs } from "../config/config.js";

const DEFAULT_SUB_AGENT_MAX_RETRIES = 3;
const DEFAULT_SUB_AGENT_BASE_DELAY_MS = 1000;
const MAX_CARRIED_STDERR_CHARS = 2000;

async function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0 || signal?.aborted) return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			cleanup();
			resolve();
		};
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function executeSingleFlow(
	deps: FlowExecutorDeps,
	item: ExecuteFlowParams,
	allResults: SingleResult[],
	resultIndex: number,
	toolCallId: string,
	emitProgress: (streamingText?: string) => void,
	selectedFlowModelConfig: LoadedFlowModelConfigs,
): Promise<SingleResult> {
	const {
		flows, currentDepth, maxDepth, ancestorFlowStack, preventCycles,
		toolOptimize, structuredOutput, cwd,
		defaultComplexity, signal, makeDetails,
		tierOverrideResolver, fallbackModel, forkSessionSnapshotJsonl,
		onFlowMetrics, goalContext,
	} = deps;

	const normalizedType = item.type.toLowerCase();
	const complexity = resolveComplexity(item.complexity, defaultComplexity);
	const lookupName = normalizedType;
	const targetFlow = flows.find((f) => f.name === lookupName);
	const effectiveMaxDepth =
		targetFlow?.maxDepth !== undefined ? targetFlow.maxDepth : maxDepth;

	const shouldInheritContext = targetFlow?.inheritContext !== false;
	// Generated audit flows have no caller-supplied snapshot. Ask the narrowly
	// scoped factory for their own tier/profile and smallest-retry budget.
	const generatedSnapshot = item.forkSessionSnapshotJsonl === undefined
		? deps.getForkSnapshot?.(normalizedType)
		: undefined;
	const flowSnapshot = item.forkSessionSnapshotJsonl !== undefined
		? item.forkSessionSnapshotJsonl
		: generatedSnapshot?.snapshot ?? forkSessionSnapshotJsonl;
	const flowCompressionStats = item.compressionStats !== undefined
		? item.compressionStats
		: generatedSnapshot?.stats ?? deps.compressionStats;
	const tier = targetFlow?.tier ?? "flash";
	const { candidates, invalidCandidates } = resolveFlowModelCandidates({
		tier,
		flowModel: targetFlow?.model,
		cliTierOverride: tierOverrideResolver(tier),
		strategy: selectedFlowModelConfig.strategy,
		fallbackModel,
	});
	const attemptedModels: string[] = [];
	let result = allResults[resultIndex];
	const flowStart = Date.now();

	// Fail fast when every configured model is known to be missing from models.json.
	if (invalidCandidates.length > 0 && candidates.length === invalidCandidates.length) {
		const badSettingsMessage = `Bad settings: all configured flow models are missing from models.json: ${invalidCandidates.join(", ")}`;
		// model stays undefined: no candidate was actually invoked, so any
		// per-model telemetry rollup would be poisoned if we set it to one
		// of the invalid candidates. Downstream consumers can read
		// invalidCandidates from errorMessage / stderr for diagnostics.
		result = {
			type: normalizedType,
			agentSource: targetFlow?.source ?? "unknown",
			intent: item.intent,
			aim: item.aim,
			exitCode: 1,
			messages: [],
			stderr: badSettingsMessage,
			usage: emptyFlowUsage(),
			stopReason: "error",
			errorMessage: badSettingsMessage,
		};
		const previous = allResults[resultIndex];
		allResults[resultIndex] = result;
		preserveMetadata(allResults[resultIndex], previous);
		emitProgress();
		if (onFlowMetrics) {
			onFlowMetrics({
				type: normalizedType,
				durationMs: Date.now() - flowStart,
				exitCode: result.exitCode,
				success: false,
				model: result.model,
				failoverCount: 0,
				connectionRetryCount: 0,
				usage: result.usage,
				source: result.agentSource,
				depth: currentDepth + 1,
			});
		}
		return result;
	}

	const attemptModels = candidates.length > 0 ? candidates : [undefined];

	const maxRetries = deps.subAgentMaxRetries ?? DEFAULT_SUB_AGENT_MAX_RETRIES;
	const baseDelayMs = deps.subAgentBaseDelayMs ?? DEFAULT_SUB_AGENT_BASE_DELAY_MS;
	let retryCount = 0;
	let carriedRetryAnnotation: string | undefined;

	while (true) {
		attemptedModels.length = 0;

		for (let attempt = 0; attempt < attemptModels.length; attempt++) {
			const candidateModel = attemptModels[attempt];
			if (candidateModel) attemptedModels.push(candidateModel);
			const attemptStartMs = Date.now();
			const attemptTimeoutMs = getComplexityTimeoutMs(complexity);
			const maxContextTokens = resolveModelContextWindow(candidateModel);
			const previous = allResults[resultIndex];
			allResults[resultIndex] = {
				type: normalizedType,
				agentSource: targetFlow?.source ?? "unknown",
				intent: item.intent,
				aim: item.aim,
				exitCode: -1,
				messages: [],
				stderr: carriedRetryAnnotation ?? "",
				usage: emptyFlowUsage(),
				model: candidateModel,
				startedAtMs: attemptStartMs,
				deadlineAtMs: attemptStartMs + attemptTimeoutMs,
				...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
			};
			preserveMetadata(allResults[resultIndex], previous);
			emitProgress();
			result = await runFlow({
				cwd,
				flows,
				flowName: lookupName,
				intent: item.intent,
				aim: item.aim,
				acceptance: item.acceptance,
				concern: item.concern,
				taskCwd: item.cwd,
				forkSessionSnapshotJsonl: shouldInheritContext ? flowSnapshot : null,
				parentDepth: currentDepth,
				parentFlowStack: ancestorFlowStack,
				maxDepth: effectiveMaxDepth,
				preventCycles,
				toolOptimize,
				structuredOutput,
				complexity,
				model: candidateModel,
				maxContextTokens,
				goalContext,
				debugMode: deps.debugMode,
				compressionStats: flowCompressionStats,
				tools: item._childTools,
				preDispatchResults: item.preDispatchResults,
				conventions: deps.conventions,
				signal,
				toolCallId,
				onUpdate: (partial) => {
					if (partial.details?.results[0]) {
						const previous = allResults[resultIndex];
						allResults[resultIndex] = partial.details.results[0];
						preserveMetadata(allResults[resultIndex], previous);
						const flowText = partial.content?.[0]?.text;
						if (flowText !== undefined && toolCallId) {
							publishFlowLiveTextAtIndex(toolCallId, resultIndex, flowText);
						} else if (flowText !== undefined) {
							setLiveText(`collapsed#${resultIndex}`, flowText);
						}
						emitProgress(partial.content?.[0]?.text);
					}
				},
				makeDetails,
			});
			const previous2 = allResults[resultIndex];
			allResults[resultIndex] = result;
			preserveMetadata(allResults[resultIndex], previous2);
			emitProgress();
			if (isFlowSuccess(result) || signal?.aborted) break;
			if (attempt < attemptModels.length - 1 && shouldFailover(result)) {
				continue;
			}
			break;
		}

		if (result && !isFlowSuccess(result) && attemptedModels.length > 1) {
			const summary = `Model failover attempts: ${attemptedModels.join(" -> ")}`;
			const baseStderr = result.stderr.trim();
			result.stderr = baseStderr ? `${baseStderr}\n\n${summary}` : summary;
			const previous3 = allResults[resultIndex];
			allResults[resultIndex] = result;
			preserveMetadata(allResults[resultIndex], previous3);
			emitProgress();
		}

		if (
			result &&
			!isFlowSuccess(result) &&
			!signal?.aborted &&
			retryCount < maxRetries &&
			isRetryableConnectionError(result.stderr ?? "", result.errorMessage)
		) {
			retryCount++;
			const delayMs = baseDelayMs * Math.pow(2, retryCount - 1);
			await sleepAbortable(delayMs, signal);
			if (signal?.aborted) break;

			const previousRetry = allResults[resultIndex];
			const priorStderr = (previousRetry?.stderr ?? "").slice(-MAX_CARRIED_STDERR_CHARS);
			carriedRetryAnnotation = `[retry ${retryCount}/${maxRetries}] ${priorStderr}`;
			allResults[resultIndex] = {
				type: normalizedType,
				agentSource: targetFlow?.source ?? "unknown",
				intent: item.intent,
				aim: item.aim,
				exitCode: -1,
				messages: [],
				stderr: carriedRetryAnnotation,
				usage: emptyFlowUsage(),
				model: undefined,
			};
			preserveMetadata(allResults[resultIndex], previousRetry);
			emitProgress();
			continue;
		}

		break;
	}

	if (onFlowMetrics) {
		const flowDuration = Date.now() - flowStart;
		onFlowMetrics({
			type: normalizedType,
			durationMs: flowDuration,
			exitCode: result.exitCode,
			success: isFlowSuccess(result),
			model: result.model,
			failoverCount: Math.max(0, attemptedModels.length - 1),
			connectionRetryCount: retryCount,
			usage: result.usage,
			source: result.agentSource,
			depth: currentDepth + 1,
		});
	}

	return result;
}
