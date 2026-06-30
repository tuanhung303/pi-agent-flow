/**
 * Audit formatting helpers — extracted from executor.ts.
 */

import type { FlowConfig } from "./agents.js";
import {
	resolveFlowModelCandidates,
	resolveModelContextWindow,
	type FlowModelStrategy,
} from "../config/config.js";
import { type CycleHistoryEntry } from "./cycle-guard.js";

// ~6 KB limit to keep grouped audit intent under typical prompt budget while preserving enough context for meaningful audit
const MAX_AUDIT_OUTPUT_SLICE = 6000;

export function resolveAuditModel(
	flows: FlowConfig[],
	tierOverrideResolver: (tier: "lite" | "flash" | "full") => string | undefined,
	strategy: FlowModelStrategy,
	fallbackModel?: string,
): { model?: string; maxContextTokens?: number } {
	const auditFlow = flows.find((f) => f.name === "audit");
	const tier = auditFlow?.tier ?? "flash";
	const { effectivePrimary } = resolveFlowModelCandidates({
		tier,
		flowModel: auditFlow?.model,
		cliTierOverride: tierOverrideResolver(tier),
		strategy,
		fallbackModel,
	});
	const model = effectivePrimary;
	const maxContextTokens = resolveModelContextWindow(model);
	return { model, maxContextTokens };
}

export function buildReworkIntent(
	originalIntent: string,
	buildAim: string,
	acceptance: string | undefined,
	auditFeedback: string,
	cycleHistory?: CycleHistoryEntry[],
): string {
	const parts = [
		`## Original Intent`,
		originalIntent,
		``,
		`## Build Aim`,
		buildAim,
		``,
	];
	if (acceptance) {
		parts.push(`## Acceptance Criteria`, acceptance, ``);
	}
	parts.push(
		`## Audit Feedback`,
		auditFeedback,
		``,
	);
	if (cycleHistory && cycleHistory.length > 0) {
		const buildOutputs = formatPriorBuildOutputs(cycleHistory);
		if (buildOutputs) {
			parts.push(buildOutputs, ``);
		}
		const auditHistory = formatPriorAuditHistory(cycleHistory);
		if (auditHistory) {
			parts.push(auditHistory, ``);
		}
	}
	parts.push(
		`Fix the above issues, preserving the Original Intent and incorporating all prior cycle feedback.`,
	);
	return parts.join("\n");
}

export function formatPriorAuditHistory(entries: CycleHistoryEntry[]): string {
	if (entries.length === 0) return "";

	const lines = entries.map((e) => {
		const parts = [
			`**Cycle ${e.cycle + 1}**`,
			`- Verdict: ${e.verdict}`,
		];
		if (e.feedback) {
			parts.push(`- Feedback: ${e.feedback.slice(0, 2000)}`);
		}
		if (e.buildFeedbacks && e.buildFeedbacks.length > 0) {
			parts.push(`- Per-Build Feedback:`);
			e.buildFeedbacks.forEach((fb, i) => {
				if (fb) {
					parts.push(`  - Build ${i + 1}: ${fb.slice(0, 1500)}`);
				} else {
					parts.push(`  - Build ${i + 1}: pass`);
				}
			});
		}
		return parts.join("\n");
	});

	return `## Prior Audit History\n\n${lines.join("\n\n")}`;
}

export function formatPriorBuildOutputs(entries: CycleHistoryEntry[]): string {
	if (entries.length === 0) return "";

	const lines = entries.map((e) => {
		const parts = [`**Cycle ${e.cycle + 1}**`];
		if (e.buildOutputs.length > 0) {
			parts.push(`- Build Outputs:`);
			e.buildOutputs.forEach((bo, i) => {
				parts.push(`  - Build ${i + 1}: ${bo.slice(0, 3000)}`);
			});
		}
		return parts.join("\n");
	});

	return `## Prior Build Outputs\n\n${lines.join("\n\n")}`;
}

export function buildGroupAuditIntent(
	builds: Array<{ aim: string; intent: string; acceptance?: string; concern?: string; output: string }>,
	cycleHistory?: CycleHistoryEntry[],
): string {
	const sections = builds.map((b, i) => {
		const section = [
			`### Build ${i + 1}`,
			``,
			`## Build Aim`,
			b.aim,
			``,
		];
		if (b.acceptance) {
			section.push(`## Acceptance Criteria`, b.acceptance, ``);
		}
		if (b.concern) {
			section.push(`## Concerns`, b.concern, ``);
		}
		if (b.intent) {
			section.push(`## Build Intent`, b.intent, ``);
		}
		section.push(
			`## Build Output`,
			b.output.slice(0, MAX_AUDIT_OUTPUT_SLICE),
		);
		return section.join("\n");
	});

	const parts = [
		...sections,
		``,
	];

	if (cycleHistory && cycleHistory.length > 0) {
		const auditHistory = formatPriorAuditHistory(cycleHistory);
		if (auditHistory) {
			parts.push(auditHistory, ``);
		}
		const buildOutputs = formatPriorBuildOutputs(cycleHistory);
		if (buildOutputs) {
			parts.push(buildOutputs, ``);
		}
	}

	parts.push(
		`Check for: security issues, correctness, completeness, edge cases, and any overlooked requirements per build. For each build, indicate whether it passes or needs rework with specific actionable feedback.`,
	);

	return parts.join("\n\n");
}
