/**
 * Pi Flow Extension (fork-only)
 *
 * Dives into specialized flow states running as isolated pi processes.
 * Each flow receives a forked snapshot of the current session context.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { setupNotify } from "./notify/notify.js";
import { discoverFlows, getFlowTier, BUNDLED_FLOW_TYPES, type FlowConfig, type FlowTier } from "./flow/agents.js";
import { getInheritedCliArgs } from "./snapshot/cli-args.js";
import { renderFlowCall, renderFlowResult } from "./tui/render.js";
import { beginFlowLiveSession, endFlowLiveSession } from "./tui/flow-live-state.js";
import { wrapFlowOnUpdate } from "./flow/flow-live.js";
import { DEFAULT_FLOW_COLORS } from "./tui/flow-colors.js";
import { terminateAllChildGroups } from "./flow/runner.js";
import { executeFlows } from "./flow/executor.js";
import { resetLoopGuard } from "./tools/loop-guard.js";
import type {
	SingleResult,
	FlowDetails,
	PiAgentFlowAPI,
} from "./types/flow.js";

import {
	createBatchTool,
	createBatchReadTool,
	BashProcessTracker,
	createBatchBashPollTool,
	runBashWithLimits,
} from "./batch/index.js";
import { createAskUserTool } from "./tools/ask-user.js";
import {
	stripSteeringHintText,
	stripSteeringHintsFromMessages,
	makeSteeringHintMessage,
	configureSteering,
} from "./steering/sliding-prompt.js";
import { registerFlow, getGoal, getGoalForSession, getLoop, recordFlowCompletion, addTokens, shutdownWakeup, clearAllContinuationState, flushAllStoreCachesSync } from "./flow/index.js";
import * as sessionRegistry from "./flow/session-registry.js";

import { createTimedBashToolDefinition } from "./tools/timed-bash.js";

import { createTraceTool } from "./tools/trace.js";
import { prepareFlowDispatchArguments } from "./flow/flow-dispatch-prep.js";
import { executeOperations } from "./batch/execute.js";
import { runWebOps } from "./tools/web-ops.js";
import { BASH_DEFAULT_TIMEOUT_MS, type FileOpInput } from "./batch/constants.js";
import type { WebOpInput } from "./tools/web-ops.js";
import {
	resolveFlowDepthConfig,
	type FlowDepthConfig,
} from "./flow/depth.js";
import { buildSnapshotWithCompression, parseSharedContext, type SharedContext } from "./core2/snapshot.js";
import {
	resolveFlowModelCandidates,
	resolveModelContextWindow,
	invalidateSettingsCache,
	flushAllSettingsCachesSync,
} from "./config/config.js";
import {
	resolveSettings,
	type ResolvedSettings,
} from "./config/settings-resolver.js";
import { getSkipFlowTools, clearClassificationCache, type SkipFlowConfig, type ClassifyDeps } from "./tools/skip-flow.js";

import { scrambleManager, setAnimationConfig } from "./tui/scramble/index.js";
import { logWarn, logError } from "./config/log.js";
export { logWarn, logError };

declare global {
	var __pi_agent_flow_shutdown_registered: boolean | undefined;
}

import {
	computeActiveTools,
	buildBeforeAgentStartPrompt,
} from "./steering/flow-prompt.js";

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const BatchDispatchOp = Type.Object({
	tool: Type.Literal("batch"),
	ops: Type.Array(Type.Object({
		o: Type.String(),
		p: Type.String(),
		c: Type.Optional(Type.String()),
		e: Type.Optional(Type.Array(Type.Object({ f: Type.String(), r: Type.String() }))),
		s: Type.Optional(Type.Number()),
		l: Type.Optional(Type.Union([Type.Number(), Type.Boolean()])),
		i: Type.Optional(Type.Union([Type.String(), Type.Boolean()])),
		t: Type.Optional(Type.Union([Type.Number(), Type.String()])),
		h: Type.Optional(Type.String()),
		q: Type.Optional(Type.String()),
		n: Type.Optional(Type.Number()),
		u: Type.Optional(Type.Number()),
	}), { description: "File/batch operations matching the batch tool schema. Aliases accepted: path=p, content=c, edits=e, offset=s, limit=l, ignoreCase=i, query=q, maxCount=n. Canonical wins." }),
});
const BashDispatchOp = Type.Object({
	tool: Type.Literal("bash"),
	ops: Type.Array(Type.Object({
		c: Type.String({ description: "Shell command. Alias: cmd." }),
		h: Type.Optional(Type.String({ description: "Working directory override. Alias: cwd." })),
		t: Type.Optional(Type.Number({ description: "Timeout in ms. Alias: timeout." })),
	}), { description: "Bash command objects." }),
});
const WebDispatchOp = Type.Object({
	tool: Type.Literal("web"),
	ops: Type.Array(Type.Object({
		o: Type.Union([Type.Literal("search"), Type.Literal("fetch")]),
		q: Type.Optional(Type.String()),
		u: Type.Optional(Type.String()),
		f: Type.Optional(Type.String()),
	}), { description: "Web operations matching the web tool schema." }),
});
const DispatchOpSchema = Type.Union([BatchDispatchOp, BashDispatchOp, WebDispatchOp], {
	description: "Pre-dispatch tool call with discriminated tool type and typed ops array. Wrapper aliases: t=tool, o=ops. Canonical wins.",
});

const FlowItem = Type.Object({
	type: Type.Union(
		BUNDLED_FLOW_TYPES.map((t) => Type.Literal(t)) as any,
		{ description: "Flow type: one of the bundled flow types." },
	),
	intent: Type.String({
		description: "Detailed mission for this flow.",
	}),
	aim: Type.String({
		description: "Short (5-7 words) headline summary.",
	}),
	acceptance: Type.Optional(
		Type.String({ description: "Success criteria for the task." }),
	),
	concern: Type.String({
		description: "Known risks, uncertainties, or areas requiring extra care. Be specific.",
	}),
	cwd: Type.Optional(
		Type.String({ description: "Working directory override." }),
	),
	complexity: Type.Union([
		Type.Literal("snap"),
		Type.Literal("simple"),
		Type.Literal("moderate"),
		Type.Literal("complex"),
		Type.Literal("intricate"),
	], {
		description: "Budget/Audit level: snap (120s), simple (300s), moderate (600s), complex (900s), intricate (1200s).",
	}),
	dispatch: Type.Optional(
		Type.Array(DispatchOpSchema, {
			description: "Tools to run before the flow starts (results are injected into the prompt). Accepts field aliases (t/o/cmd/path/etc) — canonical wins.",
		}),
	),

}, {
	title: "FlowTask",
	description: "A single flow task object.",
});

export const FlowParams = Type.Object({
	flow: Type.Array(FlowItem, {
		description: "Specialized flow tasks to dive into.",
		minItems: 1,
	}),
	confirmProjectFlows: Type.Optional(
		Type.Boolean({
			description: "Prompt before running local flows. Default: true.",
			default: true,
		}),
	),
	auditLoop: Type.Optional(
		Type.Number({
			description: "Override audit cycles (0-3).",
			default: 0,
			minimum: 0,
			maximum: 3,
		}),
	),
}, {
	title: "FlowToolParams",
	description: "The root object MUST contain a 'flow' array. Never flatten fields to the root.",
	examples: [{
		flow: [{ type: "scout", intent: "Map auth module files", aim: "Map auth module", complexity: "moderate", concern: "The auth module was recently refactored — verify assumptions" }],
	}, {
		flow: [{ type: "scout", intent: "Map auth files", aim: "Map auth", complexity: "simple", concern: "verify", dispatch: [{ t: "bash", o: [{ cmd: "ls src/auth" }] }] }]
	}, {
		flow: [
			{ type: "scout", intent: "Map auth files", aim: "Map auth", complexity: "simple", concern: "verify" },
			{ type: "build", intent: "Implement JWT middleware", aim: "Add JWT", complexity: "complex", concern: "stateless only" },
		],
	}],
});

// Exported for static description-hygiene tests. Keep in sync with the
// `pi.registerTool({ description, promptSnippet, promptGuidelines, ... })` call
// inside the default export below.
export const FLOW_TOOL_DESCRIPTION =
	"Spawns specialized agent flows. Each task needs [type] [intent] [aim] [concern] [complexity]; the [flow] array must contain only complete task objects. Routes work to [scout] [build] [audit] [debug] [craft] [ideas] agents. Complexity: [snap] [simple] [moderate] [complex] [intricate].";

export const FLOW_TOOL_PROMPT_SNIPPET =
	"Dive into specialized flows (scout, debug, build, craft, audit, ideas) via a `flow` array.";

export const FLOW_TOOL_PROMPT_GUIDELINES: readonly string[] = [
	"Combine multiple tasks into one `flow` call. Each needs `type`, `intent`, `aim`, `complexity`.",
	"Optional `dispatch` runs pre-flight reads, writes, edits, or bash commands before the flow starts.",
	"For quick file reads/checks, use `trace` instead.",
	"The `flow` array must contain only complete FlowItem objects. No commentary, no newlines, no retry notes between elements. If a previous call failed, rebuild the call cleanly from scratch.",
];

const inheritedCliArgs = getInheritedCliArgs();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function executeDispatchOps(
	dispatch: Array<
		| { tool: "batch"; ops: FileOpInput[] }
		| { tool: "bash"; ops: Array<{ c: string; h?: string; t?: number }> }
		| { tool: "web"; ops: WebOpInput[] }
	>,
	cwd: string,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<string> {
	const parts: string[] = [];
	let toolCallIndex = 0;

	for (const group of dispatch) {
		if (signal?.aborted) break;
		const toolCallId = `pre_dispatch_${group.tool}_${toolCallIndex++}`;

		try {
			if (group.tool === "batch") {
				// Separate file ops from bash ops
				const fileOps = group.ops.filter((op) => op.o !== "bash");
				const bashOps = group.ops.filter((op) => op.o === "bash");

				if (fileOps.length > 0) {
					const fileOutput = await executeOperations(fileOps as FileOpInput[], cwd, signal, { includeLimitWarnings: true });
					parts.push(`### batch (file ops)\n\ntool_call_id: ${toolCallId}\n\n${fileOutput.contentText}`);
				}

				if (bashOps.length > 0) {
					for (const op of bashOps) {
						const { stdout, stderr, exitCode } = await runBashWithLimits(op.c ?? "", op.h ?? cwd, op.t ?? BASH_DEFAULT_TIMEOUT_MS, signal);
						parts.push(`### bash [${op.i ?? "auto"}] exit ${exitCode}\n\ntool_call_id: ${toolCallId}\n\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`);
					}
				}
			} else if (group.tool === "bash") {
				for (const cmd of group.ops) {
					const { stdout, stderr, exitCode } = await runBashWithLimits(cmd.c, cmd.h ?? cwd, cmd.t ?? BASH_DEFAULT_TIMEOUT_MS, signal);
					parts.push(`### bash\n\ntool_call_id: ${toolCallId}\n\n--- bash exit ${exitCode} ---\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`);
				}
			} else if (group.tool === "web") {
				const webOutput = await runWebOps({ op: group.ops }, ctx, signal);
				parts.push(`### web\n\ntool_call_id: ${toolCallId}\n\n${webOutput.content[0].text}`);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			parts.push(`### ${group.tool} (error)\n\ntool_call_id: ${toolCallId}\n\nPre-dispatch failed: ${message}`);
		}
	}

	return parts.join("\n\n---\n\n");
}

function makeFlowDetailsFactory(projectFlowsDir: string | null, sharedContext?: SharedContext) {
	return (results: SingleResult[]): FlowDetails => ({
		mode: "flow",
		flowStyle: "fork",
		projectAgentsDir: projectFlowsDir,
		results,
		sharedContext,
	});
}


export { type FlowColorConfig } from "./tui/flow-colors.js";

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerFlag("flow-max-depth", {
		description: "Maximum allowed flow depth (default: 3).",
		type: "string",
	});
	pi.registerFlag("flow-prevent-cycles", {
		description: "Block diving into flows already in the current flow stack (default: true).",
		type: "boolean",
	});
	pi.registerFlag("flow-model-config", {
		description: "Named flow model strategy from settings.json flowModelConfigs.",
		type: "string",
	});
	pi.registerFlag("flow-mode", {
		description: "Persistently switch the global flow model strategy in ~/.pi/agent/settings.json.",
		type: "string",
	});
	pi.registerFlag("flow-lite-model", {
		description: "Model for lite-tier flows (scout, debug, trace).",
		type: "string",
	});
	pi.registerFlag("flow-flash-model", {
		description: "Model for flash-tier flows (build, audit).",
		type: "string",
	});
	pi.registerFlag("flow-full-model", {
		description: "Model for full-tier flows (ideas, craft).",
		type: "string",
	});
	pi.registerFlag("flow-max-concurrency", {
		description: "Maximum number of flows to execute in parallel (default: 4).",
		type: "string",
	});
	pi.registerFlag("flow-complexity", {
		description: "Default child-flow complexity: snap (120s no review), simple (300s no review), moderate (600s 1x audit), complex (900s 2x audit), or intricate (1200s 3x audit).",
		type: "string",
	});

	pi.registerFlag("tool-optimize", {
		description: "Use the unified batch tool instead of separate read/write/edit tools (default: true).",
		type: "boolean",
	});
	pi.registerFlag("no-steering", {
		description: "Disable root state steering hint injection.",
		type: "boolean",
	});
	pi.registerFlag("steering-prompt", {
		description: "Path to file containing custom steering prompt.",
		type: "string",
	});

	pi.registerFlag("no-animation", {
		description: "Disable all flow animation (instant render).",
		type: "boolean",
	});
	pi.registerFlag("no-glitch", {
		description: "Disable glitch/scramble effect.",
		type: "boolean",
	});
	pi.registerFlag("body-lite", {
		description: "Use lite collapsed body mode (aim + cmd only).",
		type: "boolean",
	});
	pi.registerFlag("body-full", {
		description: "Use full collapsed body mode (aim + cmd + msg).",
		type: "boolean",
	});
	pi.registerFlag("flow-debug", {
		description: "Write full child flow activation prompt to a temp file on every spawn.",
		type: "boolean",
	});
	pi.registerFlag("tools-trace", {
		description: "Enable the trace tool (default: true).",
		type: "boolean",
	});
	pi.registerFlag("tools-batch-read", {
		description: "Enable the batch_read tool (default: follows tool-optimize).",
		type: "boolean",
	});
	pi.registerFlag("skip-flow", {
		description: "Enable skip flow mode to skip flow for single-purpose tasks (default: false).",
		type: "boolean",
	});

	// Wire up bundled notification channel
	setupNotify(pi);


	// Wire up /flow command and continuation hooks
	registerFlow(pi);

	const depthConfig = resolveFlowDepthConfig(pi);
	const { currentDepth, maxDepth, canTransition, ancestorFlowStack, preventCycles } =
		depthConfig;

	let resolved: ResolvedSettings | undefined;
	let _sessionCtx: ExtensionContext | undefined;
	let bashTracker: BashProcessTracker | undefined;

	// Auto-discover flows on session start
	// Fix L2: registerFlow() already handles sessionRegistry.register() — removed duplicate here.
	pi.on("session_start", async (_event, ctx) => {
		clearClassificationCache();
		invalidateSettingsCache();
		_sessionCtx = ctx;
		resolved = resolveSettings(pi, ctx.cwd);

		// Wire resolved settings to modules
		configureSteering({ enabled: resolved.steeringEnabled, customPrompt: resolved.steeringCustomPrompt });
		scrambleManager.setAnimationConfig({ enabled: resolved.animationEnabled, glitch: resolved.animationGlitch });

		// Only restrict tools for the main root state (depth 0).
		// Child flows (depth > 0) receive their tools via --tools CLI arg;
		// overriding them here would strip bash/batch from children.
		if (currentDepth === 0) {
			pi.setActiveTools(computeActiveTools(resolved.toolOptimize, resolved.traceEnabled, resolved.batchReadEnabled));
		}

		// Register tools based on depth.
		// Depth 0 (main root state): batch_read + no bash ops.
		// Depth > 0 (child flows): batch (with bash), batch_bash_poll — they need bash ops.
		// batch_read is registered at all depths for read-only child operations.
		// The bashProcessTracker is shared between the batch tool (launches bash ops)
		// and the batch_bash_poll tool (checks on pending bash ops).
		if (resolved.batchReadEnabled) {
			pi.registerTool(createBatchReadTool());
		}
		if (resolved.toolOptimize && currentDepth > 0) {
			bashTracker = new BashProcessTracker();
			pi.registerTool(createBatchTool(bashTracker, resolved.toolOptimize));
			pi.registerTool(createBatchBashPollTool(bashTracker));
		}

		// Override built-in bash with timed wrapper so the LLM sees execution-time classification.
		// Only register for child flows — main agent should dive into flows for all bash ops.
		if (currentDepth > 0) {
			const timedBash = createTimedBashToolDefinition(ctx.cwd);
			if (timedBash) {
				pi.registerTool(timedBash);
			}
		}
	});

	// Clean up global mutable state on session shutdown
	// Fix L2: Clean up session registry on shutdown.
	pi.on("session_shutdown", () => {
		if (_sessionCtx) sessionRegistry.unregister(_sessionCtx.cwd);
		shutdownWakeup();
		clearAllContinuationState(); // Fix L3: Prevent unbounded Map growth by cleaning up session tracking state
		_sessionCtx = undefined;
		// bashTracker and its pending OS processes are discarded on restart.
		// This is expected — child process state is not serializable.
		if (bashTracker) {
			try { bashTracker.abortAll(); } catch (e) { logWarn(`[pi-agent-flow] bashTracker.abortAll() failed on shutdown: ${e}`); }
			bashTracker = undefined;
		}
	});

	// Re-apply active tools every turn to survive registry refreshes.
	// Skip for child flows — they get tools from --tools CLI arg.
	pi.on("turn_start", () => {
		if (currentDepth > 0 || !resolved) return;
		pi.setActiveTools(computeActiveTools(resolved.toolOptimize, resolved.traceEnabled, resolved.batchReadEnabled));
		resetLoopGuard();
	});

	// Inject available flows into the system prompt.
	// Skip entirely for child flows (depth > 0) — they get their instructions
	// from the 4-part prompt structure in buildFlowArgs.
	pi.on("before_agent_start", async (event) => {
		if (currentDepth > 0 || !resolved) return undefined;

		const augmented = buildBeforeAgentStartPrompt(
			event,
			resolved.toolOptimize,
		);

		if (augmented === undefined) return undefined;
		return { systemPrompt: augmented };
	});

	// Compaction: inject flow context into the summarization prompt.
	pi.on("session_before_compact", async (event, ctx) => {
		const goal = getGoal(ctx.cwd);
		if (!goal) return undefined;

		const completed = goal.completedFlows.slice(-3);
		const flowSummary = completed.length > 0
			? `\nRecently completed flows:\n${completed.map(f => `- [${f.type}] ${f.aim}`).join("\n")}`
			: "";

		const injection = `\n\n[Flow Context]\nCurrent Goal: ${goal.objective}${goal.acceptance ? `\nAcceptance: ${goal.acceptance}` : ""}${flowSummary}\nMaintain this goal and status in the summary.`;

		return { prompt: (event.prompt || "") + injection };
	});

	// Compaction: re-anchor flow context after summarization.
	pi.on("session_compact", async (_event, ctx) => {
		const goal = getGoal(ctx.cwd);
		if (!goal) return;

		// Send a non-displaying message to re-anchor the agent to its goal.
		pi.sendMessage(
			{
				content: `[Flow Re-anchor] Compaction completed. Current Goal: ${goal.objective}. Continue execution.`,
				display: false,
			},
			{ triggerTurn: false }
		);
	});

	// Steering hint: insert as a separate system message immediately
	// before the latest user message each turn. The steering hint is never
	// part of the static systemPrompt — it is injected dynamically here only.
	// We strip any stray steering hint content from systemPrompt as a safety
	// net, then insert the fresh hint as a separate message.
	// Skipped for child flows (depth > 0) — they have explicit <mission> directives.
	pi.on("context", async (event) => {
		if (currentDepth > 0) {
			return undefined;
		}

		// Always strip old steering hint messages to prevent accumulation
		const { messages: steeringStrippedMessages, changed: steeringChanged } = stripSteeringHintsFromMessages(event.messages);
		const messagesChanged = steeringChanged;

		// Find latest user message
		const userIndices = steeringStrippedMessages
			.map((m: any, i: number) => (m.role === "user" ? i : -1))
			.filter((i: number) => i !== -1);

		// Skip flow mode: adjust tools based on user message complexity
		if (resolved?.skipFlow && userIndices.length > 0) {
			const lastUserMsg = steeringStrippedMessages[userIndices[userIndices.length - 1]];
			let userContent = "";
			if (typeof lastUserMsg.content === "string") {
				userContent = lastUserMsg.content;
			} else if (Array.isArray(lastUserMsg.content)) {
				userContent = lastUserMsg.content
					.filter((c: any) => c && c.type === "text" && typeof c.text === "string")
					.map((c: any) => c.text)
					.join("\n");
			}

			if (userContent) {
				const baseTools = computeActiveTools(resolved.toolOptimize, resolved.traceEnabled, resolved.batchReadEnabled);
				const skipFlowConfig: SkipFlowConfig = {
					enabled: true,
					debugMode: resolved.debugMode,
				};

				// Get model and auth for LLM classification
				const model = (_sessionCtx as any)?.model;
				let deps: ClassifyDeps | undefined;
				if (model) {
					const auth = await (_sessionCtx as any)?.modelRegistry?.getApiKeyAndHeaders(model);
					if (auth?.ok && auth?.apiKey) {
						deps = {
							model,
							apiKey: auth.apiKey,
							headers: auth.headers,
						};
					}
				}

				const skipTools = await getSkipFlowTools(baseTools, userContent, skipFlowConfig, deps);
				pi.setActiveTools(skipTools);
			}
		}

		if (userIndices.length === 0) {
			// No user message yet: strip any stray steering hint text from systemPrompt
			// (safety net for /new or early-session), but don't inject a new one —
			// it will appear on the first user message.
			let systemPrompt = event.systemPrompt;
			let systemPromptChanged = false;
			if (typeof systemPrompt === "string") {
				const stripped = stripSteeringHintText(systemPrompt);
				if (stripped !== systemPrompt) {
					systemPrompt = stripped;
					systemPromptChanged = true;
				}
			}
			const result: any = {};
			if (messagesChanged) result.messages = steeringStrippedMessages;
			if (systemPromptChanged) result.systemPrompt = systemPrompt;
			return (messagesChanged || systemPromptChanged) ? result : undefined;
		}

		// Strip steering hint from the static systemPrompt so it only appears once,
		// as a separate message right before the latest user message.
		let systemPrompt = event.systemPrompt;
		let systemPromptChanged = false;
		if (typeof systemPrompt === "string") {
			const stripped = stripSteeringHintText(systemPrompt);
			if (stripped !== systemPrompt) {
				systemPrompt = stripped;
				systemPromptChanged = true;
			}
		}

		const lastUserIndex = userIndices[userIndices.length - 1];
		const hintMessage = makeSteeringHintMessage(steeringStrippedMessages[lastUserIndex]);
		const modified = hintMessage
			? [
					...steeringStrippedMessages.slice(0, lastUserIndex),
					hintMessage,
					...steeringStrippedMessages.slice(lastUserIndex),
				]
			: steeringStrippedMessages;

		const result: any = {};
		if (hintMessage || messagesChanged) result.messages = modified;
		if (systemPromptChanged) {
			result.systemPrompt = systemPrompt;
		}
		return result;
	});

	// Register the ask_user tool
	pi.registerTool(createAskUserTool());

	const getTierOverride = (tier: "lite" | "flash" | "full"): string | undefined => {
		const flagName =
			tier === "lite"
				? "flow-lite-model"
				: tier === "flash"
					? "flow-flash-model"
					: "flow-full-model";
		const runtimeValue = pi.getFlag(flagName);
		if (typeof runtimeValue === "string" && runtimeValue.trim()) return runtimeValue.trim();
		const inheritedValue = inheritedCliArgs.tieredModels?.[tier];
		return typeof inheritedValue === "string" && inheritedValue.trim() ? inheritedValue.trim() : undefined;
	};

	// Register the trace tool (available at all depths — quick verbatim reads)
	pi.registerTool(createTraceTool({
		getSettings: () => resolved ? { toolOptimize: resolved.toolOptimize, structuredOutput: resolved.structuredOutput, bodyVerbosity: resolved.bodyVerbosity, traceEnabled: resolved.traceEnabled, batchReadEnabled: resolved.batchReadEnabled, contextCompression: resolved.contextCompression } : undefined,
		getDepthConfig: () => depthConfig,
		getLoadedFlowModelConfigs: () => resolved?.loadedFlowModelConfigs,
		tierOverrideResolver: getTierOverride,
		fallbackModel: inheritedCliArgs.fallbackModel,
	}));

// Register the flow tool
	if (canTransition) {
		pi.registerTool({
			name: "flow",
			label: "Flow",
			promptSnippet: "Dive into specialized flows (scout, debug, build, craft, audit, ideas) via a `flow` array.",
			promptGuidelines: [
				"Combine multiple tasks into one `flow` call. Each needs `type`, `intent`, `aim`, `complexity`.",
				"Optional `dispatch` runs pre-flight reads, writes, edits, or bash commands before the flow starts.",
				"For quick file reads/checks, use `trace` instead.",
				"The `flow` array must contain only complete FlowItem objects. No commentary, no newlines, no retry notes between elements. If a previous call failed, rebuild the call cleanly from scratch.",
			],
			description: FLOW_TOOL_DESCRIPTION,
			parameters: FlowParams,
			// @ts-ignore — prepareArguments is supported by the runtime but not in the type definition
			prepareArguments: prepareFlowDispatchArguments,

			async execute(toolCallId, params, signal, onUpdate, ctx) {
				if (!resolved) {
					throw new Error("Error: session not initialized");
				}

				const discovery = discoverFlows(ctx.cwd, "all");
				const { flows } = discovery;

				// Build the fork session snapshot. Core-2 applies a 6-stage sanitization
				// pipeline that strips metadata noise irrelevant to child flow orientation
				// while preserving chronological conversation history.
				function resolveSnapshotTier(flows: FlowConfig[], flowParams: Array<Static<typeof FlowItem>>): FlowTier | undefined {
					if (flowParams.length === 0) return undefined;
					const tiers = flowParams.map((f) => {
						const config = flows.find((flow) => flow.name === f.type.toLowerCase());
						return config?.tier ?? getFlowTier(f.type);
					});
					// Most permissive: full > flash > lite
					if (tiers.includes("full")) return "full";
					if (tiers.includes("flash")) return "flash";
					return tiers[0];
				}

				function resolveSnapshotMaxContextTokens(
					flowConfigs: FlowConfig[],
					flowParams: Array<Static<typeof FlowItem>>,
					strategy: import("./config/config.js").LoadedFlowModelConfigs["strategy"],
					tierOverrideResolver: (tier: "lite" | "flash" | "full") => string | undefined,
					fallbackModel?: string,
				): number | undefined {
					let minTokens: number | undefined;
					for (const f of flowParams) {
						const config = flowConfigs.find((flow) => flow.name === f.type.toLowerCase());
						const tier = config?.tier ?? getFlowTier(f.type);
						const { primary } = resolveFlowModelCandidates({
							tier,
							flowModel: config?.model,
							cliTierOverride: tierOverrideResolver(tier),
							strategy,
							fallbackModel,
						});
						const tokens = resolveModelContextWindow(primary);
						if (tokens !== undefined) {
							minTokens = minTokens === undefined ? tokens : Math.min(minTokens, tokens);
						}
					}
					return minTokens;
				}

				const firstFlow = params.flow[0];
				const firstFlowConfig = flows.find((f) => f.name === (firstFlow?.type ?? "").toLowerCase());
				const maxContextTokens = resolveSnapshotMaxContextTokens(
					flows,
					params.flow,
					resolved.loadedFlowModelConfigs.strategy,
					getTierOverride,
					inheritedCliArgs.fallbackModel,
				);
				const { snapshot: forkSessionSnapshotJsonl, stats: compressionStats } = buildSnapshotWithCompression(
					ctx.sessionManager,
					{
						activeToolCallId: toolCallId,
						tier: resolveSnapshotTier(flows, params.flow),
						compressionProfile: firstFlowConfig?.contextProfile,
						compressionLevel: resolved?.contextCompression,
					},
					maxContextTokens,
				);

				if (compressionStats) {
					logWarn(`[pi-agent-flow] Context compression applied: ${compressionStats.level} (${compressionStats.preBytes} → ${compressionStats.postBytes} bytes, ${compressionStats.messagesDropped} messages dropped)`);
				}

				const sharedContext = parseSharedContext(forkSessionSnapshotJsonl);
				const makeDetails = makeFlowDetailsFactory(discovery.projectFlowsDir, sharedContext);
				beginFlowLiveSession(toolCallId, {
					sharedContext,
					intent: firstFlow?.intent ?? "",
					aim: firstFlow?.aim,
					flowType: firstFlow?.type,
				});

				let activeGoal = getGoalForSession(ctx.cwd, sessionRegistry.getSessionId(ctx.cwd));
				if (!activeGoal) {
					const anyGoal = getGoal(ctx.cwd);
					if (anyGoal && anyGoal.status === "active") {
						logWarn(`[pi-agent-flow] Session mismatch for goal: expected ${sessionRegistry.getSessionId(ctx.cwd)}, got ${anyGoal.sessionId ?? "none"}. Using goal anyway.`);
						activeGoal = anyGoal;
					}
				}
				const goalContext = activeGoal ? {
					objective: activeGoal.objective,
					acceptance: activeGoal.acceptance,
					flowCount: activeGoal.completedFlows.length,
					maxFlows: activeGoal.maxFlows,
					completedFlows: activeGoal.completedFlows.map(f => ({ type: f.type, aim: f.aim })),
				} : undefined;

				const preDispatchResults = await Promise.all(
					params.flow.map(async (f: Static<typeof FlowItem>) => {
						if (!f.dispatch || f.dispatch.length === 0) return undefined;
						const result = await executeDispatchOps(f.dispatch, f.cwd ?? ctx.cwd, ctx, signal);
						const notes = (f as unknown as Record<string, unknown>)._dispatchNotes as string[] | undefined;
						if (notes && notes.length > 0) {
							return `normalized:\n${notes.map((n) => `- ${n}`).join("\n")}\n\n${result}`;
						}
						return result;
					})
				);

				// Surface flow-level normalization notes
				const flowNotes = (params as unknown as Record<string, unknown>)._flowNotes as string[] | undefined;
				if (flowNotes && flowNotes.length > 0) {
					const noteText = `flow normalized:\n${flowNotes.map((n) => `- ${n}`).join("\n")}`;
					if (preDispatchResults[0] === undefined) {
						(preDispatchResults as (string | undefined)[])[0] = noteText;
					} else {
						(preDispatchResults as string[])[0] = `${noteText}\n\n${preDispatchResults[0]}`;
					}
				}

				let result: Awaited<ReturnType<typeof executeFlows>>;
				try {
					result = await executeFlows(
						{
							flows,
							currentDepth,
							maxDepth,
							ancestorFlowStack,
							preventCycles,
							toolOptimize: resolved.toolOptimize,
							structuredOutput: resolved.structuredOutput,
							cwd: ctx.cwd,
							loadedFlowModelConfigs: resolved.loadedFlowModelConfigs,
							maxConcurrency: resolved.maxConcurrency,
							debugMode: resolved.debugMode,
							defaultComplexity: resolved.defaultComplexity,
							signal,
							onUpdate: wrapFlowOnUpdate(toolCallId, onUpdate),
							makeDetails,
							getFlag: (name: string) => name === "flow-mode" ? resolved!.activeRuntimeFlowMode : pi.getFlag(name),
							tierOverrideResolver: getTierOverride,
							fallbackModel: inheritedCliArgs.fallbackModel,
							forkSessionSnapshotJsonl,
							compressionStats,
							projectFlowsDir: discovery.projectFlowsDir,
							sessionManager: ctx.sessionManager,
							hasUI: ctx.hasUI,
							uiConfirm: (title, body) => ctx.ui.confirm(title, body),
							onFlowMetrics: (metrics) => { if (typeof pi.emit === "function") pi.emit("pi-agent-flow:complete", metrics); },
							confirmProjectFlows: params.confirmProjectFlows,
							goalContext,
							goalContinuationCallback: async (results) => {
								const goal = getGoalForSession(ctx.cwd, sessionRegistry.getSessionId(ctx.cwd));
								if (!goal) return;
								for (const r of results) {
									recordFlowCompletion(ctx.cwd, { type: r.type, intent: r.intent, aim: r.aim });
									addTokens(ctx.cwd, r.usage.input + r.usage.output);
								}
							},
						},
						params.flow.map((f: Static<typeof FlowItem>, i: number) => ({
							type: f.type,
							intent: f.intent,
							aim: f.aim,
							acceptance: f.acceptance,
							concern: f.concern,
							cwd: f.cwd,
							complexity: f.complexity,
							preDispatchResults: preDispatchResults[i],
						})),
						toolCallId,
						params.auditLoop ?? 0,
					);
				} finally {
					endFlowLiveSession(toolCallId);
				}

				if (result.failed) {
					const text = result.content?.[0]?.text ?? "Flow execution failed";
					throw new Error(text);
				}

				return {
					content: result.content,
					details: result.details,
					failed: result.failed,
					_toolCallId: toolCallId,
				};
			},

			renderCall: (args, theme) => renderFlowCall(args, theme, { ...DEFAULT_FLOW_COLORS, bodyVerbosity: resolved?.bodyVerbosity }),
			renderResult: (result, { expanded }, theme, args) =>
				renderFlowResult(result, expanded, theme, args, { ...DEFAULT_FLOW_COLORS, bodyVerbosity: resolved?.bodyVerbosity }),
		});
	}


	// -------------------------------------------------------------------------
	// Public plugin API — expose for third-party extensions
	// -------------------------------------------------------------------------

	// Emit a ready event with the API surface so external plugins can extend.
	const pluginApi: PiAgentFlowAPI = {
		discoverFlows: (cwd: string) => discoverFlows(cwd, "all"),
		getFlowTier: (name: string) => getFlowTier(name),
		getSettings: () => resolved
			? {
					toolOptimize: resolved.toolOptimize,
					structuredOutput: resolved.structuredOutput,
					maxConcurrency: resolved.maxConcurrency,
					steeringEnabled: resolved.steeringEnabled,
					steeringCustomPrompt: resolved.steeringCustomPrompt,
					animationEnabled: resolved.animationEnabled,
					animationGlitch: resolved.animationGlitch,
					bodyVerbosity: resolved.bodyVerbosity,
					debugMode: resolved.debugMode,
					traceEnabled: resolved.traceEnabled,
					batchReadEnabled: resolved.batchReadEnabled,
					contextCompression: resolved.contextCompression,
				}
			: {
					toolOptimize: true,
					structuredOutput: true,
					maxConcurrency: 4,
					steeringEnabled: true,
					steeringCustomPrompt: undefined,
					animationEnabled: true,
					animationGlitch: true,
					bodyVerbosity: "lite",
					debugMode: false,
					traceEnabled: true,
					batchReadEnabled: true,
					contextCompression: undefined,
				},
	};

	if (typeof pi.emit === "function") {
		pi.emit("pi-agent-flow:ready", pluginApi);
	}

	// Register cleanup on process exit (once).
	// We use prependListener on SIGINT/SIGTERM to propagate to child processes
	// before the host's own signal handler runs. This avoids orphaned flow states.
	// The host handler still runs afterward and handles terminal cleanup.
	if (!globalThis.__pi_agent_flow_shutdown_registered) {
		globalThis.__pi_agent_flow_shutdown_registered = true;

		// Propagate signals to child process groups so flow states don't become orphans.
		// We use prependListener so our handler runs first, before the host's cleanup.
		const shutdown = () => {
			// First, abort any pending bash operations tracked by the batch tool.
			if (bashTracker) {
				try { bashTracker.abortAll(); } catch (e) { logWarn(`[pi-agent-flow] bashTracker.abortAll() failed on signal: ${e}`); }
			}
			terminateAllChildGroups();
			shutdownWakeup();
			clearAllContinuationState(); // Fix L3: Prevent unbounded Map growth by cleaning up session tracking state
			flushAllStoreCachesSync();   // Fix P9: Ensure goal state is persisted before process exit
			flushAllSettingsCachesSync(); // Fix P17: Ensure settings are persisted before process exit
			if (typeof pi.emit === "function") {
				pi.emit("pi-agent-flow:shutdown", { reason: "process-exit" });
			}
		};

		process.prependListener("SIGINT", shutdown);
		process.prependListener("SIGTERM", shutdown);

		// Also handle the 'exit' event, which fires when the host calls process.exit().
		process.on("exit", shutdown);
	}

}
