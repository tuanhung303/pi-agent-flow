/**
 * Trace tool — direct executor for quick verbatim reads and checks.
 *
 * Runs dispatch ops directly without forking a child flow.
 * Returns concise notes + tool outputs by ID. No structured output,
 * no LLM synthesis, no process spawn.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getFlowOutput } from "../types/flow.js";
import { executeOperations } from "../batch/execute.js";
import { runBashWithLimits } from "../batch/batch-bash.js";
import { runWebOps } from "./web-ops.js";
import type { FileOpInput } from "../batch/constants.js";
import type { WebOpInput } from "./web-ops.js";
import { runFlow } from "../flow/runner.js";
import { buildCore2Snapshot } from "../core2/snapshot.js";
import { discoverFlows } from "../flow/agents.js";
import { resolveFlowModelCandidates, resolveModelContextWindow } from "../config/config.js";
import type { ResolvedSettings } from "../config/settings-resolver.js";

// ---------------------------------------------------------------------------
// Dispatch schemas
// ---------------------------------------------------------------------------

const BatchDispatchOp = Type.Object({
	tool: Type.Literal("batch"),
	ops: Type.Array(Type.Object({
		o: Type.String(),
		p: Type.Optional(Type.String()),
		s: Type.Optional(Type.Number()),
		l: Type.Optional(Type.Number()),
		i: Type.Optional(Type.Union([Type.String(), Type.Boolean()])),
		t: Type.Optional(Type.Union([Type.Number(), Type.String()])),
		c: Type.Optional(Type.String()),
		e: Type.Optional(Type.Array(Type.Object({ f: Type.String(), r: Type.String() }))),
		h: Type.Optional(Type.String()),
		q: Type.Optional(Type.String()),
		n: Type.Optional(Type.Number()),
		u: Type.Optional(Type.Number()),
	}), { description: "File/batch operations matching the batch tool schema." }),
});

const BashDispatchOp = Type.Object({
	tool: Type.Literal("bash"),
	ops: Type.Array(Type.Object({
		c: Type.String({ description: "Shell command" }),
		h: Type.Optional(Type.String({ description: "Working directory override" })),
		t: Type.Optional(Type.Number({ description: "Timeout in ms" })),
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

export const DispatchOpSchema = Type.Union([BatchDispatchOp, BashDispatchOp, WebDispatchOp], {
	description: "Pre-dispatch tool call with discriminated tool type and typed ops array.",
});

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
				const fileOps = group.ops.filter((op) => op.o !== "bash");
				const bashOps = group.ops.filter((op) => op.o === "bash");

				if (fileOps.length > 0) {
					const fileOutput = await executeOperations(fileOps as FileOpInput[], cwd, signal, { includeLimitWarnings: true });
					parts.push(`### batch (file ops)\n\ntool_call_id: ${toolCallId}\n\n${fileOutput.contentText}`);
				}

				if (bashOps.length > 0) {
					for (const op of bashOps) {
						const { stdout, stderr, exitCode } = await runBashWithLimits(op.c ?? "", op.h ?? cwd, op.t ?? 30000, signal);
						parts.push(`### batch (bash op)\n\ntool_call_id: ${toolCallId}\n\nstdout:\n${stdout}${stderr ? `\nstderr:\n${stderr}` : ""}${exitCode !== 0 ? `\nexitCode: ${exitCode}` : ""}`);
					}
				}
			} else if (group.tool === "bash") {
				for (const cmd of group.ops) {
					const { stdout, stderr, exitCode } = await runBashWithLimits(cmd.c, cmd.h ?? cwd, cmd.t ?? 30000, signal);
					parts.push(`### bash\n\ntool_call_id: ${toolCallId}\n\nstdout:\n${stdout}${stderr ? `\nstderr:\n${stderr}` : ""}${exitCode !== 0 ? `\nexitCode: ${exitCode}` : ""}`);
				}
			} else if (group.tool === "web") {
				const webOutput = await runWebOps({ op: group.ops }, ctx, signal);
				parts.push(`### web\n\ntool_call_id: ${toolCallId}\n\n${webOutput.content[0].text}`);
			}
		} catch (err) {
			parts.push(`### ${group.tool}\n\ntool_call_id: ${toolCallId}\n\nError: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Trace params — zero required fields
// ---------------------------------------------------------------------------

export const TraceParams = Type.Object({
	intent: Type.Optional(Type.String({
		description: "Optional context or question. If omitted, trace simply runs the dispatch ops and returns raw outputs.",
	})),
	dispatch: Type.Optional(Type.Array(DispatchOpSchema, {
		description: "Tools to run directly. Results returned verbatim with tool call IDs.",
	})),
	cwd: Type.Optional(Type.String({ description: "Working directory override." })),
}, {
	title: "TraceToolParams",
	description: "Quick verbatim reads and checks. All fields optional.",
	examples: [
		{},
		{ dispatch: [{ tool: "batch", ops: [{ o: "read", p: "src/main.ts" }] }] },
	],
});

export interface TraceToolOptions {
	getSettings?: () => ResolvedSettings | undefined;
	getDepthConfig?: () => {
		currentDepth: number;
		maxDepth: number;
		ancestorFlowStack: string[];
		preventCycles: boolean;
	};
	getTierOverride?: (tier: "lite" | "flash" | "full") => string | undefined;
	fallbackModel?: string;
}

function formatTraceResult(dispatchText: string, intent?: string): string {
	const parts: string[] = [];
	if (intent) {
		parts.push(`## Intent\n\n${intent}\n`);
	}
	parts.push(`## Results\n\n${dispatchText}`);
	return parts.join("\n");
}

export function createTraceTool(opts: TraceToolOptions = {}) {
	return {
		name: "trace",
		label: "Trace",
		promptSnippet: "Activate trace mode — quick verbatim reads and checks. Runs tools directly, returns raw outputs with IDs. No boilerplate required.",
		promptGuidelines: [
			"Use `trace` for quick verbatim file reads, bash checks, and codebase exploration.",
			"Optional `dispatch` runs tools directly and returns verbatim outputs.",
			"No `intent`, `aim`, or `complexity` required — but you may add `intent` for context.",
		],
		description: "Input a checklist of intents as `aim`, and tool args to `dispatch`; trace releases verbatim output.",
		parameters: TraceParams,

		async execute(
			toolCallId: string,
			params: Static<typeof TraceParams>,
			signal: AbortSignal | undefined,
			onUpdate: any,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<void>> {
			const settings = opts.getSettings?.();
			if (!settings) {
				throw new Error("Error: session not initialized");
			}

			const dispatchText = params.dispatch?.length
				? await executeDispatchOps(params.dispatch, params.cwd ?? ctx.cwd, ctx, signal)
				: undefined;

			// Discover flows and find the "trace" agent config
			const discovery = discoverFlows(ctx.cwd, "all");
			const { flows } = discovery;
			const traceFlow = flows.find((f) => f.name === "trace");

			const depthConfig = opts.getDepthConfig?.() ?? {
				currentDepth: 0,
				maxDepth: 3,
				ancestorFlowStack: [],
				preventCycles: true,
			};
			const { currentDepth, maxDepth, ancestorFlowStack, preventCycles } = depthConfig;

			const tier = traceFlow?.tier ?? "lite";
			const cliTierOverride = opts.getTierOverride?.(tier);
			const strategy = settings.loadedFlowModelConfigs?.strategy;
			const { candidates } = resolveFlowModelCandidates({
				tier,
				flowModel: traceFlow?.model,
				cliTierOverride,
				strategy,
				fallbackModel: opts.fallbackModel,
			});
			const attemptModel = candidates[0];
			const maxContextTokens = resolveModelContextWindow(attemptModel);

			const forkSessionSnapshotJsonl = buildCore2Snapshot(ctx.sessionManager);
			const shouldInheritContext = traceFlow?.inheritContext !== false;

			const result = await runFlow({
				cwd: ctx.cwd,
				flows,
				flowName: "trace",
				intent: params.intent ?? "Explore codebase and verify details",
				aim: params.intent ? (params.intent.length > 40 ? params.intent.slice(0, 37) + "..." : params.intent) : "Trace",
				taskCwd: params.cwd ?? ctx.cwd,
				forkSessionSnapshotJsonl: shouldInheritContext ? forkSessionSnapshotJsonl : null,
				parentDepth: currentDepth,
				parentFlowStack: ancestorFlowStack,
				maxDepth: maxDepth,
				preventCycles,
				toolOptimize: settings.toolOptimize,
				structuredOutput: false, // trace does not use structured JSON outputs
				complexity: "simple", // simple budget is perfect for trace verbatim reads
				model: attemptModel,
				maxContextTokens,
				goalContext: undefined,
				tools: undefined, // use trace.md tools
				preDispatchResults: dispatchText,
				signal,
				onUpdate: (partial) => {
					if (onUpdate) {
						const childFlowOutput = partial.content?.[0]?.text || "";
						const liveText = dispatchText
							? `## Results\n\n${dispatchText}\n\n## Exploration\n\n${childFlowOutput}`
							: childFlowOutput;

						onUpdate({
							content: [{ type: "text", text: liveText }],
							failed: false,
							_toolCallId: toolCallId,
						});
					}
				},
				makeDetails: (results) => ({
					mode: "flow" as const,
					flowStyle: "fork" as const,
					projectAgentsDir: null,
					results,
				}),
			});

			const childFlowOutput = getFlowOutput(result.messages);
			const outputText = dispatchText
				? `## Results\n\n${dispatchText}\n\n## Exploration\n\n${childFlowOutput}`
				: childFlowOutput;

			const agentToolResult: AgentToolResult<void> = {
				content: [{ type: "text" as const, text: outputText }],
				failed: result.exitCode !== 0,
				_toolCallId: toolCallId,
			};

			if (onUpdate) {
				onUpdate(agentToolResult);
			}

			return agentToolResult;
		},
	};
}
