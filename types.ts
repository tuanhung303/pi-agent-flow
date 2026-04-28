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
}

/** Result of a single flow invocation. */
export interface SingleResult {
	type: string;
	agentSource: "user" | "project" | "unknown";
	intent: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	sawAgentEnd?: boolean;
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
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, toolCalls: 0 };
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
	return r.exitCode === 0 && r.stopReason !== "error" && r.stopReason !== "aborted";
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
export function getLastToolCall(messages: Message[]): DisplayItem | undefined {
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
