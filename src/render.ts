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
import { scrambleManager, runScrambleTimer, DynamicScrambleText, getLiveText } from "./scramble.js";
import { formatCompactStats, formatCompactTokenPair, formatCountdown, formatFlowTypeName, italic, lowerFirstWord, truncateChars, tailText, getTruncationBudget, visibleLength, stripAnsi } from "./render-utils.js";

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
	if (r.exitCode === -1) return theme.fg("warning", "(pending)");
	return isFlowError(r) ? theme.fg("error", "(error)") : theme.fg("success", "(done)");
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



// ---------------------------------------------------------------------------
// renderFlowCall — shown while the flow is being invoked
// ---------------------------------------------------------------------------

export function renderFlowCall(args: Record<string, any>, theme: FlowTheme): Container | Text {
	let container: Container | Text = new Text("", 0, 0);

	// In-place mutation pattern: reuse the stored root container
	// so the TUI host's cached reference stays valid.
	if (args?.state) {
		const s = args.state as Record<string, any>;
		if (!s.__rootContainer) {
			const root = new Container();
			root.addChild(container);
			s.__rootContainer = root;
			container = root;
		} else if (container !== s.__rootContainer) {
			const root = s.__rootContainer as Container;
			root.clear();
			root.addChild(container);
			root.invalidate();
			container = root;
		}
	}

	return container;
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

	let container: Container | Text;

	if (!details || details.results.length === 0) {
		// Ghost Dashboard: render a placeholder status line during the zero state
		const flowRequest = args?.flow?.[0];
		if (flowRequest) {
			const ghostResult: SingleResult = {
				type: flowRequest.type || "unknown",
				agentSource: "user",
				intent: flowRequest.intent || "Processing...",
				aim: flowRequest.aim || flowRequest.intent || "Processing...",
				acceptance: flowRequest.acceptance,
				exitCode: -1, // In progress
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, toolCalls: 0 },
			};
			if (expanded) {
			const now = Date.now();
			container = renderFlowExpanded(ghostResult, flowStatusIcon(ghostResult, theme), false, getFlowDisplayItems([]), getFlowOutput([]), theme, "ghost", now, false, streamingText || "");
		} else {
			container = renderFlowCollapsed(ghostResult, flowStatusIcon(ghostResult, theme), false, streamingText || "", theme);
		}
		} else {
			container = new Text(scrambleManager.renderStatic(streamingText || ""), 0, 0);
		}
	} else if (details.results.length === 1) {
		container = renderSingleFlowResult(details.results[0], expanded, theme, streamingText, (result as any)._toolCallId);
	} else {
		container = renderMultiFlowResult(details, expanded, theme, (result as any)._toolCallId);
	}

	// In-place mutation pattern: reuse the stored root container
	// so the TUI host's cached reference stays valid.
	if (args?.state) {
		const s = args.state as Record<string, any>;
		if (!s.__rootContainer) {
			// First render: store the container
			s.__rootContainer = container;
		} else if (container !== s.__rootContainer) {
			// Subsequent renders: transfer children to the stored container
			const root = s.__rootContainer as Container;
			root.clear();
			if (container instanceof Container) {
				for (const child of (container as Container).children) {
					root.addChild(child);
				}
			} else {
				// container is a Text — wrap it as a child
				root.addChild(container);
			}
			root.invalidate();
			container = root;
		}
	}

	// Scramble animation timer — shared helper so any renderer can animate.
	runScrambleTimer(args as Record<string, any> | undefined);

	return container;
}

// ---------------------------------------------------------------------------
// Single flow result
// ---------------------------------------------------------------------------

export function renderSingleFlowResult(
	r: SingleResult,
	expanded: boolean,
	theme: FlowTheme,
	streamingText?: string,
	toolCallId?: string,
): Container | Text {
	const id = toolCallId || "single";
	const error = isFlowError(r);
	const icon = flowStatusIcon(r, theme);
	const displayItems = getFlowDisplayItems(r.messages);
	const flowOutput = getFlowOutput(r.messages);
	const now = Date.now();
	const isComplete = r.exitCode !== -1;

	if (expanded) {
		return renderFlowExpanded(r, icon, error, displayItems, flowOutput, theme, id, now, isComplete, streamingText);
	}
	return renderFlowCollapsed(r, icon, error, flowOutput, theme, streamingText, id);
}

function renderFlowExpanded(
	r: SingleResult,
	icon: string,
	error: boolean,
	displayItems: DisplayItem[],
	flowOutput: string,
	theme: FlowTheme,
	id: string,
	now: number,
	isComplete: boolean,
	streamingText?: string,
): Container {
	const mdTheme = getMarkdownTheme();
	const container = new Container();

	// Header: uppercase type name with dots, no icon, no source
	const typeName = formatFlowTypeName(r.type);
	let header = theme.fg("toolTitle", theme.bold(typeName));
	if (error && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
	const plainHeader = typeName + (error && r.stopReason ? ` [${r.stopReason}]` : "");
	container.addChild(new DynamicScrambleText(
		header,
		() => {
			const result = scrambleManager.updateText(id, 'header', plainHeader, Date.now(), isComplete);
			return result.isAnimating ? theme.fg("toolTitle", result.content) : header;
		}
	));
	if (error && r.errorMessage) {
		container.addChild(new Text(scrambleManager.renderStatic(theme.fg("error", `Error: ${r.errorMessage}`)), 0, 0));
	}

	// Stats: dashboard format
	const inlineStats = formatCompactStats(r.usage, r.model);
	container.addChild(new DynamicScrambleText(
		theme.fg("dim", inlineStats),
		() => {
			const result = scrambleManager.updateText(id, 'stats', stripAnsi(inlineStats), Date.now(), isComplete);
			return result.isAnimating ? theme.fg("dim", result.content) : theme.fg("dim", inlineStats);
		}
	));

	// Intent
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", sectionHeader("intent")), 0, 0));
	container.addChild(new DynamicScrambleText(
		theme.fg("dim", r.intent),
		() => {
			const result = scrambleManager.updateText(id, 'intent', r.intent, Date.now(), isComplete);
			return result.isAnimating ? theme.fg("dim", result.content) : theme.fg("dim", r.intent);
		}
	));

	// Acceptance
	if (r.acceptance) {
		const acceptanceText = r.acceptance;
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", sectionHeader("acceptance")), 0, 0));
		container.addChild(new DynamicScrambleText(
			theme.fg("dim", acceptanceText),
			() => {
				const result = scrambleManager.updateText(id, 'acceptance', acceptanceText, Date.now(), isComplete);
				return result.isAnimating ? theme.fg("dim", result.content) : theme.fg("dim", acceptanceText);
			}
		));
	}

	// Flow report (structured output)
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", sectionHeader("report")), 0, 0));

	// Structured output summary (compact badge when available)
	if (r.structuredOutput) {
		const so = r.structuredOutput;
		const statusColor = so.status === "complete" ? "success" : so.status === "partial" ? "warning" : "error";
		const statusText = `[${so.status}] ${so.summary}`;
		const statusStatic = `${theme.fg(statusColor, `[${so.status}]`)} ${theme.fg("dim", so.summary)}`;
		container.addChild(new DynamicScrambleText(
			statusStatic,
			() => {
				const result = scrambleManager.updateText(id, 'report-status', statusText, Date.now(), isComplete, false);
				return result.isAnimating ? `${theme.fg(statusColor, result.content.split(' ')[0])} ${theme.fg("dim", result.content.slice(result.content.indexOf(' ') + 1))}` : statusStatic;
			}
		));
		if (so.files.length > 0) {
			const filesText = `Files: ${so.files.map((f) => f.path).join(", ")}`;
			container.addChild(new DynamicScrambleText(
				theme.fg("dim", filesText),
				() => {
					const result = scrambleManager.updateText(id, 'report-files', filesText, Date.now(), isComplete, false);
					return result.isAnimating ? theme.fg("dim", result.content) : theme.fg("dim", filesText);
				}
			));
		}
		if (so.commands?.length > 0) {
			const cmdLabels = so.commands.map((c) => {
				const short = c.command.length > 30 ? c.command.slice(0, 30) + "..." : c.command;
				return `${c.tool ?? "cmd"}: ${short}`;
			});
			const commandsText = `Commands: ${cmdLabels.join(", ")}`;
			container.addChild(new DynamicScrambleText(
				theme.fg("dim", commandsText),
				() => {
					const result = scrambleManager.updateText(id, 'report-commands', commandsText, Date.now(), isComplete, false);
					return result.isAnimating ? theme.fg("dim", result.content) : theme.fg("dim", commandsText);
				}
			));
		}
		if (so.notDone.length > 0) {
			const notDoneText = `Not Done: ${so.notDone.map((item) => {
				const details = [
					item.reason ? `reason: ${item.reason}` : undefined,
					item.blocker ? `blocker: ${item.blocker}` : undefined,
					item.nextStep ? `next: ${item.nextStep}` : undefined,
				].filter(Boolean).join("; ");
				return details ? `${item.item} (${details})` : item.item;
			}).join("; ")}`;
			container.addChild(new DynamicScrambleText(
				theme.fg("dim", notDoneText),
				() => {
					const result = scrambleManager.updateText(id, 'report-notDone', notDoneText, Date.now(), isComplete, false);
					return result.isAnimating ? theme.fg("dim", result.content) : theme.fg("dim", notDoneText);
				}
			));
		}
		if (so.nextSteps.length > 0) {
			const nextStepsText = `Next: ${so.nextSteps.join("; ")}`;
			container.addChild(new DynamicScrambleText(
				theme.fg("dim", nextStepsText),
				() => {
					const result = scrambleManager.updateText(id, 'report-nextSteps', nextStepsText, Date.now(), isComplete, false);
					return result.isAnimating ? theme.fg("dim", result.content) : theme.fg("dim", nextStepsText);
				}
			));
		}
		container.addChild(new Spacer(1));
	}

	// Output: animate streaming text; show clean markdown when complete
	if (!isComplete && streamingText != null) {
		const streamingText_ = streamingText;
		const initialScrambled = scrambleManager.updateMsg(id, stripAnsi(streamingText_), now, isComplete, undefined, true).content;
		container.addChild(new DynamicScrambleText(
			initialScrambled,
			() => {
				const freshStreamingText = getLiveText(id) ?? streamingText_;
				return scrambleManager.updateMsg(id, stripAnsi(freshStreamingText), Date.now(), isComplete, undefined, true).content;
			}
		));
	} else if (flowOutput) {
		container.addChild(new Markdown(flowOutput.trim(), 0, 0, mdTheme));
	} else {
		const summary = getFlowSummaryText(r);
		container.addChild(new DynamicScrambleText(
			theme.fg("muted", summary),
			() => {
				const result = scrambleManager.updateText(id, 'output-summary', summary, Date.now(), isComplete, false);
				return result.isAnimating ? theme.fg("muted", result.content) : theme.fg("muted", summary);
			}
		));
	}

	// Tool traces (expanded only) — per-line scramble
	const toolCallItems = displayItems.filter((item) => item.type === "toolCall");
	if (toolCallItems.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", sectionHeader("tool calls")), 0, 0));
		for (let i = 0; i < toolCallItems.length; i++) {
			const item = toolCallItems[i] as Extract<DisplayItem, { type: "toolCall" }>;
			const lineText = theme.fg("muted", "→ ") + formatFlowToolCall(item.name, item.args, theme.fg.bind(theme));
			const plainText = stripAnsi(lineText);
			const initialScrambled = scrambleManager.updateText(id, `tool#${i}`, plainText, now, isComplete).content;
			container.addChild(new DynamicScrambleText(
				initialScrambled,
				() => scrambleManager.updateText(id, `tool#${i}`, plainText, Date.now(), isComplete).content
			));
		}
	}

	if (isComplete) {
		scrambleManager.completeFlow(id);
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
	toolCallId?: string,
): Container {
	const id = toolCallId || "collapsed";
	const now = Date.now();
	const container = new Container();
	const maxWidth = process.stdout.columns ?? 80;
	const stats = formatCompactStats(r.usage, r.model, maxWidth, { skipTokens: true, skipContext: true, hideModel: true });

	const isComplete = r.exitCode !== -1;

	// Flash TPS value when it changes
	const tpsMatch = stats.match(/tps:\s*(\S+)/);
	let displayStats = stats;
	if (tpsMatch) {
		const scrambledTps = scrambleManager.updateTps(id, tpsMatch[1], now, isComplete, true);
		if (scrambledTps !== tpsMatch[1]) {
			displayStats = stats.replace(tpsMatch[1], scrambledTps);
		}
	}

	const typeName = formatCollapsedFlowHeaderTypeName(r.type);
	const modelLabel = r.model ? r.model.replace(/^[^/]+\//, "").toLowerCase() : "";
	let header = `${theme.fg("accent", theme.bold(typeName))}${theme.fg("dim", modelLabel ? ` - ${modelLabel} - ` : " - ")}${theme.fg("dim", displayStats)}`;
	if (error && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
	// Scramble header on first render; show full styled header when complete
	const plainHeader = typeName + (modelLabel ? ` - ${modelLabel} - ` : " - ") + stripAnsi(displayStats) + (error && r.stopReason ? ` [${r.stopReason}]` : "");
	container.addChild(new DynamicScrambleText(
		header,
		() => {
			const result = scrambleManager.updateText(id, 'header', plainHeader, Date.now(), isComplete, true);
			return result.isAnimating ? theme.fg("accent", result.content) : header;
		},
		true,
	));

	// aim: line — cascade/ripple/illuminate on text change
	if (r.aim) {
		const countdown = getLiveCountdown(r);
		const treePrefix = "├─";
		const aimPrefix = countdown
			? `${treePrefix} aim: [${countdown}] - `
			: `${treePrefix} aim: `;
		const budget = getTruncationBudget(visibleLength(aimPrefix));
		const displayAim = truncateChars(lowerFirstWord(r.aim), budget);
		container.addChild(new DynamicScrambleText(
			`${theme.fg("dim", aimPrefix)}${theme.fg("dim", italic(displayAim))}`,
			() => {
				const result = scrambleManager.updateAim(id, displayAim, Date.now(), isComplete, true);
				return `${theme.fg("dim", aimPrefix)}${theme.fg("dim", italic(result.content))}`;
			},
			true,
		));
	}

	// act: line (last tool call with count)
	const lastTool = getLastToolCall(r.messages);
	if (lastTool) {
		const actStr = formatFlowToolCall(lastTool.name, lastTool.args, theme.fg.bind(theme));
		const prefixStub = `├─ act: [${r.usage.toolCalls}] - `;
		const budget = getTruncationBudget(visibleLength(prefixStub));
		const actFullText = stripAnsi(lowerFirstWord(actStr));
		const initialActContent = actFullText.length > budget ? actFullText.slice(0, budget) : actFullText;
		container.addChild(new DynamicScrambleText(
			`${theme.fg("dim", prefixStub)}${italic(initialActContent)}`,
			() => {
				const now = Date.now();
				let actContent: string;
				if (scrambleManager.getMode() === 'stream') {
					actContent = scrambleManager.streamAct(id, actFullText, now, isComplete, budget);
				} else {
					const displayAct = truncateChars(actFullText, budget);
					actContent = scrambleManager.updateAct(id, displayAct, now, isComplete, true).content;
				}
				let actKpi = String(r.usage.toolCalls);
				const scrambledActKpi = scrambleManager.updateActKpi(id, actKpi, now, isComplete, true);
				if (scrambledActKpi !== actKpi) {
					actKpi = scrambledActKpi;
				}
				const actPrefix = `├─ act: [${actKpi}] - `;
				return `${theme.fg("dim", actPrefix)}${italic(actContent)}`;
			},
			true,
		));
	}

	// msg: line (last assistant text or streaming)
	let msgKpi = formatCompactTokenPair(r.usage);
	const scrambledMsgKpi = scrambleManager.updateMsgKpi(id, msgKpi, now, isComplete, false);
	if (scrambledMsgKpi !== msgKpi) {
		msgKpi = scrambledMsgKpi;
	}
	const msgPrefixStub = `└─ msg: [${msgKpi}] - `;
	const msgBudget = getTruncationBudget(visibleLength(msgPrefixStub));

	let rawMsg: string;
	let useError = false;
	const liveText = getLiveText(id);
	if (liveText != null) {
		rawMsg = stripAnsi(liveText);
	} else if (r.exitCode === -1 && streamingText != null) {
		rawMsg = stripAnsi(streamingText);
	} else if (r.structuredOutput?.summary) {
		rawMsg = stripAnsi(r.structuredOutput.summary);
	} else if (flowOutput) {
		rawMsg = stripAnsi(flowOutput);
	} else if (streamingText != null) {
		rawMsg = stripAnsi(streamingText);
	} else if (error && r.errorMessage) {
		rawMsg = stripAnsi(r.errorMessage);
		useError = true;
	} else {
		rawMsg = "[n/a]";
	}

	const initialMsgContent = scrambleManager.getMode() === 'stream'
		? scrambleManager.streamMsg(id, rawMsg, now, isComplete, msgBudget)
		: scrambleManager.updateMsg(id, rawMsg, now, isComplete, undefined, true).content;
	const initialMsgPrefix = `└─ msg: [${msgKpi}] - `;
	container.addChild(new DynamicScrambleText(
		`${theme.fg("dim", initialMsgPrefix)}${theme.fg(useError ? "error" : "dim", italic(initialMsgContent))}`,
		() => {
			const now = Date.now();
			let msgKpi = formatCompactTokenPair(r.usage);
			const scrambledMsgKpi = scrambleManager.updateMsgKpi(id, msgKpi, now, isComplete, false);
			if (scrambledMsgKpi !== msgKpi) {
				msgKpi = scrambledMsgKpi;
			}
			const msgPrefix = `└─ msg: [${msgKpi}] - `;
			const freshRawMsg = getLiveText(id) ?? rawMsg;
			if (scrambleManager.getMode() === 'stream') {
				return `${theme.fg("dim", msgPrefix)}${theme.fg(useError ? "error" : "dim", italic(scrambleManager.streamMsg(id, freshRawMsg, now, isComplete, msgBudget)))}`;
			} else {
				const needsTail = r.exitCode === -1 || streamingText != null || getLiveText(id) != null;
				const displayMsg = needsTail ? tailText(freshRawMsg, msgBudget) : truncateChars(freshRawMsg, msgBudget);
				const result = isComplete
					? scrambleManager.updateMsg(id, displayMsg, now, isComplete, undefined, true)
					: scrambleManager.updateMsg(id, freshRawMsg, now, isComplete, undefined, true);
				return `${theme.fg("dim", msgPrefix)}${theme.fg(useError ? "error" : "dim", italic(result.content))}`;
			}
		},
		true,
	));

	if (isComplete) {
		scrambleManager.completeFlow(id);
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
	toolCallId?: string,
): Container | Text {
	const baseId = toolCallId || "multi";
	const results = details.results;
	const successCount = results.filter((r) => isFlowSuccess(r)).length;
	const failCount = results.filter((r) => isFlowError(r)).length;
	const icon = failCount > 0 ? theme.fg("warning", "(!)") : theme.fg("success", "(ok)");
	const now = Date.now();

	if (expanded) {
		return renderMultiFlowExpanded(results, successCount, icon, theme, baseId, now);
	}
	return renderMultiFlowCollapsed(results, theme, baseId);
}

function renderMultiFlowExpanded(
	results: SingleResult[],
	successCount: number,
	icon: string,
	theme: FlowTheme,
	baseId: string,
	now: number,
): Container {
	const mdTheme = getMarkdownTheme();
	const container = new Container();

	// Summary: just show count, no icon
	container.addChild(new Text(
		theme.fg("accent", `${results.length} flows`),
		0, 0,
	));

	for (let flowIdx = 0; flowIdx < results.length; flowIdx++) {
		const r = results[flowIdx];
		const flowId = `${baseId}#${flowIdx}`;
		const isComplete = r.exitCode !== -1;
		const displayItems = getFlowDisplayItems(r.messages);
		const flowOutput = getFlowOutput(r.messages);
		const typeName = formatFlowTypeName(r.type);

		container.addChild(new Spacer(1));
		// Per-flow header: ─── EXPLORER (no icon)
		const headerStatic = theme.fg("muted", sectionHeader(typeName));
		container.addChild(new DynamicScrambleText(
			headerStatic,
			() => {
				const result = scrambleManager.updateText(flowId, 'header', typeName, Date.now(), isComplete, true);
				return result.isAnimating ? theme.fg("muted", result.content) : headerStatic;
			}
		));

		// Stats: dashboard format
		const flowStats = formatCompactStats(r.usage, r.model);
		container.addChild(new DynamicScrambleText(
			theme.fg("dim", flowStats),
			() => {
				const result = scrambleManager.updateText(flowId, 'stats', stripAnsi(flowStats), Date.now(), isComplete, true);
				return result.isAnimating ? theme.fg("dim", result.content) : theme.fg("dim", flowStats);
			}
		));

		// Intent: just show text, no prefix
		container.addChild(new DynamicScrambleText(
			theme.fg("dim", r.intent),
			() => {
				const result = scrambleManager.updateText(flowId, 'intent', r.intent, Date.now(), isComplete, true);
				return result.isAnimating ? theme.fg("dim", result.content) : theme.fg("dim", r.intent);
			}
		));

		if (r.acceptance) {
			const acceptanceText = r.acceptance;
			const acceptanceStatic = theme.fg("dim", `Acceptance: ${acceptanceText}`);
			container.addChild(new DynamicScrambleText(
				acceptanceStatic,
				() => {
					const result = scrambleManager.updateText(flowId, 'acceptance', acceptanceText, Date.now(), isComplete, true);
					return result.isAnimating ? theme.fg("dim", result.content) : acceptanceStatic;
				}
			));
		}

		// Output: animate streaming text; show clean markdown when complete
		if (!isComplete && r.streamingText != null) {
			const streamingText_ = r.streamingText;
			const initialScrambled = scrambleManager.updateMsg(flowId, stripAnsi(streamingText_), now, isComplete, undefined, true).content;
			container.addChild(new DynamicScrambleText(
				initialScrambled,
				() => {
					const freshStreamingText = getLiveText(flowId) ?? streamingText_;
					return scrambleManager.updateMsg(flowId, stripAnsi(freshStreamingText), Date.now(), isComplete, undefined, true).content;
				}
			));
		} else if (flowOutput) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(flowOutput.trim(), 0, 0, mdTheme));
		}

		// Tool traces in expanded view — per-line scramble
		const toolCallItems = displayItems.filter((item) => item.type === "toolCall");
		if (toolCallItems.length > 0) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", sectionHeader("tool calls")), 0, 0));
			for (let i = 0; i < toolCallItems.length; i++) {
				const item = toolCallItems[i] as Extract<DisplayItem, { type: "toolCall" }>;
				const lineText = theme.fg("muted", "→ ") + formatFlowToolCall(item.name, item.args, theme.fg.bind(theme));
				const plainText = stripAnsi(lineText);
				const initialScrambled = scrambleManager.updateText(flowId, `tool#${i}`, plainText, now, isComplete).content;
				container.addChild(new DynamicScrambleText(
					initialScrambled,
					() => scrambleManager.updateText(flowId, `tool#${i}`, plainText, Date.now(), isComplete).content
				));
			}
		}

		if (isComplete) {
			scrambleManager.completeFlow(flowId);
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
	baseId?: string,
): Container {
	const idPrefix = baseId || "panel";
	const container = new Container();
	const maxWidth = process.stdout.columns ?? 80;
	const now = Date.now();

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const isLast = i === results.length - 1;
		const flowId = `${idPrefix}#${i}`;
		const stats = formatCompactStats(r.usage, r.model, maxWidth, { skipTokens: true, skipContext: true, hideModel: true });

		// Flash TPS value when it changes
		const tpsMatch = stats.match(/tps:\s*(\S+)/);
		const flowComplete = r.exitCode !== -1;
		let displayStats = stats;
		if (tpsMatch) {
			const scrambledTps = scrambleManager.updateTps(flowId, tpsMatch[1], now, flowComplete, true);
			if (scrambledTps !== tpsMatch[1]) {
				displayStats = stats.replace(tpsMatch[1], scrambledTps);
			}
		}

		const error = isFlowError(r);
		const typeName = formatCollapsedFlowHeaderTypeName(r.type);

		// Header line
		const headerPrefix = isLast ? "└─" : "├─";
		const modelLabel = r.model ? r.model.replace(/^[^/]+\//, "").toLowerCase() : "";
		let headerLine = `${theme.fg("dim", headerPrefix)} ${theme.fg("accent", theme.bold(typeName))}${theme.fg("dim", modelLabel ? ` - ${modelLabel} - ` : " - ")}${theme.fg("dim", displayStats)}`;
		if (error && r.stopReason) {
			headerLine += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
		}
		const plainHeader = headerPrefix + " " + typeName + (modelLabel ? ` - ${modelLabel} - ` : " - ") + stripAnsi(displayStats) + (error && r.stopReason ? ` [${r.stopReason}]` : "");
		container.addChild(new DynamicScrambleText(
			headerLine,
			() => {
				const result = scrambleManager.updateText(flowId, 'header', plainHeader, Date.now(), flowComplete, true);
				return result.isAnimating ? theme.fg("accent", result.content) : headerLine;
			},
			true,
		));

		// Continuation indent for sub-lines
		const indent = isLast ? "   " : "│  ";

		// aim: line — cascade/ripple/illuminate on text change
		if (r.aim) {
			const countdown = getLiveCountdown(r);
			const treePrefix = indent + "├─";
			const aimPrefix = countdown
				? `${treePrefix} aim: [${countdown}] - `
				: `${treePrefix} aim: `;
			const budget = getTruncationBudget(visibleLength(aimPrefix));
			const displayAim = truncateChars(lowerFirstWord(r.aim), budget);
			container.addChild(new DynamicScrambleText(
				`${theme.fg("dim", aimPrefix)}${theme.fg("dim", italic(displayAim))}`,
				() => {
					const result = scrambleManager.updateAim(flowId, displayAim, Date.now(), flowComplete, true);
					return `${theme.fg("dim", aimPrefix)}${theme.fg("dim", italic(result.content))}`;
				},
				true,
			));
		}

		// act: line (last tool call with count)
		const lastTool = getLastToolCall(r.messages);
		if (lastTool) {
			const actStr = formatFlowToolCall(lastTool.name, lastTool.args, theme.fg.bind(theme));
			const prefixStub = `${indent}├─ act: [${r.usage.toolCalls}] - `;
			const budget = getTruncationBudget(visibleLength(prefixStub));
			const actFullText = stripAnsi(lowerFirstWord(actStr));
			const initialActContent = actFullText.length > budget ? actFullText.slice(0, budget) : actFullText;
			container.addChild(new DynamicScrambleText(
				`${theme.fg("dim", prefixStub)}${italic(initialActContent)}`,
				() => {
					const now = Date.now();
					let actContent: string;
					if (scrambleManager.getMode() === 'stream') {
						actContent = scrambleManager.streamAct(flowId, actFullText, now, flowComplete, budget);
					} else {
						const displayAct = truncateChars(actFullText, budget);
						actContent = scrambleManager.updateAct(flowId, displayAct, now, flowComplete, true).content;
					}
					let actKpi = String(r.usage.toolCalls);
					const scrambledActKpi = scrambleManager.updateActKpi(flowId, actKpi, now, flowComplete, false);
					if (scrambledActKpi !== actKpi) {
						actKpi = scrambledActKpi;
					}
					const actPrefix = `${indent}├─ act: [${actKpi}] - `;
					return `${theme.fg("dim", actPrefix)}${italic(actContent)}`;
				},
				true,
			));
		}

		// msg: line (live streaming text or last assistant text)
		let msgKpi = formatCompactTokenPair(r.usage);
		const scrambledMsgKpi = scrambleManager.updateMsgKpi(flowId, msgKpi, now, flowComplete, false);
		if (scrambledMsgKpi !== msgKpi) {
			msgKpi = scrambledMsgKpi;
		}
		const msgPrefixStub = `${indent}└─ msg: [${msgKpi}] - `;
		const msgBudget = getTruncationBudget(visibleLength(msgPrefixStub));
		const liveText = r.exitCode === -1 ? r.streamingText : undefined;
		const lastText = liveText || getLastAssistantText(r.messages);

		let rawMsg: string;
		let useError = false;
		const liveText_ = getLiveText(flowId);
		if (liveText_ != null) {
			rawMsg = stripAnsi(liveText_);
		} else if (lastText) {
			rawMsg = stripAnsi(lastText);
		} else if (error && r.errorMessage) {
			rawMsg = stripAnsi(r.errorMessage);
			useError = true;
		} else {
			rawMsg = "[n/a]";
		}

		container.addChild(new DynamicScrambleText(
			`${theme.fg("dim", msgPrefixStub)}${theme.fg(useError ? "error" : "dim", italic(rawMsg))}`,
			() => {
				const now = Date.now();
				let msgKpi = formatCompactTokenPair(r.usage);
				const scrambledMsgKpi = scrambleManager.updateMsgKpi(flowId, msgKpi, now, flowComplete, false);
				if (scrambledMsgKpi !== msgKpi) {
					msgKpi = scrambledMsgKpi;
				}
				const msgPrefix = `${indent}└─ msg: [${msgKpi}] - `;
				const freshRawMsg = getLiveText(flowId) ?? rawMsg;
				if (scrambleManager.getMode() === 'stream') {
					return `${theme.fg("dim", msgPrefix)}${theme.fg(useError ? "error" : "dim", italic(scrambleManager.streamMsg(flowId, freshRawMsg, now, flowComplete, msgBudget)))}`;
				} else {
					const needsTail = Boolean(getLiveText(flowId) || liveText || lastText);
					const displayMsg = needsTail ? tailText(freshRawMsg, msgBudget) : truncateChars(freshRawMsg, msgBudget);
					const result = flowComplete
						? scrambleManager.updateMsg(flowId, displayMsg, now, flowComplete).content
						: scrambleManager.updateMsg(flowId, freshRawMsg, now, flowComplete, undefined, true).content;
					return `${theme.fg("dim", msgPrefix)}${theme.fg(useError ? "error" : "dim", italic(result))}`;
				}
			},
			true,
		));

		if (flowComplete) {
			scrambleManager.completeFlow(flowId);
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
	baseId?: string,
): Container {
	return renderActivityPanel(results, theme, baseId);
}
