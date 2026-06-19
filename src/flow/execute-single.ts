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
import type { SingleResult, FlowDetails, FlowMetrics } from "../types/flow.js";
import type { FlowExecutorDeps, ExecuteFlowParams } from "./executor.js";
import type { LoadedFlowModelConfigs } from "../config/config.js";

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
	const tier = targetFlow?.tier ?? "flash";
	const { candidates } = resolveFlowModelCandidates({
		tier,
		flowModel: targetFlow?.model,
		cliTierOverride: tierOverrideResolver(tier),
		strategy: selectedFlowModelConfig.strategy,
		fallbackModel,
	});
	const attemptModels = candidates.length > 0 ? candidates : [undefined];
	const attemptedModels: string[] = [];
	let result = allResults[resultIndex];
	const flowStart = Date.now();

	const maxRetries = deps.subAgentMaxRetries ?? 0;
	const baseDelayMs = deps.subAgentBaseDelayMs ?? 1000;
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
				forkSessionSnapshotJsonl: shouldInheritContext ? forkSessionSnapshotJsonl : null,
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
				compressionStats: deps.compressionStats,
				tools: item._childTools,
				preDispatchResults: item.preDispatchResults,
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

		// Connection-error retry logic
		if (
			result &&
			!isFlowSuccess(result) &&
			!signal?.aborted &&
			retryCount < maxRetries &&
			isRetryableConnectionError(result.stderr ?? "", result.errorMessage)
		) {
			retryCount++;
			const delayMs = baseDelayMs * Math.pow(2, retryCount - 1);
			await new Promise<void>((resolve) => setTimeout(resolve, delayMs));

			// Preserve metadata across retry reset
			const previousRetry = allResults[resultIndex];
			carriedRetryAnnotation = `[retry ${retryCount}/${maxRetries}] ${previousRetry?.stderr ?? ""}`;
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
			usage: result.usage,
			source: result.agentSource,
			depth: currentDepth + 1,
		});
	}

	return result;
}
