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
import { getInheritedCliArgs } from "./cli-args.js";
import { processFlowJsonLine, drainStreamingText, drainStreamingEstimate, drainCtxEstimate, updateSmoothedTps, drainSmoothedTps } from "./runner-events.js";
import {
	type SingleResult,
	type FlowDetails,
	emptyFlowUsage,
	getFlowOutput,
	normalizeFlowResult,
} from "./types.js";
import { extractStructuredOutput, generateCommandsFromHistory } from "./structured-output.js";
import { DEFAULT_AGENT_SESSION_MODE, getAgentSessionTimeoutMs, type AgentSessionMode } from "./session-mode.js";

const isWindows = process.platform === "win32";
const SIGKILL_TIMEOUT_MS = 5000;
const FINISH_KILL_GRACE_MS = 5_000; // wait 5s after finish() before force-killing the child process
const AGENT_END_GRACE_MS = 2000;
const FLOW_TIME_BUDGET_WARNING_MS = 2 * 60 * 1000; // warn 2 min before kill
const FLOW_FINAL_URGE_MS = 135 * 1000; // final urge 135 s (2m15s) before kill (increased from 30s for wider summary window)
const REPORTING_GRACE_MS = 90_000; // grace period after timeout for agent to report findings (increased from 10s to 90s)
const FLOW_TOOL_SUMMARY_GRACE_MS = FLOW_FINAL_URGE_MS; // bash/tool abort lead time so the agent can summarize
const FLOW_DEPTH_ENV = "PI_FLOW_DEPTH";
const FLOW_MAX_DEPTH_ENV = "PI_FLOW_MAX_DEPTH";
const FLOW_STACK_ENV = "PI_FLOW_STACK";
const FLOW_PREVENT_CYCLES_ENV = "PI_FLOW_PREVENT_CYCLES";
const FLOW_DEADLINE_ENV = "PI_FLOW_DEADLINE_MS";
const FLOW_TOOL_SUMMARY_GRACE_ENV = "PI_FLOW_TOOL_SUMMARY_GRACE_MS";
export const FLOW_TOOL_OPTIMIZE_ENV = "PI_FLOW_TOOL_OPTIMIZE";
const PI_OFFLINE_ENV = "PI_OFFLINE";
const FLOW_REMINDER_FILE_ENV = "PI_FLOW_REMINDER_FILE";

// ---------------------------------------------------------------------------
// Global child process group tracking for signal propagation
// ---------------------------------------------------------------------------

/** Track child process groups so we can kill them on parent exit / signal. */
const runningChildGroups = new Map<number, { groupPid: number; name: string }>();

/** Register a child process group for cleanup on shutdown. */
export function registerChildGroup(pid: number, name: string): void {
	if (pid > 0 && !isWindows) {
		runningChildGroups.set(pid, { groupPid: pid, name });
	}
}

/** Unregister a completed/stopped child process group. */
export function unregisterChildGroup(pid: number): void {
	runningChildGroups.delete(pid);
}

/**
 * Terminate all registered child process groups via SIGTERM (then SIGKILL after timeout).
 * Called on parent exit, SIGINT, SIGTERM, or pi-agent-flow:shutdown.
 */
export function terminateAllChildGroups(): void {
	if (runningChildGroups.size === 0) return;
	const pids = Array.from(runningChildGroups.keys());
	for (const pid of pids) {
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
		}
	}
	// Hard kill after timeout
	const sigkillTimer = setTimeout(() => {
		for (const pid of pids) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
			}
		}
		runningChildGroups.clear();
	}, 5000);
	sigkillTimer.unref();
}

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
	// Support PI_FLOW_SPAWN_COMMAND env var override for exotic runtime
	// environments (e.g. bundled with pkg/nexe where process.argv[1] is unreliable).
	const envOverride = process.env["PI_FLOW_SPAWN_COMMAND"];
	if (envOverride && envOverride.trim()) {
		return { command: envOverride.trim(), prefixArgs: [] };
	}
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
// Reminder file helpers
// ---------------------------------------------------------------------------

/**
 * Write a reminder message to the reminder file so the child agent can see it
 * via the timed-bash wrapper before its next tool call.
 * Creates the file if it doesn't exist; appends the message.
 */
function writeReminderFile(reminderFilePath: string | null, message: string): void {
	if (!reminderFilePath) return;
	try {
		fs.writeFileSync(reminderFilePath, message + "\n", { encoding: "utf-8", flag: "a" });
	} catch {
		/* best-effort */
	}
}

// ---------------------------------------------------------------------------
// Build pi CLI arguments (fork-only)
// ---------------------------------------------------------------------------

const inheritedCliArgs = getInheritedCliArgs();

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
	sessionMode: AgentSessionMode = DEFAULT_AGENT_SESSION_MODE,
	sessionTimeoutMs: number = getAgentSessionTimeoutMs(sessionMode),
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
	if (inheritedCliArgs.flowSessionMode) {
		args.push("--flow-session-mode", inheritedCliArgs.flowSessionMode);
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

	// Compute delegation depth before building tool list — children that can
	// delegate need the "flow" tool in their available set.
	const currentDepth = Math.max(0, Math.floor(parentDepth)) + 1;
	const effectiveMaxDepth = Math.max(0, Math.floor(maxDepth));
	const canDelegate = currentDepth < effectiveMaxDepth;

	// Child flows get their configured tools from flow.tools, optimized by
	// getOptimizedTools. When toolOptimize is on and the child can delegate,
	// include "flow" so it can spawn sub-flows.
	const defaultTools = toolOptimize
		? canDelegate
			? ["batch", "bash", "flow"]
			: ["batch", "bash"]
		: ["read", "write", "edit", "batch", "bash", "flow"];
	// getOptimizedTools replaces legacy read/write/edit with batch when
	// toolOptimize is on. If the flow's frontmatter explicitly lists "flow",
	// it passes through; otherwise the defaultTools above handle it.
	const optimizedTools = getOptimizedTools(flow.tools, toolOptimize) ?? defaultTools;
	let harnessTools = optimizedTools;
	// If the flow explicitly listed only tools that got filtered (e.g. just
	// "web"), fall back to defaultTools so the child isn't orphaned.
	if (harnessTools.length === 0) {
		harnessTools = [...defaultTools];
	}
	args.push("--tools", harnessTools.join(","));

	// No --append-system-prompt: child inherits parent's system prompt for cache hits.
	// Flow instructions go in the intent message instead.

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

	const timeBudgetHint =
		sessionTimeoutMs > 0
			? `Session mode: ${sessionMode}. Time budget: ${Math.round(sessionTimeoutMs / 1000)}s total. Long-running tools may be interrupted near the deadline to preserve final-summary time; if a tool reports [Flow timeout], stop tool use and output structured findings immediately.\n`
			: "";

	const activation =
		`\n\n<activation flow="${flow.name}" depth="${currentDepth}" tools="${availableTools}">\n` +
		`You are a [${flow.name}] agent operating at depth ${currentDepth}.\n` +
		`Available tools: ${availableTools}.\n` +
		`${delegationRule}\n` +
		`${timeBudgetHint}` +
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
			`Commands are extracted automatically from tool call history — do not include a commands array.\n` +
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
			`  "notDone": [\n` +
			`    { "item": "unfinished work", "reason": "why it was not completed", "blocker": "blocking issue if any", "nextStep": "specific follow-up" }\n` +
			`  ],\n` +
			`  "nextSteps": ["recommended follow-up action"],\n` +
			`  "reasoning": ["key hypothesis or inference"],\n` +
			`  "notes": ["observation or warning"]\n` +
			`}\n` +
			`\`\`\`\n` +
			`\n` +
			`Only include fields that have data. Omit empty arrays; missing array fields are acceptable. Keep snippets under 300 characters. List at most 10 files, 10 actions, and 10 notDone items. If you cannot produce valid structured output, omit the JSON block entirely.`;
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
	/** Child-flow session mode. Default: "default" (600s). */
	sessionMode?: AgentSessionMode;
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

	const effectiveSessionMode = opts.sessionMode ?? DEFAULT_AGENT_SESSION_MODE;
	const effectiveTimeout = getAgentSessionTimeoutMs(effectiveSessionMode);
	const startedAtMs = Date.now();
	const deadlineAtMs = effectiveTimeout > 0 ? startedAtMs + effectiveTimeout : undefined;
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
		startedAtMs,
		...(deadlineAtMs !== undefined ? { deadlineAtMs } : {}),
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

	// Create a temp dir for the reminder file so the child agent can read timeout warnings
	// via the timed-bash wrapper before its next tool call.
	let reminderTmpDir: string | null = null;
	let reminderFilePath: string | null = null;
	if (effectiveTimeout > 0) {
		reminderTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-flow-reminder-"));
		reminderFilePath = path.join(reminderTmpDir, "reminder.txt");
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
			effectiveSessionMode,
			effectiveTimeout,
		);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const nextDepth = Math.max(0, Math.floor(parentDepth)) + 1;
			const propagatedMaxDepth = Math.max(0, Math.floor(maxDepth));
			const propagatedStack = [...parentFlowStack, normalizedFlowName];
			const proportionalGraceMs = Math.floor(effectiveTimeout * 0.1);
			const minimumGraceMs = effectiveTimeout >= 10_000 ? 1_000 : Math.floor(effectiveTimeout / 2);
			const toolSummaryGraceMs = Math.min(
				FLOW_TOOL_SUMMARY_GRACE_MS,
				Math.max(0, effectiveTimeout),
				Math.max(minimumGraceMs, proportionalGraceMs),
			);
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
					...(effectiveTimeout > 0 ? {
						[FLOW_DEADLINE_ENV]: String(deadlineAtMs),
						[FLOW_TOOL_SUMMARY_GRACE_ENV]: String(toolSummaryGraceMs),
						[FLOW_REMINDER_FILE_ENV]: reminderFilePath ?? "",
					} : {
						[FLOW_DEADLINE_ENV]: "",
						[FLOW_TOOL_SUMMARY_GRACE_ENV]: "0",
						[FLOW_REMINDER_FILE_ENV]: "",
					}),
				},
			});

			// Register the child process group for global cleanup on signal/exit
			if (proc.pid !== undefined && !isWindows) {
				registerChildGroup(proc.pid, normalizedFlowName);
			}

			let stdinEnded = false;
			const endStdin = () => {
				if (stdinEnded) return;
				stdinEnded = true;
				try { proc.stdin.end(); } catch { /* ignore */ }
			};
			proc.stdin.on("error", () => {
				/* ignore broken pipe on fast exits */
			});
			proc.stdin.end();

			let abortHandler: (() => void) | undefined;
			let buffer = "";
			let didClose = false;
			let settled = false;
			let timeoutFired = false;
			let semanticCompletionTimer: NodeJS.Timeout | undefined;
			let countdownTimer: NodeJS.Timeout | undefined;
			let finishKillTimer: NodeJS.Timeout | undefined;

			const clearSemanticCompletionTimer = () => {
				if (semanticCompletionTimer) {
					clearTimeout(semanticCompletionTimer);
					semanticCompletionTimer = undefined;
				}
			};

			const clearCountdownTimer = () => {
				if (countdownTimer) {
					clearInterval(countdownTimer);
					countdownTimer = undefined;
				}
			};

			const terminateChild = () => {
				endStdin();
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

			const clearFinishKillTimer = () => {
				if (finishKillTimer) {
					clearTimeout(finishKillTimer);
					finishKillTimer = undefined;
				}
			};

			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				endStdin();
				clearSemanticCompletionTimer();
				clearCountdownTimer();
				if (signal && abortHandler) {
					signal.removeEventListener("abort", abortHandler);
				}
				// Soft-kill: give the child a short grace to exit naturally after stdin close.
				// If it hasn't closed by then, force-kill to prevent orphaned processes.
				clearFinishKillTimer();
				finishKillTimer = setTimeout(() => {
					if (!didClose) {
						terminateChild();
					}
				}, FINISH_KILL_GRACE_MS);
				finishKillTimer.unref();
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

			if (onUpdate && effectiveTimeout > 0) {
				countdownTimer = setInterval(() => {
					if (didClose || settled) return;
					emitUpdate();
				}, 1000);
				countdownTimer.unref();
			}

			proc.on("close", (code) => {
				didClose = true;
				clearFinishKillTimer();
				if (proc.pid !== undefined) {
					unregisterChildGroup(proc.pid);
				}
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
					endStdin();
					terminateChild();
				};
				if (signal.aborted) abortHandler();
				else signal.addEventListener("abort", abortHandler, { once: true });
			}

			// Execution timeout — two-stage: parent-side warnings, tool-level deadline abort, then grace, then hard kill
			if (effectiveTimeout > 0) {
				// Warning timer: notify the parent UI that the child is about to be killed.
				// NOTE: True mid-flight injection into the child's context requires pi-core
				// support for out-of-band messages. Until then, the agent only knows its
				// budget from the initial prompt; this warning is parent-side only.
				const warningMs = effectiveTimeout - FLOW_TIME_BUDGET_WARNING_MS;
				if (warningMs > 0) {
					const warnTimer = setTimeout(() => {
						if (didClose || settled) return;
						const remainingSec = Math.round(FLOW_TIME_BUDGET_WARNING_MS / 1000);
						const warnMsg = `\n[Flow warning] ${remainingSec}s remaining before hard timeout. The agent should wrap up now.`;
						result.stderr += warnMsg;
						// Write to reminder file so the child agent sees it on its next bash call.
						writeReminderFile(reminderFilePath, `[Flow warning] ${remainingSec}s remaining before hard timeout. Wrap up your work and output structured findings.`);
						// Force an update so the parent UI shows the warning immediately.
						emitUpdate();
					}, warningMs);
					warnTimer.unref();
				}

				// Final urge timer: stronger warning 45 s before hard timeout
				const urgeMs = effectiveTimeout - FLOW_FINAL_URGE_MS;
				if (urgeMs > 0) {
					const urgeTimer = setTimeout(() => {
						if (didClose || settled) return;
						const remainingSec = Math.round(FLOW_FINAL_URGE_MS / 1000);
						const urgeMsg = `\n[Flow warning] ${remainingSec}s remaining before hard timeout. Stop all work and output your structured findings.`;
						result.stderr += urgeMsg;
						// Write to reminder file so the child agent sees it on its next bash call.
						writeReminderFile(reminderFilePath, `[Flow urge] ${remainingSec}s remaining before hard timeout. STOP all tool use and output your structured findings NOW.`);
						emitUpdate();
					}, urgeMs);
					urgeTimer.unref();
				}

				const timeoutTimer = setTimeout(() => {
					if (didClose || settled) return;
					timeoutFired = true;
					result.stderr += `\nFlow timed out after ${Math.round(effectiveTimeout / 1000)}s.`;
					emitUpdate();

					// Grace period before hard kill
					const graceTimer = setTimeout(() => {
						if (didClose || settled) return;
						result.stopReason = "timeout";
						result.errorMessage = `Flow timed out after ${Math.round(effectiveTimeout / 1000)}s.`;
						terminateChild();
					}, REPORTING_GRACE_MS);
					graceTimer.unref();
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
				extracted.commands = generateCommandsFromHistory(normalized.messages);
				normalized.structuredOutput = extracted;
			}
		}

		return normalized;
	} finally {
		cleanupFlowTempDir(forkSessionTmpDir);
		cleanupFlowTempDir(reminderTmpDir);
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
