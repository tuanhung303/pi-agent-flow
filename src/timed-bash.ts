/**
 * Timed Bash Tool Wrapper
 *
 * Wraps the built-in bash tool to append execution-time classification
 * to every result. This gives the LLM concrete feedback to self-correct
 * strategy (e.g. switch from bash grep to grep tool, batch commands, etc.).
 */

import { createBashToolDefinition } from "@mariozechner/pi-coding-agent";

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

/** Classify duration into user-defined tiers with actionable feedback. */
export function classifyDuration(ms: number): TimingReport {
	const s = ms / 1000;
	if (s < 10) {
		return { tier: "normal", seconds: s, label: `${s.toFixed(1)}s (normal)` };
	}
	if (s < 30) {
		return { tier: "avg", seconds: s, label: `${s.toFixed(1)}s (avg) — user feedback: consider improving the current commands or find a better solution` };
	}
	if (s < 60) {
		return {
			tier: "long",
			seconds: s,
			label: `${s.toFixed(1)}s (long) — user feedback: consider improving the whole scripts`,
		};
	}
	if (s < 300) {
		return {
			tier: "extreme_long",
			seconds: s,
			label: `${s.toFixed(1)}s (extreme long) — user feedback: should consider to improve the whole scripts`,
		};
	}
	return {
		tier: "very_long",
		seconds: s,
		label: `${(s / 60).toFixed(1)}min (very long) — user feedback: consider to improve, only run when everything tested with other means`,
	};
}

/** Format the timing appendix that gets appended to bash output. */
export function formatTimingAppendix(report: TimingReport): string {
	return `\n\n[Execution time: ${report.label}]`;
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
			try {
				const result = await original.execute(
					toolCallId,
					params,
					signal,
					onUpdate,
					ctx,
				);
				const duration = Date.now() - start;
				const report = classifyDuration(duration);
				const appendix = formatTimingAppendix(report);

				const textItem = result.content?.find(
					(c: any) => c.type === "text",
				);
				if (textItem && typeof textItem.text === "string") {
					textItem.text += appendix;
				} else if (result.content) {
					result.content.push({ type: "text", text: appendix.trim() });
				}
				return result;
			} catch (err: any) {
				const duration = Date.now() - start;
				const report = classifyDuration(duration);
				const appendix = formatTimingAppendix(report);

				if (err?.message && typeof err.message === "string") {
					err.message += appendix;
				}
				throw err;
			}
		},
	};
}
