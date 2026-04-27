/**
 * TUI rendering for flow-state tool calls and results.
 *
 * Option B: collapsed view shows structured report (Summary/Done/Not Done/Next Steps).
 * Expanded view adds raw tool call traces.
 */

import * as os from "node:os";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { getFlowSummaryText } from "./runner-events.js";
import {
	type DisplayItem,
	type SingleResult,
	type FlowDetails,
	type UsageStats,
	aggregateFlowUsage,
	getFlowDisplayItems,
	getFlowOutput,
	isFlowError,
	isFlowSuccess,
} from "./types.js";
import { formatTokens, formatFlowUsage, formatCompactStats, truncateChars, tailText } from "./render-utils.js";

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

type ThemeFg = (color: string, text: string) => string;
type ThemeBg = (color: string, text: string) => string;
type FlowTheme = { fg: ThemeFg; bold: (s: string) => string; bg: ThemeBg };

function formatFlowToolCall(toolName: string, args: Record<string, unknown>, fg: ThemeFg): string {
	const pathArg = (args.file_path || args.path || "...") as string;

	switch (toolName) {
		case "bash": {
			const cmd = (args.command as string) || "...";
			return fg("muted", "$ ") + fg("toolOutput", cmd);
		}
		case "read": {
			let text = fg("accent", shortenPath(pathArg));
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit !== undefined ? start + limit - 1 : "";
				text += fg("warning", `:${start}${end ? `-${end}` : ""}`);
			}
			return fg("muted", "read ") + text;
		}
		case "write": {
			const lines = ((args.content || "") as string).split("\n").length;
			let text = fg("muted", "write ") + fg("accent", shortenPath(pathArg));
			if (lines > 1) text += fg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit":
			return fg("muted", "edit ") + fg("accent", shortenPath(pathArg));
		case "ls":
			return fg("muted", "ls ") + fg("accent", shortenPath((args.path || ".") as string));
		case "find":
			return fg("muted", "find ") + fg("accent", (args.pattern || "*") as string) + fg("dim", ` in ${shortenPath((args.path || ".") as string)}`);
		case "grep":
			return fg("muted", "grep ") + fg("accent", `/${(args.pattern || "") as string}/`) + fg("dim", ` in ${shortenPath((args.path || ".") as string)}`);
		default:
			return fg("accent", toolName) + fg("dim", ` ${JSON.stringify(args)}`);
	}
}

// ---------------------------------------------------------------------------
// Shared rendering building blocks
// ---------------------------------------------------------------------------

function splitOutputLines(text: string): string[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function renderToolTraces(
	items: DisplayItem[],
	theme: { fg: ThemeFg },
): string {
	const lines: string[] = [];
	for (const item of items) {
		if (item.type === "toolCall") {
			lines.push(theme.fg("muted", "→ ") + formatFlowToolCall(item.name, item.args, theme.fg.bind(theme)));
		}
	}
	return lines.join("\n");
}

function renderFlowReport(
	output: string,
	theme: { fg: ThemeFg },
): string {
	const lines = splitOutputLines(output);
	return lines.map((line) => theme.fg("toolOutput", line)).join("\n");
}

function flowStatusIcon(r: SingleResult, theme: { fg: ThemeFg }): string {
	if (r.exitCode === -1) return theme.fg("warning", "⏳");
	return isFlowError(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

// ---------------------------------------------------------------------------
// renderFlowCall — shown while the flow is being invoked
// ---------------------------------------------------------------------------

function truncateText(text: string): string {
	const words = text.split(/\s+/);
	if (words.length <= 12) return text;
	return `${words.slice(0, 3).join(" ")} ... ${words.slice(-8).join(" ")}`;
}

export function renderFlowCall(args: Record<string, any>, theme: FlowTheme): Text {
	const flows = args.flow as Array<{ type: string; intent: string }> | undefined;

	// Minimal — renderFlowResult owns the full display
	return new Text("", 0, 0);

	return new Text(theme.fg("muted", "(empty flow call)"), 0, 0);
}

// ---------------------------------------------------------------------------
// renderFlowResult — shown after the flow completes
// ---------------------------------------------------------------------------

export function renderFlowResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	expanded: boolean,
	theme: FlowTheme,
): Container | Text {
	const details = result.details as FlowDetails | undefined;
	const streamingText = result.content?.[0]?.type === "text" ? result.content[0].text : undefined;

	if (!details || details.results.length === 0) {
		return new Text(streamingText || "", 0, 0);
	}

	if (details.results.length === 1) {
		return renderSingleFlowResult(details.results[0], expanded, theme, streamingText);
	}

	return renderMultiFlowResult(details, expanded, theme);
}

// ---------------------------------------------------------------------------
// Single flow result
// ---------------------------------------------------------------------------

function renderSingleFlowResult(
	r: SingleResult,
	expanded: boolean,
	theme: FlowTheme,
	streamingText?: string,
): Container | Text {
	const error = isFlowError(r);
	const icon = flowStatusIcon(r, theme);
	const displayItems = getFlowDisplayItems(r.messages);
	const flowOutput = getFlowOutput(r.messages);

	if (expanded) {
		return renderFlowExpanded(r, icon, error, displayItems, flowOutput, theme);
	}
	return renderFlowCollapsed(r, icon, error, flowOutput, theme, streamingText);
}

function renderFlowExpanded(
	r: SingleResult,
	icon: string,
	error: boolean,
	displayItems: DisplayItem[],
	flowOutput: string,
	theme: FlowTheme,
): Container {
	const mdTheme = getMarkdownTheme();
	const container = new Container();

	// Header
	let header = `${icon} ${theme.fg("toolTitle", theme.bold(`[${r.type}]`))}${theme.fg("muted", ` (${r.agentSource})`)}`;
	if (error && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
	container.addChild(new Text(header, 0, 0));
	if (error && r.errorMessage) {
		container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
	}

	// Intent
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Intent ───"), 0, 0));
	container.addChild(new Text(theme.fg("dim", r.intent), 0, 0));

	// Flow report (structured output)
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Report ───"), 0, 0));
	if (flowOutput) {
		container.addChild(new Markdown(flowOutput.trim(), 0, 0, mdTheme));
	} else {
		const summary = getFlowSummaryText(r);
		container.addChild(new Text(theme.fg("muted", summary), 0, 0));
	}

	// Tool traces (expanded only)
	const toolTraces = renderToolTraces(displayItems, theme);
	if (toolTraces) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Tool Calls ───"), 0, 0));
		container.addChild(new Text(toolTraces, 0, 0));
	}

	// Usage
	const usageStr = formatFlowUsage(r.usage, r.model);
	if (usageStr) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
	}

	return container;
}



function renderFlowCollapsed(
	r: SingleResult,
	icon: string,
	error: boolean,
	flowOutput: string,
	theme: FlowTheme,
	streamingText?: string,
): Text {
	const stats = formatCompactStats(r.usage, r.model);
	let text = `${theme.bg("selectedBg", theme.fg("accent", theme.bold(r.type)))} ${theme.fg("dim", "─")} ${theme.fg("dim", stats)}`;
	if (error && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;

	// Intent line
	if (r.intent) {
		text += `\n${theme.fg("dim", `├─ int:`)} ${theme.fg("dim", truncateChars(r.intent, 40))}`;
	}

	// Output line
	if (flowOutput) {
		text += `\n${theme.fg("dim", "└─ msg:")} ${renderFlowReport(truncateChars(flowOutput, 25), theme)}`;
	} else if (streamingText) {
		text += `\n${theme.fg("dim", "└─ msg:")} ${theme.fg("dim", tailText(streamingText, 40))}`;
	} else if (error && r.errorMessage) {
		text += `\n${theme.fg("dim", "└─ msg:")} ${theme.fg("error", truncateChars(r.errorMessage, 25))}`;
	} else {
		text += `\n${theme.fg("dim", "└─ msg:")} ${theme.fg("dim", "[n/a]")}`;
	}

	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// Multi-flow result
// ---------------------------------------------------------------------------

function renderMultiFlowResult(
	details: FlowDetails,
	expanded: boolean,
	theme: FlowTheme,
): Container | Text {
	const results = details.results;
	const successCount = results.filter((r) => isFlowSuccess(r)).length;
	const failCount = results.filter((r) => isFlowError(r)).length;
	const icon = failCount > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");

	if (expanded) {
		return renderMultiFlowExpanded(results, successCount, icon, theme);
	}
	return renderMultiFlowCollapsed(results, theme);
}

function renderMultiFlowExpanded(
	results: SingleResult[],
	successCount: number,
	icon: string,
	theme: FlowTheme,
): Container {
	const mdTheme = getMarkdownTheme();
	const container = new Container();

	container.addChild(new Text(
		`${icon} ${theme.fg("toolTitle", theme.bold("flow "))}${theme.fg("accent", `${successCount}/${results.length} flows`)}`,
		0, 0,
	));

	for (const r of results) {
		const rIcon = flowStatusIcon(r, theme);
		const displayItems = getFlowDisplayItems(r.messages);
		const flowOutput = getFlowOutput(r.messages);

		container.addChild(new Spacer(1));
		container.addChild(new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", `[${r.type}]`)} ${rIcon}`, 0, 0));
		container.addChild(new Text(theme.fg("muted", "Intent: ") + theme.fg("dim", r.intent), 0, 0));

		if (flowOutput) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(flowOutput.trim(), 0, 0, mdTheme));
		}

		// Tool traces in expanded view
		const toolTraces = renderToolTraces(displayItems, theme);
		if (toolTraces) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Tool Calls ───"), 0, 0));
			container.addChild(new Text(toolTraces, 0, 0));
		}

		const taskUsage = formatFlowUsage(r.usage, r.model);
		if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
	}

	const totalUsage = formatFlowUsage(aggregateFlowUsage(results));
	if (totalUsage) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
	}

	return container;
}

function renderMultiFlowCollapsed(
	results: SingleResult[],
	theme: FlowTheme,
): Text {
	let text = "";

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const isLast = i === results.length - 1;
		const flowOutput = getFlowOutput(r.messages);
		const stats = formatCompactStats(r.usage, r.model);
		const error = isFlowError(r);

		// Header line
		const headerPrefix = isLast ? "└─" : "├─";
		let line = `${theme.fg("dim", headerPrefix)} ${theme.bg("selectedBg", theme.fg("accent", theme.bold(r.type)))}`;
		if (stats) {
			line += ` ${theme.fg("dim", "─")} ${theme.fg("dim", stats)}`;
		}
		if (error && r.stopReason) {
			line += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
		}
		if (i > 0) text += "\n";
		text += line;

		// Continuation indent for sub-lines
		const indent = isLast ? "   " : "│  ";

		// Intent line
		if (r.intent) {
			const intentPrefix = hasMsg ? "├─" : "└─";
			text += `\n${theme.fg("dim", indent + intentPrefix + " int:")} ${theme.fg("dim", truncateChars(r.intent, 40))}`;
		}

		// Output line
		if (flowOutput) {
			text += `\n${theme.fg("dim", indent + "└─ msg:")} ${renderFlowReport(truncateChars(flowOutput, 25), theme)}`;
		} else if (error && r.errorMessage) {
			text += `\n${theme.fg("dim", indent + "└─ msg:")} ${theme.fg("error", truncateChars(r.errorMessage, 25))}`;
		} else {
			text += `\n${theme.fg("dim", indent + "└─ msg:")} ${theme.fg("dim", "[n/a]")}`;
		}
	}

	text += `\n${theme.fg("muted", "(Ctrl+O to expand tool traces)")}`;

	return new Text(text, 0, 0);
}
