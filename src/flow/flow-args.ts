/**
 * CLI argument building for child flows — extracted from runner.ts.
 */

import { type FlowConfig, getFlowTier } from "./agents.js";
import { getInheritedCliArgs } from "../snapshot/cli-args.js";
import { mapThinkingLevel } from "../config/thinking-level-map.js";
import {
	computeTransitionState,
	buildGuardLine,
	buildFlowListSection,
	buildLineage,
	computeChildPropagation,
} from "./transition.js";
import { DEFAULT_COMPLEXITY, getComplexityTimeoutMs, type Complexity } from "./complexity.js";
import type { GoalContext } from "./types.js";

export const inheritedCliArgs = getInheritedCliArgs();

/**
 * Transform a flow's tool list when toolOptimize is enabled.
 * Replaces separate read/write/edit tools with the unified batch tool.
 */
export function getOptimizedTools(
	flowTools: string[] | undefined,
	toolOptimize: boolean,
): string[] | undefined {
	if (!toolOptimize || !flowTools) return flowTools;
	const hasLegacyTools = flowTools.some(
		(t) => t === "read" || t === "write" || t === "edit",
	);
	if (!hasLegacyTools) return flowTools;
	const filtered = flowTools.filter(
		(t) => t !== "read" && t !== "write" && t !== "edit" && t !== "batch" && t !== "batch_read",
	);
	return filtered.includes("batch")
		? filtered
		: [...filtered, "batch"];
}

export function buildFlowArgs(
	flow: FlowConfig,
	intent: string,
	forkSessionPath: string | null,
	model?: string,
	parentDepth: number = 0,
	maxDepth: number = 0,
	toolOptimize: boolean = false,
	structuredOutput: boolean = true,
	complexity: Complexity = DEFAULT_COMPLEXITY,
	sessionTimeoutMs: number = getComplexityTimeoutMs(complexity),
	acceptance?: string,
	concern?: string,
	discoveredFlows: FlowConfig[] = [],
	parentFlowStack: string[] = [],
	preventCycles: boolean = true,
	goalContext?: GoalContext,
	cwd?: string,
	tools?: string[],
	preDispatchResults?: string,
	conventions?: string,
): string[] {
	const args: string[] = [
		"--mode",
		"json",
		...inheritedCliArgs.extensionArgs,
		...inheritedCliArgs.alwaysProxy,
	];

	if (forkSessionPath) {
		args.push("--session", forkSessionPath);
	}

	if (inheritedCliArgs.flowModelConfig) {
		args.push("--flow-model-config", inheritedCliArgs.flowModelConfig);
	}
	if (inheritedCliArgs.flowComplexity) {
		args.push("--flow-complexity", inheritedCliArgs.flowComplexity);
	}
	if (inheritedCliArgs.tieredModels?.lite) {
		args.push("--flow-lite-model", inheritedCliArgs.tieredModels.lite);
	}
	if (inheritedCliArgs.tieredModels?.flash) {
		args.push("--flow-flash-model", inheritedCliArgs.tieredModels.flash);
	}
	if (inheritedCliArgs.tieredModels?.full) {
		args.push("--flow-full-model", inheritedCliArgs.tieredModels.full);
	}

	const resolvedModel = model ?? flow.model ?? inheritedCliArgs.fallbackModel;
	if (resolvedModel) args.push("--model", resolvedModel);

	const rawSkipSo = process.env["PI_FLOW_SKIP_STRUCTURED_DIRECTIVE"];
	const skipStructuredDirective =
		rawSkipSo !== undefined && ["1", "true", "yes"].includes(rawSkipSo.trim().toLowerCase());

	const rawThinking = flow.thinking;
	if (rawThinking) {
		const mappedThinking = mapThinkingLevel(rawThinking);
		if (mappedThinking) {
			args.push("--thinking", mappedThinking);
		}
	}

	const { currentDepth, effectiveMaxDepth, canTransition } = computeTransitionState(parentDepth, maxDepth);

	const defaultTools = toolOptimize
		? canTransition
			? ["batch", "bash", "flow"]
			: ["batch", "bash"]
		: canTransition
			? ["batch", "bash", "flow"]
			: ["batch", "bash"];
	const sourceTools = tools ?? flow.tools;
	const optimizedTools = getOptimizedTools(sourceTools, toolOptimize) ?? defaultTools;
	let harnessTools = optimizedTools;
	const hasEssentials = harnessTools.some(
		(t) => t === "batch" || t === "bash" || t === "batch_read",
	);
	if (harnessTools.length === 0 || !hasEssentials) {
		harnessTools = [...new Set([...defaultTools, ...harnessTools])];
	}
	args.push("--tools", harnessTools.join(","));

	const availableTools = harnessTools.join(", ");

	const contextSeal =
		`<context-seal>\n` +
		`The conversation above is sealed — it is your session history for situational awareness only.\n` +
		`Your task begins NOW. Do not respond to or continue anything from the history.\n` +
		`</context-seal>`;

	const guardLine = buildGuardLine(currentDepth, effectiveMaxDepth, preventCycles, parentFlowStack);
	const flowListSection = buildFlowListSection(canTransition, discoveredFlows);

	const effectiveTier = flow.tier ?? getFlowTier(flow.name);
	const lineage = buildLineage(flow.name, parentFlowStack);
	const activation =
		`\n\n<activation flow="${flow.name}" depth="${currentDepth}" tools="${availableTools}" tier="${effectiveTier}" lineage="${lineage}">\n` +
		`You are a [${flow.name}] agent operating at depth ${currentDepth}.\n` +
		`${flowListSection}` +
		`Do not attempt to use any tool outside the available set — it will fail.\n` +
		`Field aliases: t=tool, o=ops, cmd/command=c, content=c, path=p, cwd=h, timeout=t. Canonical wins.\n` +
		`</activation>`;

	let directiveBody = flow.systemPrompt.trim();
	const resolvedConventions = conventions?.trim();
	if (resolvedConventions) {
		directiveBody += `\n\n## Conventions\n${resolvedConventions}`;
	}

	const isTrace = flow.name.toLowerCase() === "trace";
	if (structuredOutput && directiveBody && !skipStructuredDirective && !isTrace) {
		const isAudit = flow.name.toLowerCase() === "audit";
		const auditFields = isAudit
			? " Also include `verdict: 'pass' | 'rework'` and `feedback: string` (required when verdict is 'rework', optional when 'pass'). When auditing multiple builds, also include `builds: { index: number, verdict: 'pass' | 'rework', feedback?: string }[]` with per-build verdicts."
			: "";
		directiveBody +=
			`\n\n## Structured Output\n` +
			`End with a \`\`\`json block: { version, status, summary, files[], actions[], notDone[], nextSteps[], reasoning[], notes[]${isAudit ? ", verdict, feedback, builds" : ""} }. Commands auto-extracted; omit empty arrays. Keep snippets under 300 chars. List at most 10 items per array.${auditFields}`;
	}

	const directive = directiveBody
		? `\n\n<directive>\n${directiveBody}\n</directive>`
		: "";

	const acceptanceLine = acceptance ? `\nAcceptance: ${acceptance}` : "";
	const concernLine = concern ? `\nConcerns:\n${concern}` : "";
	const mission =
		`\n\n<mission>\n${intent}${acceptanceLine}${concernLine}\n` +
		`\nBefore the first tool call, output a \`## Base Understanding\` block (max 5 lines): objectively restate the mission in 1-2 sentences, list key context or constraints relied on from the mission, acceptance, concerns, or sealed history, and note material assumptions or unknowns. Then proceed with the workflow.\n` +
		`\nExecute this mission. Use only your available tools. If blocked, report why — do not guess.\n` +
		`Follow the output format specified in your directive.\n` +
		`</mission>`;

	let goalSection = "";
	if (goalContext?.objective) {
		const completedSummary = goalContext.completedFlows?.length
			? `\nCompleted steps:\n${goalContext.completedFlows.map(f => `- [${f.type}] ${f.aim}`).join("\n")}`
			: "";
		goalSection = `\n\n<flow>\nObjective: ${goalContext.objective}\n${goalContext.acceptance ? `Acceptance: ${goalContext.acceptance}\n` : ""}${goalContext.maxFlows !== undefined ? `Progress: ${goalContext.flowCount ?? 0}/${goalContext.maxFlows} flows used.\n` : ""}${completedSummary}\n</flow>`;
	}

	const preDispatchSection = preDispatchResults
		? `\n\n<pre-dispatch>\nThe following tool calls were already executed on your behalf. Continue your exploration from there, or synthesize the outputs, pick up necessary tool id to keep.\n\n${preDispatchResults}\n</pre-dispatch>`
		: "";

	args.push("-p", `${contextSeal}${activation}${directive}${mission}${goalSection}${preDispatchSection}`);
	return args;
}
