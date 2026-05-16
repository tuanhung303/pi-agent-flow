/**
 * Flow execution and telemetry types.
 */

import type { Message } from "@mariozechner/pi-ai";
import { getFlowFinalText } from "../snapshot/runner-events.js";

/** Aggregated token usage from a flow run. */
export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
	toolCalls: number;
	smoothedTps?: number;
}

/** Result of a single flow invocation. */
export interface SingleResult {
	type: string;
	agentSource: "user" | "project" | "bundled" | "unknown";
	intent: string;
	aim: string;
	acceptance?: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	sawAgentEnd?: boolean;
	/** Epoch ms when flow execution started; used for live countdown rendering. */
	startedAtMs?: number;
	/** Epoch ms when the flow hard timeout occurs; used for live countdown rendering. */
	deadlineAtMs?: number;
	/** Live in-progress text for status rendering; not part of the final flow report. */
	streamingText?: string;
	/** Structured JSON output parsed from the flow's final response. */
	structuredOutput?: import("./output.js").FlowStructuredOutput;
}

/** Metadata attached to every tool result for rendering. */
export interface FlowDetails {
	mode: "flow";
	flowStyle: "fork";
	projectAgentsDir: string | null;
	results: SingleResult[];
}

/** Metrics emitted after each flow completes. */
export interface FlowMetrics {
	/** Flow type name. */
	type: string;
	/** Duration in milliseconds. */
	durationMs: number;
	/** Final exit code. */
	exitCode: number;
	/** Whether the flow succeeded. */
	success: boolean;
	/** Model used for this execution. */
	model?: string;
	/** Number of failover attempts. */
	failoverCount: number;
	/** Token usage. */
	usage: UsageStats;
	/** Flow source. */
	source: string;
	/** Current flow depth. */
	depth: number;
}

/** Public API surface exposed via the pi-agent-flow:ready event. */
export interface PiAgentFlowAPI {
	/** Discover all available flows for a given working directory. */
	discoverFlows: (cwd: string) => { flows: Array<{ name: string; description: string; source: string }>; projectFlowsDir: string | null };
	/** Determine the model tier for a given flow name. */
	getFlowTier: (name: string) => string;
	/** Get current flow settings. */
	getSettings: () => {
		toolOptimize: boolean;
		structuredOutput: boolean;
		maxConcurrency: number;
		steeringEnabled: boolean;
		steeringCustomPrompt: string | undefined;
		steeringStrategicHint: boolean;
		animationEnabled: boolean;
		animationGlitch: boolean;
	};
}

/** Create an empty UsageStats object. */
export function emptyFlowUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, toolCalls: 0, smoothedTps: 0 };
}

/** Sum usage across multiple results. */
export function aggregateFlowUsage(results: SingleResult[]): UsageStats {
	const total = emptyFlowUsage();
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
		total.toolCalls += r.usage.toolCalls;
		if ((r.usage.smoothedTps ?? 0) > (total.smoothedTps ?? 0)) {
			total.smoothedTps = r.usage.smoothedTps;
		}
	}
	return total;
}

/** Whether the child emitted a final assistant text response. */
export function hasFlowOutput(r: Pick<SingleResult, "messages">): boolean {
	return getFlowFinalText(r.messages).trim().length > 0;
}

/** Whether the child semantically completed the run. */
export function isFlowComplete(r: Pick<SingleResult, "messages" | "sawAgentEnd">): boolean {
	return Boolean(r.sawAgentEnd) && hasFlowOutput(r);
}

/** Whether a result should be treated as successful by the wrapper/UI. */
export function isFlowSuccess(r: SingleResult): boolean {
	if (r.exitCode === -1) return false;
	if (isFlowComplete(r)) return true;
	return r.exitCode === 0 && r.stopReason !== "error" && r.stopReason !== "aborted" && r.stopReason !== "timeout";
}

/** Whether a result represents an error. */
export function isFlowError(r: SingleResult): boolean {
	if (r.exitCode === -1) return false;
	return !isFlowSuccess(r);
}

/** Reconcile process exit status with semantic completion observed from Pi's event stream. */
export function normalizeFlowResult(result: SingleResult, wasAborted: boolean): SingleResult {
	const hasSemanticSuccess = isFlowComplete(result);

	if (wasAborted) {
		if (hasSemanticSuccess) {
			result.exitCode = 0;
			if (result.stopReason === "aborted") result.stopReason = undefined;
			if (result.errorMessage === "Flow was aborted.") {
				result.errorMessage = undefined;
			}
		} else {
			result.exitCode = 130;
			result.stopReason = "aborted";
			result.errorMessage = "Flow was aborted.";
			if (!result.stderr.trim()) result.stderr = "Flow was aborted.";
		}
		return result;
	}

	if (result.exitCode > 0) {
		if (hasSemanticSuccess) {
			result.exitCode = 0;
			if (result.stopReason === "error") result.stopReason = undefined;
			if (result.errorMessage === result.stderr.trim()) {
				result.errorMessage = undefined;
			}
		} else {
			if (!result.stopReason) result.stopReason = "error";
			if (!result.errorMessage && result.stderr.trim()) {
				result.errorMessage = result.stderr.trim();
			}
		}
	}

	return result;
}

/** Extract the last assistant text from a message history. */
export function getFlowOutput(messages: Message[]): string {
	return getFlowFinalText(messages);
}
