/**
 * Pi Flow Extension (fork-only)
 *
 * Delegates tasks to specialized flow states running as isolated pi processes.
 * Each flow receives a forked snapshot of the current session context.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { setupNotify } from "./notify.js";
import { discoverFlows, getFlowTier } from "./agents.js";
import { getInheritedCliArgs } from "./cli-args.js";
import { renderFlowCall, renderFlowResult } from "./render.js";
import { terminateAllChildGroups } from "./flow.js";
import { executeFlows } from "./executor.js";
import { appendStrategicHint } from "./tool-utils.js";
import {
	type SingleResult,
	type FlowDetails,
	type CompressedFlowResult,
	type PiAgentFlowAPI,
} from "./types.js";
import { createBatchTool, createBatchReadTool, BashProcessTracker, createBatchBashPollTool } from "./batch.js";
import { createWebTool } from "./web-tool.js";
import { createAskUserTool } from "./ask-user.js";
import {
	stripSlidingPromptText,
	stripSlidingPromptsFromMessages,
	makeSlidingPromptMessage,
} from "./sliding-prompt.js";
import { createTimedBashToolDefinition } from "./timed-bash.js";
import {
	resolveFlowDepthConfig,
	type FlowDepthConfig,
} from "./depth.js";
import {
	buildForkSessionSnapshotJsonl,
	sanitizeForkSnapshot,
} from "./snapshot.js";
import {
	resolveSettings,
	type ResolvedSettings,
} from "./settings-resolver.js";
import {
	computeActiveTools,
	buildBeforeAgentStartPrompt,
} from "./flow-prompt.js";

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const FlowItem = Type.Object({
	type: Type.String({
		description: "Flow type. Matching is case-insensitive. Must correspond to an available flow name such as scout, debug, build, craft, audit, or ideas.",
	}),
	intent: Type.String({
		description: "Clear, specific mission for this flow.",
	}),
	aim: Type.String({
		description: "Extreme short intent — one sentence, 5-7 words, headline-style summary of what this flow does.",
	}),
	cwd: Type.Optional(
		Type.String({ description: "Working directory override for this flow." }),
	),
	sessionMode: Type.Optional(
		Type.Union([
			Type.Literal("fast"),
			Type.Literal("default"),
			Type.Literal("long"),
			Type.Literal("extreme_long"),
		], {
			description: "Agent session budget for this flow: fast=300s, default=600s, long=900s, extreme_long=1200s. Use long or extreme_long only when the work genuinely needs the larger budget.",
		}),
	),
});

const FlowParams = Type.Object({
	flow: Type.Array(FlowItem, {
		description:
			"Array of flow tasks to execute. Each runs in its own forked process. " +
			"Optional sessionMode selects the child-agent budget: fast=300s, default=600s, long=900s, extreme_long=1200s. " +
			'Example: { flow: [{ type: "scout", "intent": "Find all authentication-related code and trace JWT validation", "aim": "Find auth code and trace JWT", "sessionMode": "fast" }, { type: "build", "intent": "Fix the bug in user registration", "aim": "Fix registration bug", "sessionMode": "long" }] }',
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
		delegationMode: "fork",
		projectAgentsDir: projectFlowsDir,
		results,
	});
}

// Re-export compressToolResults and compressFlowToolResults for tests
export { compressToolResults, compressFlowToolResults, stripBatchReadToolCalls } from "./snapshot.js";

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerFlag("flow-max-depth", {
		description: "Maximum allowed flow delegation depth (default: 3).",
		type: "string",
	});
	pi.registerFlag("flow-prevent-cycles", {
		description: "Block delegating to flows already in the current delegation stack (default: true).",
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
		description: "Default child-flow session mode: fast (300s), default (600s), or long (900s).",
		type: "string",
	});

	pi.registerFlag("tool-optimize", {
		description: "Use the unified batch tool instead of separate read/write/edit tools (default: true).",
		type: "boolean",
	});

	// Wire up bundled notification channel
	setupNotify(pi);

	const depthConfig = resolveFlowDepthConfig(pi);
	const { currentDepth, maxDepth, canDelegate, ancestorFlowStack, preventCycles } =
		depthConfig;

	let resolved: ResolvedSettings | undefined;
	let bashTracker: BashProcessTracker | undefined;

	// Auto-discover flows on session start
	pi.on("session_start", async (_event, ctx) => {
		resolved = resolveSettings(pi, ctx.cwd);

		// Only restrict tools for the main orchestrator (depth 0).
		// Child flows (depth > 0) receive their tools via --tools CLI arg;
		// overriding them here would strip bash/batch from children.
		if (currentDepth === 0) {
			pi.setActiveTools(computeActiveTools(resolved.toolOptimize));
		}

		// Register tools based on depth.
		// Depth 0 (main orchestrator): only batch_read — no bash ops, only reads + flow delegation.
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
				pi.registerTool(createBatchTool(bashTracker));
				pi.registerTool(createBatchBashPollTool(bashTracker));
			}
		}

		// Override built-in bash with timed wrapper so the LLM sees execution-time classification.
		// Only register for child flows — main agent should delegate all bash ops to flows.
		if (currentDepth > 0) {
			const timedBash = createTimedBashToolDefinition(ctx.cwd);
			if (timedBash) {
				pi.registerTool(timedBash);
			}
		}
	});

	// Re-apply active tools every turn to survive registry refreshes.
	// Skip for child flows — they get tools from --tools CLI arg.
	pi.on("turn_start", () => {
		if (currentDepth > 0 || !resolved) return;
		pi.setActiveTools(computeActiveTools(resolved.toolOptimize));
	});

	// Inject available flows into the system prompt.
	// Skip entirely for child flows (depth > 0) — they get their instructions
	// from the 4-part prompt structure in buildFlowArgs.
	pi.on("before_agent_start", async (event) => {
		if (currentDepth > 0 || !resolved) return undefined;

		const augmented = buildBeforeAgentStartPrompt(
			event,
			resolved.toolOptimize,
			canDelegate,
			resolved.discoveredFlows,
			depthConfig,
		);

		if (augmented === undefined) return undefined;
		return { systemPrompt: augmented };
	});

	// Sliding system prompt: insert as a separate system message immediately
	// before the latest user message each turn. Strips from the static
	// systemPrompt to avoid duplication, then inserts separately.
	// Skipped for child flows (depth > 0) — they have explicit <mission> directives.
	pi.on("context", async (event) => {
		if (currentDepth > 0) return undefined;

		// Always strip old sliding prompt messages to prevent accumulation
		const { messages, changed: messagesChanged } = stripSlidingPromptsFromMessages(event.messages);

		// Find latest user message
		const userIndices = messages
			.map((m: any, i: number) => (m.role === "user" ? i : -1))
			.filter((i: number) => i !== -1);

		if (userIndices.length === 0) {
			// No user message yet: keep sliding prompt in the static system prompt only.
			return messagesChanged ? { messages } : undefined;
		}

		// Strip sliding from the static systemPrompt so it only appears once,
		// as a separate message right before the latest user message.
		let systemPrompt = event.systemPrompt;
		let systemPromptChanged = false;
		if (typeof systemPrompt === "string") {
			const stripped = stripSlidingPromptText(systemPrompt);
			if (stripped !== systemPrompt) {
				systemPrompt = stripped;
				systemPromptChanged = true;
			}
		}

		const lastUserIndex = userIndices[userIndices.length - 1];
		const modified = [
			...messages.slice(0, lastUserIndex),
			makeSlidingPromptMessage(messages[lastUserIndex]),
			...messages.slice(lastUserIndex),
		];

		const result: any = { messages: modified };
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
	if (canDelegate) {
		pi.registerTool({
			name: "flow",
			label: "Flow",
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
					return {
						content: [{ type: "text", text: "Error: session not initialized" }],
						details: makeFlowDetailsFactory(null)([]),
						isError: true,
					};
				}

				const discovery = discoverFlows(ctx.cwd, "all");
				const { flows } = discovery;
				const makeDetails = makeFlowDetailsFactory(discovery.projectFlowsDir);

				// Build the full fork session snapshot and sanitize only non-inheritable
				// artifacts before passing it to child flows.
				const flowResultCache = new Map<string, CompressedFlowResult[]>();
				const forkSessionSnapshotJsonl = sanitizeForkSnapshot(
					buildForkSessionSnapshotJsonl(ctx.sessionManager),
					flowResultCache,
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
						flowResultCache,
						projectFlowsDir: discovery.projectFlowsDir,
						sessionManager: ctx.sessionManager,
						hasUI: ctx.hasUI,
						uiConfirm: (title, body) => ctx.ui.confirm(title, body),
						onFlowMetrics: (metrics) => { if (typeof pi.emit === "function") pi.emit("pi-agent-flow:complete", metrics); },
						confirmProjectFlows: params.confirmProjectFlows,
					},
					params.flow.map((f: any) => ({ type: f.type, intent: f.intent, aim: f.aim, cwd: f.cwd, sessionMode: f.sessionMode })),
					toolCallId,
				);

				const flowToolResult = {
					content: result.content,
					details: result.details,
					isError: result.isError,
				};
				appendStrategicHint(flowToolResult);
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
			? { toolOptimize: resolved.toolOptimize, structuredOutput: resolved.structuredOutput, maxConcurrency: resolved.maxConcurrency }
			: { toolOptimize: true, structuredOutput: true, maxConcurrency: 4 },
	};

	if (typeof pi.emit === "function") {
		pi.emit("pi-agent-flow:ready", pluginApi);
	}

	// Register cleanup on process exit (once).
	// We use prependListener on SIGINT/SIGTERM to propagate to child processes
	// before the host's own signal handler runs. This avoids orphaned sub-agents.
	// The host handler still runs afterward and handles terminal cleanup.
	if (!(globalThis as any).__pi_agent_flow_shutdown_registered) {
		(globalThis as any).__pi_agent_flow_shutdown_registered = true;

		// Propagate signals to child process groups so sub-agents don't become orphans.
		// We use prependListener so our handler runs first, before the host's cleanup.
		const shutdown = () => {
			// First, abort any pending bash operations tracked by the batch tool.
			if (bashTracker) {
				try { bashTracker.abortAll(); } catch { /* best-effort */ }
			}
			terminateAllChildGroups();
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
