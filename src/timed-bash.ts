/**
 * Timed Bash Tool Wrapper
 *
 * Wraps the built-in bash tool to append execution-time classification
 * to every result. This gives the LLM concrete feedback to self-correct
 * strategy (e.g. switch from bash grep to grep tool, batch commands, etc.).
 *
 * Child flows also receive a hard deadline from the parent runner. When a
 * bash command is still running near that deadline, this wrapper aborts just
 * the bash tool and returns an explicit instruction to stop using tools and
 * summarize. That preserves the child agent process long enough to produce
 * its final structured report instead of being killed while a shell command is
 * still active.
 */

import * as fs from "node:fs";
import { createBashToolDefinition } from "@mariozechner/pi-coding-agent";
import { appendStrategicHintOnce, appendTextToToolResult } from "./tool-utils.js";

export type TimingTier =
	| "normal"
	| "avg"
	| "long"
	| "extreme_long"
	| "very_long";

export interface TimingReport {
	tier: TimingTier;
	seconds: number;
	label: string;
}

const FLOW_DEADLINE_ENV = "PI_FLOW_DEADLINE_MS";
const FLOW_TOOL_SUMMARY_GRACE_ENV = "PI_FLOW_TOOL_SUMMARY_GRACE_MS";
const FLOW_REMINDER_FILE_ENV = "PI_FLOW_REMINDER_FILE";
const DEFAULT_FLOW_TOOL_SUMMARY_GRACE_MS = 30_000;

/** Classify duration into user-defined tiers with actionable feedback. */
export function classifyDuration(ms: number): TimingReport {
	const s = ms / 1000;
	if (s < 10) {
		return { tier: "normal", seconds: s, label: `${s.toFixed(1)}s (normal)` };
	}
	if (s < 30) {
		return { tier: "avg", seconds: s, label: `${s.toFixed(1)}s (avg)` };
	}
	if (s < 60) {
		return {
			tier: "long",
			seconds: s,
			label: `${s.toFixed(1)}s (long)`,
		};
	}
	if (s < 300) {
		return {
			tier: "extreme_long",
			seconds: s,
			label: `${s.toFixed(1)}s (extreme long)`,
		};
	}
	return {
		tier: "very_long",
		seconds: s,
		label: `${(s / 60).toFixed(1)}min (very long)`,
	};
}

/** Format the timing appendix that gets appended to bash output. */
export function formatTimingAppendix(report: TimingReport): string {
	return `\n\n[Execution time: ${report.label}]`;
}

function parsePositiveSafeInteger(raw: unknown): number | null {
	if (typeof raw !== "string" || !raw.trim()) return null;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeSafeInteger(raw: unknown): number | null {
	if (typeof raw !== "string" || !raw.trim()) return null;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function getFlowDeadlineMs(): number | null {
	return parsePositiveSafeInteger(process.env[FLOW_DEADLINE_ENV]);
}

function getFlowToolSummaryGraceMs(): number {
	return parseNonNegativeSafeInteger(process.env[FLOW_TOOL_SUMMARY_GRACE_ENV]) ?? DEFAULT_FLOW_TOOL_SUMMARY_GRACE_MS;
}

function getFlowReminderFilePath(): string | null {
	const raw = process.env[FLOW_REMINDER_FILE_ENV];
	return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * Read any pending reminder from the reminder file set by the parent runner.
 * Returns the reminder text (without trailing newline), or null if no reminder exists.
 * Clears the file after reading so the agent only sees each reminder once.
 */
export function readAndClearReminderFile(): string | null {
	const filePath = getFlowReminderFilePath();
	if (!filePath) return null;
	try {
		if (!fs.existsSync(filePath)) return null;
		const content = fs.readFileSync(filePath, { encoding: "utf-8" }).trim();
		// Clear the file after reading so each reminder is only injected once.
		try { fs.writeFileSync(filePath, "", { encoding: "utf-8" }); } catch { /* best-effort */ }
		return content || null;
	} catch {
		return null;
	}
}

function formatDeadlineAppendix(): string {
	return "\n\n[Flow timeout] Bash command was interrupted to preserve time for the final flow summary. Stop running tools and return structured findings now.";
}



function createDeadlineSignal(parentSignal: AbortSignal | undefined): {
	signal: AbortSignal | undefined;
	cleanup: () => void;
	wasDeadlineAbort: () => boolean;
} {
	const deadlineMs = getFlowDeadlineMs();
	if (!deadlineMs) {
		return { signal: parentSignal, cleanup: () => undefined, wasDeadlineAbort: () => false };
	}

	const summaryGraceMs = getFlowToolSummaryGraceMs();
	const abortAtMs = deadlineMs - summaryGraceMs;
	const delayMs = abortAtMs - Date.now();

	const controller = new AbortController();
	let deadlineAbort = false;
	let timer: NodeJS.Timeout | undefined;
	let relayParentAbort: (() => void) | undefined;

	const abortForDeadline = () => {
		if (controller.signal.aborted) return;
		deadlineAbort = true;
		controller.abort(new Error("Flow deadline reached while bash command was running."));
	};

	if (parentSignal?.aborted) {
		controller.abort(parentSignal.reason);
	} else if (parentSignal) {
		relayParentAbort = () => controller.abort(parentSignal.reason);
		parentSignal.addEventListener("abort", relayParentAbort, { once: true });
	}

	if (delayMs <= 0) {
		abortForDeadline();
	} else {
		timer = setTimeout(abortForDeadline, delayMs);
		timer.unref?.();
	}

	return {
		signal: controller.signal,
		cleanup: () => {
			if (timer) clearTimeout(timer);
			if (parentSignal && relayParentAbort) {
				parentSignal.removeEventListener("abort", relayParentAbort);
			}
		},
		wasDeadlineAbort: () => deadlineAbort,
	};
}

/**
 * Create a timed bash tool definition that wraps the built-in one.
 * Extensions override built-in tools by name, so this replaces the
 * default `bash` tool transparently.
 *
 * Returns `null` if the underlying `createBashToolDefinition` is not
 * available (e.g. test environment or incompatible CLI version).
 */
export function createTimedBashToolDefinition(
	cwd: string,
	options?: {
		shellPath?: string;
		commandPrefix?: string;
		operations?: any;
		spawnHook?: any;
	},
): any {
	let original: any;
	try {
		original = createBashToolDefinition(cwd, options);
	} catch {
		return null;
	}
	if (!original || typeof original.execute !== "function") {
		return null;
	}

	return {
		...original,
		async execute(
			toolCallId: string,
			params: { command: string; timeout?: number },
			signal: AbortSignal,
			onUpdate: any,
			ctx: any,
		) {
			const start = Date.now();
			const deadlineSignal = createDeadlineSignal(signal);

			// Check for pending reminder from parent runner before executing bash.
			// This allows the parent to inject timeout warnings into the agent's context
			// via the tool result, since stdin is closed after spawn.
			const reminderPreamble = readAndClearReminderFile();

			try {
				const result = await original.execute(
					toolCallId,
					params,
					deadlineSignal.signal,
					onUpdate,
					ctx,
				);
				const duration = Date.now() - start;
				const report = classifyDuration(duration);
				const appendix = formatTimingAppendix(report);

				// Inject reminder preamble before timing info so it's the first thing the agent sees.
				if (reminderPreamble) {
					appendTextToToolResult(result, `\n\n[REMINDER FROM PARENT] ${reminderPreamble}`);
				}
				appendTextToToolResult(result, appendix);
				if (deadlineSignal.wasDeadlineAbort()) {
					appendTextToToolResult(result, formatDeadlineAppendix());
					result.isError = true;
				} else {
					appendStrategicHintOnce(result);
				}
				return result;
			} catch (err: any) {
				const duration = Date.now() - start;
				const report = classifyDuration(duration);
				const appendix = formatTimingAppendix(report);

				if (deadlineSignal.wasDeadlineAbort()) {
					const message = typeof err?.message === "string" && err.message.trim()
						? `${err.message}${appendix}${formatDeadlineAppendix()}`
						: `${appendix.trim()}${formatDeadlineAppendix()}`;
					return {
						content: [{ type: "text", text: message }],
						isError: true,
					};
				}

				if (err?.message && typeof err.message === "string") {
					err.message += appendix;
				}
				throw err;
			} finally {
				deadlineSignal.cleanup();
			}
		},
	};
}
