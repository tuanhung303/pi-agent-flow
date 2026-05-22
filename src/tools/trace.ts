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
import { renderFlowCall, renderFlowResult } from "../tui/render.js";
import { DEFAULT_FLOW_COLORS } from "../tui/flow-colors.js";
import { emptyFlowUsage, type SingleResult, type FlowDetails } from "../types/flow.js";
import { executeOperations } from "../batch/execute.js";
import { runBashWithLimits } from "../batch/batch-bash.js";
import { runWebOps } from "./web-ops.js";
import type { FileOpInput } from "../batch/constants.js";
import type { WebOpInput } from "./web-ops.js";

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
	getSettings?: () => { bodyVerbosity: "lite" | "full" } | undefined;
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
	let lastCallArgs: any;

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
		): Promise<AgentToolResult<FlowDetails>> {
			if (!opts.getSettings?.()) {
				throw new Error("Error: session not initialized");
			}

			lastCallArgs = params;

			const dispatchText = params.dispatch?.length
				? await executeDispatchOps(params.dispatch, params.cwd ?? ctx.cwd, ctx, signal)
				: undefined;

			const outputText = dispatchText
				? formatTraceResult(dispatchText, params.intent)
				: (params.intent ?? "Trace completed — no dispatch ops provided.");

			const syntheticMessage = {
				role: "assistant",
				content: [{ type: "text", text: outputText }],
			};

			const result: SingleResult = {
				type: "trace",
				agentSource: "bundled",
				intent: params.intent ?? "Trace",
				aim: "",
				exitCode: 0,
				messages: [syntheticMessage as any],
				stderr: "",
				usage: emptyFlowUsage(),
			};

			const agentToolResult: AgentToolResult<FlowDetails> = {
				content: [{ type: "text" as const, text: outputText }],
				details: {
					mode: "flow",
					flowStyle: "fork",
					projectAgentsDir: null,
					results: [result],
				},
				failed: false,
				_toolCallId: toolCallId,
			};

			if (onUpdate) {
				onUpdate({ ...agentToolResult, _toolCallId: toolCallId });
			}

			return agentToolResult;
		},

		renderCall: (args: any, theme: any) =>
			renderFlowCall(args, theme, { ...DEFAULT_FLOW_COLORS, bodyVerbosity: opts.getSettings?.()?.bodyVerbosity ?? "lite" }),

		renderResult: (result: any, { expanded }: any, theme: any, args: any) => {
			const enrichedArgs = args?.flow?.[0]
				? args
				: {
						...(args || {}),
						flow: [
							{
								type: "trace",
								intent: args?.intent || lastCallArgs?.intent || "Trace",
								aim: "",
								model: undefined,
								maxContextTokens: undefined,
							},
						],
					};
			return renderFlowResult(result, expanded, theme, enrichedArgs, { ...DEFAULT_FLOW_COLORS, bodyVerbosity: opts.getSettings?.()?.bodyVerbosity ?? "lite" });
		},
	};
}
