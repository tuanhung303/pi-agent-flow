/**
 * FlowExecutor — extracted from index.ts for testability.
 *
 * Encapsulates the orchestration logic for running flows: cycle detection,
 * project-flow confirmation, parallel execution with failover, caching,
 * and telemetry.
 */

import type { FlowConfig } from "./agents.js";
import type {
	SingleResult,
	FlowDetails,
	FlowMetrics,
} from "../types/flow.js";
import { isFlowSuccess, isFlowError, isFlowComplete, getFlowOutput, emptyFlowUsage } from "../types/flow.js";

import { extractStructuredOutput } from "../snapshot/structured-output.js";


import { getFlowSummaryText } from "../snapshot/runner-events.js";
import { normalizeFlowModeName, resolveFlowModelCandidates, resolveModelContextWindow, selectFlowModelStrategy, type LoadedFlowModelConfigs, type FlowModelStrategy } from "../config/config.js";
import { getComplexityTimeoutMs, resolveComplexity, getImpliedAuditLoop, type Complexity } from "./complexity.js";
import { setFlowComplete } from "../notify/notify-state.js";
import { setLiveText, clearLiveText } from '../tui/scramble/index.js';
import { publishFlowLiveText, publishFlowLiveTextAtIndex } from './flow-live.js';
import { logWarn } from '../config/log.js';
import { markFlowCompleted } from '../flow/index.js';
import type { GoalContext } from '../flow/types.js';
import {
	preserveMetadata,
	getFlowCycleViolations,
	createGhostResult,
	shouldFailover,
	type CycleHistoryEntry,
} from "./cycle-guard.js";
import {
	resolveAuditModel,
	buildReworkIntent,
	buildGroupAuditIntent,
	formatPriorAuditHistory,
	formatPriorBuildOutputs,
} from "./audit-formatters.js";
import { executeSingleFlow } from "./execute-single.js";

export { preserveMetadata, createGhostResult, shouldFailover, type CycleHistoryEntry } from "./cycle-guard.js";
export { buildReworkIntent, buildGroupAuditIntent, formatPriorAuditHistory, formatPriorBuildOutputs } from "./audit-formatters.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FlowExecutorDeps {
	flows: FlowConfig[];
	currentDepth: number;
	maxDepth: number;
	ancestorFlowStack: string[];
	preventCycles: boolean;
	toolOptimize: boolean;
	structuredOutput: boolean;
	cwd: string;
	loadedFlowModelConfigs: LoadedFlowModelConfigs;
	maxConcurrency: number;
	defaultComplexity: Complexity;
	signal?: AbortSignal;
	onUpdate?: (result: import("@earendil-works/pi-agent-core").AgentToolResult<FlowDetails>) => void;
	makeDetails: (results: SingleResult[]) => FlowDetails;
	getFlag: (name: string) => unknown;
	tierOverrideResolver: (tier: "lite" | "flash" | "full") => string | undefined;
	fallbackModel?: string;
	forkSessionSnapshotJsonl: string | null;
	compressionStats?: import("../core2/snapshot.js").CompressionStats;
	projectFlowsDir: string | null;
	sessionManager: { getHeader: () => unknown; getBranch: () => unknown[]; getSessionId: () => string };
	hasUI: boolean;
	uiConfirm: (title: string, body: string) => Promise<boolean>;
	onFlowMetrics?: (metrics: FlowMetrics) => void;
	confirmProjectFlows?: boolean;
	goalContinuationCallback?: (results: SingleResult[]) => Promise<void>;
	goalContext?: GoalContext;
	debugMode: boolean;
	subAgentMaxRetries?: number;
	subAgentBaseDelayMs?: number;
}

export interface ExecuteFlowParams {
	type: string;
	intent: string;
	aim: string;
	acceptance?: string;
	concern?: string;
	cwd?: string;
	complexity: Complexity;
	_childTools?: string[];
	preDispatchResults?: string;
}

export interface ExecuteFlowResult {
	content: Array<{ type: string; text: string }>;
	details: FlowDetails;
	failed?: boolean;
	_toolCallId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

class ConcurrencyLimiter {
  private activeCount = 0;
  private pendingQueue: (() => void)[] = [];

  constructor(private max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeCount >= this.max) {
      await new Promise<void>((resolve) => {
        this.pendingQueue.push(resolve);
      });
    }
    this.activeCount++;
    try {
      return await fn();
    } finally {
      this.activeCount--;
      const next = this.pendingQueue.shift();
      if (next) {
        next();
      }
    }
  }
}

interface PingPongGroup {
  items: ExecuteFlowParams[];
  auditLoop: number;
  buildIndices: number[];
  auditIndex: number;
  groupId: number;
}

async function executeGroupedPingPong(
  deps: FlowExecutorDeps,
  group: PingPongGroup,
  allResults: SingleResult[],
  toolCallId: string,
  emitProgress: (streamingText?: string) => void,
  selectedFlowModelConfig: LoadedFlowModelConfigs,
  limiter: ConcurrencyLimiter,
): Promise<SingleResult[]> {
  const { items, auditLoop, buildIndices, auditIndex } = group;
  const maxCycles = (auditLoop ?? 0) + 1;
  let cycle = 0;
  const verdictHistory: Array<{ cycle: number; verdict: string; feedback?: string }> = [];
  const cycleHistory: CycleHistoryEntry[] = [];
  const auditFeedbacks: (string | null)[] = new Array(items.length).fill(null);

  for (let i = 0; i < items.length; i++) {
    allResults[buildIndices[i]] = createGhostResult(items[i].type, items[i].intent, items[i].aim);
    allResults[buildIndices[i]].status = "running";
    allResults[buildIndices[i]].pingPongMeta = { cycles: 0, verdicts: [], finalVerdict: "pending" };
    allResults[buildIndices[i]].auditLoopGroupId = group.groupId;
  }
  const { model: auditModel, maxContextTokens: auditMaxCtx } = resolveAuditModel(deps.flows, deps.tierOverrideResolver, selectedFlowModelConfig.strategy, deps.fallbackModel);
  allResults[auditIndex] = createGhostResult("audit", "", `Audit ${items.length} build outputs`, auditModel, auditMaxCtx);
  allResults[auditIndex].status = "awaiting";
  allResults[auditIndex].auditParentType = "build";
  allResults[auditIndex].auditLoopGroupId = group.groupId;

  const key = toolCallId || 'collapsed';
  const buildResults: SingleResult[] = new Array(items.length);

  while (cycle < maxCycles) {
    for (let i = 0; i < items.length; i++) {
      allResults[buildIndices[i]].status = "running";
      allResults[buildIndices[i]].exitCode = -1;
      allResults[buildIndices[i]].streamingText = undefined;
      allResults[buildIndices[i]].startedAtMs = undefined;
      allResults[buildIndices[i]].deadlineAtMs = undefined;
    }
    allResults[auditIndex].status = "awaiting";
    allResults[auditIndex].exitCode = -1;
    clearLiveText(`${key}#${auditIndex}`);
    setLiveText(`${key}#${auditIndex}`, "[awaiting...]");
    setLiveText(`collapsed#${auditIndex}`, "[awaiting...]");
    emitProgress();

    const buildPromises = items.map((item, i) => {
      const buildInput = cycle > 0
        ? buildReworkIntent(item.intent, item.aim, item.acceptance, auditFeedbacks[i] ?? "No issues found.", cycleHistory)
        : item.intent;
      const buildItem: ExecuteFlowParams = { ...item, intent: buildInput };
      return limiter.run(() => executeSingleFlow(deps, buildItem, allResults, buildIndices[i], toolCallId, emitProgress, selectedFlowModelConfig));
    });
    const newBuildResults = await Promise.all(buildPromises);

    for (let i = 0; i < items.length; i++) {
      buildResults[i] = newBuildResults[i];
      preserveMetadata(buildResults[i], allResults[buildIndices[i]]);
      allResults[buildIndices[i]] = buildResults[i];
      allResults[buildIndices[i]].status = isFlowSuccess(buildResults[i]) ? "done" : "error";
      allResults[buildIndices[i]].streamingText = undefined;
      allResults[buildIndices[i]].startedAtMs = undefined;
      allResults[buildIndices[i]].deadlineAtMs = undefined;
    }
    emitProgress();

    const anyBuildFailed = buildResults.some(r => !isFlowSuccess(r));
    if (anyBuildFailed) {
      const { model: skipAuditModel, maxContextTokens: skipAuditMaxCtx } = resolveAuditModel(deps.flows, deps.tierOverrideResolver, selectedFlowModelConfig.strategy, deps.fallbackModel);
      allResults[auditIndex] = {
        ...createGhostResult("audit", "", `Audit ${items.length} build outputs`, skipAuditModel, skipAuditMaxCtx),
        status: "skipped",
        exitCode: 0,
        stderr: "",
        auditParentType: "build",
        auditLoopGroupId: allResults[auditIndex]?.auditLoopGroupId,
      };
      emitProgress();
      break;
    }

    for (let i = 0; i < items.length; i++) {
      allResults[buildIndices[i]].status = "awaiting";
      clearLiveText(`${key}#${buildIndices[i]}`);
      setLiveText(`${key}#${buildIndices[i]}`, "[awaiting...]");
      setLiveText(`collapsed#${buildIndices[i]}`, "[awaiting...]");
    }
    allResults[auditIndex].status = "running";
    allResults[auditIndex].exitCode = -1;
    allResults[auditIndex].streamingText = undefined;
    allResults[auditIndex].startedAtMs = undefined;
    allResults[auditIndex].deadlineAtMs = undefined;
    emitProgress();

    const auditInput = buildGroupAuditIntent(
      items.map((item, i) => ({
        aim: item.aim,
        intent: item.intent,
        acceptance: item.acceptance,
        concern: item.concern,
        output: getFlowSummaryText(buildResults[i], { toolContext: false }),
      })),
      cycleHistory,
    );
    const auditItem: ExecuteFlowParams = {
      type: "audit",
      intent: `Audit the completed build flows.\n\n${auditInput}`,
      aim: `Audit ${items.length} build outputs`,
      acceptance: "Verify correctness, security, and completeness of all build flows' outputs.",
      concern: "Verify audit accuracy against original build intents and outputs.",
      complexity: items[0]?.complexity ?? "moderate",
    };
    const auditResult = await limiter.run(() => executeSingleFlow(deps, auditItem, allResults, auditIndex, toolCallId, emitProgress, selectedFlowModelConfig));
    auditResult.auditParentType = items[0].type;
    allResults[auditIndex] = auditResult;

    const perBuildVerdicts = auditResult.structuredOutput?.builds;
    const topLevelVerdict = auditResult.structuredOutput?.verdict ?? "pass";
    const topLevelFeedback = auditResult.structuredOutput?.feedback;

    let anyReworkNeeded = false;

    if (Array.isArray(perBuildVerdicts)) {
      for (let i = 0; i < items.length; i++) {
        const bv = perBuildVerdicts.find((b: { index: number | string; verdict?: string; feedback?: string }) => Number(b.index) === i);
        if (bv?.verdict === "rework") {
          auditFeedbacks[i] = bv.feedback ?? "Fix issues found in audit.";
          anyReworkNeeded = true;
        } else {
          auditFeedbacks[i] = null;
        }
      }
    } else {
      if (topLevelVerdict === "rework") {
        for (let i = 0; i < items.length; i++) {
          auditFeedbacks[i] = topLevelFeedback ?? "Fix issues found in audit.";
        }
        anyReworkNeeded = true;
      } else {
        for (let i = 0; i < items.length; i++) {
          auditFeedbacks[i] = null;
        }
      }
    }

    verdictHistory.push({
      cycle,
      verdict: anyReworkNeeded ? "rework" : "pass",
      ...(anyReworkNeeded && topLevelFeedback ? { feedback: topLevelFeedback } : {}),
    });

    cycleHistory.push({
      cycle,
      buildOutputs: buildResults.map((r) => getFlowSummaryText(r, { toolContext: false })),
      verdict: anyReworkNeeded ? "rework" : "pass",
      feedback: anyReworkNeeded ? topLevelFeedback : undefined,
      buildFeedbacks: [...auditFeedbacks],
    });

    auditResult.status = auditResult.exitCode === 0 ? "done" : "error";
    preserveMetadata(auditResult, allResults[auditIndex]);
    allResults[auditIndex] = auditResult;
    emitProgress();

    if (!anyReworkNeeded) {
      break;
    }

    if (cycle + 1 >= maxCycles) {
      break;
    }

    cycle++;
  }

  for (let i = 0; i < items.length; i++) {
    allResults[buildIndices[i]].exitCode = isFlowSuccess(buildResults[i]) ? 0 : (buildResults[i].exitCode > 0 ? buildResults[i].exitCode : 1);
    allResults[buildIndices[i]].status = isFlowSuccess(buildResults[i]) ? "done" : "error";
  }
  if (allResults[auditIndex].status === "skipped") {
    allResults[auditIndex].exitCode = 0;
  } else {
    allResults[auditIndex].exitCode = isFlowSuccess(allResults[auditIndex]) ? 0 : (allResults[auditIndex].exitCode > 0 ? allResults[auditIndex].exitCode : 1);
    allResults[auditIndex].status = "done";
  }

  for (let i = 0; i < items.length; i++) {
    allResults[buildIndices[i]].pingPongMeta = {
      cycles: cycle + 1,
      verdicts: verdictHistory,
      finalVerdict: allResults[auditIndex].structuredOutput?.verdict ?? (allResults[auditIndex].status === "skipped" ? "fail" : "pass"),
    };
  }

  if (allResults[auditIndex].status !== "skipped") {
    allResults[auditIndex].pingPongMeta = {
      cycles: cycle + 1,
      verdicts: verdictHistory,
      finalVerdict: allResults[auditIndex].structuredOutput?.verdict ?? "pass",
    };
  }

  emitProgress();
  return buildResults;
}


// ---------------------------------------------------------------------------
// FlowExecutor
// ---------------------------------------------------------------------------

export async function executeFlows(
	deps: FlowExecutorDeps,
	params: ExecuteFlowParams[],
	toolCallId: string,
	auditLoop: number,
): Promise<ExecuteFlowResult> {
	const {
		flows, currentDepth, maxDepth, ancestorFlowStack, preventCycles,
		toolOptimize, structuredOutput, cwd, loadedFlowModelConfigs,
		maxConcurrency, defaultComplexity, signal, onUpdate, makeDetails,
		getFlag, tierOverrideResolver, fallbackModel, forkSessionSnapshotJsonl,
		projectFlowsDir, hasUI, uiConfirm, onFlowMetrics,
		confirmProjectFlows,
		goalContext,
		subAgentMaxRetries,
		subAgentBaseDelayMs,
	} = deps;

	const requested = new Set<string>(params.map((f) => f.type.toLowerCase()));

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
				failed: true,
			};
		}
	}

	const projectFlows = getRequestedProjectFlows(flows, requested);
	if (projectFlows.length > 0 && confirmProjectFlows !== false) {
		const { ok, blocked } = await confirmProjectFlowsIfNeeded(projectFlows, projectFlowsDir, hasUI, uiConfirm);
		if (!ok) {
			return {
				content: [{ type: "text", text: blocked ?? "Canceled: project-local flows not approved." }],
				details: makeDetails([]),
				failed: !blocked,
			};
		}
	}

	const cliFlowMode = normalizeFlowModeName(getFlag("flow-mode"));
	const cliFlowModelConfig = normalizeFlowModeName(getFlag("flow-model-config"));
	if (cliFlowMode !== undefined && cliFlowModelConfig !== undefined && cliFlowMode !== cliFlowModelConfig) {
		logWarn(
			`[pi-agent-flow] Both --flow-mode "${cliFlowMode}" and --flow-model-config "${cliFlowModelConfig}" were provided. Using --flow-mode.`,
		);
	}
	const selectedFlowModelConfig = selectFlowModelStrategy(
		loadedFlowModelConfigs.configs,
		cliFlowMode ?? cliFlowModelConfig ?? loadedFlowModelConfigs.selectedName,
	);

	const regularParams: ExecuteFlowParams[] = [];
	const regularIndices: number[] = [];
	const groups: PingPongGroup[] = [];

	const effectiveAuditLoops = params.map((p) => {
		if (p.type.toLowerCase() === "build") {
			return Math.max(auditLoop ?? 0, getImpliedAuditLoop(p.complexity));
		}
		return 0;
	});
	const hasBuildsWithAudit = effectiveAuditLoops.some((loop, i) =>
		params[i].type.toLowerCase() === "build" && loop > 0,
	);

	let nextIndex = 0;
	let buildGroup: PingPongGroup | undefined;
	for (let i = 0; i < params.length; i++) {
		if (hasBuildsWithAudit && params[i].type.toLowerCase() === "audit") {
			logWarn(`Manual audit flow skipped — audit auto-spawned by complexity or auditLoop`);
			continue;
		}
		if (params[i].type.toLowerCase() === "build" && effectiveAuditLoops[i] > 0) {
			if (buildGroup) {
				buildGroup.items.push(params[i]);
				buildGroup.buildIndices.push(nextIndex++);
				buildGroup.auditLoop = Math.max(buildGroup.auditLoop, effectiveAuditLoops[i]);
			} else {
				const buildIndex = nextIndex++;
				buildGroup = {
					items: [params[i]],
					auditLoop: effectiveAuditLoops[i],
					buildIndices: [buildIndex],
					auditIndex: -1,
					groupId: -1,
				};
				groups.push(buildGroup!);
			}
		} else {
			regularIndices.push(nextIndex);
			regularParams.push(params[i]);
			nextIndex++;
			buildGroup = undefined;
		}
	}

	let groupCounter = 0;
	for (const group of groups) {
		group.auditIndex = nextIndex++;
		group.groupId = groupCounter++;
	}

	const allResults: SingleResult[] = new Array(nextIndex);
	for (let i = 0; i < regularParams.length; i++) {
		const idx = regularIndices[i];
		allResults[idx] = {
			type: regularParams[i].type,
			agentSource: "unknown",
			intent: regularParams[i].intent,
			aim: regularParams[i].aim,
			acceptance: regularParams[i].acceptance,
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: emptyFlowUsage(),
		};
	}
	for (const group of groups) {
		for (let i = 0; i < group.items.length; i++) {
			const buildIndex = group.buildIndices[i];
			allResults[buildIndex] = createGhostResult(group.items[i].type, group.items[i].intent, group.items[i].aim);
			allResults[buildIndex].status = "running";
			allResults[buildIndex].pingPongMeta = { cycles: 0, verdicts: [], finalVerdict: "pending" };
			allResults[buildIndex].auditLoopGroupId = group.groupId;
		}
		const { model: auditModel, maxContextTokens: auditMaxCtx } = resolveAuditModel(flows, tierOverrideResolver, selectedFlowModelConfig.strategy, fallbackModel);
		allResults[group.auditIndex] = createGhostResult("audit", "", `Audit ${group.items.length} build outputs`, auditModel, auditMaxCtx);
		allResults[group.auditIndex].status = "awaiting";
		allResults[group.auditIndex].auditParentType = "build";
		allResults[group.auditIndex].auditLoopGroupId = group.groupId;
	}

	let lastEmittedSignature: string | undefined;
	const emitProgress = (streamingText?: string) => {
		const activeStreamingText = allResults
			.filter((r) => r.exitCode === -1)
			.map((r) => r.streamingText)
			.filter((text): text is string => Boolean(text))
			.at(-1);
		const text = streamingText ?? activeStreamingText ?? "";

		if (toolCallId) {
			publishFlowLiveText(toolCallId, text);
			for (let i = 0; i < allResults.length; i++) {
				const r = allResults[i];
				if (r.streamingText) {
					publishFlowLiveTextAtIndex(toolCallId, i, r.streamingText);
				}
			}
		} else {
			setLiveText("collapsed", text);
			for (let i = 0; i < allResults.length; i++) {
				const r = allResults[i];
				if (r.streamingText) {
					setLiveText(`collapsed#${i}`, r.streamingText);
				}
			}
		}

		if (!onUpdate) return;

		const signature =
			text +
			"|" +
			allResults
				.map((r) => {
					const remainingSeconds = r.exitCode === -1 && typeof r.deadlineAtMs === "number"
						? Math.max(0, Math.ceil((r.deadlineAtMs - Date.now()) / 1000))
						: "";
					return `${r.messages.length}:${r.usage.toolCalls}:${r.usage.input}:${r.usage.output}:${r.usage.contextTokens}:${r.usage.smoothedTps ?? 0}:${r.startedAtMs ?? ""}:${r.deadlineAtMs ?? ""}:${remainingSeconds}:${r.errorMessage ?? ""}`;
				})
				.join(";");
		if (signature === lastEmittedSignature) return;
		lastEmittedSignature = signature;
		try {
			onUpdate({
				content: [{ type: "text", text }],
				details: makeDetails([...allResults]),
				_toolCallId: toolCallId,
			});
		} catch (err) {
			if (err instanceof Error && err.message.includes("outside active run")) {
				return;
			}
			throw err;
		}
	};

	emitProgress();

	const executionStart = Date.now();
	const limiter = new ConcurrencyLimiter(maxConcurrency);

	const regularPromise = regularParams.length > 0
		? Promise.all(regularParams.map((item, localIndex) => {
			const globalIndex = regularIndices[localIndex];
			return limiter.run(() => executeSingleFlow(deps, item, allResults, globalIndex, toolCallId, emitProgress, selectedFlowModelConfig));
		}))
		: Promise.resolve([]);

	const groupPromises = groups.map((group) =>
		executeGroupedPingPong(deps, group, allResults, toolCallId, emitProgress, selectedFlowModelConfig, limiter),
	);

	await Promise.all([regularPromise, ...groupPromises]);

	const results = [...allResults];

	const lastResult = results[results.length - 1];
	if (lastResult) {
		setFlowComplete(
			lastResult.type,
			lastResult.acceptance,
			results.length - 1,
			results.length,
		);
	}

	markFlowCompleted(deps.sessionManager.getSessionId());

	if (deps.goalContinuationCallback) {
		await deps.goalContinuationCallback(results);
	}

	const successCount = results.filter((r) => isFlowSuccess(r)).length;
	const flowReports = results.map((r) => {
		const output = getFlowSummaryText(r);
		const status = isFlowError(r) ? "failed" : "accomplished";
		return `flow [${r.type}] ${status}\n\n${output}`;
	});

	return {
		content: [{
			type: "text" as const,
			text: `Flow: ${successCount}/${results.length} completed\n\n${flowReports.join("\n\n---\n\n")}`,
		}],
		details: makeDetails(results),
		_toolCallId: toolCallId,
	};
}
