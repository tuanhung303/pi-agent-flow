/**
 * Delegation logic extracted from flow.ts.
 *
 * Computes depth/canDelegate state and builds delegation-related
 * prompt fragments for child flow activation.
 */

import type { FlowConfig } from "./agents.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DelegationState {
	currentDepth: number;
	effectiveMaxDepth: number;
	canDelegate: boolean;
}

// ---------------------------------------------------------------------------
// Depth / delegation state
// ---------------------------------------------------------------------------

export function computeDelegationState(
	parentDepth: number,
	maxDepth: number,
): DelegationState {
	const currentDepth = Math.max(0, Math.floor(parentDepth)) + 1;
	const effectiveMaxDepth = Math.max(0, Math.floor(maxDepth));
	const canDelegate = currentDepth < effectiveMaxDepth;
	return { currentDepth, effectiveMaxDepth, canDelegate };
}

// ---------------------------------------------------------------------------
// Prompt fragment builders
// ---------------------------------------------------------------------------

export function buildGuardLine(
	currentDepth: number,
	effectiveMaxDepth: number,
	preventCycles: boolean,
	parentFlowStack: string[],
): string {
	const stackLabel = parentFlowStack.length > 0 ? parentFlowStack.join(" -> ") : "(root)";
	return `depth ${currentDepth}/${effectiveMaxDepth} | cycles: ${preventCycles ? "blocked" : "off"} | stack: ${stackLabel}`;
}

export function buildDelegationRule(canDelegate: boolean, guardLine: string): string {
	return canDelegate
		? `You may delegate to sub-flows (${guardLine}).`
		: `You may NOT delegate to sub-flows (${guardLine}).`;
}

export function buildFlowListSection(
	canDelegate: boolean,
	discoveredFlows: FlowConfig[],
): string {
	if (!canDelegate || discoveredFlows.length === 0) return "";
	return (
		`Available flows:\n${discoveredFlows
			.map((f) => {
				const badge = f.source === "project" ? " 🔒" : f.source === "user" ? " ⚙" : "";
				return `- [${f.name}]${badge} — ${f.description}`;
			})
			.join("\n")}\n`
	);
}

export function buildLineage(flowName: string, parentFlowStack: string[]): string {
	return ["orchestrator", ...parentFlowStack, flowName].join(" → ");
}

export function buildParentLineageHint(parentFlowStack: string[]): string {
	return parentFlowStack.length > 0
		? `Spawned by: ${parentFlowStack.join(" → ")}.\n`
		: "";
}

// ---------------------------------------------------------------------------
// Child env propagation
// ---------------------------------------------------------------------------

export function computeChildPropagation(
	parentDepth: number,
	maxDepth: number,
	parentFlowStack: string[],
	normalizedFlowName: string,
): {
	nextDepth: number;
	propagatedMaxDepth: number;
	propagatedStack: string[];
} {
	const nextDepth = Math.max(0, Math.floor(parentDepth)) + 1;
	const propagatedMaxDepth = Math.max(0, Math.floor(maxDepth));
	const propagatedStack = [...parentFlowStack, normalizedFlowName];
	return { nextDepth, propagatedMaxDepth, propagatedStack };
}
