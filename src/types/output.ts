/**
 * Structured output and compression types.
 */

/** Structured file entry in a flow's output. */
export interface FileEntry {
	/** Path to the file, relative or absolute. */
	path: string;
	/** Semantic role of this file in the flow's work. */
	role?: "reference" | "read" | "modified" | "created" | "deleted" | "test";
	/** Why this file matters (1 sentence). */
	description?: string;
	/** Short excerpt or snippet (not full content). */
	snippet?: string;
	/** Specific line ranges of interest. */
	ranges?: Array<{
		start: number;
		end: number;
		/** Free-form label like "bug", "fix", "ref", "added". */
		label?: string;
	}>;
}

/** Structured command/tool invocation entry in a flow's output. */
export interface CommandEntry {
	/** The exact verbatim command string or tool call that was executed. */
	command: string;
	/** Tool used: bash, grep, find, ls, batch, read, write, edit, flow, web. */
	tool?: string;
	/** Execution time classification from the timed bash wrapper (e.g. "3.5s (normal)"). */
	executionTime?: string;
}

/** Action performed or attempted by a flow. */
export interface Action {
	type: string;
	description: string;
	target?: string;
	result?: "success" | "failure" | "partial" | "skipped";
	evidence?: string;
}

/** Incomplete, skipped, blocked, or deferred work reported by a flow. */
export interface NotDoneItem {
	/** The unfinished item. */
	item: string;
	/** Why the item was not completed. */
	reason?: string;
	/** Concrete blocker preventing completion, when applicable. */
	blocker?: string;
	/** Suggested follow-up for this item. */
	nextStep?: string;
}

/** Structured JSON output from a flow run. */
export interface FlowStructuredOutput {
	/** Schema version for forward compatibility. */
	version: string;
	/** Overall completion status. */
	status: "complete" | "partial" | "blocked" | "failed";
	/** 1–3 sentence summary of what was accomplished. */
	summary: string;
	/** Files touched, read, or referenced. */
	files: FileEntry[];
	/** Actions performed or attempted. */
	actions: Action[];
	/** Commands or tool calls executed during the flow. */
	commands: CommandEntry[];
	/** Incomplete, skipped, blocked, or deferred work. */
	notDone: NotDoneItem[];
	/** Recommended next steps or follow-up flows. */
	nextSteps: string[];
	/** Reasoning chains, hypotheses, inferences made during the flow. */
	reasoning: string[];
	/** Observations, warnings, caveats, side notes. */
	notes: string[];
	/** Escape hatch for flow-specific data (audit findings, debug root cause, etc.). */
	extensions?: Record<string, unknown>;
}

/** Compressed representation of a flow result for child context inheritance. */
export interface CompressedFlowResult {
	/** Flow type (scout, build, debug, etc.). */
	type: string;
	/** Execution outcome. */
	status: "accomplished" | "failed" | "aborted";
	/** Original mission intent. */
	intent?: string;
	/** Short headline of what the flow aimed to do. */
	aim?: string;
	/** 1–3 sentence summary of what was accomplished. */
	summary?: string;
	/** Files touched, read, or referenced. */
	files?: FileEntry[];
	/** Actions performed or attempted. */
	actions?: Action[];
	/** Commands or tool calls executed. */
	commands?: CommandEntry[];
	/** Incomplete, skipped, blocked, or deferred work. */
	notDone?: NotDoneItem[];
	/** Recommended next steps or follow-up flows. */
	nextSteps?: string[];
	/** Key hypotheses or inferences made during the flow. */
	reasoning?: string[];
	/** Observations, warnings, caveats, side notes. */
	notes?: string[];
	/** Error message for failed/aborted flows. */
	error?: string;
}

export interface DepthPolicy {
	showPreviews: boolean;
	showBytes: boolean;
	showSupersededBreadcrumbs: boolean;
	showEditBlocks: boolean;
}
