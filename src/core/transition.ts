/**
 * Transition logic extracted from flow.ts.
 *
 * Computes depth/canTransition state and builds transition-related
 * prompt fragments for child flow activation.
 */

import type { FlowConfig } from "./agents.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TransitionState {
	currentDepth: number;
	effectiveMaxDepth: number;
	canTransition: boolean;
}

// ---------------------------------------------------------------------------
// Depth / transition state
// ---------------------------------------------------------------------------

export function computeTransitionState(
	parentDepth: number,
	maxDepth: number,
): TransitionState {
	const currentDepth = Math.max(0, Math.floor(parentDepth)) + 1;
	const effectiveMaxDepth = Math.max(0, Math.floor(maxDepth));
	const canTransition = currentDepth < effectiveMaxDepth;
	return { currentDepth, effectiveMaxDepth, canTransition };
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
	const stackLabel = parentFlowStack.length > 0 ? parentFlowStack.join(" -> ") : "root";
	return `depth ${currentDepth}/${effectiveMaxDepth} · stack: ${stackLabel}`;
}

export function buildTransitionRule(canTransition: boolean, guardLine: string): string {
	return `Transition: ${canTransition ? "on" : "off"} (${guardLine})`;
}

export function buildFlowListSection(
	canTransition: boolean,
	discoveredFlows: FlowConfig[],
): string {
	if (!canTransition || discoveredFlows.length === 0) return "";
	return (
		`Available flows:\n${discoveredFlows
			.map((f) => `- ${f.name}`)
			.join("\n")}\n`
	);
}

export function buildLineage(flowName: string, parentFlowStack: string[]): string {
	return ["root state", ...parentFlowStack, flowName].join(" → ");
}

export function buildParentLineageHint(_parentFlowStack: string[]): string {
	return "";
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
