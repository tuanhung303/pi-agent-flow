/**
 * Pi Flow Extension (fork-only)
 *
 * Delegates tasks to specialized flow states running as isolated pi processes.
 * Each flow receives a forked snapshot of the current session context.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type FlowConfig, discoverFlows } from "./agents.js";
import { renderFlowCall, renderFlowResult } from "./render.js";
import { getFlowSummaryText } from "./runner-events.js";
import { mapFlowConcurrent, runFlow } from "./flow.js";
import {
	type SingleResult,
	type FlowDetails,
	emptyFlowUsage,
	isFlowError,
	isFlowSuccess,
} from "./types.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DELEGATION_DEPTH = 3;
const DEFAULT_PREVENT_CYCLE_DELEGATION = true;
const FLOW_DEPTH_ENV = "PI_FLOW_DEPTH";
const FLOW_MAX_DEPTH_ENV = "PI_FLOW_MAX_DEPTH";
const FLOW_STACK_ENV = "PI_FLOW_STACK";
const FLOW_PREVENT_CYCLES_ENV = "PI_FLOW_PREVENT_CYCLES";

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const FlowItem = Type.Object({
	type: Type.String({
		description: "Flow type. Must match an available flow name exactly: explore, debug, code, architect, review.",
	}),
	intent: Type.String({
		description: "Clear, specific mission for this flow.",
	}),
	cwd: Type.Optional(
		Type.String({ description: "Working directory override for this flow." }),
	),
});

const FlowParams = Type.Object({
	flow: Type.Array(FlowItem, {
		description:
			"Array of flow tasks to execute. Each runs in its own forked process. " +
			'Example: { flow: [{ type: "explore", "intent": "Find auth code" }, { type: "code", "intent": "Fix bug" }] }',
		minItems: 1,
	}),
	confirmProjectFlows: Type.Optional(
		Type.Boolean({
			description: "Whether to prompt the user before running project-local flows. Default: true.",
			default: true,
		}),
	),
});

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

	// Trim the current conversation turn from the fork.
	let trimFrom = branchEntries.length;
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		const entry = branchEntries[i] as Record<string, unknown>;
		if (entry?.type === "message") {
			const msg = entry.message as Record<string, unknown> | undefined;
			if (msg?.role === "user") {
				trimFrom = i;
				break;
			}
		}
	}

	const trimmedEntries = branchEntries.slice(0, trimFrom);
	const lines = [JSON.stringify(header)];
	for (const entry of trimmedEntries) lines.push(JSON.stringify(entry));
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
		.map((value) => value.trim())
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

function formatFlowNames(flows: FlowConfig[]): string {
	return flows.map((f) => `${f.name} (${f.source})`).join(", ") || "none";
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
		.map((name) => flows.find((f) => f.name === name))
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

	const depthConfig = resolveFlowDepthConfig(pi);
	const { currentDepth, maxDepth, canDelegate, ancestorFlowStack, preventCycles } =
		depthConfig;

	let discoveredFlows: FlowConfig[] = [];

	// Auto-discover flows on session start
	pi.on("session_start", async (_event, ctx) => {
		if (!canDelegate) return;

		const discovery = discoverFlows(ctx.cwd, "all");
		discoveredFlows = discovery.flows;
	});

	// Inject available flows into the system prompt
	pi.on("before_agent_start", async (event) => {
		if (!canDelegate) return;
		if (discoveredFlows.length === 0) return;

		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n## Flows

Before acting, reason about whether to dive into a flow:

- [explore] — when you need to understand first. Find files, trace code paths, map architecture.
- [debug] — when something is broken. Investigate logs, errors, stack traces to find root cause.
- [code] — when you are ready to build. Implement features, fix bugs, write tests.
- [architect] — when you need a plan. Design structure, break down requirements before building.
- [review] — when you need to verify. Audit security, quality, correctness.

Multiple independent flows? Batch them into one call:

✅ { "flow": [{ "type": "explore", "intent": "..." }, { "type": "review", "intent": "..." }] }
❌ Two separate calls — wastes time

Each call renders as:

routing to:
  • flow [explore] — Map the full directory structure...
  • flow [review] — Audit security and quality...

Each flow returns:

flow [type] accomplished

[Summary] — what happened
[Done] — completed with file:line references
[Not Done] — incomplete items and reasons
[Next Steps] — recommended follow-up

### Guards
- Depth: ${currentDepth}/${maxDepth} | Cycles: ${preventCycles ? "blocked" : "off"} | Stack: ${ancestorFlowStack.length > 0 ? ancestorFlowStack.join(" -> ") : "(root)"}
`,
		};
	});

	// Register the flow tool
	if (canDelegate) {
		pi.registerTool({
			name: "flow",
			label: "Flow",
			description: [
				"Delegate work to flow states running in isolated pi processes.",
				"Each flow receives a snapshot of your current session context.",
				"All flows run in parallel — batch independent tasks into one call.",
				"",
				'Usage: { "flow": [{ "type": "explore", "intent": "..." }, ...] }',
			].join("\n"),
			parameters: FlowParams,

			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const discovery = discoverFlows(ctx.cwd, "all");
				const { flows } = discovery;
				const makeDetails = makeFlowDetailsFactory(discovery.projectFlowsDir);

				// Build fork session snapshot (shared across all flows)
				const forkSessionSnapshotJsonl = buildForkSessionSnapshotJsonl(
					ctx.sessionManager,
				);
				if (!forkSessionSnapshotJsonl) {
					return {
						content: [{ type: "text", text: "Cannot use fork mode: failed to snapshot current session context." }],
						details: makeDetails([]),
						isError: true,
					};
				}

				// Collect all requested flow names
				const requested = new Set(params.flow.map((f) => f.type));

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
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: emptyFlowUsage(),
					};
				}

				const emitProgress = () => {
					if (!onUpdate) return;
					onUpdate({
						content: [{ type: "text", text: `Flow: ${allResults.filter((r) => r.exitCode !== -1).length}/${allResults.length} done` }],
						details: makeDetails([...allResults]),
					});
				};

				let heartbeat: NodeJS.Timeout | undefined;
				if (onUpdate) {
					emitProgress();
					heartbeat = setInterval(() => {
						if (allResults.some((r) => r.exitCode === -1)) emitProgress();
					}, 1000);
				}

				let results: SingleResult[];
				try {
					results = await mapFlowConcurrent(params.flow, 4, async (item, index) => {
						const targetFlow = flows.find((f) => f.name === item.type);
						const effectiveMaxDepth =
							targetFlow?.maxDepth !== undefined ? targetFlow.maxDepth : maxDepth;

						const result = await runFlow({
							cwd: ctx.cwd,
							flows,
							flowName: item.type,
							intent: item.intent,
							taskCwd: item.cwd,
							forkSessionSnapshotJsonl,
							parentDepth: currentDepth,
							parentFlowStack: ancestorFlowStack,
							maxDepth: effectiveMaxDepth,
							preventCycles,
							signal,
							onUpdate: (partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = partial.details.results[0];
									emitProgress();
								}
							},
							makeDetails,
						});
						allResults[index] = result;
						emitProgress();
						return result;
					});
				} finally {
					if (heartbeat) clearInterval(heartbeat);
				}

				// Build tool result with FULL flow output — no truncation
				const successCount = results.filter((r) => isFlowSuccess(r)).length;
				const flowReports = results.map((r) => {
					const output = getFlowSummaryText(r);
					const status = isFlowError(r) ? "failed" : "accomplished";
					return `flow [${r.type}] ${status}\n\n${output}`;
				});

				return {
					content: [{
						type: "text" as const,
						text: `Flow: ${successCount}/${results.length} completed\n\n${flowReports.join("\n\n---\n\n")}`,
					}],
					details: makeDetails(results),
				};
			},

			renderCall: (args, theme) => renderFlowCall(args, theme),
			renderResult: (result, { expanded }, theme) =>
				renderFlowResult(result, expanded, theme),
		});
	}
}
