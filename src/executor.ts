/**
 * FlowExecutor — extracted from index.ts for testability.
 *
 * Encapsulates the orchestration logic for running flows: cycle detection,
 * project-flow confirmation, parallel execution with failover, caching,
 * hook invocation, auto-transition, and telemetry.
 */

import type { FlowConfig } from "./agents.js";
import type {
	SingleResult,
	FlowDetails,
	CompressedFlowResult,
	FlowMetrics,
} from "./types.js";
import { isFlowSuccess, isFlowError, getFlowOutput, emptyFlowUsage } from "./types.js";
import { extractStructuredOutput } from "./structured-output.js";
import { runHooksDetailed, type RunHooksResult } from "./hooks.js";
import { mapFlowConcurrent, runFlow } from "./flow.js";
import { getFlowSummaryText } from "./runner-events.js";
import { resolveFlowModelCandidates, selectFlowModelStrategy, type LoadedFlowModelConfigs, type FlowModelStrategy } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FlowExecutorDeps {
	/** All discovered flow configs. */
	flows: FlowConfig[];
	/** Current delegation depth. */
	currentDepth: number;
	/** Maximum delegation depth. */
	maxDepth: number;
	/** Ancestor flow stack (names). */
	ancestorFlowStack: string[];
	/** Whether cycle prevention is enabled. */
	preventCycles: boolean;
	/** Whether to use optimized tool list. */
	toolOptimize: boolean;
	/** Whether to inject structured output instructions. */
	structuredOutput: boolean;
	/** Working directory. */
	cwd: string;
	/** Loaded flow model configs. */
	loadedFlowModelConfigs: LoadedFlowModelConfigs;
	/** Max concurrency for parallel flow execution. */
	maxConcurrency: number;
	/** Whether auto-transition is enabled. */
	autoTransition: boolean;
	/** Abort signal. */
	signal?: AbortSignal;
	/** Streaming update callback. */
	onUpdate?: (result: import("@mariozechner/pi-agent-core").AgentToolResult<FlowDetails>) => void;
	/** Factory to wrap results into FlowDetails. */
	makeDetails: (results: SingleResult[]) => FlowDetails;
	/** Get a CLI flag value. */
	getFlag: (name: string) => unknown;
	/** Inherited CLI args for tier overrides. */
	tierOverrideResolver: (tier: "lite" | "flash" | "full") => string | undefined;
	/** Inherited fallback model. */
	fallbackModel?: string;
	/** Fork session snapshot JSONL. */
	forkSessionSnapshotJsonl: string | null;
	/** Flow result cache for compression. */
	flowResultCache: Map<string, CompressedFlowResult[]>;
	/** Project flows directory. */
	projectFlowsDir: string | null;
	/** Session manager for fork snapshot. */
	sessionManager: { getHeader: () => unknown; getBranch: () => unknown[] };
	/** Whether UI is available for confirmation. */
	hasUI: boolean;
	/** UI confirmation callback. */
	uiConfirm: (title: string, body: string) => Promise<boolean>;
	/** Telemetry callback. */
	onFlowMetrics?: (metrics: FlowMetrics) => void;
	/** Whether to prompt the user before running project-local flows. Default: true. */
	confirmProjectFlows?: boolean;
}

export interface ExecuteFlowParams {
	type: string;
	intent: string;
	aim: string;
	cwd?: string;
}

export interface ExecuteFlowResult {
	content: Array<{ type: string; text: string }>;
	details: FlowDetails;
	isError?: boolean;
	/** Auto-queued transitions for the caller to execute. */
	autoTransitions?: Array<{ type: string; intent: string }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFlowCycleViolations(
	requestedNames: Set<string>,
	ancestorFlowStack: string[],
): string[] {
	if (requestedNames.size === 0 || ancestorFlowStack.length === 0) return [];
	const stackSet = new Set(ancestorFlowStack);
	return Array.from(requestedNames).filter((name) => stackSet.has(name));
}

function getRequestedProjectFlows(
	flows: FlowConfig[],
	requestedNames: Set<string>,
): FlowConfig[] {
	return Array.from(requestedNames)
		.map((name) => flows.find((f) => f.name === name.toLowerCase()))
		.filter((f): f is FlowConfig => f?.source === "project");
}

async function confirmProjectFlowsIfNeeded(
	projectFlows: FlowConfig[],
	projectFlowsDir: string | null,
	hasUI: boolean,
	uiConfirm: (title: string, body: string) => Promise<boolean>,
): Promise<{ ok: boolean; blocked?: string }> {
	if (projectFlows.length === 0) return { ok: true };

	const names = projectFlows.map((f) => f.name).join(", ");
	const dir = projectFlowsDir ?? "(unknown)";

	if (hasUI) {
		const ok = await uiConfirm(
			"Run project-local flows?",
			`Flows: ${names}\nSource: ${dir}\n\nProject flows are repo-controlled. Only continue for trusted repositories.`,
		);
		return { ok };
	}

	return {
		ok: false,
		blocked: `Blocked: project-local flow confirmation required in non-UI mode.\nFlows: ${names}\nRe-run with confirmProjectFlows: false if trusted.`,
	};
}

function shouldFailover(result: SingleResult): boolean {
	if (result.stopReason === "aborted") return false;
	const text = `${result.errorMessage ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
	if (!text.trim()) return false;
	if (text.includes("permission") || text.includes("invalid tool") || text.includes("bad settings")) {
		return false;
	}
	return result.exitCode > 0;
}

// ---------------------------------------------------------------------------
// FlowExecutor
// ---------------------------------------------------------------------------

/**
 * Execute a set of flow tasks with full orchestration: cycle detection,
 * project confirmation, parallel execution with model failover, hook
 * invocation, auto-transition, and telemetry.
 */
export async function executeFlows(
	deps: FlowExecutorDeps,
	params: ExecuteFlowParams[],
	toolCallId: string,
): Promise<ExecuteFlowResult> {
	const {
		flows, currentDepth, maxDepth, ancestorFlowStack, preventCycles,
		toolOptimize, structuredOutput, cwd, loadedFlowModelConfigs,
		maxConcurrency, autoTransition, signal, onUpdate, makeDetails,
		getFlag, tierOverrideResolver, fallbackModel, forkSessionSnapshotJsonl,
		flowResultCache, projectFlowsDir, hasUI, uiConfirm, onFlowMetrics,
		confirmProjectFlows,
	} = deps;

	const requested = new Set<string>(params.map((f) => f.type.toLowerCase()));

	// Cycle check
	if (preventCycles) {
		const violations = getFlowCycleViolations(requested, ancestorFlowStack);
		if (violations.length > 0) {
			const stack = ancestorFlowStack.join(" -> ") || "(root)";
			return {
				content: [{
					type: "text",
					text: `Blocked: cycle detected. Flow(s) in stack: ${violations.join(", ")}\nStack: ${stack}`,
				}],
				details: makeDetails([]),
				isError: true,
			};
		}
	}

	// Project flow confirmation
	const projectFlows = getRequestedProjectFlows(flows, requested);
	if (projectFlows.length > 0 && confirmProjectFlows !== false) {
		const { ok, blocked } = await confirmProjectFlowsIfNeeded(projectFlows, projectFlowsDir, hasUI, uiConfirm);
		if (!ok) {
			return {
				content: [{ type: "text", text: blocked ?? "Canceled: project-local flows not approved." }],
				details: makeDetails([]),
				isError: !blocked,
			};
		}
	}

	// Resolve model strategy
	const cliFlowModelConfig =
		typeof getFlag("flow-model-config") === "string"
			? (getFlag("flow-model-config") as string)
			: undefined;
	const selectedFlowModelConfig = selectFlowModelStrategy(
		loadedFlowModelConfigs.configs,
		cliFlowModelConfig ?? loadedFlowModelConfigs.selectedName,
	);

	// Pre-allocate results array
	const allResults: SingleResult[] = new Array(params.length);
	for (let i = 0; i < params.length; i++) {
		allResults[i] = {
			type: params[i].type,
			agentSource: "unknown",
			intent: params[i].intent,
			aim: params[i].aim,
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		};
	}

	// Streaming progress
	let lastStreamingText = "";
	let lastEmittedSignature: string | undefined;
	const emitProgress = (streamingText?: string) => {
		if (!onUpdate) return;
		if (streamingText !== undefined) lastStreamingText = streamingText;
		const text = lastStreamingText || "";
		const signature =
			text +
			"|" +
			allResults
				.map(
					(r) =>
						`${r.messages.length}:${r.usage.toolCalls}:${r.usage.input}:${r.usage.output}:${r.usage.contextTokens}:${r.usage.smoothedTps ?? 0}:${r.errorMessage ?? ""}`,
				)
				.join(";");
		if (signature === lastEmittedSignature) return;
		lastEmittedSignature = signature;
		onUpdate({
			content: [{ type: "text", text }],
			details: makeDetails([...allResults]),
		});
	};

	if (onUpdate) emitProgress();

	// Execute all flows in parallel
	const executionStart = Date.now();
	const results = await mapFlowConcurrent(params, maxConcurrency, async (item, index) => {
		const normalizedType = item.type.toLowerCase();
		const targetFlow = flows.find((f) => f.name === normalizedType);
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
		let result = allResults[index];
		const flowStart = Date.now();

		for (let attempt = 0; attempt < attemptModels.length; attempt++) {
			const candidateModel = attemptModels[attempt];
			if (candidateModel) attemptedModels.push(candidateModel);
			result = await runFlow({
				cwd,
				flows,
				flowName: normalizedType,
				intent: item.intent,
				aim: item.aim,
				taskCwd: item.cwd,
				forkSessionSnapshotJsonl: shouldInheritContext ? forkSessionSnapshotJsonl : null,
				parentDepth: currentDepth,
				parentFlowStack: ancestorFlowStack,
				maxDepth: effectiveMaxDepth,
				preventCycles,
				toolOptimize,
				structuredOutput,
				model: candidateModel,
				signal,
				onUpdate: (partial) => {
					if (partial.details?.results[0]) {
						allResults[index] = partial.details.results[0];
						emitProgress(partial.content?.[0]?.text);
					}
				},
				makeDetails,
			});
			allResults[index] = result;
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
			allResults[index] = result;
			emitProgress();
		}

		// Telemetry for individual flow
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
	});

	// Cache flow results
	for (const result of results) {
		const so = result.structuredOutput;
		if (!so) continue;
		const compressed: CompressedFlowResult = {
			type: result.type,
			status: isFlowError(result) ? "failed" : "accomplished",
		};
		if (so.files.length > 0) compressed.files = so.files;
		if (so.commands.length > 0) compressed.commands = so.commands;
		if (result.errorMessage) compressed.error = result.errorMessage;
		const existing = flowResultCache.get(toolCallId) ?? [];
		existing.push(compressed);
		flowResultCache.set(toolCallId, existing);
	}

	// Build tool result
	const successCount = results.filter((r) => isFlowSuccess(r)).length;
	const flowReports = results.map((r) => {
		const output = getFlowSummaryText(r);
		const status = isFlowError(r) ? "failed" : "accomplished";
		return `flow [${r.type}] ${status}\n\n${output}`;
	});

	// Post-flow hooks
	const hookResult: RunHooksResult = runHooksDetailed(params, results);
	const advisorBlock = hookResult.advisors.length > 0
		? "\n\n---\n\n💡 " + hookResult.advisors.join("\n💡 ")
		: "";

	// Auto-transition: collect qualifying transitions
	const queuedTransitions: Array<{ type: string; intent: string }> = [];
	if (autoTransition && hookResult.autoTransitions.length > 0) {
		for (const transition of hookResult.autoTransitions) {
			if (transition.confidence >= 0.7) {
				const normalizedType = transition.type.toLowerCase();
				const flowExists = flows.some((f) => f.name === normalizedType);
				const notAlreadyRequested = !requested.has(normalizedType);
				const noCycles = !preventCycles || !ancestorFlowStack.includes(normalizedType);
				if (flowExists && notAlreadyRequested && noCycles) {
					queuedTransitions.push({
						type: transition.type,
						intent: transition.intent,
					});
				}
			}
		}
	}

	return {
		content: [{
			type: "text" as const,
			text: `Flow: ${successCount}/${results.length} completed\n\n${flowReports.join("\n\n---\n\n")}${advisorBlock}`,
		}],
		details: makeDetails(results),
		autoTransitions: queuedTransitions.length > 0 ? queuedTransitions : undefined,
	};
}
