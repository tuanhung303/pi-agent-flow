/**
 * Declarative transition matrix for post-flow routing.
 *
 * Instead of imperative hooks for common flow paths, this module defines a
 * data-driven transition map. Each entry describes a recommended follow-up
 * flow given a source flow's outcome. The matrix is user-overridable via
 * settings.json.
 *
 * NOTE: There is no confidence threshold gating. Non-deterministic agents
 * should not have unstable numeric params controlling execution flow.
 * All matching transitions are recommended; the caller decides whether to
 * auto-queue them.
 */

import { type PostFlowHook, type AutoTransition, isFlowSuccess } from "./types.js";

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
	{ from: "build", to: "audit", on: "success", advice: "Consider running a [audit] flow to audit the changes for security, correctness, and code quality." },
	{ from: "build", to: "debug", on: "failure", advice: "Build failed. Consider running a [debug] flow to investigate the root cause." },
	{ from: "audit", to: "scout", on: "success", advice: "Audit complete. Consider running a [scout] flow to trace the audit findings across the codebase." },
	{ from: "audit", to: "build", on: "failure", advice: "Audit found issues. Consider running a [build] flow to fix them." },
	{ from: "craft", to: "build", on: "success", advice: "Plan ready. Consider running a [build] flow to implement the design." },
	{ from: "ideas", to: "craft", on: "success", advice: "Ideas explored. Consider running a [craft] flow to design the approach, or [build] to implement directly." },
];

// ---------------------------------------------------------------------------
// Hook generation
// ---------------------------------------------------------------------------

/**
 * Convert the transition matrix into PostFlowHook instances.
 *
 * Each transition becomes a hook that checks:
 *   1. The source flow type matches
 *   2. The target flow was not already requested
 *   3. The outcome matches the `on` condition
 */
export function buildTransitionHooks(transitions: FlowTransition[]): PostFlowHook[] {
	return transitions.map((t) => ({
		name: `pi-agent-flow/${t.from}-to-${t.to}-${t.on}`,
		trigger: {
			flowTypes: [t.from],
			onlyOnSuccess: t.on === "success",
		},
		action: (ctx) => {
			// Respect the on condition: success hooks only fire when all results
			// succeeded; failure hooks only fire when at least one result failed.
			const allSucceeded = ctx.results.every((r) => isFlowSuccess(r));
			if (t.on === "success" && !allSucceeded) return null;
			if (t.on === "failure" && allSucceeded) return null;

			const alreadyRequested = ctx.params.some(
				(p) => p.type.toLowerCase() === t.to,
			);
			if (alreadyRequested) return null;

			return {
				content: t.advice,
				priority: 10,
			};
		},
	}));
}
