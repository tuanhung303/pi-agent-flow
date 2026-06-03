/**
 * Streaming Stdout Protocol
 *
 * Event types emitted by pi child processes:
 * - session: session metadata
 * - agent_start: agent initialization
 * - turn_start: turn beginning
 * - message_start: message beginning
 * - message_end: message completed
 * - message_update: streaming delta
 *   - thinking_start / thinking_delta: reasoning tokens
 *   - text_delta: content tokens
 *
 * See core2/snapshot.ts for the Fork Snapshot Protocol (session state serialization).
 */

import type { Message } from "@earendil-works/pi-ai";
import { logWarn } from "../config/log.js";
import { formatBatchOpsSummary } from "../batch/summary.js";
import type { SingleResult } from "../types/flow.js";

// WeakMap-based side tables to avoid polluting caller objects and survive frozen/sealed objects.
const seenSignaturesMap = new WeakMap<object, Set<string>>();
const streamingTextBufferMap = new WeakMap<object, string>();
const lastEmittedWordCountMap = new WeakMap<object, number>();
const streamingEstimateMap = new WeakMap<object, { chars: number }>();
// Fix P8: Add LRU eviction to seenSignaturesMap to prevent unbounded Set growth
const MAX_SEEN_SIGNATURES = 10000;
const smoothedTpsMap = new WeakMap<object, number>();
const lastEmitTimeMap = new WeakMap<object, number>();
const pendingTokensMap = new WeakMap<object, number>();
const pauseAfterNextEmitMap = new WeakMap<object, boolean>();
const ctxBaselineMap = new WeakMap<object, number>();
const ctxStreamingCharsMap = new WeakMap<object, number>();
const toolCallTokenEstimateMap = new WeakMap<object, number>();

function getSeenFlowMessageSignatures(result: object): Set<string> {
	if (!seenSignaturesMap.has(result)) {
		seenSignaturesMap.set(result, new Set());
	}
	return seenSignaturesMap.get(result)!;
}

function addSeenSignature(result: object, signature: string): void {
	const seen = getSeenFlowMessageSignatures(result);
	seen.add(signature);
	while (seen.size > MAX_SEEN_SIGNATURES) {
		const oldest = seen.values().next().value;
		if (oldest !== undefined) {
			seen.delete(oldest);
		} else {
			break;
		}
	}
}

interface StreamingTextState {
	buffer: string;
	lastEmittedWordCount: number;
}

function getStreamingTextState(result: object): StreamingTextState {
	if (!streamingTextBufferMap.has(result)) {
		streamingTextBufferMap.set(result, "");
		lastEmittedWordCountMap.set(result, 0);
	}
	return {
		get buffer() { return streamingTextBufferMap.get(result)!; },
		set buffer(v) { streamingTextBufferMap.set(result, v); },
		get lastEmittedWordCount() { return lastEmittedWordCountMap.get(result)!; },
		set lastEmittedWordCount(v) { lastEmittedWordCountMap.set(result, v); },
	};
}

/**
 * Drain the accumulated streaming text buffer and return it.
 * Updates the last-emitted word count for threshold tracking.
 */
export function drainStreamingText(result: object): string {
	const state = getStreamingTextState(result);
	const buf = state.buffer;
	if (!buf) return "";
	state.buffer = "";
	state.lastEmittedWordCount = 0;
	return buf;
}

// ---------------------------------------------------------------------------
// Streaming token estimate
// ---------------------------------------------------------------------------

/** Chars per token heuristic for output estimation. */
const CHARS_PER_TOKEN = 4;

/** Minimum elapsed ms between TPS samples. */
const MIN_TPS_SAMPLE_MS = 50;
/** Cap on instantaneous TPS to suppress burst artifacts. */
const MAX_INSTANT_TPS = 300;
/** Calibration scale to align heuristic tokens with empirical display range. */
const TPS_CALIBRATION = 1.0;
/** EMA smoothing factor for tokens-per-second (higher = more responsive). */
const EMA_ALPHA = 0.35;
/** Emit streaming text as soon as a non-empty delta arrives. */
const STREAMING_EMIT_CHARS = 1;

function getStreamingEstimate(result: object): { chars: number } {
	if (!streamingEstimateMap.has(result)) {
		streamingEstimateMap.set(result, { chars: 0 });
	}
	return streamingEstimateMap.get(result)!;
}

function getToolCallTokenEstimate(result: object): number {
	if (!toolCallTokenEstimateMap.has(result)) {
		toolCallTokenEstimateMap.set(result, 0);
	}
	return toolCallTokenEstimateMap.get(result)!;
}

function addToolCallTokens(result: object, tokens: number): void {
	if (tokens <= 0) return;
	toolCallTokenEstimateMap.set(result, getToolCallTokenEstimate(result) + tokens);
}

/** Better estimator for JSON content that treats structural chars as ~1 token each. */
function estimateToolCallTokens(text: string): number {
	let tokens = 0;
	let alphaRun = 0;
	for (const char of text) {
		if ('{}[]":,'.includes(char)) {
			if (alphaRun > 0) {
				tokens += Math.ceil(alphaRun / 4);
				alphaRun = 0;
			}
			tokens += 1;
		} else if (/[a-zA-Z0-9]/.test(char)) {
			alphaRun++;
		} else {
			if (alphaRun > 0) {
				tokens += Math.ceil(alphaRun / 4);
				alphaRun = 0;
			}
		}
	}
	if (alphaRun > 0) {
		tokens += Math.ceil(alphaRun / 4);
	}
	return tokens;
}

interface TpsState {
	smoothedTps: number;
	lastEmitTime: number;
	pendingTokens: number;
	pauseAfterNextEmit: boolean;
}

/**
 * Lazily initialize TPS tracking state on the result object.
 * Returns an accessor object backed by a WeakMap so frozen/sealed
 * objects do not throw.
 */
function getTpsState(result: object): TpsState {
	if (!smoothedTpsMap.has(result)) {
		smoothedTpsMap.set(result, 0);
		lastEmitTimeMap.set(result, 0);
		pendingTokensMap.set(result, 0);
		pauseAfterNextEmitMap.set(result, false);
	}
	return {
		get smoothedTps() { return smoothedTpsMap.get(result)!; },
		set smoothedTps(v) { smoothedTpsMap.set(result, v); },
		get lastEmitTime() { return lastEmitTimeMap.get(result)!; },
		set lastEmitTime(v) { lastEmitTimeMap.set(result, v); },
		get pendingTokens() { return pendingTokensMap.get(result)!; },
		set pendingTokens(v) { pendingTokensMap.set(result, v); },
		get pauseAfterNextEmit() { return pauseAfterNextEmitMap.get(result)!; },
		set pauseAfterNextEmit(v) { pauseAfterNextEmitMap.set(result, v); },
	};
}

/**
 * Update the EMA-smoothed tokens-per-second based on a new sample.
 * Called from emitUpdate() with the estimated output tokens since last emit.
 * Accumulates tokens in pendingTokens and only computes a rate when
 * MIN_TPS_SAMPLE_MS has elapsed. Applies MAX_INSTANT_TPS cap before EMA.
 */
export function updateSmoothedTps(result: object, estimatedTokens: number): void {
	const tracker = getTpsState(result);

	if (estimatedTokens > 0) {
		tracker.pendingTokens += estimatedTokens;
	}

	if (tracker.lastEmitTime === 0) {
		// First emit after a gap — seed the value directly
		tracker.lastEmitTime = Date.now();
		tracker.pauseAfterNextEmit = false;
		return;
	}

	const now = Date.now();
	const deltaMs = now - tracker.lastEmitTime;
	if (deltaMs < MIN_TPS_SAMPLE_MS) {
		// If a pause was requested but we can't compute yet, reset the timer
		// so the upcoming gap (e.g., tool execution) isn't counted.
		if (tracker.pauseAfterNextEmit) {
			tracker.lastEmitTime = 0;
			tracker.pauseAfterNextEmit = false;
		}
		return;
	}

	// Enough time has passed — compute TPS if we have tokens, otherwise just
	// reset the clock so the next batch is measured cleanly.
	if (tracker.pendingTokens <= 0) {
		if (tracker.pauseAfterNextEmit) {
			tracker.lastEmitTime = 0;
			tracker.pauseAfterNextEmit = false;
		} else {
			tracker.lastEmitTime = now;
		}
		return;
	}

	const deltaSec = deltaMs / 1000;
	let instantRate = (tracker.pendingTokens * TPS_CALIBRATION) / deltaSec;
	if (instantRate > MAX_INSTANT_TPS) {
		instantRate = MAX_INSTANT_TPS;
	}
	if (tracker.smoothedTps === 0) {
		tracker.smoothedTps = instantRate;
	} else {
		// Outlier rejection: dampen burst spikes that would dominate the EMA
		const alpha = (tracker.smoothedTps > 0 && instantRate > 2 * tracker.smoothedTps)
			? EMA_ALPHA * 0.3
			: EMA_ALPHA;
		tracker.smoothedTps = alpha * instantRate + (1 - alpha) * tracker.smoothedTps;
	}
	tracker.lastEmitTime = now;
	tracker.pendingTokens = 0;

	if (tracker.pauseAfterNextEmit) {
		tracker.lastEmitTime = 0;
		tracker.pauseAfterNextEmit = false;
	}
}

/**
 * Return the current EMA-smoothed tokens-per-second value.
 */
export function drainSmoothedTps(result: object): number {
	const tracker = getTpsState(result);
	return tracker.smoothedTps;
}

export interface CtxState {
	baseline: number;
	streamingChars: number;
}

/**
 * Lazily initialize ctx baseline tracking state on the result object.
 * Returns an accessor object backed by a WeakMap so frozen/sealed
 * objects do not throw.
 */
export function getCtxState(result: object): CtxState {
	if (!ctxBaselineMap.has(result)) {
		ctxBaselineMap.set(result, 0);
		ctxStreamingCharsMap.set(result, 0);
	}
	return {
		get baseline() { return ctxBaselineMap.get(result)!; },
		set baseline(v) { ctxBaselineMap.set(result, v); },
		get streamingChars() { return ctxStreamingCharsMap.get(result)!; },
		set streamingChars(v) { ctxStreamingCharsMap.set(result, v); },
	};
}

/**
 * Track streaming characters and estimate output tokens.
 * Called on every streaming delta.
 */
function updateStreamingEstimate(result: object, deltaLength: number): void {
	if (deltaLength <= 0) return;
	const est = getStreamingEstimate(result);
	est.chars += deltaLength;
	// Also accumulate chars for ctx estimation (not drained on emit)
	const ctxState = getCtxState(result);
	ctxState.streamingChars += deltaLength;
}

/**
 * Drain the accumulated tool call token estimate and return it.
 * Returns 0 when no tool calls have been estimated.
 */
export function drainToolCallEstimate(result: object): number {
	const tokens = getToolCallTokenEstimate(result);
	toolCallTokenEstimateMap.set(result, 0);
	return tokens;
}

/**
 * Drain the current streaming estimate and return estimated output tokens.
 * Returns 0 when no streaming has occurred.
 */
export function drainStreamingEstimate(result: object): number {
	const est = getStreamingEstimate(result);
	const tokens = Math.floor(est.chars / CHARS_PER_TOKEN);
	est.chars = est.chars % CHARS_PER_TOKEN;
	return tokens;
}

/**
 * Return the estimated context tokens: last known real totalTokens (baseline)
 * plus any additional output tokens estimated since that baseline was set.
 * Returns 0 before the first message_end when no baseline exists yet,
 * in which case the caller should fall back to the streaming output estimate.
 */
export function drainCtxEstimate(result: object): number {
	const ctxState = getCtxState(result);
	const streamingTokens = Math.floor(ctxState.streamingChars / CHARS_PER_TOKEN);
	return ctxState.baseline + streamingTokens;
}

/**
 * Accumulate a text or thinking delta into the streaming buffer.
 * Returns true if the caller should emit an update.
 */
function accumulateStreamingDelta(result: object, delta: string): boolean {
	if (!delta) return false;
	const state = getStreamingTextState(result);
	state.buffer = state.buffer + delta;
	updateStreamingEstimate(result, delta.length);
	if (state.buffer.length - state.lastEmittedWordCount >= STREAMING_EMIT_CHARS) {
		state.lastEmittedWordCount = state.buffer.length;
		return true;
	}
	return false;
}

// Fix P13: Cache stableStringify results for repeated object references
const stableStringifyCache = new WeakMap<object, string>();

export function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}

	if (seen.has(value)) {
		return '"[Circular]"';
	}

	// Fix P13: Cache stableStringify results for repeated object references
	if (stableStringifyCache.has(value)) {
		return stableStringifyCache.get(value)!;
	}

	seen.add(value);

	if (Array.isArray(value)) {
		const out = `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
		seen.delete(value);
		if (!out.includes('"[Circular]"')) {
			stableStringifyCache.set(value, out);
		}
		return out;
	}

	const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
	const out = `{${entries
		.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue, seen)}`)
		.join(",")}}`;
	seen.delete(value);
	if (!out.includes('"[Circular]"')) {
		stableStringifyCache.set(value, out);
	}
	return out;
}

function getMessageSignature(message: unknown): string {
	return stableStringify(message);
}

interface AssistantMessage extends Record<string, unknown> {
	role: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	content?: unknown;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number };
		totalTokens?: number;
		prompt_tokens?: number;
		completion_tokens?: number;
		cache_read?: number;
		cache_write?: number;
		total_tokens?: number;
	};
}

function updateAssistantMetadata(result: { model?: string; stopReason?: string; errorMessage?: string }, message: AssistantMessage): void {
	if (!message || message.role !== "assistant") return;
	if (!result.model && message.model) result.model = message.model;
	if (message.stopReason) result.stopReason = message.stopReason;
	if (message.errorMessage) result.errorMessage = message.errorMessage;
}

/** Message part types that represent reasoning/thinking content. */
const REASONING_PART_TYPES = new Set([
	"thinking",
	"reasoning",
	"reasoning_content",
	"reasoningContent",
]);

/** Top-level fields on assistant messages that carry reasoning data. */
const REASONING_FIELDS = [
	"thinking",
	"thinkingSignature",
	"thinking_signature",
	"reasoning",
	"reasoningContent",
	"reasoning_content",
	"reasoningSignature",
	"reasoning_signature",
];

/** Strip thinking/reasoning content from an assistant message. */
function stripReasoning(message: AssistantMessage): { message: AssistantMessage; changed: boolean } {
	let next = message;
	let changed = false;

	for (const field of REASONING_FIELDS) {
		if (field in next) {
			if (next === message) next = { ...message };
			delete (next as Record<string, unknown>)[field];
			changed = true;
		}
	}

	if (Array.isArray(message.content)) {
		const filteredContent = message.content.filter(
			(part: unknown) => {
				const type = (part as { type?: string }).type;
				return typeof type === "string" ? !REASONING_PART_TYPES.has(type) : true;
			},
		);
		if (filteredContent.length !== message.content.length) {
			if (next === message) next = { ...message };
			next.content = filteredContent;
			changed = true;
		}
	}

	return { message: next, changed };
}



export interface FlowResult {
	messages: Message[];
	model?: string;
	stopReason?: string;
	exitCode?: number;
	stderr?: string;
	errorMessage?: string;
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		totalTokens?: number;
		turns: number;
		toolCalls: number;
		smoothedTps?: number;
		contextTokens: number;
	};
	sawAgentEnd?: boolean;
	streamingText?: string;
}

function addFlowAssistantMessage(result: FlowResult, message: AssistantMessage): boolean {
	if (!message || message.role !== "assistant") return false;

	// Strip reasoning/thinking from the message before storing
	const { message: sanitized } = stripReasoning(message);

	updateAssistantMetadata(result, sanitized);

	const signature = getMessageSignature(sanitized);
	const seen = getSeenFlowMessageSignatures(result);
	if (seen.has(signature)) return false;
	addSeenSignature(result, signature);

	result.messages.push(sanitized as Message);

	// Reset streaming estimate when actual usage arrives
	const est = getStreamingEstimate(result);
	est.chars = 0;

	result.usage!.turns++;
	const usage = message.usage;
	const totalTokens = usage
		? (usage.totalTokens ?? usage.total_tokens ?? ((usage.input || usage.prompt_tokens || 0) + (usage.output || usage.completion_tokens || 0) + (usage.cacheRead || usage.cache_read || 0) + (usage.cacheWrite || usage.cache_write || 0)))
		: 0;

	// Count tool call parts in the message content and estimate their tokens
	let toolCallTokens = 0;
	if (Array.isArray(message.content)) {
		for (const part of message.content as Array<{ type: string; name?: string; toolName?: string; arguments?: unknown; input?: unknown }>) {
			if (part.type === "toolCall") {
				result.usage!.toolCalls++;
				const tcText = JSON.stringify({ name: part.name, args: part.arguments || part.input || {} });
				toolCallTokens += estimateToolCallTokens(tcText);
			}
		}
		if (toolCallTokens > 0) {
			addToolCallTokens(result, toolCallTokens);
			const tracker = getTpsState(result);
			tracker.pauseAfterNextEmit = true;
		}
	}

	if (totalTokens > 0) {
		result.usage!.input += usage!.input || usage!.prompt_tokens || 0;
		result.usage!.output += usage!.output || usage!.completion_tokens || 0;
		result.usage!.cacheRead += usage!.cacheRead || usage!.cache_read || 0;
		result.usage!.cacheWrite += usage!.cacheWrite || usage!.cache_write || 0;
		result.usage!.cost += usage!.cost?.total || 0;
		result.usage!.contextTokens = totalTokens;
	} else {
		// Provider omitted or sent empty usage metadata — estimate from message content
		let textLen = 0;
		if (typeof message.content === "string") {
			textLen = message.content.length;
		} else if (Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part && part.type === "text" && typeof part.text === "string") {
					textLen += part.text.length;
				}
			}
		}
		let estimatedOutputTokens = 0;
		if (textLen > 0) {
			estimatedOutputTokens = Math.floor(textLen / CHARS_PER_TOKEN);
		}
		const totalEstimatedOutput = estimatedOutputTokens + toolCallTokens;
		if (totalEstimatedOutput > 0) {
			result.usage!.output += totalEstimatedOutput;
			result.usage!.contextTokens += totalEstimatedOutput;
		}
	}

	// Always snapshot ctx baseline for smooth streaming estimation after message completed
	const ctxState = getCtxState(result);
	ctxState.baseline = result.usage!.contextTokens;
	ctxState.streamingChars = 0;

	return true;
}

interface ToolMessage {
	role: string;
	toolCallId?: string;
	content?: unknown;
}

function addFlowToolMessage(result: FlowResult, message: ToolMessage): boolean {
	if (!message || (message.role !== "tool" && message.role !== "toolResult")) return false;

	// Defensive: upstream host assumes content is always an array for tool/toolResult
	// messages. Normalize string / null / undefined into a block array.
	if (!Array.isArray(message.content)) {
		const text = typeof message.content === "string" ? message.content : "";
		const normalizedContent = text ? [{ type: "text", text }] : [];
		message = { ...message, content: normalizedContent };
	}

	const signature = getMessageSignature(message);
	const seen = getSeenFlowMessageSignatures(result);
	if (seen.has(signature)) return false;
	addSeenSignature(result, signature);

	result.messages.push(message as Message);
	return true;
}

function addFlowMessages(result: FlowResult, messages: unknown[]): boolean {
	if (!Array.isArray(messages)) return false;
	let changed = false;
	for (const message of messages) {
		if (message && ((message as Record<string, unknown>).role === "tool" || (message as Record<string, unknown>).role === "toolResult")) {
			if (addFlowToolMessage(result, message as ToolMessage)) changed = true;
		} else if (message && (message as Record<string, unknown>).role === "assistant") {
			if (addFlowAssistantMessage(result, message as AssistantMessage)) changed = true;
		}
	}
	return changed;
}

interface FlowEvent {
	type: string;
	message?: AssistantMessage | ToolMessage;
	messages?: unknown[];
	usage?: any;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	assistantMessageEvent?: {
		type: string;
		delta?: string;
	};
}

function processFlowEvent(event: FlowEvent, result: FlowResult): boolean {
	if (!event || typeof event !== "object") return false;

	switch (event.type) {
		case "message_end": {
			let msg = event.message;
			if (msg && msg.role === "assistant") {
				const amsg = msg as AssistantMessage;
				msg = {
					...amsg,
					usage: amsg.usage || event.usage,
					model: amsg.model || event.model,
					stopReason: amsg.stopReason || event.stopReason,
					errorMessage: amsg.errorMessage || event.errorMessage,
				};
			}
			return addFlowMessages(result, [msg]);
		}

		case "turn_end": {
			let msg = event.message;
			if (msg && msg.role === "assistant") {
				const amsg = msg as AssistantMessage;
				msg = {
					...amsg,
					usage: amsg.usage || event.usage,
					model: amsg.model || event.model,
					stopReason: amsg.stopReason || event.stopReason,
					errorMessage: amsg.errorMessage || event.errorMessage,
				};
			}
			return addFlowMessages(result, [msg]);
		}

		case "agent_end":
			result.sawAgentEnd = true;
			return addFlowMessages(result, event.messages ?? []);

		case "message_update": {
			const evt = event.assistantMessageEvent;
			if (!evt || typeof evt !== "object") return false;
			if (evt.type === "text_delta") {
				return accumulateStreamingDelta(result, evt.delta ?? "");
			}
			// thinking_delta is NOT accumulated into the streaming text buffer
			// (reasoning is stripped from flow results), but tokens ARE counted
			// for TPS estimation so the dashboard shows a live rate during
			// extended thinking phases.
			if (evt.type === "thinking_delta") {
				const thinkingDelta = evt.delta ?? "";
				if (thinkingDelta) {
					updateStreamingEstimate(result, thinkingDelta.length);
					return true;
				}
				return false;
			}
			// toolcall_delta carries streaming tool-call arguments — actual
			// output tokens that should contribute to TPS even though they
			// aren't part of the text buffer.
			if (evt.type === "toolcall_delta") {
				const toolDelta = evt.delta ?? "";
				if (toolDelta) {
					updateStreamingEstimate(result, toolDelta.length);
					return true;
				}
				return false;
			}
			return false;
		}

		default:
			return false;
	}
}

export function processFlowJsonLine(line: string, result: FlowResult): boolean {
	if (!line.trim()) return false;

	let event: FlowEvent;
	try {
		event = JSON.parse(line) as FlowEvent;
	} catch (e) {
		logWarn(`[pi-agent-flow] Failed to parse runner event JSON: ${e}`);
		return false;
	}

	return processFlowEvent(event, result);
}

export function getFlowFinalText(messages: Message[]): string {
	if (!Array.isArray(messages)) return "";

	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || message.role !== "assistant") {
			continue;
		}
		if (typeof message.content === "string" && message.content.length > 0) {
			return message.content;
		}
		if (!Array.isArray(message.content)) {
			continue;
		}

		for (const part of message.content) {
			if (part?.type === "text" && typeof part.text === "string" && part.text.length > 0) {
				return part.text;
			}
		}
	}

	return "";
}

interface ToolCallEntry {
	name: string;
	args: Record<string, unknown>;
}

function extractNonReadToolCalls(messages: Message[]): ToolCallEntry[] {
	const calls: ToolCallEntry[] = [];
	if (!Array.isArray(messages)) return calls;
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const part of msg.content) {
			if (part.type === "toolCall" && part.name !== "read") {
				calls.push({ name: part.name, args: (part.arguments || part.input || {}) as Record<string, unknown> });
			}
		}
	}
	return calls;
}

function formatToolCallShort(tc: ToolCallEntry): string {
	const args = tc.args || {};
	switch (tc.name) {
		case "edit":
		case "write":
			return `${tc.name} ${(args.file_path as string || args.path as string || "?").split("/").pop()}`;
		case "bash": {
			const cmd = (args.command as string || "").replace(/[\n\r\t]+/g, " ").replace(/ +/g, " ").trim();
			return `bash ${cmd.length > 40 ? cmd.slice(0, 40) + "..." : cmd}`;
		}
		case "grep":
			return `grep /${args.pattern || "?"}/ in ${args.path || "."}`;
		case "find":
			return `find ${args.pattern || "*"} in ${args.path || "."}`;
		case "ls":
			return `ls ${args.path || "."}`;
		case "batch": {
			const summary = formatBatchOpsSummary(args);
			// formatBatchOpsSummary already includes "batch (empty)" prefix when empty,
			// but for runner-events we want just the inner ops summary with "batch " prefix.
			if (summary === "batch (empty)") return summary;
			return `batch ${summary}`;
		}
		case "batch_bash_poll": {
			const ids = Array.isArray(args.i) ? args.i : [];
			const idStr = ids.length <= 3
				? ids.join(", ")
				: `${ids.slice(0, 3).join(", ")} +${ids.length - 3}`;
			return `batch_bash_poll [${idStr}]`;
		}
		default:
			return tc.name;
	}
}

interface ToolPair {
	name: string;
	args: Record<string, unknown>;
	output: string;
}

/**
 * Match tool calls with their results to build a paired list.
 * Returns [{ name, command/args, output }] limited to the most recent pairs.
 */
function matchToolCallsWithResults(messages: Message[], maxPairs: number): ToolPair[] {
	if (!Array.isArray(messages)) return [];
	const pairs: ToolPair[] = [];

	// Fallback for external APIs that use snake_case
	const SNAKE_TOOL_CALL_ID = "tool_call_id";

	// Build a map of toolCallId -> tool result output
	const resultMap = new Map<string, string>();
	for (const msg of messages) {
		if ((msg.role !== "tool" && msg.role !== "toolResult") || !Array.isArray(msg.content)) continue;
		const id = (msg as unknown as { toolCallId?: string }).toolCallId || (msg as unknown as Record<string, unknown>)[SNAKE_TOOL_CALL_ID] as string | undefined || "";
		if (!id) continue;
		const text = msg.content
			.filter((p: { type: string; text?: string }) => p.type === "text" && typeof p.text === "string")
			.map((p: { text: string }) => p.text)
			.join("\n");
		resultMap.set(id, text);
	}

	// Walk assistant messages to find tool calls that have matching results
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const part of msg.content) {
			if (part.type !== "toolCall") continue;
			const id = part.toolCallId || (part as unknown as Record<string, unknown>)[SNAKE_TOOL_CALL_ID] as string | undefined || "";
			if (!id || !resultMap.has(id)) continue;
			const name = part.name || (part as unknown as { toolName?: string }).toolName || "unknown";
			const args = part.arguments || part.input || {};
			const output = resultMap.get(id)!;
			pairs.push({ name, args: args as Record<string, unknown>, output });
		}
	}

	// Return the most recent pairs
	return pairs.slice(-maxPairs);
}

/** Max tool result output chars to include per tool call in the summary. */
const TOOL_RESULT_MAX_CHARS = 2000;

export function getFlowSummaryText(
	result?: FlowResult | null,
	options?: { toolContext?: boolean },
): string {
	const includeToolContext = options?.toolContext !== false;
	const finalText = getFlowFinalText(result?.messages ?? []);
	const isError =
		(typeof result?.exitCode === "number" && result.exitCode > 0) ||
		result?.stopReason === "error" ||
		result?.stopReason === "aborted";

	// Build error base for failed flows
	let errorBase = "";
	if (isError) {
		if (typeof result?.errorMessage === "string" && result.errorMessage.trim()) {
			errorBase = result.errorMessage.trim();
		} else if (typeof result?.stderr === "string" && result.stderr.trim()) {
			errorBase = result.stderr.trim();
		} else {
			errorBase = "Flow failed";
		}
	}

	// Extract tool call/result pairs for context
	let toolContext = "";
	if (includeToolContext) {
		const toolPairs = matchToolCallsWithResults(result?.messages ?? [], 10);
		const toolSummaryParts: string[] = [];

		for (const pair of toolPairs) {
			const callLabel = formatToolCallShort({ name: pair.name, args: pair.args });
			if (pair.output.trim()) {
				const truncated = pair.output.length > TOOL_RESULT_MAX_CHARS
					? pair.output.slice(0, TOOL_RESULT_MAX_CHARS) + "\n... (truncated)"
					: pair.output;
				toolSummaryParts.push(`${callLabel}:\n${truncated}`);
			} else {
				toolSummaryParts.push(`${callLabel}: (no output)`);
			}
		}

		toolContext = toolSummaryParts.length > 0
			? "\n\n[Tool Results]\n" + toolSummaryParts.join("\n---\n")
			: "";
	}

	// Append ping-pong cycle metadata if present
	const singleResult = result as (FlowResult & Partial<SingleResult>) | null | undefined;
	const pingPongMeta = singleResult?.pingPongMeta;
	let pingPongNote = "";
	if (pingPongMeta) {
		const isAuditCapstone = singleResult?.type === "audit" && singleResult?.auditParentType;
		const hasMultipleCycles = Array.isArray(pingPongMeta.verdicts) && pingPongMeta.verdicts.length > 1;

		if (isAuditCapstone && hasMultipleCycles) {
			// Audit capstone with multiple cycles: show full chronological verdict history
			const verdictLines = pingPongMeta.verdicts.map(
				(v: { cycle: number; verdict: string; feedback?: string }) => {
					const fb = v.feedback ? ` — ${v.feedback.slice(0, 200)}` : "";
					return `  Cycle ${v.cycle + 1}: ${v.verdict}${fb}`;
				}
			);
			pingPongNote = `\n\n[Audit Loop: ${pingPongMeta.cycles} cycle(s), final verdict: ${pingPongMeta.finalVerdict}\n${verdictLines.join("\n")}]`;
		} else {
			// Build results or single-cycle: keep simple one-line note
			pingPongNote = `\n\n[Audit Loop: ${pingPongMeta.cycles} cycle(s), final verdict: ${pingPongMeta.finalVerdict}]`;
		}
	}

	// If there's final text, include it plus tool context
	if (finalText) {
		return finalText + toolContext + pingPongNote;
	}

	// No final text
	if (isError) {
		if (includeToolContext) {
			// Surface partial tool calls (excluding read) for failed/aborted flows
			const toolCalls = extractNonReadToolCalls(result?.messages ?? []);
			if (toolCalls.length > 0) {
				const formatted = toolCalls.map(formatToolCallShort).join(", ");
				return `${errorBase}\nPartial work: ${formatted}${toolContext}`;
			}
		}
		return errorBase;
	}

	// Success but no final text — show tool results if any
	if (includeToolContext && toolContext) {
		return toolContext.trim() + pingPongNote;
	}

	// Fallback: pingPongNote if present, otherwise (no output)
	return pingPongNote.trim() || "(no output)";
}
