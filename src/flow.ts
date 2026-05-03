/**
 * Flow process runner (fork-only).
 *
 * Spawns isolated pi processes with forked session context
 * and streams results back via callbacks.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { type FlowConfig } from "./agents.js";
import { parseFlowCliArgs } from "./cli-args.js";
import { processFlowJsonLine, drainStreamingText, drainStreamingEstimate, drainCtxEstimate, updateSmoothedTps, drainSmoothedTps } from "./runner-events.js";
import {
	type SingleResult,
	type FlowDetails,
	emptyFlowUsage,
	getFlowOutput,
	normalizeFlowResult,
} from "./types.js";
import { extractStructuredOutput } from "./structured-output.js";

const isWindows = process.platform === "win32";
const SIGKILL_TIMEOUT_MS = 5000;
const AGENT_END_GRACE_MS = 2000;
const DEFAULT_FLOW_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const FLOW_DEPTH_ENV = "PI_FLOW_DEPTH";
const FLOW_MAX_DEPTH_ENV = "PI_FLOW_MAX_DEPTH";
const FLOW_STACK_ENV = "PI_FLOW_STACK";
const FLOW_PREVENT_CYCLES_ENV = "PI_FLOW_PREVENT_CYCLES";
const FLOW_TIMEOUT_ENV = "PI_FLOW_TIMEOUT_MS";
export const FLOW_TOOL_OPTIMIZE_ENV = "PI_FLOW_TOOL_OPTIMIZE";
const PI_OFFLINE_ENV = "PI_OFFLINE";

type FlowUpdateCallback = (partial: AgentToolResult<FlowDetails>) => void;

/**
 * Merge actual usage with streaming estimates.
 * Uses Math.max for output to avoid double-counting.
 * Uses Math.max for contextTokens so the ctx estimate (baseline + streaming)
 * smoothly increments during active streaming.
 */
function mergeStreamingUsage(
	actual: SingleResult["usage"],
	estimatedOutputTokens: number,
	ctxEstimate: number,
	smoothedTps: number,
): SingleResult["usage"] {
	if (estimatedOutputTokens <= 0 && ctxEstimate <= 0 && smoothedTps <= 0) return actual;
	return {
		...actual,
		...(estimatedOutputTokens > 0 ? { output: Math.max(actual.output, estimatedOutputTokens) } : {}),
		...(ctxEstimate > 0 ? { contextTokens: Math.max(actual.contextTokens, ctxEstimate) } : {}),
		// Show the live EMA value so the dashboard can rise and fall smoothly.
		...(smoothedTps > 0 ? { smoothedTps } : {}),
	};
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/**
 * Derive the spawn command from the current process context so child invocations
 * work on Unix and Windows without going through a shell wrapper.
 */
function resolveFlowSpawn(): { command: string; prefixArgs: string[] } {
	const isNode = /[\\/]node(?:\.exe)?$/i.test(process.execPath);
	if (isNode && process.argv[1]) {
		return { command: process.execPath, prefixArgs: [process.argv[1]] };
	}
	return { command: process.execPath, prefixArgs: [] };
}

// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------

function writeFlowSessionToTempFile(
	flowName: string,
	sessionJsonl: string,
): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-"));
	const safeName = flowName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `flow-${safeName}.jsonl`);
	fs.writeFileSync(filePath, sessionJsonl, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

function cleanupFlowTempDir(dir: string | null): void {
	if (!dir) return;
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

// ---------------------------------------------------------------------------
// Build pi CLI arguments (fork-only)
// ---------------------------------------------------------------------------

const inheritedCliArgs = parseFlowCliArgs(process.argv);

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

function buildFlowArgs(
	flow: FlowConfig,
	intent: string,
	forkSessionPath: string | null,
	model?: string,
	parentDepth: number = 0,
	maxDepth: number = 0,
	toolOptimize: boolean = false,
	structuredOutput: boolean = true,
): string[] {
	const args: string[] = [
		"--mode",
		"json",
		...inheritedCliArgs.extensionArgs,
		...inheritedCliArgs.alwaysProxy,
	];

	// Fork mode: always use --session
	if (forkSessionPath) {
		args.push("--session", forkSessionPath);
	}

	if (inheritedCliArgs.flowModelConfig) {
		args.push("--flow-model-config", inheritedCliArgs.flowModelConfig);
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

	const thinking = flow.thinking ?? inheritedCliArgs.fallbackThinking;
	if (thinking) args.push("--thinking", thinking);

	// Child flows get their configured tools from flow.tools, optimized by
	// getOptimizedTools, with web explicitly filtered out.
	// When flow.tools is undefined and toolOptimize=true, default to batch+bash+web
	// (flow is unnecessary since the child is already inside a flow).
	// When toolOptimize=false, include batch and web alongside legacy tools.
	const defaultTools = toolOptimize
		? ["batch", "bash", "web"]
		: ["read", "write", "edit", "batch", "bash", "flow", "web"];
	const optimizedTools = getOptimizedTools(flow.tools, toolOptimize) ?? defaultTools;
	let harnessTools = optimizedTools.filter((t) => t !== "web");
	// If the flow explicitly listed only "web" (or nothing after filtering),
	// fall back to defaultTools so the child isn't orphaned with zero tools.
	if (harnessTools.length === 0) {
		harnessTools = defaultTools.filter((t) => t !== "web");
	}
	args.push("--tools", harnessTools.join(","));

	// No --append-system-prompt: child inherits parent's system prompt for cache hits.
	// Flow instructions go in the intent message instead.

	const currentDepth = Math.max(0, Math.floor(parentDepth)) + 1;
	const effectiveMaxDepth = Math.max(0, Math.floor(maxDepth));
	const canDelegate = currentDepth < effectiveMaxDepth;
	const availableTools = harnessTools.join(", ");

	// Phase 1: Context seal — sharp boundary declaring history sealed
	const contextSeal =
		`<context-seal>\n` +
		`The conversation above is sealed — it is your session history for situational awareness only.\n` +
		`Your task begins NOW. Do not respond to or continue anything from the history.\n` +
		`</context-seal>`;

	// Phase 2: Activation — role, tools, depth, delegation rules (dynamically generated)
	const delegationRule = canDelegate
		? `You may delegate to sub-flows (depth ${currentDepth}/${effectiveMaxDepth}).`
		: `You may NOT delegate to sub-flows (depth limit reached).`;

	const activation =
		`\n\n<activation flow="${flow.name}" depth="${currentDepth}" tools="${availableTools}">\n` +
		`You are a [${flow.name}] agent operating at depth ${currentDepth}.\n` +
		`Available tools: ${availableTools}.\n` +
		`${delegationRule}\n` +
		`Do not attempt to use any tool outside the available set — it will fail.\n` +
		`</activation>`;

	// Phase 3: Directive — the flow's system prompt (renamed from <system-directive>)
	let directiveBody = flow.systemPrompt.trim();

	// Append structured output instructions when enabled
	if (structuredOutput && directiveBody) {
		directiveBody +=
			`\n\n## Structured Output\n\n` +
			`End your response with a JSON code block containing:\n` +
			`\n` +
			`\`\`\`json\n` +
			`{\n` +
			`  "version": "1.0",\n` +
			`  "status": "complete",\n` +
			`  "summary": "2-3 sentence summary of what was accomplished",\n` +
			`  "files": [\n` +
			`    { "path": "relative/path", "role": "read", "description": "why it matters", "snippet": "short excerpt", "ranges": [{ "start": 10, "end": 25, "label": "bug" }] }\n` +
			`  ],\n` +
			`  "actions": [\n` +
			`    { "type": "read", "description": "what was done", "target": "file.ts", "result": "success", "evidence": "output or proof" }\n` +
			`  ],\n` +
			`  "commands": [\n` +
			`    { "command": "npm test", "tool": "bash", "target": ".", "result": "success", "output": "12 passing, 2 failing", "purpose": "Run test suite to verify fix" }\n` +
			`  ],\n` +
			`  "notDone": [\n` +
			`    { "item": "unfinished work", "reason": "why it was not completed", "blocker": "blocking issue if any", "nextStep": "specific follow-up" }\n` +
			`  ],\n` +
			`  "nextSteps": ["recommended follow-up action"],\n` +
			`  "reasoning": ["key hypothesis or inference"],\n` +
			`  "notes": ["observation or warning"]\n` +
			`}\n` +
			`\`\`\`\n` +
			`\n` +
			`Only include fields that have data. Omit empty arrays; missing array fields are acceptable. Keep snippets under 300 characters. List at most 10 files, 10 actions, 10 commands, and 10 notDone items. If you cannot produce valid structured output, omit the JSON block entirely.`;
	}

	const directive = directiveBody
		? `\n\n<directive>\n${directiveBody}\n</directive>`
		: "";

	// Phase 4: Mission — the intent wrapped with execution contract
	const mission =
		`\n\n<mission>\n` +
		`${intent}\n` +
		`\nExecute this mission. Use only your available tools. If blocked, report why — do not guess.\n` +
		`Follow the output format specified in your directive.\n` +
		`</mission>`;

	// -p must immediately precede the prompt so the CLI parser binds it correctly
	args.push("-p", `${contextSeal}${activation}${directive}${mission}`);
	return args;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunFlowOptions {
	/** Fallback working directory when the intent doesn't specify one. */
	cwd: string;
	/** All available flow configs. */
	flows: FlowConfig[];
	/** Name of the flow to run. */
	flowName: string;
	/** Intent description. */
	intent: string;
	/** Short headline for display. */
	aim: string;
	/** Optional override working directory. */
	taskCwd?: string;
	/** Serialized parent session snapshot for fork mode. Null when the flow starts with a clean slate. */
	forkSessionSnapshotJsonl: string | null;
	/** Current delegation depth of the caller process. */
	parentDepth: number;
	/** Delegation stack from the caller process (ancestor flow names). */
	parentFlowStack: string[];
	/** Maximum allowed delegation depth to propagate to child processes. */
	maxDepth: number;
	/** Whether cycle prevention should be enforced in child processes. */
	preventCycles: boolean;
	/** Whether to transform tool lists to use batch. */
	toolOptimize?: boolean;
	/** Whether to inject structured JSON output instructions. Default: true. */
	structuredOutput?: boolean;
	/** Explicit model to use for this flow execution. */
	model?: string;
	/** Abort signal for cancellation. */
	signal?: AbortSignal;
	/** Streaming update callback. */
	onUpdate?: FlowUpdateCallback;
	/** Factory to wrap results into FlowDetails. */
	makeDetails: (results: SingleResult[]) => FlowDetails;
	/** Max execution time in ms before child is terminated. Default: 10 minutes. */
	timeoutMs?: number;
}

/**
 * Spawn a single flow process with forked session context.
 *
 * Returns a SingleResult even on failure (exitCode > 0, stderr populated).
 */
export async function runFlow(opts: RunFlowOptions): Promise<SingleResult> {
	const {
		cwd,
		flows,
		flowName,
		intent,
		aim,
		taskCwd,
		forkSessionSnapshotJsonl,
		parentDepth,
		parentFlowStack,
		maxDepth,
		preventCycles,
		toolOptimize = false,
		structuredOutput = true,
		model,
		signal,
		onUpdate,
		makeDetails,
	} = opts;

	const normalizedFlowName = flowName.toLowerCase();
	const flow = flows.find((f) => f.name === normalizedFlowName);
	if (!flow) {
		const available = flows.map((f) => `"${f.name}"`).join(", ") || "none";
		return {
			type: normalizedFlowName,
			agentSource: "unknown",
			intent,
			aim,
			exitCode: 1,
			messages: [],
			stderr: `Unknown flow: "${flowName}". Available flows: ${available}.`,
			usage: emptyFlowUsage(),
		};
	}

	const resolvedModel = model ?? flow.model ?? inheritedCliArgs.fallbackModel;
	const result: SingleResult = {
		type: normalizedFlowName,
		agentSource: flow.source,
		intent,
		aim,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyFlowUsage(),
		model: resolvedModel,
	};

	let liveStreamingText = "";
	let liveEstimatedOutputTokens = 0;
	let lastActualOutputTokens = result.usage.output;
	const emitUpdate = () => {
		const streamingDelta = drainStreamingText(result);
		if (streamingDelta) liveStreamingText += streamingDelta;
		const estimatedTokens = drainStreamingEstimate(result);
		if (result.usage.output !== lastActualOutputTokens) {
			lastActualOutputTokens = result.usage.output;
			liveEstimatedOutputTokens = result.usage.output;
		}
		liveEstimatedOutputTokens += estimatedTokens;
		const ctxEst = drainCtxEstimate(result);
		updateSmoothedTps(result, estimatedTokens);
		const smoothedTps = drainSmoothedTps(result);
		const mergedUsage = mergeStreamingUsage(result.usage, liveEstimatedOutputTokens, ctxEst, smoothedTps);
		onUpdate?.({
			content: [
				{
					type: "text",
					text: liveStreamingText || getFlowOutput(result.messages) || "(running...)",
				},
			],
			details: makeDetails([{ ...result, usage: mergedUsage, streamingText: liveStreamingText || undefined }]),
		});
	};

	// Write forked session snapshot to temp file only when provided
	let forkSessionTmpDir: string | null = null;
	let forkSessionTmpPath: string | null = null;
	if (forkSessionSnapshotJsonl) {
		const forkTmp = writeFlowSessionToTempFile(flow.name, forkSessionSnapshotJsonl);
		forkSessionTmpDir = forkTmp.dir;
		forkSessionTmpPath = forkTmp.filePath;
	}

	try {
		const piArgs = buildFlowArgs(
			flow,
			intent,
			forkSessionTmpPath,
			model,
			parentDepth,
			maxDepth,
			toolOptimize,
			structuredOutput,
		);
		let wasAborted = false;

		// Resolve timeout: explicit option > env var > default (10 min)
		const envTimeoutRaw = process.env[FLOW_TIMEOUT_ENV];
		const envTimeout = envTimeoutRaw !== undefined ? (() => {
			const n = Number(envTimeoutRaw);
			return Number.isSafeInteger(n) && n >= 0 ? n : null;
		})() : null;
		const effectiveTimeout = opts.timeoutMs ?? envTimeout ?? DEFAULT_FLOW_TIMEOUT_MS;

		const exitCode = await new Promise<number>((resolve) => {
			const nextDepth = Math.max(0, Math.floor(parentDepth)) + 1;
			const propagatedMaxDepth = Math.max(0, Math.floor(maxDepth));
			const propagatedStack = [...parentFlowStack, normalizedFlowName];
			const { command, prefixArgs } = resolveFlowSpawn();
			const proc = spawn(command, [...prefixArgs, ...piArgs], {
				cwd: taskCwd ?? cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				// Process group on Unix so we can kill all descendants on timeout/abort.
				detached: !isWindows,
				env: {
					...process.env,
					[FLOW_DEPTH_ENV]: String(nextDepth),
					[FLOW_MAX_DEPTH_ENV]: String(propagatedMaxDepth),
					[FLOW_STACK_ENV]: JSON.stringify(propagatedStack),
					[FLOW_PREVENT_CYCLES_ENV]: preventCycles ? "1" : "0",
					[FLOW_TOOL_OPTIMIZE_ENV]: toolOptimize ? "1" : "0",
					[PI_OFFLINE_ENV]: "1",
				},
			});

			proc.stdin.on("error", () => {
				/* ignore broken pipe on fast exits */
			});
			proc.stdin.end();

			let buffer = "";
			let didClose = false;
			let settled = false;
			let abortHandler: (() => void) | undefined;
			let semanticCompletionTimer: NodeJS.Timeout | undefined;

			const clearSemanticCompletionTimer = () => {
				if (semanticCompletionTimer) {
					clearTimeout(semanticCompletionTimer);
					semanticCompletionTimer = undefined;
				}
			};

			const terminateChild = () => {
				if (isWindows) {
					if (proc.pid !== undefined) {
						const killer = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
							stdio: "ignore",
						});
						killer.unref();
					}
					return;
				}

				// Kill the entire process group (negative PID).
				if (proc.pid === undefined) { proc.kill("SIGTERM"); } else { try { process.kill(-proc.pid, "SIGTERM"); } catch { proc.kill("SIGTERM"); } }
				const sigkillTimer = setTimeout(() => {
					if (!didClose) {
						if (proc.pid === undefined) { proc.kill("SIGKILL"); } else { try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); } }
					}
				}, SIGKILL_TIMEOUT_MS);
				sigkillTimer.unref();
			};

			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				clearSemanticCompletionTimer();
				if (signal && abortHandler) {
					signal.removeEventListener("abort", abortHandler);
				}
				resolve(code);
			};

			const flushLine = (line: string) => {
				if (processFlowJsonLine(line, result)) emitUpdate();
				maybeFinishFromAgentEnd();
			};

			const flushBufferedLines = (text: string) => {
				for (const line of text.split(/\r?\n/)) {
					if (line.trim()) flushLine(line);
				}
			};

			let semanticCompletionTimerArmed = false;
			const maybeFinishFromAgentEnd = () => {
				if (!result.sawAgentEnd || didClose || settled || semanticCompletionTimerArmed) return;
				semanticCompletionTimerArmed = true;
				semanticCompletionTimer = setTimeout(() => {
					if (didClose || settled || !result.sawAgentEnd) return;
					if (buffer.trim()) {
						flushBufferedLines(buffer);
						buffer = "";
					}
					finish(0);
				}, AGENT_END_GRACE_MS);
				semanticCompletionTimer.unref();
			};

			const onStdoutData = (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split(/\r?\n/);
				buffer = lines.pop() || "";
				for (const line of lines) flushLine(line);
			};

			const onStderrData = (chunk: Buffer) => {
				result.stderr += chunk.toString();
			};

			proc.stdout.on("data", onStdoutData);
			proc.stderr.on("data", onStderrData);

			proc.on("close", (code) => {
				didClose = true;
				if (buffer.trim()) flushBufferedLines(buffer);
				finish(code ?? 0);
			});

			proc.on("error", (err) => {
				if (!result.stderr.trim()) result.stderr = err.message;
				finish(1);
			});

			// Abort handling
			if (signal) {
				abortHandler = () => {
					if (didClose || settled) return;
					wasAborted = true;
					terminateChild();
				};
				if (signal.aborted) abortHandler();
				else signal.addEventListener("abort", abortHandler, { once: true });
			}

			// Execution timeout — kill child if it runs too long
			if (effectiveTimeout > 0) {
				const timeoutTimer = setTimeout(() => {
					if (didClose || settled) return;
					result.stderr += `\nFlow timed out after ${Math.round(effectiveTimeout / 1000)}s.`;
					terminateChild();
				}, effectiveTimeout);
				timeoutTimer.unref();
			}
		});

		result.exitCode = exitCode;

		// Persist final smoothed TPS into the result's usage so it survives after streaming ends.
		// During streaming, emitUpdate() only merges smoothedTps into a temporary display object;
		// without this, result.usage.smoothedTps stays at 0 and the UI shows a dash.
		const finalSmoothedTps = drainSmoothedTps(result);
		if (finalSmoothedTps > 0) {
			result.usage.smoothedTps = finalSmoothedTps;
		}

		const normalized = normalizeFlowResult(result, wasAborted);

		// Extract structured JSON output from the final assistant text
		if (structuredOutput) {
			const flowText = getFlowOutput(normalized.messages);
			const extracted = extractStructuredOutput(flowText);
			if (extracted) {
				normalized.structuredOutput = extracted;
			}
		}

		return normalized;
	} finally {
		cleanupFlowTempDir(forkSessionTmpDir);
	}
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

/**
 * Map over items with a bounded number of concurrent workers.
 */
export async function mapFlowConcurrent<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;

	const worker = async () => {
		while (true) {
			const i = nextIndex++;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
	};

	await Promise.all(Array.from({ length: limit }, () => worker()));
	return results;
}
