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
	if (text.includes("permission") || text.includes("bad settings")) {
		return false;
	}
	// Generic "invalid tool" failures are not retryable, but "invalid tool_call_id"
	// errors are a specific provider-side rejection that failover can recover from.
	if (text.includes("invalid tool") && !text.includes("tool_call_id")) {
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
	// Provider-side 404 / resource-not-found errors should fail over to the next
	// configured model even when the process exits 0. Trigger shape:
	//   - the canonical JSON envelope (`"type":"resource_not_found_error"`)
	//     fails over with or without a 404 token;
	//   - the bare machine type marker (`resource_not_found_error`) fails over
	//     (covers providers that print just the type);
	//   - the bare English phrase ("requested resource was not found") only
	//     fails over when paired with an explicit 404 token, since that phrase
	//     alone is plausible in tool output or docs text;
	//   - a bare 404 token (no envelope, no type marker, no English phrase)
	//     fails over only when stderr also looks like a provider/API context
	//     (e.g. an /v1/* API path). A bare "404" in tool output or docs
	//     narration — "HTTP 404 while checking a website" — must NOT trigger,
	//     since that text is what ordinary child stderr looks like when a tool
	//     fetched a missing URL.
	const has404Token = /\b404\b/.test(text);
	const hasEnglishPhrase = text.includes("requested resource was not found");
	const hasResourceJsonEnvelope = /"type"\s*:\s*"resource_not_found_error"/.test(text);
	const hasResourceTypeMarker = text.includes("resource_not_found_error");
	const hasApiPathContext = /\/v\d+\/[a-z0-9_-]+/i.test(text);
	if (
		!isFlowComplete(result) &&
		((hasResourceJsonEnvelope || hasResourceTypeMarker) ||
			(hasEnglishPhrase && has404Token) ||
			(has404Token && hasApiPathContext))
	) {
		return true;
	}
	return false;
}

/** Substrings that indicate a failure should not be retried as a transient connection error. */
const NON_RETRYABLE_CONNECTION_PATTERNS: RegExp[] = [
	/permission/i,
	/invalid tool/i,
	/bad settings/i,
	/unauthorized/i,
	/\b401\b/,
	/\b403\b/,
	/\b404\b/,
	/\b400\b.*param/i,
	/tool_call_id/i,
];

/**
 * Patterns indicating transient connection / network errors worth retrying
 * at the sub-agent level after model failover is exhausted.
 */
export const CONNECTION_ERROR_PATTERNS: RegExp[] = [
	/ECONNREFUSED/,
	/ECONNRESET/,
	/ECONNABORTED/,
	/EPIPE/,
	/EHOSTUNREACH/,
	/EHOSTDOWN/,
	/ENETUNREACH/,
	/ENETDOWN/,
	/ETIMEDOUT/,
	/ESOCKETTIMEDOUT/,
	/EAI_AGAIN/,
	/socket hang up/i,
	/socket disconnected/i,
	/network error/i,
	/network timeout/i,
	/fetch failed/i,
	/request timed? ?out/i,
	/\b502\b/,
	/\b503\b/,
	/\b504\b/,
	/connection reset/i,
	/connection refused/i,
	/connection timed? ?out/i,
	/provider error/i,
];

/**
 * Returns true when stderr + errorMessage match a transient connection pattern
 * and do not match any non-retryable denylist pattern.
 */
export function isRetryableConnectionError(stderr: string, errorMessage?: string): boolean {
	const text = `${stderr ?? ""}\n${errorMessage ?? ""}`;
	if (!text.trim()) return false;
	if (NON_RETRYABLE_CONNECTION_PATTERNS.some((pat) => pat.test(text))) return false;
	return CONNECTION_ERROR_PATTERNS.some((pat) => pat.test(text));
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
