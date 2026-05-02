/**
 * Pi Flow Extension (fork-only)
 *
 * Delegates tasks to specialized flow states running as isolated pi processes.
 * Each flow receives a forked snapshot of the current session context.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type FlowConfig, discoverFlows, getFlowTier } from "./agents.js";
import {
	loadFlowModelConfigs,
	loadFlowSettings,
	resolveFlowModelCandidates,
	selectFlowModelStrategy,
	type LoadedFlowModelConfigs,
} from "./config.js";
import { parseFlowCliArgs } from "./cli-args.js";
import { renderFlowCall, renderFlowResult } from "./render.js";
import { getFlowSummaryText } from "./runner-events.js";
import { runHooks } from "./hooks.js";
import { mapFlowConcurrent, runFlow } from "./flow.js";
import {
	type SingleResult,
	type FlowDetails,
	emptyFlowUsage,
	isFlowError,
	isFlowSuccess,
} from "./types.js";
import { createBatchTool, createBatchReadTool } from "./batch.js";
import {
	createWebTool,
	looksLikeUrlPrompt,
	looksLikeWebSearchPrompt,
} from "./web-tool.js";

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
});

const FlowParams = Type.Object({
	flow: Type.Array(FlowItem, {
		description:
			"Array of flow tasks to execute. Each runs in its own forked process. " +
			'Example: { flow: [{ type: "scout", "intent": "Find all authentication-related code and trace JWT validation", "aim": "Find auth code and trace JWT" }, { type: "build", "intent": "Fix the bug in user registration", "aim": "Fix registration bug" }] }',
		minItems: 1,
	}),
	confirmProjectFlows: Type.Optional(
		Type.Boolean({
			description: "Whether to prompt the user before running project-local flows. Default: true.",
			default: true,
		}),
	),
});

const inheritedCliArgs = parseFlowCliArgs(process.argv);

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

const SLIDING_PROMPT_OPEN_TAG = "<pi-flow-sliding-system>";
const SLIDING_PROMPT_CLOSE_TAG = "</pi-flow-sliding-system>";

const SLIDING_PROMPT =
	`${SLIDING_PROMPT_OPEN_TAG}\n` +
	`You are operating with pi-agent-flow routing.\n` +
	`If the answer is already in context, answer directly; otherwise delegate to the appropriate flow.\n` +
	`${SLIDING_PROMPT_CLOSE_TAG}`;

const SLIDING_PROMPT_RE = new RegExp(
	SLIDING_PROMPT_OPEN_TAG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
	"[\\s\\S]*?" +
	SLIDING_PROMPT_CLOSE_TAG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
	"g",
);

/** Strip any old sliding system prompt tags from a string. */
function stripSlidingPromptText(text: string): string {
	return text.replace(SLIDING_PROMPT_RE, "");
}

/** Strip sliding prompt tags from content (string or text-part array). */
function stripSlidingPromptFromContent(
	content: string | { type: string; text?: string }[],
): string | { type: string; text?: string }[] {
	if (typeof content === "string") {
		return stripSlidingPromptText(content);
	}
	return content.map((c) => {
		if (c.type === "text" && typeof c.text === "string") {
			return { ...c, text: stripSlidingPromptText(c.text) };
		}
		return c;
	});
}

/** Check whether content (string or text-part array) contains the sliding tag. */
function contentContainsSlidingTag(content: any): boolean {
	if (typeof content === "string") {
		return content.includes(SLIDING_PROMPT_OPEN_TAG);
	}
	if (Array.isArray(content)) {
		return content.some(
			(part: any) =>
				part.type === "text" &&
				typeof part.text === "string" &&
				part.text.includes(SLIDING_PROMPT_OPEN_TAG),
		);
	}
	return false;
}

/** Remove any existing sliding-system-prompt system messages and strip tags from user messages.
 *  Returns the sanitized messages and a flag indicating whether anything changed.
 */
function stripSlidingPromptsFromMessages(messages: any[]): { messages: any[]; changed: boolean } {
	let changed = false;
	const result = messages
		.filter((msg) => {
			// Remove dedicated sliding system prompt messages
			if (msg.role === "system" && contentContainsSlidingTag(msg.content)) {
				changed = true;
				return false;
			}
			return true;
		})
		.map((msg) => {
			// Also strip stray tags embedded in user/assistant messages
			if (!("content" in msg)) return msg;
			const stripped = stripSlidingPromptFromContent(msg.content);
			if (isJsonEqual(stripped, msg.content)) return msg;
			changed = true;
			return { ...msg, content: stripped };
		});
	return { messages: result, changed };
}

/** Build a system message containing the sliding prompt. */
function makeSlidingPromptMessage(referenceMessage?: any): any {
	return {
		role: "system",
		content: SLIDING_PROMPT,
		timestamp: referenceMessage?.timestamp,
	};
}

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

function isJsonEqual(a: any, b: any): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Sanitize a fork session snapshot JSONL to remove only non-inheritable
 * artifacts before passing full parent context to child flows: sliding system
 * prompts, legacy reminders, and assistant reasoning/thinking.
 */
function sanitizeForkSnapshot(snapshot: string | null): string | null {
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

	return `${sanitizedLines.join("\n")}\n`;
}

function computeActiveTools(optimize: boolean): string[] {
	return optimize
		? ["batch_read", "bash", "flow"]
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
	pi.registerFlag("tool-optimize", {
		description: "Use the unified batch tool instead of separate read/write/edit tools (default: true).",
		type: "boolean",
	});

	const depthConfig = resolveFlowDepthConfig(pi);
	const { currentDepth, maxDepth, canDelegate, ancestorFlowStack, preventCycles } =
		depthConfig;

	// toolOptimize: CLI flag > env var > settings.json > default (true)
	let toolOptimize = true;
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

	// Auto-discover flows on session start
	pi.on("session_start", async (_event, ctx) => {
		const discovery = discoverFlows(ctx.cwd, "all");
		discoveredFlows = discovery.flows;
		loadedFlowModelConfigs = loadFlowModelConfigs(ctx.cwd);

		// Resolve toolOptimize: CLI flag > env var > settings.json > default
		const cliFlag = pi.getFlag("tool-optimize");
		if (typeof cliFlag === "boolean") {
			toolOptimize = cliFlag;
		} else if (typeof cliFlag === "string") {
			const parsed = parseBoolean(cliFlag);
			if (parsed !== null) toolOptimize = parsed;
		} else {
			const flowSettings = loadFlowSettings(ctx.cwd);
			if (typeof flowSettings.toolOptimize === "boolean") {
				toolOptimize = flowSettings.toolOptimize;
			}
		}

		// Only restrict tools for the main orchestrator (depth 0).
		// Child flows (depth > 0) receive their tools via --tools CLI arg;
		// overriding them here would strip bash/batch from children.
		if (currentDepth === 0) {
			pi.setActiveTools(computeActiveTools(toolOptimize));
		}

		// Register batch and batch_read so they are available for main agent and child flows.
		if (toolOptimize) {
			pi.registerTool(createBatchReadTool());
			pi.registerTool(createBatchTool());
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

		return {
			systemPrompt:
				systemPrompt +
				`\n\n## Flows

Before acting, reason about whether to dive into a flow:

- [scout] — when you need to understand first. Find files, trace code paths, map architecture.
- [debug] — when something is broken. Investigate logs, errors, stack traces to find root cause.
- [build] — when you are ready to build. Implement features, fix bugs, write tests.
- [craft] — when you need a plan. Design structure, break down requirements before building.
- [audit] — when you need to verify and remediate. Audit security, quality, and correctness; fix safe issues directly.
- [ideas] — when you need fresh ideas. Use inherited context as background while exploring alternatives.

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
				'Invoke: { "flow": [{ "type": "scout", "intent": "..." }, ...] }',
				"States: scout, debug, build, craft, audit, ideas.",
				"Custom states configs in (create if not exists): .md files in .pi/agents/ or ~/.pi/agent/agents/.",
			].join("\n"),
			parameters: FlowParams,

			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const discovery = discoverFlows(ctx.cwd, "all");
				const { flows } = discovery;
				const makeDetails = makeFlowDetailsFactory(discovery.projectFlowsDir);

				const cliFlowModelConfig =
					typeof pi.getFlag("flow-model-config") === "string"
						? (pi.getFlag("flow-model-config") as string)
						: inheritedCliArgs.flowModelConfig;
				const selectedFlowModelConfig = selectFlowModelStrategy(
					loadedFlowModelConfigs.configs,
					cliFlowModelConfig ?? loadedFlowModelConfigs.selectedName,
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

				const shouldFailover = (result: SingleResult): boolean => {
					if (result.stopReason === "aborted") return false;
					const text = `${result.errorMessage ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
					if (!text.trim()) return false;
					if (text.includes("permission") || text.includes("invalid tool") || text.includes("bad settings")) {
						return false;
					}
					return result.exitCode > 0;
				};

				// Build the full fork session snapshot and sanitize only non-inheritable
				// artifacts before passing it to child flows.
				const forkSessionSnapshotJsonl = sanitizeForkSnapshot(
					buildForkSessionSnapshotJsonl(ctx.sessionManager),
				);

				// Collect all requested flow names
				const requested = new Set<string>(params.flow.map((f: any) => f.type.toLowerCase()));

				// Cycle check
				if (preventCycles) {
					const violations = getFlowCycleViolations(requested, ancestorFlowStack);
					if (violations.length > 0) {
						const stack = ancestorFlowStack.join(" -> ") || "(root)";
						return {
							content: [{
								type: "text",
								text: `Blocked: cycle detected. Flow(s) in stack: ${violations.join(", ")}\nStack: ${stack}`,
							}],
							details: makeDetails([]),
							isError: true,
						};
					}
				}

				// Project flow confirmation
				const shouldConfirm = params.confirmProjectFlows ?? true;
				if (shouldConfirm) {
					const projectFlows = getRequestedProjectFlows(flows, requested);
					if (projectFlows.length > 0) {
						if (ctx.hasUI) {
							const ok = await confirmProjectFlowsIfNeeded(projectFlows, discovery.projectFlowsDir, ctx);
							if (!ok) {
								return {
									content: [{ type: "text", text: "Canceled: project-local flows not approved." }],
									details: makeDetails([]),
								};
							}
						} else {
							const names = projectFlows.map((f) => f.name).join(", ");
							return {
								content: [{
									type: "text",
									text: `Blocked: project-local flow confirmation required in non-UI mode.\nFlows: ${names}\nRe-run with confirmProjectFlows: false if trusted.`,
								}],
								details: makeDetails([]),
								isError: true,
							};
						}
					}
				}

				// Run all flows in parallel
				const allResults: SingleResult[] = new Array(params.flow.length);
				for (let i = 0; i < params.flow.length; i++) {
					allResults[i] = {
						type: params.flow[i].type,
						agentSource: "unknown",
						intent: params.flow[i].intent,
						aim: params.flow[i].aim,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: emptyFlowUsage(),
					};
				}

				let lastStreamingText = "";
				let lastEmittedSignature: string | undefined;
				const emitProgress = (streamingText?: string) => {
					if (!onUpdate) return;
					if (streamingText !== undefined) lastStreamingText = streamingText;
					const text = lastStreamingText || "";
					const signature =
						text +
						"|" +
						allResults
							.map(
								(r) =>
									`${r.messages.length}:${r.usage.toolCalls}:${r.usage.input}:${r.usage.output}:${r.usage.contextTokens}:${r.usage.smoothedTps ?? 0}:${r.errorMessage ?? ""}`,
							)
							.join(";");
					if (signature === lastEmittedSignature) return;
					lastEmittedSignature = signature;
					onUpdate({
						content: [{ type: "text", text }],
						details: makeDetails([...allResults]),
					});
				};

				if (onUpdate) emitProgress();

				const results = await mapFlowConcurrent(params.flow, 4, async (item: any, index: number) => {
					const normalizedType = item.type.toLowerCase();
					const targetFlow = flows.find((f) => f.name === normalizedType);
					const effectiveMaxDepth =
						targetFlow?.maxDepth !== undefined ? targetFlow.maxDepth : maxDepth;

					const shouldInheritContext = targetFlow?.inheritContext !== false;
					const tier = getFlowTier(normalizedType);
					const { candidates } = resolveFlowModelCandidates({
						tier,
						flowModel: targetFlow?.model,
						cliTierOverride: getTierOverride(tier),
						strategy: selectedFlowModelConfig.strategy,
						fallbackModel: inheritedCliArgs.fallbackModel,
					});
					const attemptModels = candidates.length > 0 ? candidates : [undefined];
					const attemptedModels: string[] = [];
					let result = allResults[index];

					for (let attempt = 0; attempt < attemptModels.length; attempt++) {
						const candidateModel = attemptModels[attempt];
						if (candidateModel) attemptedModels.push(candidateModel);
						result = await runFlow({
							cwd: ctx.cwd,
							flows,
							flowName: normalizedType,
							intent: item.intent,
							aim: item.aim,
							taskCwd: item.cwd,
							forkSessionSnapshotJsonl: shouldInheritContext ? forkSessionSnapshotJsonl : null,
							parentDepth: currentDepth,
							parentFlowStack: ancestorFlowStack,
							maxDepth: effectiveMaxDepth,
							preventCycles,
							toolOptimize,
							model: candidateModel,
							signal,
							onUpdate: (partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = partial.details.results[0];
									emitProgress(partial.content?.[0]?.text);
								}
							},
							makeDetails,
						});
						allResults[index] = result;
						emitProgress();
						if (isFlowSuccess(result) || signal?.aborted) break;
						if (attempt < attemptModels.length - 1 && shouldFailover(result)) {
							continue;
						}
						break;
					}

					if (result && !isFlowSuccess(result) && attemptedModels.length > 1) {
						const summary = `Model failover attempts: ${attemptedModels.join(" -> ")}`;
						const baseStderr = result.stderr.trim();
						result.stderr = baseStderr ? `${baseStderr}\n\n${summary}` : summary;
						allResults[index] = result;
						emitProgress();
					}

					return result;
				});

				// Build tool result with FULL flow output — no truncation
				const successCount = results.filter((r) => isFlowSuccess(r)).length;
				const flowReports = results.map((r) => {
					const output = getFlowSummaryText(r);
					const status = isFlowError(r) ? "failed" : "accomplished";
					return `flow [${r.type}] ${status}\n\n${output}`;
				});

				// Post-flow hooks — inject advisory messages
				const advisors = runHooks(params.flow, results);
				const advisorBlock = advisors.length > 0
					? "\n\n---\n\n💡 " + advisors.join("\n💡 ")
					: "";

				return {
					content: [{
						type: "text" as const,
						text: `Flow: ${successCount}/${results.length} completed\n\n${flowReports.join("\n\n---\n\n")}${advisorBlock}`,
					}],
					details: makeDetails(results),
				};
			},

			renderCall: (args, theme) => renderFlowCall(args, theme),
			renderResult: (result, { expanded }, theme, args) =>
				renderFlowResult(result, expanded, theme, args),
		});
	}

}
