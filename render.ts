/**
 * TUI rendering for flow-state tool calls and results.
 *
 * Option B: collapsed view shows structured report (Summary/Done/Not Done/Next Steps).
 * Expanded view adds raw tool call traces.
 */

import * as os from "node:os";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text, TruncatedText } from "@mariozechner/pi-tui";
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
import { formatCompactStats, formatFlowTypeName, truncateChars, contentBudget } from "./render-utils.js";

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
	args?: Record<string, any>,
): Container | Text {
	const details = result.details as FlowDetails | undefined;
	const streamingText = result.content?.[0]?.type === "text" ? result.content[0].text : undefined;

	if (!details || details.results.length === 0) {
		// Ghost Dashboard: render a placeholder status line during the zero state
		const flowRequest = args?.flow?.[0];
		if (flowRequest) {
			const ghostResult: SingleResult = {
				type: flowRequest.type || "unknown",
				agentSource: "user",
				intent: flowRequest.intent || "Processing...",
				exitCode: -1, // In progress
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, toolCalls: 0 },
			};
			return renderFlowCollapsed(ghostResult, flowStatusIcon(ghostResult, theme), false, streamingText || "", theme);
		}
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

	// Stats: dashboard format
	const inlineStats = formatCompactStats(r.usage, r.model);
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
	container.addChild(new TruncatedText(header, 0, 0));

	// dir: line (intent/objective)
	if (r.intent) {
		const dirContent = truncateChars(r.intent, contentBudget(10));
		container.addChild(new TruncatedText(`${theme.fg("dim", "├─ dir:")} ${theme.fg("dim", dirContent)}`, 0, 0));
	}

	// act: line (last tool call with count)
	const lastTool = getLastToolCall(r.messages);
	if (lastTool) {
		const actStr = formatFlowToolCall(lastTool.name, lastTool.args, theme.fg.bind(theme));
		const actPrefix = `act: [${r.usage.toolCalls}] - `;
		const actContent = truncateChars(actStr, contentBudget(10));
		container.addChild(new TruncatedText(`${theme.fg("dim", "├─ " + actPrefix)}${actContent}`, 0, 0));
	}

	// log: line (last assistant text or streaming)
	if (flowOutput) {
		const logContent = truncateChars(flowOutput, contentBudget(10));
		container.addChild(new TruncatedText(`${theme.fg("dim", "└─ log:")} ${theme.fg("dim", logContent)}`, 0, 0));
	} else if (streamingText) {
		const logContent = truncateChars(streamingText, contentBudget(10));
		container.addChild(new TruncatedText(`${theme.fg("dim", "└─ log:")} ${theme.fg("dim", logContent)}`, 0, 0));
	} else if (error && r.errorMessage) {
		const logContent = truncateChars(r.errorMessage, contentBudget(10));
		container.addChild(new TruncatedText(`${theme.fg("dim", "└─ log:")} ${theme.fg("error", logContent)}`, 0, 0));
	} else {
		container.addChild(new TruncatedText(`${theme.fg("dim", "└─ log:")} ${theme.fg("dim", "[n/a]")}`, 0, 0));
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

		// Stats: dashboard format
		const flowStats = formatCompactStats(r.usage, r.model);
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

	// Total stats: dashboard format
	const totalUsage = aggregateFlowUsage(results);
	const totalModel = results[0]?.model;
	const totalStats = formatCompactStats(totalUsage, totalModel);
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
		container.addChild(new TruncatedText(headerLine, 0, 0));

		// Continuation indent for sub-lines
		const indent = isLast ? "   " : "│  ";

		// dir: line (intent/objective)
		if (r.intent) {
			const dirContent = truncateChars(r.intent, contentBudget(10));
			container.addChild(new TruncatedText(`${theme.fg("dim", indent + "├─ dir:")} ${theme.fg("dim", dirContent)}`, 0, 0));
		}

		// act: line (last tool call with count)
		const lastTool = getLastToolCall(r.messages);
		if (lastTool) {
			const actStr = formatFlowToolCall(lastTool.name, lastTool.args, theme.fg.bind(theme));
			const actPrefix = `act: [${r.usage.toolCalls}] - `;
			const actContent = truncateChars(actStr, contentBudget(10));
			container.addChild(new TruncatedText(`${theme.fg("dim", indent + "├─ " + actPrefix)}${actContent}`, 0, 0));
		}

		// log: line (last assistant text)
		const lastText = getLastAssistantText(r.messages);
		if (lastText) {
			const logContent = truncateChars(lastText, contentBudget(10));
			container.addChild(new TruncatedText(`${theme.fg("dim", indent + "└─ log:")} ${theme.fg("dim", logContent)}`, 0, 0));
		} else if (error && r.errorMessage) {
			const logContent = truncateChars(r.errorMessage, contentBudget(10));
			container.addChild(new TruncatedText(`${theme.fg("dim", indent + "└─ log:")} ${theme.fg("error", logContent)}`, 0, 0));
		} else {
			container.addChild(new TruncatedText(`${theme.fg("dim", indent + "└─ log:")} ${theme.fg("dim", "[n/a]")}`, 0, 0));
		}

		// Add blank line separator between flows (with continuation pipe)
		if (!isLast) {
			container.addChild(new TruncatedText(theme.fg("dim", "│"), 0, 0));
		}
	}

	container.addChild(new TruncatedText(theme.fg("muted", "(Ctrl+O to expand tool traces)"), 0, 0));

	return container;
}

function renderMultiFlowCollapsed(
	results: SingleResult[],
	theme: FlowTheme,
): Container {
	return renderActivityPanel(results, theme);
}
