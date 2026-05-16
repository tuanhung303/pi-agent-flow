/**
 * Declarative transition matrix for post-flow advisory messages.
 *
 * Defines a data-driven transition map. Each entry describes a recommended
 * follow-up flow given a source flow's outcome. The matrix is used by
 * getTransitionAdvice() to generate advisory strings.
 */

import { isFlowSuccess } from "../types/flow.js";

// ---------------------------------------------------------------------------
// Transition descriptor
// ---------------------------------------------------------------------------

export interface FlowTransition {
	/** Source flow name (case-insensitive). */
	from: string;
	/** Target flow name (case-insensitive). */
	to: string;
	/** Condition for this transition. */
	on: "success" | "failure" | "always";
	/** Advisory message shown to the user. */
	advice: string;
}

// ---------------------------------------------------------------------------
// Default transition matrix
// ---------------------------------------------------------------------------

export const DEFAULT_TRANSITIONS: FlowTransition[] = [
	{ from: "scout", to: "build", on: "success", advice: "Context mapped. Consider running a [build] flow to implement changes, or [debug] if investigating an issue." },
	{ from: "scout", to: "debug", on: "success", advice: "Context mapped. Consider running a [debug] flow if investigating an issue." },
	{ from: "debug", to: "build", on: "success", advice: "The root cause has been identified. Consider running a [build] flow to implement the fix." },
	{ from: "debug", to: "audit", on: "success", advice: "Root cause identified. Consider running an [audit] flow to verify the fix area for related issues." },
	{ from: "build", to: "audit", on: "success", advice: "Consider running an [audit] flow to audit the changes for security, correctness, and code quality." },
	{ from: "build", to: "debug", on: "failure", advice: "Build failed. Consider running a [debug] flow to investigate the root cause." },
	{ from: "audit", to: "scout", on: "success", advice: "Audit complete. Consider running a [scout] flow to trace the audit findings across the codebase." },
	{ from: "audit", to: "build", on: "failure", advice: "Audit found issues. Consider running a [build] flow to fix them." },
	{ from: "craft", to: "build", on: "success", advice: "Plan ready. Consider running a [build] flow to implement the design." },
	{ from: "ideas", to: "craft", on: "success", advice: "Ideas explored. Consider running a [craft] flow to design the approach, or [build] to implement directly." },
];

// ---------------------------------------------------------------------------
// Advice generation
// ---------------------------------------------------------------------------

/**
 * Get advisory messages for completed flows based on the transition matrix.
 *
 * For each flow result, finds matching transitions where:
 *   1. The source flow type matches
 *   2. The outcome matches the `on` condition
 *   3. The target flow was not already in the batch
 *
 * Returns advisory strings in matrix order.
 */
export function getTransitionAdvice(
	params: Array<{ type: string; intent: string }>,
	results: Array<{ type: string; exitCode: number; stopReason?: string; sawAgentEnd?: boolean; messages: unknown[] }>,
	transitions: FlowTransition[] = DEFAULT_TRANSITIONS,
): string[] {
	const requestedTypes = new Set(params.map((p) => p.type.toLowerCase()));
	const advisors: string[] = [];

	for (const result of results) {
		const resultType = result.type.toLowerCase();
		const succeeded = isFlowSuccess(result as import("../types/flow.js").SingleResult);

		for (const t of transitions) {
			if (t.from.toLowerCase() !== resultType) continue;

			// Check outcome condition
			if (t.on === "success" && !succeeded) continue;
			if (t.on === "failure" && succeeded) continue;

			// Suppress if target already in the batch
			if (requestedTypes.has(t.to.toLowerCase())) continue;

			advisors.push(t.advice);
		}
	}

	return advisors;
}
