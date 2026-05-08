/**
 * Shared type definitions for the flow-state delegation extension.
 */

import type { Message } from "@mariozechner/pi-ai";
import { getFlowFinalText } from "./runner-events.js";

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

/** Structured file entry in a flow's output. */
export interface FileEntry {
	/** Path to the file, relative or absolute. */
	path: string;
	/** Semantic role of this file in the flow's work. */
	role?: "reference" | "read" | "modified" | "created" | "deleted" | "test";
	/** Why this file matters (1 sentence). */
	description?: string;
	/** Short excerpt or snippet (not full content). */
	snippet?: string;
	/** Specific line ranges of interest. */
	ranges?: Array<{
		start: number;
		end: number;
		/** Free-form label like "bug", "fix", "ref", "added". */
		label?: string;
	}>;
}

/** Structured command/tool invocation entry in a flow's output. */
export interface CommandEntry {
	/** The exact verbatim command string or tool call that was executed. */
	command: string;
	/** Tool used: bash, grep, find, ls, batch, read, write, edit, flow, web. */
	tool?: string;
	/** Execution time classification from the timed bash wrapper (e.g. "3.5s (normal)"). */
	executionTime?: string;
}

/** Compressed representation of a flow result for child context inheritance. */
export interface CompressedFlowResult {
	/** Flow type (scout, build, debug, etc.). */
	type: string;
	/** Execution outcome. */
	status: "accomplished" | "failed" | "aborted";
	/** Files touched, read, or referenced. */
	files?: FileEntry[];
	/** Commands or tool calls executed. */
	commands?: CommandEntry[];
	/** Error message for failed/aborted flows. */
	error?: string;
}

/** Action performed or attempted by a flow. */
export interface Action {
	type: string;
	description: string;
	target?: string;
	result?: "success" | "failure" | "partial" | "skipped";
	evidence?: string;
}

/** Incomplete, skipped, blocked, or deferred work reported by a flow. */
export interface NotDoneItem {
	/** The unfinished item. */
	item: string;
	/** Why the item was not completed. */
	reason?: string;
	/** Concrete blocker preventing completion, when applicable. */
	blocker?: string;
	/** Suggested follow-up for this item. */
	nextStep?: string;
}

/** Structured JSON output from a flow run. */
export interface FlowStructuredOutput {
	/** Schema version for forward compatibility. */
	version: string;
	/** Overall completion status. */
	status: "complete" | "partial" | "blocked" | "failed";
	/** 1–3 sentence summary of what was accomplished. */
	summary: string;
	/** Files touched, read, or referenced. */
	files: FileEntry[];
	/** Actions performed or attempted. */
	actions: Action[];
	/** Commands or tool calls executed during the flow. */
	commands: CommandEntry[];
	/** Incomplete, skipped, blocked, or deferred work. */
	notDone: NotDoneItem[];
	/** Recommended next steps or follow-up flows. */
	nextSteps: string[];
	/** Reasoning chains, hypotheses, inferences made during the flow. */
	reasoning: string[];
	/** Observations, warnings, caveats, side notes. */
	notes: string[];
	/** Escape hatch for flow-specific data (audit findings, debug root cause, etc.). */
	extensions?: Record<string, unknown>;
}

/** Result of a single flow invocation. */
export interface SingleResult {
	type: string;
	agentSource: "user" | "project" | "bundled" | "unknown";
	intent: string;
	aim: string;
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
	structuredOutput?: FlowStructuredOutput;
}

/** Metadata attached to every tool result for rendering. */
export interface FlowDetails {
	mode: "flow";
	delegationMode: "fork";
	projectAgentsDir: string | null;
	results: SingleResult[];
}

/** A display-friendly representation of a message part. */
export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

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

/** Extract all display-worthy items from a message history. */
export function getFlowDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") {
					items.push({ type: "text", text: part.text });
				} else if (part.type === "toolCall") {
					const name = part.name ?? part.toolName ?? "unknown";
					const args = (part.arguments ?? part.input ?? {}) as Record<string, unknown>;
					items.push({ type: "toolCall", name, args });
				}
			}
		}
	}
	return items;
}

/** Extract the last tool call from message history. */
export function getLastToolCall(messages: Message[]): { type: "toolCall"; name: string; args: Record<string, unknown> } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (let j = msg.content.length - 1; j >= 0; j--) {
				const part = msg.content[j];
				if (part.type === "toolCall") {
					const name = part.name ?? part.toolName ?? "unknown";
					const args = (part.arguments ?? part.input ?? {}) as Record<string, unknown>;
					return { type: "toolCall", name, args };
				}
			}
		}
	}
	return undefined;
}

/** Extract the last assistant text from message history. */
export function getLastAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (let j = msg.content.length - 1; j >= 0; j--) {
				const part = msg.content[j];
				if (part.type === "text" && part.text.trim()) {
					return part.text.trim();
				}
			}
		}
	}
	return "";
}

// ---------------------------------------------------------------------------
// Telemetry types
// ---------------------------------------------------------------------------

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
	/** Current delegation depth. */
	depth: number;
}

// ---------------------------------------------------------------------------
// Plugin API types
// ---------------------------------------------------------------------------

/** Public API surface exposed via the pi-agent-flow:ready event. */
export interface PiAgentFlowAPI {
	/** Discover all available flows for a given working directory. */
	discoverFlows: (cwd: string) => { flows: Array<{ name: string; description: string; source: string }>; projectFlowsDir: string | null };
	/** Determine the model tier for a given flow name. */
	getFlowTier: (name: string) => string;
	/** Get current flow settings. */
	getSettings: () => { toolOptimize: boolean; structuredOutput: boolean; maxConcurrency: number };
}

