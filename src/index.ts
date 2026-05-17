/**
 * Pi Flow Extension (fork-only)
 *
 * Dives into specialized flow states running as isolated pi processes.
 * Each flow receives a forked snapshot of the current session context.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { setupNotify } from "./notify/notify.js";
import { discoverFlows, getFlowTier } from "./core/agents.js";
import { getInheritedCliArgs } from "./snapshot/cli-args.js";
import { renderFlowCall, renderFlowResult } from "./tui/render.js";
import { terminateAllChildGroups } from "./core/flow.js";
import { executeFlows, evictCacheOverflow } from "./core/executor.js";
import { appendDirectiveOnce, resetDirectiveTracker, configureDirective, stripDirectivesFromMessages, type FlowHintContext } from "./steering/tool-utils.js";
import type {
	SingleResult,
	FlowDetails,
	PiAgentFlowAPI,
} from "./types/flow.js";
import type { CompressedFlowResult } from "./types/output.js";
import {
	createBatchTool,
	createBatchReadTool,
	BashProcessTracker,
	createBatchBashPollTool,
} from "./batch/index.js";
import { createWebTool } from "./tools/web-tool.js";
import { createAskUserTool } from "./tools/ask-user.js";
import {
	stripSteeringHintText,
	stripSteeringHintsFromMessages,
	makeSteeringHintMessage,
	configureSteering,
} from "./steering/sliding-prompt.js";
import { registerFlow, getGoal, getGoalForSession, getLoop, recordFlowCompletion, addTokens, shutdownWakeup } from "./flow/index.js";
import * as sessionRegistry from "./core/session-registry.js";

import { createTimedBashToolDefinition } from "./tools/timed-bash.js";
import {
	resolveFlowDepthConfig,
	type FlowDepthConfig,
} from "./core/depth.js";
import {
	buildForkSessionSnapshotJsonl,
	sanitizeForkSnapshot,
} from "./snapshot/snapshot.js";
import {
	resolveSettings,
	type ResolvedSettings,
} from "./config/settings-resolver.js";

import { scrambleManager, setAnimationConfig } from "./tui/scramble/index.js";
import { logWarn, logError } from "./config/log.js";
export { logWarn, logError };

// ---------------------------------------------------------------------------
// Persistent flow result cache — shared across execute() calls so historical
// flow results are compressed properly in fork snapshots.
// ---------------------------------------------------------------------------
const flowResultCache = new Map<string, CompressedFlowResult[]>();

/**
 * Reconstruct flowResultCache from an existing session branch after restart.
 * Scans tool results for the "flow" tool and rebuilds CompressedFlowResult
 * entries so child-fork compression works immediately without waiting for
 * new flows to complete.
 */
function reconstructFlowResultCache(
	sessionManager: { getBranch: () => unknown[] },
	cache: Map<string, CompressedFlowResult[]>,
): void {
	const branch = sessionManager.getBranch();
	if (!Array.isArray(branch) || branch.length === 0) return;

	// Pass 1: map toolCallId -> "flow" from assistant messages
	const toolCallIdToName = new Map<string, string>();
	for (const entry of branch) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		if (e.type !== "message") continue;
		const msg = e.message as Record<string, unknown> | undefined;
		if (!msg || msg.role !== "assistant") continue;
		const content = msg.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const p = part as Record<string, unknown>;
			if (p.type === "toolCall" && p.name === "flow") {
				const tcId = (p.id ?? p.toolCallId) as string | undefined;
				if (tcId) toolCallIdToName.set(tcId, "flow");
			}
		}
	}

	// Pass 2: scan tool/toolResult messages and rebuild cache
	for (const entry of branch) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		if (e.type !== "message") continue;
		const msg = e.message as Record<string, unknown> | undefined;
		if (!msg || (msg.role !== "tool" && msg.role !== "toolResult")) continue;

		let toolCallId: string | undefined;
		if (typeof msg.toolCallId === "string" && msg.toolCallId.trim()) {
			toolCallId = msg.toolCallId;
		} else if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (!part || typeof part !== "object") continue;
				const p = part as Record<string, unknown>;
				if (p.type === "toolResult" && typeof p.toolCallId === "string" && p.toolCallId.trim()) {
					toolCallId = p.toolCallId;
					break;
				}
			}
		}
		if (!toolCallId || toolCallIdToName.get(toolCallId) !== "flow") continue;

		const details = msg.details as Record<string, unknown> | undefined;
		if (!details || !Array.isArray(details.results)) continue;

		const results = details.results as Array<Record<string, unknown>>;
		const compressed: CompressedFlowResult[] = [];
		for (const r of results) {
			const so = r.structuredOutput as Record<string, unknown> | undefined;
			if (!so) continue;
			const c: CompressedFlowResult = {
				type: typeof r.type === "string" ? r.type : "unknown",
				status: typeof r.exitCode === "number" && r.exitCode === 0 ? "accomplished" : "failed",
			};
			if (typeof r.intent === "string") c.intent = r.intent;
			if (typeof r.aim === "string") c.aim = r.aim;
			if (typeof so.summary === "string") c.summary = so.summary;
			if (Array.isArray(so.files)) c.files = so.files as CompressedFlowResult["files"];
			if (Array.isArray(so.actions)) c.actions = so.actions as CompressedFlowResult["actions"];
			if (Array.isArray(so.commands)) c.commands = so.commands as CompressedFlowResult["commands"];
			if (Array.isArray(so.notDone)) c.notDone = so.notDone as CompressedFlowResult["notDone"];
			if (Array.isArray(so.nextSteps)) c.nextSteps = so.nextSteps as CompressedFlowResult["nextSteps"];
			if (Array.isArray(so.reasoning)) c.reasoning = so.reasoning as CompressedFlowResult["reasoning"];
			if (Array.isArray(so.notes)) c.notes = so.notes as CompressedFlowResult["notes"];
			if (typeof r.errorMessage === "string") c.error = r.errorMessage;
			compressed.push(c);
		}
		if (compressed.length > 0) {
			const existing = cache.get(toolCallId) ?? [];
			existing.push(...compressed);
			cache.set(toolCallId, existing);
		}
	}

	evictCacheOverflow(cache);
}

import {
	computeActiveTools,
	buildBeforeAgentStartPrompt,
} from "./steering/flow-prompt.js";

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const FlowItem = Type.Object({
	type: Type.String({
		description: "Flow type. Matching is case-insensitive. Must correspond to an available flow name such as scout, debug, build, craft, audit, or ideas.",
	}),
	intent: Type.String({
		description: "Specific mission for this flow — target concrete files, folders, or code patterns. Be precise in final outcome/expectation and common sense, but avoid over-specifying implementation details or assuming current state that may have shifted.",
	}),
	aim: Type.String({
		description: "Extreme short intent — one sentence, 5-7 words, headline-style summary of what this flow does.",
	}),
	acceptance: Type.Optional(
		Type.String({ description: "Short success criteria — one sentence stating what done looks like." }),
	),
	cwd: Type.Optional(
		Type.String({ description: "Working directory override for this flow." }),
	),
	sessionMode: Type.Optional(
		Type.Union([
			Type.Literal("snap"),
			Type.Literal("fast"),
			Type.Literal("default"),
			Type.Literal("long"),
			Type.Literal("extreme_long"),
		], {
			description: "Agent session budget for this flow: snap=90s, fast=300s, default=600s, long=900s, extreme_long=1200s. Use long or extreme_long only when the work genuinely needs the larger budget.",
		}),
	),
}, {
	title: "FlowTask",
	description: "A single flow task — must be a JSON object, NOT a string.",
});

const FlowParams = Type.Object({
	flow: Type.Array(FlowItem, {
		description:
			"Array of flow tasks to execute. Each runs in its own forked process. " +
			"Optional sessionMode selects the flow state budget: fast=300s, default=600s, long=900s, extreme_long=1200s.",
		examples: [
			{ type: "scout", intent: "Map auth module files and trace JWT validation path", aim: "Map auth and trace JWT" },
			{ type: "audit", intent: "Audit input validation and SQL injection risks in user routes", aim: "Audit user route security" },
		],
		minItems: 1,
	}),
	confirmProjectFlows: Type.Optional(
		Type.Boolean({
			description: "Whether to prompt the user before running project-local flows. Default: true.",
			default: true,
		}),
	),
});

const inheritedCliArgs = getInheritedCliArgs();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFlowDetailsFactory(projectFlowsDir: string | null) {
	return (results: SingleResult[]): FlowDetails => ({
		mode: "flow",
		flowStyle: "fork",
		projectAgentsDir: projectFlowsDir,
		results,
	});
}

// Re-export compressToolResults and stripBatchReadToolCalls for tests
export { compressToolResults, stripBatchReadToolCalls } from "./snapshot/snapshot.js";
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
		description: "Model for lite-tier flows (scout, debug).",
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
	pi.registerFlag("flow-session-mode", {
		description: "Default child-flow session mode: snap (90s), fast (300s), default (600s), long (900s), or extreme_long (1200s).",
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
	pi.registerFlag("no-strategic-hint", {
		description: "Disable strategic [Hint: ...] after tool results.",
		type: "boolean",
	});
	pi.registerFlag("no-animation", {
		description: "Disable all flow animation (instant render).",
		type: "boolean",
	});
	pi.registerFlag("no-glitch", {
		description: "Disable glitch/scramble effect.",
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
	pi.on("session_start", async (_event, ctx) => {
		sessionRegistry.register(ctx.cwd, ctx.sessionManager.getSessionId());
		_sessionCtx = ctx;
		resolved = resolveSettings(pi, ctx.cwd);

		// Reconstruct historical flow result cache so fork snapshots can compress
		// past flow results immediately (instead of showing placeholder text until
		// new flows complete). bashTracker is created fresh below — pending OS
		// processes are inherently lost across restarts, which is expected.
		reconstructFlowResultCache(ctx.sessionManager, flowResultCache);

		// Wire resolved settings to modules
		configureSteering({ enabled: resolved.steeringEnabled, customPrompt: resolved.steeringCustomPrompt });
		configureDirective(resolved.steeringStrategicHint);
		scrambleManager.setAnimationConfig({ enabled: resolved.animationEnabled, glitch: resolved.animationGlitch });

		// Only restrict tools for the main root state (depth 0).
		// Child flows (depth > 0) receive their tools via --tools CLI arg;
		// overriding them here would strip bash/batch from children.
		if (currentDepth === 0) {
			pi.setActiveTools(computeActiveTools(resolved.toolOptimize));
		}

		// Register tools based on depth.
		// Depth 0 (main root state): only batch_read — no bash ops, only reads + flow tool.
		// Depth > 0 (child flows): batch (with bash), batch_bash_poll — they need bash ops.
		// Children use batch for reads (which includes read ops), so batch_read is NOT
		// registered for depth > 0 to avoid confusion and keep the tool set minimal.
		// The bashProcessTracker is shared between the batch tool (launches bash ops)
		// and the batch_bash_poll tool (checks on pending bash ops).
		if (resolved.toolOptimize) {
			if (currentDepth === 0) {
				pi.registerTool(createBatchReadTool());
			} else {
				bashTracker = new BashProcessTracker();
				pi.registerTool(createBatchTool(bashTracker, resolved.toolOptimize));
				pi.registerTool(createBatchBashPollTool(bashTracker));
			}
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
	pi.on("session_shutdown", () => {
		flowResultCache.clear();
		_sessionCtx = undefined;
		// bashTracker and its pending OS processes are discarded on restart.
		// This is expected — child process state is not serializable.
		if (bashTracker) {
			try { bashTracker.abortAll(); } catch { /* best-effort */ }
			bashTracker = undefined;
		}
	});

	// Re-apply active tools every turn to survive registry refreshes.
	// Skip for child flows — they get tools from --tools CLI arg.
	pi.on("turn_start", () => {
		if (currentDepth > 0 || !resolved) return;
		pi.setActiveTools(computeActiveTools(resolved.toolOptimize));
		resetDirectiveTracker();
	});

	// Inject available flows into the system prompt.
	// Skip entirely for child flows (depth > 0) — they get their instructions
	// from the 4-part prompt structure in buildFlowArgs.
	pi.on("before_agent_start", async (event) => {
		if (currentDepth > 0 || !resolved) return undefined;

		const augmented = buildBeforeAgentStartPrompt(
			event,
			resolved.toolOptimize,
			canTransition,
			resolved.discoveredFlows,
			depthConfig,
		);

		if (augmented === undefined) return undefined;
		return { systemPrompt: augmented };
	});

	// Steering hint: insert as a separate system message immediately
	// before the latest user message each turn. The steering hint is never
	// part of the static systemPrompt — it is injected dynamically here only.
	// We strip any stray steering hint content from systemPrompt as a safety
	// net, then insert the fresh hint as a separate message.
	// Skipped for child flows (depth > 0) — they have explicit <mission> directives.
	pi.on("context", async (event) => {
		if (currentDepth > 0) return undefined;

		// Always strip old steering hint messages to prevent accumulation
		const { messages: steeringStrippedMessages, changed: steeringChanged } = stripSteeringHintsFromMessages(event.messages);
		// Also strip directive hints (adaptive hints appended to tool results)
		const { messages, changed: directiveChanged } = stripDirectivesFromMessages(steeringStrippedMessages);
		const messagesChanged = steeringChanged || directiveChanged;

		// Find latest user message
		const userIndices = messages
			.map((m: any, i: number) => (m.role === "user" ? i : -1))
			.filter((i: number) => i !== -1);

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
			if (messagesChanged) result.messages = messages;
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
		const hintMessage = makeSteeringHintMessage(messages[lastUserIndex]);
		const modified = hintMessage
			? [
					...messages.slice(0, lastUserIndex),
					hintMessage,
					...messages.slice(lastUserIndex),
				]
			: messages;

		const result: any = {};
		if (hintMessage || messagesChanged) result.messages = modified;
		if (systemPromptChanged) {
			result.systemPrompt = systemPrompt;
		}
		return result;
	});

	// Register the web tool
	pi.registerTool(createWebTool());

	// Register the ask_user tool
	pi.registerTool(createAskUserTool());

	// Register the flow tool
	if (canTransition) {
		pi.registerTool({
			name: "flow",
			label: "Flow",
			promptSnippet: "Transition to specialized agent flows running in isolated forked processes",
			promptGuidelines: [
				"Use `flow` when the task requires skills beyond your current context (scout, debug, build, craft, audit, ideas).",
				"Combine multiple related tasks into a single `flow` call with an array of flow items.",
				"Always provide a concrete intent, aim, and optional acceptance criteria.",
			],
			description: [
				"If you cannot answer from your current context, you are forbidden from guessing.",
				"You MUST enter to the following flow states, with tool call method.",
				"",
				"Flow states are isolated π processes with forked session snapshots. They run in parallel.",
				'Invoke: { "flow": [{ "type": "scout", "intent": "...", "aim": "...", "sessionMode": "default" }, ...] }',
				"Session modes: fast=300s, default=600s, long=900s, extreme_long=1200s. Use long or extreme_long only when the work genuinely needs the larger budget.",
				"States: scout, debug, build, craft, audit, ideas.",
				"Custom states configs in (create if not exists): .md files in .pi/agents/ or ~/.pi/agent/agents/.",
			].join("\n"),
			parameters: FlowParams,

			async execute(toolCallId, params, signal, onUpdate, ctx) {
				if (!resolved) {
					throw new Error("Error: session not initialized");
				}

				const discovery = discoverFlows(ctx.cwd, "all");
				const { flows } = discovery;
				const makeDetails = makeFlowDetailsFactory(discovery.projectFlowsDir);

				// Build the full fork session snapshot and sanitize only non-inheritable
				// artifacts before passing it to child flows.
				// Uses the persistent module-level cache so historical flow results
				// are properly compressed (not passed through verbatim).
				const { result: forkSessionSnapshotJsonl, stats: forkSessionSnapshotStats } = sanitizeForkSnapshot(
					buildForkSessionSnapshotJsonl(ctx.sessionManager),
					flowResultCache,
					{
						forkedFrom: ctx.sessionManager.getSessionId(),
						forkedAt: new Date().toISOString(),
						depth: currentDepth + 1,
						...(ancestorFlowStack.length > 0 ? { parentFlow: ancestorFlowStack[ancestorFlowStack.length - 1] } : {}),
					},
				);

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
				} : undefined;

				const result = await executeFlows(
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

						defaultSessionMode: resolved.defaultSessionMode,
						signal,
						onUpdate,
						makeDetails,
						getFlag: (name: string) => name === "flow-mode" ? resolved!.activeRuntimeFlowMode : pi.getFlag(name),
						tierOverrideResolver: getTierOverride,
						fallbackModel: inheritedCliArgs.fallbackModel,
						forkSessionSnapshotJsonl,
						forkSessionSnapshotStats,
						flowResultCache,
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
					params.flow.map((f: any) => ({ type: f.type, intent: f.intent, aim: f.aim, acceptance: f.acceptance, cwd: f.cwd, sessionMode: f.sessionMode })),
					toolCallId,
				);

				if (result.failed) {
					const text = result.content?.[0]?.text ?? "Flow execution failed";
					throw new Error(text);
				}

				const flowToolResult = {
					content: result.content,
					details: result.details,
					failed: result.failed,
					_toolCallId: toolCallId,
				} as any;
				// Build adaptive directive context from flow results
				const hintContext: FlowHintContext = { hasNotDone: false, statusVague: false };
				if (result.details?.results && Array.isArray(result.details.results)) {
					for (const r of result.details.results) {
						if (r.structuredOutput?.notDone?.length) {
							hintContext.hasNotDone = true;
						}
						if (!r.structuredOutput || !["complete", "partial", "blocked"].includes(r.structuredOutput.status)) {
							hintContext.statusVague = true;
						}
					}
				}
				appendDirectiveOnce(flowToolResult, hintContext);
				return flowToolResult;
			},

			renderCall: (args, theme) => renderFlowCall(args, theme),
			renderResult: (result, { expanded }, theme, args) =>
				renderFlowResult(result, expanded, theme, args),
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
					steeringStrategicHint: resolved.steeringStrategicHint,
					animationEnabled: resolved.animationEnabled,
					animationGlitch: resolved.animationGlitch,
				}
			: {
					toolOptimize: true,
					structuredOutput: true,
					maxConcurrency: 4,
					steeringEnabled: true,
					steeringCustomPrompt: undefined,
					steeringStrategicHint: true,
					animationEnabled: true,
					animationGlitch: true,
				},
	};

	if (typeof pi.emit === "function") {
		pi.emit("pi-agent-flow:ready", pluginApi);
	}

	// Register cleanup on process exit (once).
	// We use prependListener on SIGINT/SIGTERM to propagate to child processes
	// before the host's own signal handler runs. This avoids orphaned flow states.
	// The host handler still runs afterward and handles terminal cleanup.
	if (!(globalThis as any).__pi_agent_flow_shutdown_registered) {
		(globalThis as any).__pi_agent_flow_shutdown_registered = true;

		// Propagate signals to child process groups so flow states don't become orphans.
		// We use prependListener so our handler runs first, before the host's cleanup.
		const shutdown = () => {
			// First, abort any pending bash operations tracked by the batch tool.
			if (bashTracker) {
				try { bashTracker.abortAll(); } catch { /* best-effort */ }
			}
			terminateAllChildGroups();
			shutdownWakeup();
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
