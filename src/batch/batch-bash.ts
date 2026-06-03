
import { logWarn } from "../config/log.js";
import { compressOutput } from "./shell-compress.js";

/**
 * batch bash -- parallel bash execution and polling.
 *
 * Runs multiple shell commands concurrently with a soft timeout,
 * tracks running/pending processes, and exposes a polling interface
 * so the agent can retrieve results of long-running commands later.
 *
 * The soft timeout (default 20s) does NOT kill commands. It sets the maximum
 * wait time before the batch tool returns partial results. Commands that
 * haven't finished continue running in the background and can be polled
 * via the `batch_bash_poll` tool.
 *
 * Why not `createLocalBashOperations` from `@earendil-works/pi-coding-agent`?
 * That helper is a simple exec wrapper (returns a promise when the process exits).
 * Our tracker needs background execution + polling: processes must outlive the
 * soft timeout and be queried later via `batch_bash_poll`. We therefore use raw
 * `node:child_process.spawn` directly to retain full control over detached mode,
 * per-process AbortControllers, and background lifecycle.
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { Type } from "@sinclair/typebox";
import {
	type BashOpResult,
	type PendingBashResult,
	BASH_SOFT_TIMEOUT_MS,
	BASH_POLL_TAIL_LINES,
	MAX_BASH_OUTPUT_BYTES,
	MAX_BASH_OUTPUT_LINES,
} from "./constants.js";
import { classifyDuration } from "../tools/timed-bash.js";
import { truncateBashOutputText } from "./truncate-output.js";

// Fix L4: Cap in-memory chunk arrays to prevent unbounded growth for long-running processes.
// The ring buffer preserves the most recent output which is what getRunningTail needs.
const MAX_CHUNKS = 1000;
const MAX_CHUNK_BYTES = 5 * 1024 * 1024; // 5 MB

// ---------------------------------------------------------------------------
// Process tracker -- shared between batch and batch_bash_poll tools
// ---------------------------------------------------------------------------

interface RunningProcess {
	proc: ChildProcess;
	command: string;
	startedAt: number;
	stdoutChunks: string[];
	stderrChunks: string[];
	abortController: AbortController;
}

interface TrackedBashResult {
	id: string;
	command: string;
	status: "ok" | "error" | "aborted";
	exitCode?: number;
	stdout: string;
	stderr: string;
	duration: number;
	timingTier: string;
}

/**
 * Enforce ring-buffer limits on a chunk array: oldest chunks are dropped first
 * when count exceeds MAX_CHUNKS or total bytes exceed MAX_CHUNK_BYTES.
 */
function capChunks(chunks: string[]): void {
	let totalBytes = 0;
	for (const c of chunks) totalBytes += c.length;
	while (chunks.length > MAX_CHUNKS || totalBytes > MAX_CHUNK_BYTES) {
		const removed = chunks.shift();
		if (removed) totalBytes -= removed.length;
		else break;
	}
}

/**
 * Process tracker for batch bash operations.
 * Both the `batch` tool (launch side) and `batch_bash_poll` tool (read side)
 * share the same instance.
 */
export class BashProcessTracker {
	private running = new Map<string, RunningProcess>();
	private completed = new Map<string, TrackedBashResult>();

	/** Launch a bash command. Returns immediately; the process runs in the background. */
	launch(
		id: string,
		command: string,
		cwd: string,
		signal?: AbortSignal,
	): void {
		// Abort any existing process with the same id
		this.abortById(id);
		this.completed.delete(id);

		const ac = new AbortController();
		const child = spawn(command, [], {
			cwd,
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			signal: ac.signal,
		});

		const rp: RunningProcess = {
			proc: child,
			command,
			startedAt: Date.now(),
			stdoutChunks: [],
			stderrChunks: [],
			abortController: ac,
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			rp.stdoutChunks.push(chunk.toString());
			capChunks(rp.stdoutChunks);
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			rp.stderrChunks.push(chunk.toString());
			capChunks(rp.stderrChunks);
		});

		// Wire parent signal
		if (signal) {
			const onParentAbort = () => this.abortById(id);
			if (signal.aborted) {
				this.abortById(id);
			} else {
				signal.addEventListener("abort", onParentAbort, { once: true });
				child.on("close", () => signal.removeEventListener("abort", onParentAbort));
			}
		}

		child.on("close", (code) => {
			this.running.delete(id);

			let stdout: string;
			let stderr: string;
			try {
				const rawStdout = rp.stdoutChunks.join("");
				const rawStderr = rp.stderrChunks.join("");
				const { stdout: compressedStdout, stderr: compressedStderr } = compressOutput(rp.command, rawStdout, rawStderr);
				stdout = truncateBashOutput(compressedStdout);
				stderr = truncateBashOutput(compressedStderr);
			} catch (e) {
				logWarn(`[pi-agent-flow] compressOutput failed, using raw output: ${e}`);
				stdout = truncateBashOutput(rp.stdoutChunks.join(""));
				stderr = truncateBashOutput(rp.stderrChunks.join(""));
			}
			const duration = Date.now() - rp.startedAt;
			const report = classifyDuration(duration);

			this.completed.set(id, {
				id,
				command,
				status: code === 0 ? "ok" : "error",
				exitCode: code ?? undefined,
				stdout,
				stderr,
				duration,
				timingTier: report.label,
			});
		});

		child.on("error", (err) => {
			this.running.delete(id);

			const duration = Date.now() - rp.startedAt;
			const report = classifyDuration(duration);
			let stdout: string;
			let stderr: string;
			try {
				const rawStdout = rp.stdoutChunks.join("");
				const rawStderr = rp.stderrChunks.join("");
				const { stdout: compressedStdout, stderr: compressedStderr } = compressOutput(rp.command, rawStdout, rawStderr);
				stdout = truncateBashOutput(compressedStdout);
				stderr = truncateBashOutput(compressedStderr) || err.message;
			} catch (e) {
				logWarn(`[pi-agent-flow] compressOutput failed, using raw output: ${e}`);
				stdout = truncateBashOutput(rp.stdoutChunks.join(""));
				stderr = truncateBashOutput(rp.stderrChunks.join("")) || err.message;
			}

			this.completed.set(id, {
				id,
				command,
				status: "aborted",
				exitCode: undefined,
				stdout,
				stderr,
				duration,
				timingTier: report.label,
			});
		});

		this.running.set(id, rp);
	}

	/** Check if a command is still running. */
	isRunning(id: string): boolean {
		return this.running.has(id);
	}

	/** Get the last N lines of a running process's stdout. */
	getRunningTail(id: string): string {
		const rp = this.running.get(id);
		if (!rp) return "";
		// Joining all chunks is fine because capChunks keeps the array bounded.
		const stdout = rp.stdoutChunks.join("");
		return tailLines(stdout, BASH_POLL_TAIL_LINES);
	}

	/** Get the command of a running process. */
	getRunningCommand(id: string): string | undefined {
		return this.running.get(id)?.command;
	}

	/** Get the result of a completed/aborted command. Does NOT remove from cache. */
	peekCompleted(id: string): TrackedBashResult | undefined {
		return this.completed.get(id);
	}

	/** Get the result of a completed/aborted command. Removes from completed cache. */
	popCompleted(id: string): TrackedBashResult | undefined {
		const result = this.completed.get(id);
		if (result) this.completed.delete(id);
		return result;
	}

	/** Get the start time of a running process. */
	getStartedAt(id: string): number | undefined {
		return this.running.get(id)?.startedAt;
	}

	/** Check if a command has completed. */
	hasCompleted(id: string): boolean {
		return this.completed.has(id);
	}

	/** Abort a running process by id. */
	private abortById(id: string): void {
		const rp = this.running.get(id);
		if (!rp) return;
		try {
			rp.abortController.abort();
			rp.proc.kill("SIGTERM");
		} catch (e) {
			logWarn(`[pi-agent-flow] Failed to kill bash process: ${e}`);
		}
	}

	/** Abort all running processes (cleanup). */
	abortAll(): void {
		for (const [id] of this.running) {
			this.abortById(id);
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tailLines(text: string, n: number): string {
	const lines = text.split("\n");
	return lines.slice(-n).join("\n");
}

/** Generate a short random ID for bash ops that don't provide one. */
/**
 * Run a single bash command with output truncation and optional timeout.
 * Returns a promise that resolves with stdout, stderr, and exitCode.
 * Uses execFile (synchronous completion) with truncateBashOutput applied.
 */
export function runBashWithLimits(
	command: string,
	cwd: string,
	timeoutMs?: number,
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve) => {
		const child = execFile("bash", ["-c", command], { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
			const out = truncateBashOutput(stdout);
			const err = truncateBashOutput(stderr);
			if (error) {
				resolve({ stdout: out, stderr: err, exitCode: error.code as number ?? 1 });
			} else {
				resolve({ stdout: out, stderr: err, exitCode: 0 });
			}
		});
		child.stdout?.setEncoding("utf-8");
		child.stderr?.setEncoding("utf-8");
		if (signal) {
			const onAbort = () => {
				child.kill("SIGTERM");
				resolve({ stdout: "", stderr: "[aborted]", exitCode: -1 });
			};
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}
	});
}

/**
 * Truncate bash stdout/stderr to prevent oversized tool results.
 * Applies line limit first, then byte limit, with clear markers.
 */
export function truncateBashOutput(
	text: string,
	maxBytes: number = MAX_BASH_OUTPUT_BYTES,
	maxLines: number = MAX_BASH_OUTPUT_LINES,
): string {
	return truncateBashOutputText(text, maxBytes, maxLines);
}

// Re-export normalizeBashOp and generateBashId from normalize.ts for backward compatibility
export { normalizeBashOp, generateBashId } from "./normalize.js";

/**
 * Execute a batch of bash ops concurrently.
 *
 * Launches all commands in parallel, then waits until all finish or the
 * soft timeout expires. The soft timeout is the max of per-op `t` values
 * (if any), or the global default. Commands that haven't finished within
 * the timeout are returned as "pending" with the last N lines of output.
 * They continue running in the background and can be polled via batch_bash_poll.
 */
export async function executeBatchBash(
	ops: Array<{ i: string; c: string; t?: number; h?: string }>,
	defaultCwd: string,
	tracker: BashProcessTracker,
	signal?: AbortSignal,
	softTimeoutMs: number = BASH_SOFT_TIMEOUT_MS,
): Promise<BashOpResult[]> {
	if (ops.length === 0) return [];

	// Compute the effective batch soft timeout: if per-op timeouts are specified,
	// use the minimum of those; otherwise fall back to the global default.
	const perOpTimeouts = ops.filter((op) => typeof op.t === "number" && op.t! > 0).map((op) => op.t!);
	const effectiveTimeout = perOpTimeouts.length > 0
		? Math.min(...perOpTimeouts)
		: softTimeoutMs;

	// Launch all commands in parallel
	for (const op of ops) {
		const cwd = op.h ? op.h : defaultCwd;
		tracker.launch(op.i, op.c, cwd, signal);
	}

	// Wait up to effectiveTimeout for all to finish
	await waitForSettle(ops, tracker, effectiveTimeout, signal);

	// Collect results
	const results: BashOpResult[] = [];
	for (const op of ops) {
		const completed = tracker.popCompleted(op.i);
		if (completed) {
			results.push({
				op: "bash",
				path: op.i,
				id: op.i,
				command: op.c,
				status: completed.status === "ok" ? "ok" : "error",
				exitCode: completed.exitCode,
				stdout: completed.stdout,
				stderr: completed.stderr,
				duration: completed.duration,
				timingTier: completed.timingTier,
			});
		} else {
			// Still running -- return pending with tail
			const tail = tracker.getRunningTail(op.i);
			results.push({
				op: "bash",
				path: op.i,
				id: op.i,
				command: op.c,
				status: "pending",
				stdout: tail,
				stderr: "",
				duration: Date.now() - getStartTime(tracker, op.i),
			});
		}
	}

	return results;
}

/** Get the start time of a running process, or Date.now() if not found. */
function getStartTime(tracker: BashProcessTracker, id: string): number {
	return tracker.getStartedAt(id) ?? Date.now();
}

/**
 * Wait until all ops have completed or the soft timeout expires.
 * Uses a polling check every 100ms.
 */
function waitForSettle(
	ops: Array<{ i: string }>,
	tracker: BashProcessTracker,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise<void>((resolve) => {
		const deadline = Date.now() + timeoutMs;

		const check = () => {
			if (signal?.aborted) {
				resolve();
				return;
			}
			const allDone = ops.every((op) => !tracker.isRunning(op.i));
			if (allDone || Date.now() >= deadline) {
				resolve();
				return;
			}
			setTimeout(check, 100);
		};
		check();
	});
}

/** Poll for completed bash results. */
export function pollBatchBashResults(
	ids: string[],
	tracker: BashProcessTracker,
): PendingBashResult[] {
	const results: PendingBashResult[] = [];
	for (const id of ids) {
		if (tracker.hasCompleted(id)) {
			const r = tracker.popCompleted(id)!;
			results.push({
				id,
				command: r.command,
				status: "completed",
				exitCode: r.exitCode,
				stdout: r.stdout,
				stderr: r.stderr,
				duration: r.duration,
				timingTier: r.timingTier,
			});
		} else if (tracker.isRunning(id)) {
			results.push({
				id,
				command: tracker.getRunningCommand(id) ?? "",
				status: "pending",
				stdout: tracker.getRunningTail(id),
			});
		} else {
			results.push({
				id,
				command: tracker.getRunningCommand(id) ?? "",
				status: "pending",
				stdout: "",
			});
		}
	}
	return results;
}

// ---------------------------------------------------------------------------
// Poll tool schema & factory
// ---------------------------------------------------------------------------

const BatchBashPollParams = Type.Object({
	i: Type.Array(Type.String(), {
		description: "Array of bash operation IDs to poll for results.",
		minItems: 1,
	}),
});

export function createBatchBashPollTool(tracker: BashProcessTracker) {
	return {
		name: "batch_bash_poll",
		label: "batch_bash_poll",
		description: [
			"Poll for results of pending bash commands from a previous batch call.",
			"Pass the IDs of pending commands to check their status.",
			"Returns completed results with full stdout/stderr, or indicates still-pending with last output lines.",
		].join("\n"),
		promptSnippet: "Poll pending bash commands for results",
		promptGuidelines: [
			"Use `batch_bash_poll` to check on bash commands that returned pending from a batch call.",
			"Pass the `i` (id) values from the pending results.",
		],
		parameters: BatchBashPollParams,

		prepareArguments(input: unknown): unknown {
			if (!input || typeof input !== "object") return { i: [] };
			const args = input as Record<string, unknown>;
			const ids = args.i ?? args.ids;
			if (!Array.isArray(ids)) return { i: [] };
			return { i: ids };
		},

		async execute(
			_toolCallId: string,
			input: unknown,
			_signal?: AbortSignal,
			_onUpdate?: unknown,
		) {
			const args = (input ?? {}) as Record<string, unknown>;
			const ids = Array.isArray(args.i) ? (args.i as string[]) : Array.isArray(args.ids) ? (args.ids as string[]) : [];

			if (ids.length === 0) {
				throw new Error("Error: i (ids) array is required and must not be empty.");
			}

			const results = pollBatchBashResults(ids, tracker);

			const lines: string[] = [];
			for (const r of results) {
				if (r.status === "completed") {
					const exitInfo = r.exitCode !== undefined ? `exit ${r.exitCode}` : "interrupted";
					lines.push(`--- [${r.id}] ${exitInfo} ---`);
					if (r.timingTier) lines.push(`[Execution time: ${r.timingTier}]`);
					if (r.stdout?.trim()) lines.push(r.stdout.trimEnd());
					if (r.stderr?.trim()) lines.push(`[stderr]\n${r.stderr.trimEnd()}`);
				} else {
					lines.push(`--- [${r.id}] still running ---`);
					if (r.stdout?.trim()) lines.push(`[output so far]\n${r.stdout.trimEnd()}`);
				}
				lines.push("");
			}

			return {
				content: [{ type: "text", text: lines.join("\n").trimEnd() }],
				details: { results },
			};
		},
	};
}
