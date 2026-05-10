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
import { formatBatchOpsSummary } from "./batch/render.js";
import { formatCompactStats, formatCompactTokenPair, formatCountdown, formatFlowTypeName, italic, lowerFirstWord, truncateChars, tailText, getTruncationBudget, visibleLength } from "./render-utils.js";

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

type ThemeFg = (color: string, text: string) => string;
type ThemeBg = (color: string, text: string) => string;
type FlowTheme = { fg: ThemeFg; bold: (s: string) => string; bg: ThemeBg };

function formatCollapsedFlowHeaderTypeName(type: string): string {
	return type.toLowerCase();
}

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
		case "batch":
		case "batch_read": {
			const summary = formatBatchOpsSummary(args);
			return fg("muted", `${toolName} `) + fg("accent", summary);
		}
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

/** Center a label in a fixed-width header using em-dashes. Total width = 20. */
function sectionHeader(label: string): string {
	const total = 20;
	const innerLen = label.length + 2; // account for spaces around label
	const side = (total - innerLen) / 2;
	const left = "─".repeat(Math.floor(side));
	const right = "─".repeat(Math.ceil(side));
	return `${left} ${label} ${right}`;
}

function getLiveCountdown(r: SingleResult): string | undefined {
	if (r.exitCode !== -1 || typeof r.deadlineAtMs !== "number") return undefined;
	return formatCountdown(r.deadlineAtMs - Date.now());
}

function formatAimLinePrefix(treePrefix: string, r: SingleResult): string {
	const countdown = getLiveCountdown(r);
	const aimLabel = italic("aim:");
	return countdown ? `${treePrefix} ${aimLabel} [${countdown}] - ` : `${treePrefix} ${aimLabel} `;
}

function formatMsgLinePrefix(treePrefix: string, r: SingleResult): string {
	const msgLabel = italic("msg:");
	return `${treePrefix} ${msgLabel} [${formatCompactTokenPair(r.usage)}] - `;
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
				aim: flowRequest.aim || flowRequest.intent || "Processing...",
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
	container.addChild(new Text(theme.fg("muted", sectionHeader("intent")), 0, 0));
	container.addChild(new Text(theme.fg("dim", r.intent), 0, 0));

	// Flow report (structured output)
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", sectionHeader("report")), 0, 0));

	// Structured output summary (compact badge when available)
	if (r.structuredOutput) {
		const so = r.structuredOutput;
		const statusColor = so.status === "complete" ? "success" : so.status === "partial" ? "warning" : "error";
		container.addChild(new Text(
			`${theme.fg(statusColor, `[${so.status}]`)} ${theme.fg("dim", so.summary)}`,
			0, 0,
		));
		if (so.files.length > 0) {
			container.addChild(new Text(theme.fg("dim", `Files: ${so.files.map((f) => f.path).join(", ")}`), 0, 0));
		}
		if (so.commands?.length > 0) {
			const cmdLabels = so.commands.map((c) => {
				const short = c.command.length > 30 ? c.command.slice(0, 30) + "..." : c.command;
				return `${c.tool ?? "cmd"}: ${short}`;
			});
			container.addChild(new Text(theme.fg("dim", `Commands: ${cmdLabels.join(", ")}`), 0, 0));
		}
		if (so.notDone.length > 0) {
			const notDoneText = so.notDone.map((item) => {
				const details = [
					item.reason ? `reason: ${item.reason}` : undefined,
					item.blocker ? `blocker: ${item.blocker}` : undefined,
					item.nextStep ? `next: ${item.nextStep}` : undefined,
				].filter(Boolean).join("; ");
				return details ? `${item.item} (${details})` : item.item;
			}).join("; ");
			container.addChild(new Text(theme.fg("dim", `Not Done: ${notDoneText}`), 0, 0));
		}
		if (so.nextSteps.length > 0) {
			container.addChild(new Text(theme.fg("dim", `Next: ${so.nextSteps.join("; ")}`), 0, 0));
		}
		container.addChild(new Spacer(1));
	}

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
		container.addChild(new Text(theme.fg("muted", sectionHeader("tool calls")), 0, 0));
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
	const stats = formatCompactStats(r.usage, r.model, maxWidth, { skipTokens: true, skipContext: true, hideModel: true });
	const typeName = formatCollapsedFlowHeaderTypeName(r.type);
	const modelLabel = r.model ? r.model.replace(/^[^/]+\//, "").toLowerCase() : "";
	let header = `${theme.fg("accent", theme.bold(typeName))}${theme.fg("dim", modelLabel ? ` - ${modelLabel} - ` : " - ")}${theme.fg("dim", stats)}`;
	if (error && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
	container.addChild(new TruncatedText(header, 0, 0));

	// aim: line (short headline)
	if (r.aim) {
		const aimPrefix = formatAimLinePrefix("├─", r);
		const dirContent = truncateChars(lowerFirstWord(r.aim), getTruncationBudget(visibleLength(aimPrefix)));
		container.addChild(new TruncatedText(`${theme.fg("dim", aimPrefix)}${theme.fg("dim", dirContent)}`, 0, 0));
	}

	// act: line (last tool call with count)
	const lastTool = getLastToolCall(r.messages);
	if (lastTool) {
		const actStr = formatFlowToolCall(lastTool.name, lastTool.args, theme.fg.bind(theme));
		const actPrefix = `├─ ${italic("act:")} [${r.usage.toolCalls}] - `;
		const actContent = truncateChars(lowerFirstWord(actStr), getTruncationBudget(visibleLength(actPrefix)));
		container.addChild(new TruncatedText(`${theme.fg("dim", actPrefix)}${actContent}`, 0, 0));
	}

	// msg: line (last assistant text or streaming)
	const msgPrefix = formatMsgLinePrefix("└─", r);
	const msgBudget = getTruncationBudget(visibleLength(msgPrefix));
	if (r.exitCode === -1 && streamingText) {
		const logContent = tailText(streamingText, msgBudget);
		container.addChild(new TruncatedText(`${theme.fg("dim", msgPrefix)}${theme.fg("dim", logContent)}`, 0, 0));
	} else if (r.structuredOutput?.summary) {
		const logContent = truncateChars(r.structuredOutput.summary, msgBudget);
		container.addChild(new TruncatedText(`${theme.fg("dim", msgPrefix)}${theme.fg("dim", logContent)}`, 0, 0));
	} else if (flowOutput) {
		const logContent = tailText(flowOutput, msgBudget);
		container.addChild(new TruncatedText(`${theme.fg("dim", msgPrefix)}${theme.fg("dim", logContent)}`, 0, 0));
	} else if (streamingText) {
		const logContent = tailText(streamingText, msgBudget);
		container.addChild(new TruncatedText(`${theme.fg("dim", msgPrefix)}${theme.fg("dim", logContent)}`, 0, 0));
	} else if (error && r.errorMessage) {
		const logContent = truncateChars(r.errorMessage, msgBudget);
		container.addChild(new TruncatedText(`${theme.fg("dim", msgPrefix)}${theme.fg("error", logContent)}`, 0, 0));
	} else {
		container.addChild(new TruncatedText(`${theme.fg("dim", msgPrefix)}${theme.fg("dim", "[n/a]")}`, 0, 0));
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
		container.addChild(new Text(theme.fg("muted", sectionHeader(typeName)), 0, 0));

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
			container.addChild(new Text(theme.fg("muted", sectionHeader("tool calls")), 0, 0));
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
		const stats = formatCompactStats(r.usage, r.model, maxWidth, { skipTokens: true, skipContext: true, hideModel: true });
		const error = isFlowError(r);
		const typeName = formatCollapsedFlowHeaderTypeName(r.type);

		// Header line
		const headerPrefix = isLast ? "└─" : "├─";
		const modelLabel = r.model ? r.model.replace(/^[^/]+\//, "").toLowerCase() : "";
		let headerLine = `${theme.fg("dim", headerPrefix)} ${theme.fg("accent", theme.bold(typeName))}${theme.fg("dim", modelLabel ? ` - ${modelLabel} - ` : " - ")}${theme.fg("dim", stats)}`;
		if (error && r.stopReason) {
			headerLine += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
		}
		container.addChild(new TruncatedText(headerLine, 0, 0));

		// Continuation indent for sub-lines
		const indent = isLast ? "   " : "│  ";

		// aim: line (short headline)
		if (r.aim) {
			const aimPrefix = formatAimLinePrefix(indent + "├─", r);
			const dirContent = truncateChars(lowerFirstWord(r.aim), getTruncationBudget(visibleLength(aimPrefix)));
			container.addChild(new TruncatedText(`${theme.fg("dim", aimPrefix)}${theme.fg("dim", dirContent)}`, 0, 0));
		}

		// act: line (last tool call with count)
		const lastTool = getLastToolCall(r.messages);
		if (lastTool) {
			const actStr = formatFlowToolCall(lastTool.name, lastTool.args, theme.fg.bind(theme));
			const actPrefix = `${indent}├─ ${italic("act:")} [${r.usage.toolCalls}] - `;
			const actContent = truncateChars(lowerFirstWord(actStr), getTruncationBudget(visibleLength(actPrefix)));
			container.addChild(new TruncatedText(`${theme.fg("dim", actPrefix)}${actContent}`, 0, 0));
		}

		// msg: line (live streaming text or last assistant text)
		const msgPrefix = formatMsgLinePrefix(indent + "└─", r);
		const msgBudget = getTruncationBudget(visibleLength(msgPrefix));
		const liveText = r.exitCode === -1 ? r.streamingText : undefined;
		const lastText = liveText || getLastAssistantText(r.messages);
		if (lastText) {
			const logContent = tailText(lastText, msgBudget);
			container.addChild(new TruncatedText(`${theme.fg("dim", msgPrefix)}${theme.fg("dim", logContent)}`, 0, 0));
		} else if (error && r.errorMessage) {
			const logContent = truncateChars(r.errorMessage, msgBudget);
			container.addChild(new TruncatedText(`${theme.fg("dim", msgPrefix)}${theme.fg("error", logContent)}`, 0, 0));
		} else {
			container.addChild(new TruncatedText(`${theme.fg("dim", msgPrefix)}${theme.fg("dim", "[n/a]")}`, 0, 0));
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
