/**
 * Pi Flow Extension (fork-only)
 *
 * Delegates tasks to specialized flow states running as isolated pi processes.
 * Each flow receives a forked snapshot of the current session context.
 */

import * as os from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type FlowConfig, discoverFlows, getFlowTier } from "./agents.js";
import {
	loadFlowModelConfigs,
	loadFlowSettings,
	loadProjectFlowModelConfigName,
	normalizeFlowModeName,
	resolveFlowModelCandidates,
	selectFlowModelStrategy,
	writeGlobalFlowMode,
	formatFlowModelStrategy,
	type LoadedFlowModelConfigs,
} from "./config.js";
import { getInheritedCliArgs } from "./cli-args.js";
import { renderFlowCall, renderFlowResult } from "./render.js";
import { getFlowSummaryText } from "./runner-events.js";
import { runHooks, runHooksDetailed, getRegisteredHooks, registerHook, unregisterHook } from "./hooks.js";
import { mapFlowConcurrent, runFlow, terminateAllChildGroups } from "./flow.js";
import { executeFlows } from "./executor.js";
import {
	type SingleResult,
	type FlowDetails,
	type CompressedFlowResult,
	type FlowMetrics,
	type FileEntry,
	type CommandEntry,
	type AutoTransition,
	type PiAgentFlowAPI,
	emptyFlowUsage,
	isFlowError,
	isFlowSuccess,
	getFlowOutput,
} from "./types.js";
import { extractStructuredOutput } from "./structured-output.js";
import { createBatchTool, createBatchReadTool, BashProcessTracker, createBatchBashPollTool } from "./batch.js";
import {
	createWebTool,
	looksLikeUrlPrompt,
	looksLikeWebSearchPrompt,
} from "./web-tool.js";
import {
	SLIDING_PROMPT,
	SLIDING_PROMPT_OPEN_TAG,
	stripSlidingPromptText,
	stripSlidingPromptFromContent,
	contentContainsSlidingTag,
	isJsonEqual,
	stripSlidingPromptsFromMessages,
	makeSlidingPromptMessage,
} from "./sliding-prompt.js";
import { DEFAULT_TRANSITIONS, buildTransitionHooks } from "./transitions.js";
import { createTimedBashToolDefinition } from "./timed-bash.js";
import {
	DEFAULT_AGENT_SESSION_MODE,
	PI_FLOW_SESSION_MODE_ENV,
	parseAgentSessionMode,
	type AgentSessionMode,
} from "./session-mode.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DELEGATION_DEPTH = 3;
const DEFAULT_PREVENT_CYCLE_DELEGATION = true;
const FLOW_DEPTH_ENV = "PI_FLOW_DEPTH";
const FLOW_MAX_DEPTH_ENV = "PI_FLOW_MAX_DEPTH";
const FLOW_STACK_ENV = "PI_FLOW_STACK";
const FLOW_PREVENT_CYCLES_ENV = "PI_FLOW_PREVENT_CYCLES";
export const FLOW_TOOL_OPTIMIZE_ENV = "PI_FLOW_TOOL_OPTIMIZE";

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

interface FlowDepthConfig {
	currentDepth: number;
	maxDepth: number;
	canDelegate: boolean;
	ancestorFlowStack: string[];
	preventCycles: boolean;
}

interface SessionSnapshotSource {
	getHeader: () => unknown;
	getBranch: () => unknown[];
}

function buildForkSessionSnapshotJsonl(
	sessionManager: SessionSnapshotSource,
): string | null {
	const header = sessionManager.getHeader();
	if (!header || typeof header !== "object") return null;

	const branchEntries = sessionManager.getBranch();
	const lines = [JSON.stringify(header)];
	for (const entry of branchEntries) lines.push(JSON.stringify(entry));
	return `${lines.join("\n")}\n`;
}

function parseNonNegativeInt(raw: unknown): number | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const parsed = Number(trimmed);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseBoolean(raw: unknown): boolean | null {
	if (typeof raw === "boolean") return raw;
	if (typeof raw !== "string") return null;
	const normalized = raw.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return null;
}

function parseFlowStack(raw: unknown): string[] | null {
	if (raw === undefined) return [];
	if (typeof raw !== "string") return null;
	if (!raw.trim()) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	if (!Array.isArray(parsed)) return null;
	if (!parsed.every((value) => typeof value === "string")) return null;
	return parsed
		.map((value) => value.trim().toLowerCase())
		.filter((value) => value.length > 0);
}

function getMaxDepthFlagFromArgv(argv: string[]): string | null {
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--flow-max-depth") {
			return argv[i + 1] ?? "";
		}
		if (arg.startsWith("--flow-max-depth=")) {
			return arg.slice("--flow-max-depth=".length);
		}
	}
	return null;
}

function getPreventCyclesFlagFromArgv(
	argv: string[],
): string | boolean | null {
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--flow-prevent-cycles") {
			const maybeValue = argv[i + 1];
			if (maybeValue !== undefined && !maybeValue.startsWith("--")) {
				return maybeValue;
			}
			return true;
		}
		if (arg === "--no-flow-prevent-cycles") return false;
		if (arg.startsWith("--flow-prevent-cycles=")) {
			return arg.slice("--flow-prevent-cycles=".length);
		}
	}
	return null;
}

function resolveFlowDepthConfig(pi: ExtensionAPI): FlowDepthConfig {
	const depthRaw = process.env[FLOW_DEPTH_ENV];
	const parsedDepth = parseNonNegativeInt(depthRaw);
	if (depthRaw !== undefined && parsedDepth === null) {
		console.warn(
			`[pi-agent-flow] Ignoring invalid ${FLOW_DEPTH_ENV}="${depthRaw}". Expected a non-negative integer.`,
		);
	}
	const currentDepth = parsedDepth ?? 0;

	const stackRaw = process.env[FLOW_STACK_ENV];
	const ancestorFlowStack = parseFlowStack(stackRaw);
	if (stackRaw !== undefined && ancestorFlowStack === null) {
		console.warn(
			`[pi-agent-flow] Ignoring invalid ${FLOW_STACK_ENV} value. Expected a JSON array of flow names.`,
		);
	}

	const envMaxDepthRaw = process.env[FLOW_MAX_DEPTH_ENV];
	const envMaxDepth = parseNonNegativeInt(envMaxDepthRaw);
	if (envMaxDepthRaw !== undefined && envMaxDepth === null) {
		console.warn(
			`[pi-agent-flow] Ignoring invalid ${FLOW_MAX_DEPTH_ENV}="${envMaxDepthRaw}". Expected a non-negative integer.`,
		);
	}

	const argvFlagRaw = getMaxDepthFlagFromArgv(process.argv);
	const argvFlagMaxDepth =
		argvFlagRaw !== null ? parseNonNegativeInt(argvFlagRaw) : null;
	if (argvFlagRaw !== null && argvFlagMaxDepth === null) {
		console.warn(
			`[pi-agent-flow] Ignoring invalid --flow-max-depth value "${argvFlagRaw}". Expected a non-negative integer.`,
		);
	}

	const runtimeFlagValue = pi.getFlag("flow-max-depth");
	const runtimeFlagMaxDepth =
		typeof runtimeFlagValue === "string"
			? parseNonNegativeInt(runtimeFlagValue)
			: null;
	if (
		argvFlagRaw === null &&
		typeof runtimeFlagValue === "string" &&
		runtimeFlagMaxDepth === null
	) {
		console.warn(
			`[pi-agent-flow] Ignoring invalid --flow-max-depth value "${runtimeFlagValue}". Expected a non-negative integer.`,
		);
	}

	const envPreventCyclesRaw = process.env[FLOW_PREVENT_CYCLES_ENV];
	const envPreventCycles = parseBoolean(envPreventCyclesRaw);
	if (envPreventCyclesRaw !== undefined && envPreventCycles === null) {
		console.warn(
			`[pi-agent-flow] Ignoring invalid ${FLOW_PREVENT_CYCLES_ENV}="${envPreventCyclesRaw}". Expected true/false.`,
		);
	}

	const argvPreventCyclesRaw = getPreventCyclesFlagFromArgv(process.argv);
	const argvPreventCycles =
		typeof argvPreventCyclesRaw === "boolean"
			? argvPreventCyclesRaw
			: parseBoolean(argvPreventCyclesRaw);
	if (
		typeof argvPreventCyclesRaw === "string" &&
		argvPreventCycles === null
	) {
		console.warn(
			`[pi-agent-flow] Ignoring invalid --flow-prevent-cycles value "${argvPreventCyclesRaw}". Expected true/false.`,
		);
	}

	const runtimePreventCyclesRaw = pi.getFlag("flow-prevent-cycles");
	const runtimePreventCycles = parseBoolean(runtimePreventCyclesRaw);
	if (
		argvPreventCyclesRaw === null &&
		runtimePreventCyclesRaw !== undefined &&
		runtimePreventCycles === null
	) {
		console.warn(
			`[pi-agent-flow] Ignoring invalid --flow-prevent-cycles value "${String(runtimePreventCyclesRaw)}". Expected true/false.`,
		);
	}

	const flagMaxDepth = argvFlagMaxDepth ?? runtimeFlagMaxDepth;
	const maxDepth = flagMaxDepth ?? envMaxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH;
	const preventCycles =
		argvPreventCycles ??
		runtimePreventCycles ??
		envPreventCycles ??
		DEFAULT_PREVENT_CYCLE_DELEGATION;

	return {
		currentDepth,
		maxDepth,
		canDelegate: currentDepth < maxDepth,
		ancestorFlowStack: ancestorFlowStack ?? [],
		preventCycles,
	};
}

function makeFlowDetailsFactory(projectFlowsDir: string | null) {
	return (results: SingleResult[]): FlowDetails => ({
		mode: "flow",
		delegationMode: "fork",
		projectAgentsDir: projectFlowsDir,
		results,
	});
}

function getFlowCycleViolations(
	requestedNames: Set<string>,
	ancestorFlowStack: string[],
): string[] {
	if (requestedNames.size === 0 || ancestorFlowStack.length === 0) return [];
	const stackSet = new Set(ancestorFlowStack);
	return Array.from(requestedNames).filter((name) => stackSet.has(name));
}

/** Get project-local flows referenced by the current request. */
function getRequestedProjectFlows(
	flows: FlowConfig[],
	requestedNames: Set<string>,
): FlowConfig[] {
	return Array.from(requestedNames)
		.map((name) => flows.find((f) => f.name === name.toLowerCase()))
		.filter((f): f is FlowConfig => f?.source === "project");
}

/**
 * Prompt the user to confirm project-local flows if needed.
 * Returns false if the user declines.
 */
async function confirmProjectFlowsIfNeeded(
	projectFlows: FlowConfig[],
	projectFlowsDir: string | null,
	ctx: { ui: { confirm: (title: string, body: string) => Promise<boolean> } },
): Promise<boolean> {
	if (projectFlows.length === 0) return true;

	const names = projectFlows.map((f) => f.name).join(", ");
	const dir = projectFlowsDir ?? "(unknown)";
	return ctx.ui.confirm(
		"Run project-local flows?",
		`Flows: ${names}\nSource: ${dir}\n\nProject flows are repo-controlled. Only continue for trusted repositories.`,
	);
}

// ---------------------------------------------------------------------------
// Sliding system prompt (short, inserted before latest user message)
// Always active for root flows. Appended to the static system prompt in
// before_agent_start, and inserted as a separate system message immediately
// before the latest user message by the context handler.
// ---------------------------------------------------------------------------

// SLIDING_PROMPT, SLIDING_PROMPT_OPEN_TAG imported from ./sliding-prompt.js

const REASONING_PART_TYPES = new Set([
	"thinking",
	"reasoning",
	"reasoning_content",
	"reasoningContent",
]);

const REASONING_FIELDS = [
	"thinking",
	"thinkingSignature",
	"thinking_signature",
	"reasoning",
	"reasoningContent",
	"reasoning_content",
	"reasoningSignature",
	"reasoning_signature",
];

function stripReasoningFromAssistantMessage(message: any): {
	message: any;
	changed: boolean;
} {
	let next = message;
	let changed = false;

	for (const field of REASONING_FIELDS) {
		if (field in next) {
			if (next === message) next = { ...message };
			delete next[field];
			changed = true;
		}
	}

	if (Array.isArray(message.content)) {
		const filteredContent = message.content.filter(
			(part: any) => !REASONING_PART_TYPES.has(part?.type),
		);
		if (filteredContent.length !== message.content.length) {
			if (next === message) next = { ...message };
			next.content = filteredContent;
			changed = true;
		}
	}

	return { message: next, changed };
}

// ---------------------------------------------------------------------------
// Flow result compression
// ---------------------------------------------------------------------------

/**
 * Build compressed representations of flow results and cache them by toolCallId.
 */
function cacheFlowResults(
	cache: Map<string, CompressedFlowResult[]>,
	toolCallId: string,
	results: SingleResult[],
): void {
	for (const result of results) {
		const so = result.structuredOutput;
		if (!so) continue;
		const compressed: CompressedFlowResult = {
			type: result.type,
			status: isFlowError(result) ? "failed" : "accomplished",
		};
		if (so.files.length > 0) compressed.files = so.files;
		if (so.commands.length > 0) compressed.commands = so.commands;
		if (result.errorMessage) compressed.error = result.errorMessage;
		const existing = cache.get(toolCallId) ?? [];
		existing.push(compressed);
		cache.set(toolCallId, existing);
	}
}

/**
 * Render a compressed flow result as compact text for child context.
 */
function renderCompressedFlowResult(r: CompressedFlowResult): string {
	const parts: string[] = [`[Flow: ${r.type} ${r.status}]`];
	if (r.files?.length) {
		const fileLines = r.files.map((f) => {
			const role = f.role ? ` (${f.role})` : "";
			const desc = f.description ? ` — ${f.description}` : "";
			return `  ${f.path}${role}${desc}`;
		});
		parts.push(`Files:\n${fileLines.join("\n")}`);
	}
	if (r.commands?.length) {
		const cmdLines = r.commands.map((c) => `  ${c.tool ?? "cmd"}: ${c.command}`);
		parts.push(`Commands:\n${cmdLines.join("\n")}`);
	}
	if (r.error) parts.push(`Error: ${r.error}`);
	return parts.join("\n");
}

/**
 * Compress flow tool results in a sanitized session snapshot.
 *
 * Scans for tool result messages that correspond to flow invocations
 * and replaces their content with compact compressed output.
 */
export function compressFlowToolResults(snapshot: string, cache: Map<string, CompressedFlowResult[]>): string {
	if (cache.size === 0) return snapshot;

	const lines = snapshot.trimEnd().split("\n");
	const result: string[] = [];

	// First pass: map toolCallId → tool name from assistant messages
	const toolCallIdToName = new Map<string, string>();
	for (const line of lines) {
		let entry: any;
		try { entry = JSON.parse(line); } catch { continue; }
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part.type === "toolCall" && part.toolCallId && part.name) {
				toolCallIdToName.set(part.toolCallId, part.name);
			}
		}
	}

	// Second pass: compress flow tool results
	for (const line of lines) {
		let entry: any;
		try { entry = JSON.parse(line); } catch { result.push(line); continue; }

		if (entry?.type !== "message" || entry.message?.role !== "tool") {
			result.push(line);
			continue;
		}

		// Extract toolCallId — either from message-level or content-level toolResult
		let toolCallId: string | undefined;
		if (typeof entry.message.toolCallId === "string") {
			toolCallId = entry.message.toolCallId;
		} else if (Array.isArray(entry.message.content)) {
			for (const part of entry.message.content) {
				if (part.type === "toolResult" && part.toolCallId) {
					toolCallId = part.toolCallId;
					break;
				}
			}
		}

		if (!toolCallId) { result.push(line); continue; }

		const toolName = toolCallIdToName.get(toolCallId);
		if (toolName !== "flow") { result.push(line); continue; }

		const compressed = cache.get(toolCallId);
		if (!compressed || compressed.length === 0) { result.push(line); continue; }

		const rendered = compressed.map(renderCompressedFlowResult).join("\n\n");

		// Replace content in the tool result message
		if (typeof entry.message.toolCallId === "string") {
			// Format 1: toolCallId at message level, content is text array
			entry = {
				...entry,
				message: {
					...entry.message,
					content: [{ type: "text", text: rendered }],
				},
			};
		} else {
			// Format 2: toolCallId inside content array
			entry = {
				...entry,
				message: {
					...entry.message,
					content: entry.message.content.map((part: any) =>
						part.type === "toolResult" && part.toolCallId === toolCallId
							? { ...part, content: rendered }
							: part,
					),
				},
			};
		}

		result.push(JSON.stringify(entry));
	}

	return `${result.join("\n")}\n`;
}

/**
 * Sanitize a fork session snapshot JSONL to remove only non-inheritable
 * artifacts before passing full parent context to child flows: sliding system
 * prompts, legacy reminders, and assistant reasoning/thinking.
 */
function sanitizeForkSnapshot(snapshot: string | null, cache: Map<string, CompressedFlowResult[]> = new Map()): string | null {
	if (!snapshot) return snapshot;

	const lines = snapshot.trimEnd().split("\n");
	const sanitizedLines: string[] = [];

	for (const line of lines) {
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			sanitizedLines.push(line);
			continue;
		}

		let changed = false;

		// Drop sliding system prompt messages entirely.
		if (
			entry?.type === "message" &&
			entry.message?.role === "system" &&
			contentContainsSlidingTag(entry.message?.content)
		) {
			continue;
		}

		if (entry?.type === "message" && entry.message) {
			let message = entry.message;

			if (message.role === "assistant") {
				const stripped = stripReasoningFromAssistantMessage(message);
				message = stripped.message;
				changed ||= stripped.changed;
			}

			if ("content" in message) {
				const originalContent = message.content;
				const strippedContent = stripSlidingPromptFromContent(originalContent);

				if (!isJsonEqual(strippedContent, originalContent)) {
					message = {
						...message,
						content: strippedContent,
					};
					changed = true;
				}
			}

			if (changed) {
				entry = { ...entry, message };
			}
		}

		sanitizedLines.push(changed ? JSON.stringify(entry) : line);
	}

	const sanitized = `${sanitizedLines.join("\n")}\n`;
	return compressFlowToolResults(sanitized, cache);
}

function computeActiveTools(optimize: boolean): string[] {
	return optimize
		? ["batch_read", "batch_bash_poll", "flow"]
		: ["read", "write", "edit", "batch", "bash", "flow", "web"];
}

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
	pi.registerFlag("auto-transition", {
		description: "Automatically queue follow-up flows based on hook transitions (default: false).",
		type: "boolean",
	});
	pi.registerFlag("tool-optimize", {
		description: "Use the unified batch tool instead of separate read/write/edit tools (default: true).",
		type: "boolean",
	});

	const depthConfig = resolveFlowDepthConfig(pi);
	const { currentDepth, maxDepth, canDelegate, ancestorFlowStack, preventCycles } =
		depthConfig;

	// toolOptimize: CLI flag > env var > settings.json > default (true)
	let toolOptimize = true;
	// structuredOutput: settings.json > default (true)
	let structuredOutput = true;
	let maxConcurrency = 4;
	let autoTransition = false;
	let defaultSessionMode: AgentSessionMode = DEFAULT_AGENT_SESSION_MODE;
	const envToolOptimize = process.env[FLOW_TOOL_OPTIMIZE_ENV];
	if (envToolOptimize !== undefined) {
		const parsed = parseBoolean(envToolOptimize);
		if (parsed !== null) toolOptimize = parsed;
	}

	let discoveredFlows: FlowConfig[] = [];
	let loadedFlowModelConfigs: LoadedFlowModelConfigs = {
		selectedName: "default",
		configs: { default: {} },
		strategy: {},
	};
	let activeRuntimeFlowMode: string | undefined;

	// Auto-discover flows on session start
	pi.on("session_start", async (_event, ctx) => {
		const discovery = discoverFlows(ctx.cwd, "all");
		discoveredFlows = discovery.flows;
		loadedFlowModelConfigs = loadFlowModelConfigs(ctx.cwd);
		activeRuntimeFlowMode = undefined;

		const requestedFlowMode = normalizeFlowModeName(pi.getFlag("flow-mode"));
		if (requestedFlowMode !== undefined) {
			if (!Object.prototype.hasOwnProperty.call(loadedFlowModelConfigs.configs, requestedFlowMode)) {
				const availableModes = Object.keys(loadedFlowModelConfigs.configs).sort().join(", ") || "(none)";
				console.warn(
					`[pi-agent-flow] Cannot switch flow mode to "${requestedFlowMode}"; no flowModelConfigs.${requestedFlowMode} strategy was found. Available modes: ${availableModes}.`,
				);
			} else {
				try {
					writeGlobalFlowMode(requestedFlowMode);
					const strategy = loadedFlowModelConfigs.configs[requestedFlowMode] ?? {};
					const strategyDescription = formatFlowModelStrategy(requestedFlowMode, strategy);
					console.warn(strategyDescription);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					console.warn(`[pi-agent-flow] ${message}`);
				}

				const projectFlowModelConfig = loadProjectFlowModelConfigName(ctx.cwd);
				if (projectFlowModelConfig !== undefined && projectFlowModelConfig !== requestedFlowMode) {
					console.warn(
						`[pi-agent-flow] Switched global flow mode to "${requestedFlowMode}"; this project selects "${projectFlowModelConfig}" in .pi/settings.json, so future runs in this project may still use "${projectFlowModelConfig}" unless project settings are changed.`,
					);
				}

				activeRuntimeFlowMode = requestedFlowMode;
				loadedFlowModelConfigs = selectFlowModelStrategy(loadedFlowModelConfigs.configs, requestedFlowMode);
			}
		}

		// Register declarative transition hooks from the transition matrix
		for (const hook of buildTransitionHooks(DEFAULT_TRANSITIONS)) {
			registerHook(hook);
		}

		const flowSettings = loadFlowSettings(ctx.cwd);
		if (typeof flowSettings.structuredOutput === "boolean") {
			structuredOutput = flowSettings.structuredOutput;
		}
		if (typeof flowSettings.maxConcurrency === "number") {
			maxConcurrency = flowSettings.maxConcurrency;
		}
		if (typeof flowSettings.autoTransition === "boolean") {
			autoTransition = flowSettings.autoTransition;
		}

		// Resolve toolOptimize: CLI flag > env var > settings.json > default
		const cliFlag = pi.getFlag("tool-optimize");
		if (typeof flowSettings.toolOptimize === "boolean") {
			toolOptimize = flowSettings.toolOptimize;
		}
		if (envToolOptimize !== undefined) {
			const parsed = parseBoolean(envToolOptimize);
			if (parsed !== null) toolOptimize = parsed;
		}
		if (typeof cliFlag === "boolean") {
			toolOptimize = cliFlag;
		} else if (typeof cliFlag === "string") {
			const parsed = parseBoolean(cliFlag);
			if (parsed !== null) toolOptimize = parsed;
		}

		// Resolve sessionMode: CLI flag > env var > settings.json > default
		defaultSessionMode = flowSettings.sessionMode ?? DEFAULT_AGENT_SESSION_MODE;
		const envSessionModeRaw = process.env[PI_FLOW_SESSION_MODE_ENV];
		if (envSessionModeRaw !== undefined) {
			const envSessionMode = parseAgentSessionMode(envSessionModeRaw);
			if (envSessionMode !== undefined) {
				defaultSessionMode = envSessionMode;
			} else {
				console.warn(`[pi-agent-flow] Ignoring invalid ${PI_FLOW_SESSION_MODE_ENV}="${envSessionModeRaw}". Expected fast, default, or long.`);
			}
		}
		const cliSessionModeRaw = pi.getFlag("flow-session-mode");
		if (typeof cliSessionModeRaw === "string") {
			const cliSessionMode = parseAgentSessionMode(cliSessionModeRaw);
			if (cliSessionMode !== undefined) {
				defaultSessionMode = cliSessionMode;
			} else {
				console.warn(`[pi-agent-flow] Ignoring invalid --flow-session-mode value "${cliSessionModeRaw}". Expected fast, default, or long.`);
			}
		} else if (inheritedCliArgs.flowSessionMode !== undefined) {
			defaultSessionMode = inheritedCliArgs.flowSessionMode;
		}

		// Resolve maxConcurrency: CLI flag > env var > settings.json > default
		const cliConcurrency = pi.getFlag("flow-max-concurrency");
		if (typeof cliConcurrency === "string") {
			const parsed = Number(cliConcurrency);
			if (Number.isSafeInteger(parsed) && parsed >= 1) maxConcurrency = parsed;
		} else if (typeof cliConcurrency === "number" && Number.isSafeInteger(cliConcurrency) && cliConcurrency >= 1) {
			maxConcurrency = cliConcurrency;
		}
		const envConcurrency = process.env["PI_FLOW_MAX_CONCURRENCY"];
		if (envConcurrency !== undefined && typeof cliConcurrency === "undefined") {
			const parsed = Number(envConcurrency);
			if (Number.isSafeInteger(parsed) && parsed >= 1) maxConcurrency = parsed;
		}
		// Cap concurrency to the number of available CPUs
		if (typeof os.availableParallelism === "function") {
			const hwConcurrency = os.availableParallelism();
			if (hwConcurrency > 0) maxConcurrency = Math.min(maxConcurrency, hwConcurrency);
		}

		// Resolve autoTransition: CLI flag > settings.json > default
		const cliAutoTransition = pi.getFlag("auto-transition");
		if (typeof cliAutoTransition === "boolean") {
			autoTransition = cliAutoTransition;
		} else if (typeof cliAutoTransition === "string") {
			const parsed = parseBoolean(cliAutoTransition);
			if (parsed !== null) autoTransition = parsed;
		
		}

		// Only restrict tools for the main orchestrator (depth 0).
		// Child flows (depth > 0) receive their tools via --tools CLI arg;
		// overriding them here would strip bash/batch from children.
		if (currentDepth === 0) {
			pi.setActiveTools(computeActiveTools(toolOptimize));
		}

		// Register batch and batch_read so they are available for main agent and child flows.
		// The bashProcessTracker is shared between the batch tool (launches bash ops)
		// and the batch_bash_poll tool (checks on pending bash ops).
		if (toolOptimize) {
			const bashTracker = new BashProcessTracker();
			pi.registerTool(createBatchReadTool());
			pi.registerTool(createBatchTool(bashTracker));
			pi.registerTool(createBatchBashPollTool(bashTracker));
		}

		// Override built-in bash with timed wrapper so the LLM sees execution-time classification.
		const timedBash = createTimedBashToolDefinition(ctx.cwd);
		if (timedBash) {
			pi.registerTool(timedBash);
		}
	});

	// Re-apply active tools every turn to survive registry refreshes.
	// Skip for child flows — they get tools from --tools CLI arg.
	pi.on("turn_start", () => {
		if (currentDepth > 0) return;
		pi.setActiveTools(computeActiveTools(toolOptimize));
	});
	// Inject available flows into the system prompt.
	// Skip entirely for child flows (depth > 0) — they get their instructions
	// from the 4-part prompt structure in buildFlowArgs and have no web tool.
	pi.on("before_agent_start", async (event) => {
		if (currentDepth > 0) return undefined;

		const prompt = event.prompt;
		const hasUrl = looksLikeUrlPrompt(prompt);
		const likelyNeedsWeb = looksLikeWebSearchPrompt(prompt);


		const webInstructions: string[] = [];
		if (hasUrl) {
			webInstructions.push(
				"The prompt includes a URL. Use web tool with op: { o: 'fetch', u: '<url>' } before answering about that page.",
			);
		}
		if (likelyNeedsWeb) {
			webInstructions.push(
				"The prompt likely needs external or current info. Prefer web tool with op: [{ o: 'search', q: '<query>' }] over memory.",
			);
		}

		let systemPrompt = event.systemPrompt;
		if (!toolOptimize && webInstructions.length > 0) {
			systemPrompt +=
				"\n\n## pi-web steering\n" +
				webInstructions.map((line) => `- ${line}`).join("\n");
		}

		// Append sliding prompt to static system prompt unconditionally.
		systemPrompt += "\n\n" + SLIDING_PROMPT;

		if (!canDelegate || discoveredFlows.length === 0) {
			return { systemPrompt };
		}

		const flowList = discoveredFlows
			.map((f) => {
				const badge = f.source === "project" ? " 🔒" : f.source === "user" ? " ⚙" : "";
				return `- [${f.name}]${badge} — ${f.description}`;
			})
			.join("\n");

		return {
			systemPrompt:
				systemPrompt +
				`\n\n## Flows

Before acting, reason about whether to dive into a flow:

${flowList}

Multiple independent flows? Batch them into one call:

✅ { "flow": [{ "type": "scout", "intent": "..." }, { "type": "audit", "intent": "..." }] }
❌ Two separate calls — wastes time

Each call renders as:

• flow [scout] — Map the full directory structure...
• flow [audit] — Audit security and quality, then fix safe issues...

Each flow returns:

flow [type] accomplished

[Summary] — what happened and current status
[Done] — completed work with file:line references and verification results
[Not Done] — incomplete items, skipped checks, blockers, and reasons
[Next Steps] — specific recommended follow-up or next flow

### Guards
- Depth: ${currentDepth}/${maxDepth} | Cycles: ${preventCycles ? "blocked" : "off"} | Stack: ${ancestorFlowStack.length > 0 ? ancestorFlowStack.join(" -> ") : "(root)"}

### Shared Context
Child flows fork your session automatically:

- They receive a sanitized snapshot of your conversation — files read, commands run, prior flow results.
- Prior flow tool results are **compressed** into compact summaries (files touched, commands used, status).
- Write 'intent' as a **forward-looking mission** — reference what the child already sees, don't re-describe it.
- Set inheritContext: false in a custom flow's front-matter to start with a **clean slate** (no inherited context).
`,
		};
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

	// Register the flow tool
	if (canDelegate) {
		pi.registerTool({
			name: "flow",
			label: "Flow",
			description: [
				"If you cannot answer from your current context, you are forbidden from guessing.",
				"You MUST enter to the following flow states, with tool call method.",
				"",
				"Flow states are isolated \u03c0 processes with forked session snapshots. They run in parallel.",
				'Invoke: { "flow": [{ "type": "scout", "intent": "...", "aim": "...", "sessionMode": "default" }, ...] }',
				"Session modes: fast=300s, default=600s, long=900s, extreme_long=1200s. Use long or extreme_long only when the work genuinely needs the larger budget.",
				"States: scout, debug, build, craft, audit, ideas.",
				"Custom states configs in (create if not exists): .md files in .pi/agents/ or ~/.pi/agent/agents/.",
			].join("\n"),
			parameters: FlowParams,

			async execute(toolCallId, params, signal, onUpdate, ctx) {
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
						toolOptimize,
						structuredOutput,
						cwd: ctx.cwd,
						loadedFlowModelConfigs,
						maxConcurrency,
						autoTransition,
						defaultSessionMode,
						signal,
						onUpdate,
						makeDetails,
						getFlag: (name: string) => name === "flow-mode" ? activeRuntimeFlowMode : pi.getFlag(name),
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

				return {
					content: result.content,
					details: result.details,
					isError: result.isError,
				};
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
	// Emit a typed plugin API surface
	const pluginApi: PiAgentFlowAPI = {
		registerHook,
		unregisterHook,
		getRegisteredHooks,
		discoverFlows: (cwd: string) => discoverFlows(cwd, "all"),
		getFlowTier: (name: string) => getFlowTier(name),
		getSettings: () => ({ toolOptimize, structuredOutput, maxConcurrency, autoTransition }),
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
		process.prependListener("SIGINT", terminateAllChildGroups);
		process.prependListener("SIGTERM", terminateAllChildGroups);

		// Also handle the 'exit' event, which fires when the host calls process.exit().
		const emitShutdown = () => {
			terminateAllChildGroups();
			if (typeof pi.emit === "function") {
				pi.emit("pi-agent-flow:shutdown", { reason: "process-exit" });
			}
		};
		process.on("exit", emitShutdown);
	}

}
