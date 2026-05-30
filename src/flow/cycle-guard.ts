/**
 * Cycle detection and flow result metadata — extracted from executor.ts.
 */

import { type SingleResult, isFlowComplete, emptyFlowUsage } from "../types/flow.js";

export function getFlowCycleViolations(
	requestedNames: Set<string>,
	ancestorFlowStack: string[],
): string[] {
	if (requestedNames.size === 0 || ancestorFlowStack.length === 0) return [];
	const stackSet = new Set(ancestorFlowStack);
	return Array.from(requestedNames).filter((name) => stackSet.has(name));
}

/**
 * Shallow-merge helper: copies audit-loop metadata fields from `source`
 * onto `target` without mutating the target's identity reference.
 */
export function preserveMetadata(target: SingleResult, source?: SingleResult): void {
	if (source?.pingPongMeta) {
		target.pingPongMeta = source.pingPongMeta;
	}
	if (source?.auditParentType) {
		target.auditParentType = source.auditParentType;
	}
	if (source?.auditLoopGroupId !== undefined) {
		target.auditLoopGroupId = source.auditLoopGroupId;
	}
}

export function shouldFailover(result: SingleResult): boolean {
	if (result.stopReason === "aborted") return false;
	const text = `${result.errorMessage ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
	if (!text.trim()) return false;
	if (text.includes("permission") || text.includes("invalid tool") || text.includes("bad settings")) {
		return false;
	}
	if (result.exitCode > 0) return true;
	// Some child runs log HTTP 400 / "Param Incorrect" to stderr while exiting 0
	// without completing a turn — treat as retryable for model failover.
	if (!isFlowComplete(result) && text.includes("400") && text.includes("param")) {
		return true;
	}
	// tool_call_id mismatch — strict API providers (kimi, DeepSeek) reject
	// snapshots with orphaned toolResult messages.
	if (!isFlowComplete(result) && text.includes("400") && text.includes("tool_call_id")) {
		return true;
	}
	return false;
}

export function createGhostResult(type: string, intent: string, aim: string, model?: string, maxContextTokens?: number): SingleResult {
	return {
		type,
		agentSource: "unknown",
		intent,
		aim,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyFlowUsage(),
		...(model ? { model } : {}),
		...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
	};
}

export interface CycleHistoryEntry {
	cycle: number;
	buildOutputs: string[];
	verdict: string;
	feedback?: string;
	buildFeedbacks?: (string | null)[];
}
