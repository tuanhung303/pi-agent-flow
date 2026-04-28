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
	getLastToolCall,
	getLastAssistantText,
	isFlowError,
	isFlowSuccess,
} from "./types.js";
import { formatFixedTokens, formatCompactStats, formatFlowTypeName, truncateChars, tailText, getTruncationBudget } from "./render-utils.js";

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
			const cmd = ((args.command as string) || "...").replace(/[\n\r\t]+/g, " ").replace(/ +/g, " ").trim();
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

export function renderFlowCall(args: Record<string, any>, theme: FlowTheme): Text {
	const flows = args.flow as Array<{ type: string; intent: string }> | undefined;

	// Minimal — renderFlowResult owns the full display
	return new Text("", 0, 0);
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

	// Header: uppercase type name with dots, no icon, no source
	const typeName = formatFlowTypeName(r.type);
	let header = theme.fg("toolTitle", theme.bold(typeName));
	if (error && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
	container.addChild(new Text(header, 0, 0));
	if (error && r.errorMessage) {
		container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
	}

	// Stats: all-in-one bracket format with context inline
	const statsParts: string[] = [];
	statsParts.push(`${formatFixedTokens(r.usage.input || 0)}↑`);
	statsParts.push(`${formatFixedTokens(r.usage.output || 0)}↓`);
	if (r.usage.cacheRead) statsParts.push(`cr:${formatFixedTokens(r.usage.cacheRead)}`);
	if (r.usage.contextTokens > 0) statsParts.push(`ctx:${formatFixedTokens(r.usage.contextTokens)}`);
	const inlineStats = `[ ${statsParts.join(" ")} ]${r.model ? ` ─ ${r.model}` : ""}`;
	container.addChild(new Text(theme.fg("dim", inlineStats), 0, 0));

	// Intent
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── intent ───"), 0, 0));
	container.addChild(new Text(theme.fg("dim", r.intent), 0, 0));

	// Flow report (structured output)
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── report ───"), 0, 0));
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
		container.addChild(new Text(theme.fg("muted", "─── tool calls ───"), 0, 0));
		container.addChild(new Text(toolTraces, 0, 0));
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
): Container {
	const container = new Container();
	const maxWidth = process.stdout.columns ?? 80;
	const stats = formatCompactStats(r.usage, r.model, maxWidth);
	const typeName = formatFlowTypeName(r.type);
	let header = `${theme.fg("accent", theme.bold(typeName))} ${theme.fg("dim", "─")} ${theme.fg("dim", stats)}`;
	if (error && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
	container.addChild(new Text(truncateChars(header, maxWidth), 0, 0));

	// dir: line (intent/objective)
	if (r.intent) {
		container.addChild(new Text(`${theme.fg("dim", "├─ dir:")} ${theme.fg("dim", truncateChars(r.intent, getTruncationBudget(8)))}`, 0, 0));
	}

	// exe: line (last tool call)
	const lastTool = getLastToolCall(r.messages);
	if (lastTool) {
		const exeStr = formatFlowToolCall(lastTool.name, lastTool.args, theme.fg.bind(theme));
		container.addChild(new Text(`${theme.fg("dim", "├─ exe:")} ${truncateChars(exeStr, getTruncationBudget(8))}`, 0, 0));
	}

	// log: line (last assistant text or streaming)
	if (flowOutput) {
		container.addChild(new Text(`${theme.fg("dim", "└─ log:")} ${theme.fg("dim", truncateChars(flowOutput, getTruncationBudget(8)))}`, 0, 0));
	} else if (streamingText) {
		container.addChild(new Text(`${theme.fg("dim", "└─ log:")} ${theme.fg("dim", tailText(streamingText, getTruncationBudget(8)))}`, 0, 0));
	} else if (error && r.errorMessage) {
		container.addChild(new Text(`${theme.fg("dim", "└─ log:")} ${theme.fg("error", truncateChars(r.errorMessage, getTruncationBudget(8)))}`, 0, 0));
	} else {
		container.addChild(new Text(`${theme.fg("dim", "└─ log:")} ${theme.fg("dim", "[n/a]")}`, 0, 0));
	}

	return container;
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

	// Summary: just show count, no icon
	container.addChild(new Text(
		theme.fg("accent", `${results.length} flows`),
		0, 0,
	));

	for (const r of results) {
		const displayItems = getFlowDisplayItems(r.messages);
		const flowOutput = getFlowOutput(r.messages);
		const typeName = formatFlowTypeName(r.type);

		container.addChild(new Spacer(1));
		// Per-flow header: ─── EXPLORER (no icon)
		container.addChild(new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", typeName)}`, 0, 0));

		// Stats: all-in-one bracket format with context inline
		const flowParts: string[] = [];
		flowParts.push(`${formatFixedTokens(r.usage.input || 0)}↑`);
		flowParts.push(`${formatFixedTokens(r.usage.output || 0)}↓`);
		if (r.usage.cacheRead) flowParts.push(`cr:${formatFixedTokens(r.usage.cacheRead)}`);
		if (r.usage.contextTokens > 0) flowParts.push(`ctx:${formatFixedTokens(r.usage.contextTokens)}`);
		const flowStats = `[ ${flowParts.join(" ")} ]${r.model ? ` ─ ${r.model}` : ""}`;
		container.addChild(new Text(theme.fg("dim", flowStats), 0, 0));

		// Intent: just show text, no prefix
		container.addChild(new Text(theme.fg("dim", r.intent), 0, 0));

		if (flowOutput) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(flowOutput.trim(), 0, 0, mdTheme));
		}

		// Tool traces in expanded view
		const toolTraces = renderToolTraces(displayItems, theme);
		if (toolTraces) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── tool calls ───"), 0, 0));
			container.addChild(new Text(toolTraces, 0, 0));
		}
	}

	// Total stats: all-in-one bracket format with context inline
	const totalUsage = aggregateFlowUsage(results);
	const totalModel = results[0]?.model;
	const totalParts: string[] = [];
	totalParts.push(`${formatFixedTokens(totalUsage.input || 0)}↑`);
	totalParts.push(`${formatFixedTokens(totalUsage.output || 0)}↓`);
	if (totalUsage.cacheRead) totalParts.push(`cr:${formatFixedTokens(totalUsage.cacheRead)}`);
	if (totalUsage.contextTokens > 0) totalParts.push(`ctx:${formatFixedTokens(totalUsage.contextTokens)}`);
	const totalStats = `[ ${totalParts.join(" ")} ]${totalModel ? ` ─ ${totalModel}` : ""}`;
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", totalStats), 0, 0));

	return container;
}

function renderActivityPanel(
	results: SingleResult[],
	theme: FlowTheme,
): Container {
	const container = new Container();
	const maxWidth = process.stdout.columns ?? 80;

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const isLast = i === results.length - 1;
		const stats = formatCompactStats(r.usage, r.model, maxWidth);
		const error = isFlowError(r);
		const typeName = formatFlowTypeName(r.type);

		// Header line
		const headerPrefix = isLast ? "└─" : "├─";
		let headerLine = `${theme.fg("dim", headerPrefix)} ${theme.fg("accent", theme.bold(typeName))} ${theme.fg("dim", "─")} ${theme.fg("dim", stats)}`;
		if (error && r.stopReason) {
			headerLine += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
		}
		container.addChild(new Text(truncateChars(headerLine, maxWidth), 0, 0));

		// Continuation indent for sub-lines
		const indent = isLast ? "   " : "│  ";

		// dir: line (intent/objective)
		if (r.intent) {
			container.addChild(new Text(`${theme.fg("dim", indent + "├─ dir:")} ${theme.fg("dim", truncateChars(r.intent, getTruncationBudget(11)))}`, 0, 0));
		}

		// exe: line (last tool call)
		const lastTool = getLastToolCall(r.messages);
		if (lastTool) {
			const exeStr = formatFlowToolCall(lastTool.name, lastTool.args, theme.fg.bind(theme));
			container.addChild(new Text(`${theme.fg("dim", indent + "├─ exe:")} ${truncateChars(exeStr, getTruncationBudget(11))}`, 0, 0));
		}

		// log: line (last assistant text)
		const lastText = getLastAssistantText(r.messages);
		if (lastText) {
			container.addChild(new Text(`${theme.fg("dim", indent + "└─ log:")} ${theme.fg("dim", truncateChars(lastText, getTruncationBudget(11)))}`, 0, 0));
		} else if (error && r.errorMessage) {
			container.addChild(new Text(`${theme.fg("dim", indent + "└─ log:")} ${theme.fg("error", truncateChars(r.errorMessage, getTruncationBudget(11)))}`, 0, 0));
		} else {
			container.addChild(new Text(`${theme.fg("dim", indent + "└─ log:")} ${theme.fg("dim", "[n/a]")}`, 0, 0));
		}

		// Add blank line separator between flows (with continuation pipe)
		if (!isLast) {
			container.addChild(new Text(theme.fg("dim", "│"), 0, 0));
		}
	}

	container.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand tool traces)"), 0, 0));

	return container;
}

function renderMultiFlowCollapsed(
	results: SingleResult[],
	theme: FlowTheme,
): Container {
	return renderActivityPanel(results, theme);
}
