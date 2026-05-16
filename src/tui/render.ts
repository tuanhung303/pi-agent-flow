/**
 * TUI rendering for flow-state tool calls and results.
 *
 * Option B: collapsed view shows structured report (Summary/Done/Not Done/Next Steps).
 * Expanded view adds raw tool call traces.
 */

import * as os from "node:os";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text, TruncatedText } from "@mariozechner/pi-tui";
import { getFlowSummaryText } from "../snapshot/runner-events.js";
import type {
	SingleResult,
	FlowDetails,
} from "../types/flow.js";
import {
	aggregateFlowUsage,
	getFlowOutput,
	isFlowError,
	isFlowSuccess,
} from "../types/flow.js";
import {
	type DisplayItem,
	getFlowDisplayItems,
	getLastToolCall,
	getLastAssistantText,
} from "../types/ui.js";
import { formatBatchOpsSummary } from "../batch/summary.js";
import { scrambleManager, runScrambleTimer, DynamicScrambleText, getLiveText } from "./scramble/index.js";

// ---------------------------------------------------------------------------
// Anonymous flow-id counter — prevents scramble-state collisions when multiple
// flow widgets share the screen and toolCallId is absent from result/args.
// ---------------------------------------------------------------------------
let anonFlowIdCounter = 0;
function getAnonymousFlowId(): string {
	return `flow-${++anonFlowIdCounter}`;
}

/** Reset the anonymous counter — call in tests for deterministic ids. */
export function resetAnonymousFlowIdCounter(): void {
	anonFlowIdCounter = 0;
}

function getLiveTextWithFallback(id: string): string | undefined {
	const value = getLiveText(id);
	if (value !== undefined) return value;
	const fallbackId = id.includes("#") ? "collapsed" + id.slice(id.indexOf("#")) : "collapsed";
	return getLiveText(fallbackId);
}
import { formatCompactStats, formatFlowTypeName, lowerFirstWord, truncateChars, tailText, getTruncationBudget, visibleLength, stripAnsi, formatModelLabel, formatCountdownRemaining } from "./render-utils.js";

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

import {
  type FlowColorConfig,
  type FlowTheme,
  applyRole,
  DEFAULT_FLOW_COLORS,
} from "./flow-colors.js";
type ThemeFg = (color: string, text: string) => string;

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
	theme: FlowTheme,
	config?: FlowColorConfig,
): string {
	const lines: string[] = [];
	for (const item of items) {
		if (item.type === "toolCall") {
			lines.push(applyRole("prefixLabel", "→ ", theme, config) + formatFlowToolCall(item.name, item.args, theme.fg.bind(theme)));
		}
	}
	return lines.join("\n");
}

function renderFlowReport(
	output: string,
	theme: FlowTheme,
	config?: FlowColorConfig,
): string {
	const lines = splitOutputLines(output);
	return lines.map((line) => applyRole("actContent", line, theme, config)).join("\n");
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


// ---------------------------------------------------------------------------
// renderFlowCall — shown while the flow is being invoked
// ---------------------------------------------------------------------------

export function renderFlowCall(args: Record<string, any>, theme: FlowTheme, config?: FlowColorConfig): Container | Text {
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
	config?: FlowColorConfig,
): Container | Text {
	const details = result.details as FlowDetails | undefined;
	const streamingText = result.content?.[0]?.type === "text" ? result.content[0].text : undefined;

	// Resolve a stable id for this flow widget. Once an id is stored in
	// state we keep reusing it to prevent mid-render id switches that would
	// reset scramble animation state. On first render we prefer result._toolCallId,
	// then args inputs, then a per-state anonymous counter.
	// This prevents scramble-state collisions when multiple flow widgets are
	// visible simultaneously (e.g. sequential flows) and toolCallId is absent.
	let resolvedToolCallId: string | undefined;
	if (args?.state) {
		const s = args.state as Record<string, any>;
		resolvedToolCallId = s.__flowId;
		if (!resolvedToolCallId) {
			resolvedToolCallId = (result as any)._toolCallId || (args as any)?.toolCallId || (args as any)?.id;
			if (!resolvedToolCallId) {
				resolvedToolCallId = getAnonymousFlowId();
			}
			s.__flowId = resolvedToolCallId;
		}
	} else {
		resolvedToolCallId = (result as any)._toolCallId || (args as any)?.toolCallId || (args as any)?.id;
	}

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
			const ghostId = resolvedToolCallId || 'ghost';
			if (expanded) {
				const now = Date.now();
				container = renderFlowExpanded(ghostResult, flowStatusIcon(ghostResult, theme), false, getFlowDisplayItems([]), getFlowOutput([]), theme, ghostId, now, false, streamingText || "", config);
			} else {
				container = renderFlowCollapsed(ghostResult, flowStatusIcon(ghostResult, theme), false, streamingText || "", theme, undefined, ghostId, config);
			}
		} else {
			container = new Text(scrambleManager.renderStatic(streamingText || ""), 0, 0);
		}
	} else if (details.results.length === 1) {
		container = renderSingleFlowResult(details.results[0], expanded, theme, streamingText, resolvedToolCallId, config);
	} else {
		container = renderMultiFlowResult(details, expanded, theme, resolvedToolCallId, config);
	}

	// In-place mutation pattern: reuse the stored root container
	// so the TUI host's cached reference stays valid.
	if (args?.state) {
		const s = args.state as Record<string, any>;
		if (!s.__rootContainer) {
			// First render: store the container (always wrap Text in a Container for consistency)
			if (container instanceof Container) {
				s.__rootContainer = container;
			} else {
				const root = new Container();
				root.addChild(container);
				s.__rootContainer = root;
			}
		} else if (container !== s.__rootContainer) {
			// Subsequent renders: transfer children to the stored container.
			// Use a snapshot of the children array so the loop remains safe even if
			// addChild() mutates the source array (removes from old parent).
			const root = s.__rootContainer as Container;
			root.clear();
			if (container instanceof Container) {
				const children = [...(container as Container).children];
				for (const child of children) {
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
	// Use resolvedToolCallId so the timer scope matches the state scope.
	let timerId: string;
	if (!details || details.results.length === 0) {
		const flowRequest = args?.flow?.[0];
		timerId = resolvedToolCallId || (flowRequest ? 'ghost' : 'single');
	} else if (details.results.length === 1) {
		timerId = resolvedToolCallId || 'single';
	} else {
		timerId = resolvedToolCallId || 'multi';
	}
	runScrambleTimer(args as Record<string, any> | undefined, timerId);

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
	config?: FlowColorConfig,
): Container | Text {
	const id = toolCallId || "single";
	const error = isFlowError(r);
	const icon = flowStatusIcon(r, theme);
	const displayItems = getFlowDisplayItems(r.messages);
	const flowOutput = getFlowOutput(r.messages);
	const now = Date.now();
	const isComplete = r.exitCode !== -1;

	if (expanded) {
		return renderFlowExpanded(r, icon, error, displayItems, flowOutput, theme, id, now, isComplete, streamingText, config);
	}
	return renderFlowCollapsed(r, icon, error, flowOutput, theme, streamingText, id, config);
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
	config?: FlowColorConfig,
): Container {
	const mdTheme = getMarkdownTheme();
	const container = new Container();

	// Header: uppercase type name with dots, no icon, no source
	const typeName = formatFlowTypeName(r.type);
	let header = applyRole("flowName", typeName, theme, config);
	if (error && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
	const plainHeader = typeName + (error && r.stopReason ? ` [${r.stopReason}]` : "");
	container.addChild(new DynamicScrambleText(
		header,
		() => {
			const result = scrambleManager.updateText(id, 'header', plainHeader, Date.now(), isComplete);
			return result.isAnimating ? applyRole("flowName", result.content, theme, config) : header;
		}
	));
	if (error && r.errorMessage) {
		container.addChild(new Text(scrambleManager.renderStatic(theme.fg("error", `Error: ${r.errorMessage}`)), 0, 0));
	}

	// Stats: dashboard format
	const inlineStats = formatCompactStats(r.usage, r.model);
	container.addChild(new DynamicScrambleText(
		applyRole("stats", inlineStats, theme, config),
		() => {
			const result = scrambleManager.updateText(id, 'stats', stripAnsi(inlineStats), Date.now(), isComplete);
			return result.isAnimating ? applyRole("stats", result.content, theme, config) : applyRole("stats", inlineStats, theme, config);
		}
	));

	// Intent — column-aware truncation (budget recalculated inside closure for resize handling)
	const intentBudget = getTruncationBudget(0);
	const displayIntent = truncateChars(r.intent, intentBudget);
	container.addChild(new Spacer(1));
	container.addChild(new Text(applyRole("prefixLabel", sectionHeader("intent"), theme, config), 0, 0));
	container.addChild(new DynamicScrambleText(
		applyRole("aimContent", displayIntent, theme, config),
		() => {
			const budget = getTruncationBudget(0);
			const text = truncateChars(r.intent, budget);
			const result = scrambleManager.updateText(id, 'intent', text, Date.now(), isComplete);
			return result.isAnimating ? applyRole("aimContent", result.content, theme, config) : applyRole("aimContent", text, theme, config);
		}
	));

	// Acceptance
	if (r.acceptance) {
		const acceptanceRaw = r.acceptance;
		const acceptanceBudget = getTruncationBudget(0);
		const acceptanceText = truncateChars(acceptanceRaw, acceptanceBudget);
		container.addChild(new Spacer(1));
		container.addChild(new Text(applyRole("prefixLabel", sectionHeader("acceptance"), theme, config), 0, 0));
		container.addChild(new DynamicScrambleText(
			applyRole("aimContent", acceptanceText, theme, config),
			() => {
				const budget = getTruncationBudget(0);
				const text = truncateChars(acceptanceRaw, budget);
				const result = scrambleManager.updateText(id, 'acceptance', text, Date.now(), isComplete);
				return result.isAnimating ? applyRole("aimContent", result.content, theme, config) : applyRole("aimContent", text, theme, config);
			}
		));
	}

	// Flow report (structured output)
	container.addChild(new Spacer(1));
	container.addChild(new Text(applyRole("prefixLabel", sectionHeader("report"), theme, config), 0, 0));

	// Structured output summary (compact badge when available)
	if (r.structuredOutput) {
		const so = r.structuredOutput;
		const statusColor = so.status === "complete" ? "success" : so.status === "partial" ? "warning" : "error";
		const statusText = `[${so.status}] ${so.summary}`;
		const statusStatic = `${theme.fg(statusColor, `[${so.status}]`)} ${applyRole("aimContent", so.summary, theme, config)}`;
		container.addChild(new DynamicScrambleText(
			statusStatic,
			() => {
				const result = scrambleManager.updateText(id, 'report-status', statusText, Date.now(), isComplete, false);
				return result.isAnimating ? `${theme.fg(statusColor, result.content.split(' ')[0])} ${applyRole("aimContent", result.content.slice(result.content.indexOf(' ') + 1), theme, config)}` : statusStatic;
			}
		));
		if (so.files.length > 0) {
			const filesText = `Files: ${so.files.map((f) => f.path).join(", ")}`;
			container.addChild(new DynamicScrambleText(
				applyRole("aimContent", filesText, theme, config),
				() => {
					const result = scrambleManager.updateText(id, 'report-files', filesText, Date.now(), isComplete, false);
					return result.isAnimating ? applyRole("aimContent", result.content, theme, config) : applyRole("aimContent", filesText, theme, config);
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
				applyRole("aimContent", commandsText, theme, config),
				() => {
					const result = scrambleManager.updateText(id, 'report-commands', commandsText, Date.now(), isComplete, false);
					return result.isAnimating ? applyRole("aimContent", result.content, theme, config) : applyRole("aimContent", commandsText, theme, config);
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
				applyRole("aimContent", notDoneText, theme, config),
				() => {
					const result = scrambleManager.updateText(id, 'report-notDone', notDoneText, Date.now(), isComplete, false);
					return result.isAnimating ? applyRole("aimContent", result.content, theme, config) : applyRole("aimContent", notDoneText, theme, config);
				}
			));
		}
		if (so.nextSteps.length > 0) {
			const nextStepsText = `Next: ${so.nextSteps.join("; ")}`;
			container.addChild(new DynamicScrambleText(
				applyRole("aimContent", nextStepsText, theme, config),
				() => {
					const result = scrambleManager.updateText(id, 'report-nextSteps', nextStepsText, Date.now(), isComplete, false);
					return result.isAnimating ? applyRole("aimContent", result.content, theme, config) : applyRole("aimContent", nextStepsText, theme, config);
				}
			));
		}
		container.addChild(new Spacer(1));
	}

	// Output: animate streaming text; show clean markdown when complete
	if (!isComplete && streamingText != null) {
		const msgBudget = getTruncationBudget(0);
		const displayMsg = tailText(stripAnsi(streamingText), msgBudget);
		container.addChild(new DynamicScrambleText(
			displayMsg,
			() => {
				const budget = getTruncationBudget(0);
				const freshStreamingText = getLiveTextWithFallback(id) ?? streamingText;
				const text = tailText(stripAnsi(freshStreamingText), budget);
				return scrambleManager.updateMsg(id, text, Date.now(), isComplete, undefined, true).content;
			}
		));
	} else if (flowOutput) {
		container.addChild(new Markdown(flowOutput.trim(), 0, 0, mdTheme));
	} else {
		const summary = getFlowSummaryText(r);
		container.addChild(new DynamicScrambleText(
			applyRole("msgContent", summary, theme, config),
			() => {
				const result = scrambleManager.updateText(id, 'output-summary', summary, Date.now(), isComplete, false);
				return result.isAnimating ? applyRole("msgContent", result.content, theme, config) : applyRole("msgContent", summary, theme, config);
			}
		));
	}

	// Tool traces (expanded only) — per-line scramble
	const toolCallItems = displayItems.filter((item) => item.type === "toolCall");
	if (toolCallItems.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(applyRole("prefixLabel", sectionHeader("tool calls"), theme, config), 0, 0));
		const toolPrefixLen = visibleLength("→ ");
		const toolBudget = getTruncationBudget(toolPrefixLen);
		for (let i = 0; i < toolCallItems.length; i++) {
			const item = toolCallItems[i] as Extract<DisplayItem, { type: "toolCall" }>;
			const lineText = applyRole("prefixLabel", "→ ", theme, config) + formatFlowToolCall(item.name, item.args, theme.fg.bind(theme));
			const plainText = stripAnsi(lineText);
			const displayTool = truncateChars(plainText, toolBudget);
			const initialScrambled = scrambleManager.updateText(id, `tool#${i}`, displayTool, now, isComplete).content;
			container.addChild(new DynamicScrambleText(
				initialScrambled,
				() => {
					const budget = getTruncationBudget(toolPrefixLen);
					const freshPlain = stripAnsi(lineText);
					const text = truncateChars(freshPlain, budget);
					return scrambleManager.updateText(id, `tool#${i}`, text, Date.now(), isComplete).content;
				}
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
	config?: FlowColorConfig,
): Container {
	const id = toolCallId || "collapsed";
	const now = Date.now();
	const container = new Container();
	const maxWidth = process.stdout.columns ?? 80;
	const typeName = formatCollapsedFlowHeaderTypeName(r.type);
	const modelLabel = formatModelLabel(r.model);
	const headerPrefixLen = visibleLength(typeName) + visibleLength(modelLabel ? `    ${modelLabel} · ` : "    ");

	const isComplete = r.exitCode !== -1;

	// Build header stats: countdown · tok/s
	const countdown = formatCountdownRemaining(r.deadlineAtMs);
	const statsParts: string[] = [];
	if (countdown) statsParts.push(countdown);
	const tpsValue = r.usage.smoothedTps;
	const tpsDisplay = tpsValue && tpsValue >= 100 ? `${Math.round(tpsValue)}` : (tpsValue && tpsValue > 0 ? tpsValue.toFixed(1) : undefined);
	if (tpsDisplay) statsParts.push(`${tpsDisplay} tok/s`);
	else statsParts.push("-- tok/s");
	let displayStats = statsParts.join(" · ");

	// Flash TPS value when it changes
	if (tpsDisplay) {
		const scrambledTps = scrambleManager.updateTps(id, tpsDisplay, now, isComplete, true);
		if (scrambledTps !== tpsDisplay) {
			displayStats = displayStats.replace(`${tpsDisplay} tok/s`, `${scrambledTps} tok/s`);
		}
	}
	let header = `${applyRole("flowName", typeName, theme, config)}${applyRole("modelName", modelLabel ? `    ${modelLabel} · ` : "    ", theme, config)}${applyRole("stats", displayStats, theme, config)}`;
	if (error && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
	// Scramble header on first render; show full styled header when complete
	const plainHeader = typeName + (modelLabel ? `    ${modelLabel} · ` : "    ") + stripAnsi(displayStats) + (error && r.stopReason ? ` [${r.stopReason}]` : "");
	container.addChild(new DynamicScrambleText(
		header,
		() => {
			const result = scrambleManager.updateText(id, 'header', plainHeader, Date.now(), isComplete, true);
			return result.isAnimating ? applyRole("flowName", result.content, theme, config) : header;
		},
		true,
	));

	// aim: line — glitch on text change
	if (r.aim) {
		const aimTree = "├─";
		const aimLabel = ` aim ▸ `;
		const aimPrefix = `${aimTree}${aimLabel}`;
		const budget = getTruncationBudget(visibleLength(aimPrefix));
		const displayAim = truncateChars(lowerFirstWord(r.aim), budget);
		container.addChild(new DynamicScrambleText(
			`${applyRole("treeChars", aimTree, theme, config)}${applyRole("prefixLabel", aimLabel, theme, config)}${applyRole("aimContent", displayAim, theme, config)}`,
			() => {
				const now = Date.now();
				const freshAimLabel = ` aim ▸ `;
				const freshAimPrefix = `${aimTree}${freshAimLabel}`;
				const freshBudget = getTruncationBudget(visibleLength(freshAimPrefix));
				const freshText = truncateChars(lowerFirstWord(r.aim), freshBudget);
				const result = scrambleManager.updateAim(id, freshText, now, isComplete, true);
				return `${applyRole("treeChars", aimTree, theme, config)}${applyRole("prefixLabel", freshAimLabel, theme, config)}${applyRole("aimContent", result.content, theme, config)}`;
			},
			true,
		));
	}

	// act: line (last tool call with count)
	const lastTool = getLastToolCall(r.messages);
	const actStr = lastTool ? formatFlowToolCall(lastTool.name, lastTool.args, theme.fg.bind(theme)) : "[n/a]";
	const actTree = "├─";
	const actLabel = ` cmd ▸ `;
	const prefixStub = `${actTree}${actLabel}`;
	const budget = getTruncationBudget(visibleLength(prefixStub));
	const actFullText = stripAnsi(lowerFirstWord(actStr));
	const initialActContent = actFullText.length > budget ? tailText(actFullText, budget) : actFullText;
	container.addChild(new DynamicScrambleText(
		`${applyRole("treeChars", actTree, theme, config)}${applyRole("prefixLabel", actLabel, theme, config)}${applyRole("actContent", initialActContent, theme, config)}`,
		() => {
			const now = Date.now();
			const displayAct = tailText(actFullText, budget);
			const actContent = scrambleManager.updateAct(id, displayAct, now, isComplete, true).content;
			const actLabel = ` cmd ▸ `;
			const actPrefix = `${actTree}${actLabel}`;
			return `${applyRole("treeChars", actTree, theme, config)}${applyRole("prefixLabel", actLabel, theme, config)}${applyRole("actContent", actContent, theme, config)}`;
		},
		true,
	));

	// msg: line (last assistant text or streaming)
	const msgPrefixStub = `└─ msg ▸ `;
	const msgBudget = getTruncationBudget(visibleLength(msgPrefixStub));

	let rawMsg: string;
	let useError = false;
	const liveMsgText = r.exitCode === -1 ? getLiveTextWithFallback(id) : undefined;
	if (liveMsgText != null) {
		rawMsg = stripAnsi(liveMsgText);
	} else if (r.exitCode === -1 && streamingText != null) {
		rawMsg = stripAnsi(streamingText);
	} else if (r.structuredOutput?.summary) {
		rawMsg = stripAnsi(r.structuredOutput.summary);
	} else if (flowOutput) {
		rawMsg = stripAnsi(flowOutput);
	} else if (error && r.errorMessage) {
		rawMsg = stripAnsi(r.errorMessage);
		useError = true;
	} else {
		const summary = getFlowSummaryText(r);
		rawMsg = stripAnsi(summary) || "[n/a]";
	}

	const initialNeedsTail = r.exitCode === -1 || streamingText != null || liveMsgText != null;
	const initialMsgContent = initialNeedsTail
		? tailText(rawMsg, msgBudget)
		: truncateChars(rawMsg, msgBudget);
	const msgTree = "└─";
	const msgLabel = ` msg ▸ `;
	const initialMsgPrefix = `${msgTree}${msgLabel}`;
	container.addChild(new DynamicScrambleText(
		`${applyRole("treeChars", msgTree, theme, config)}${applyRole("prefixLabel", msgLabel, theme, config)}${applyRole(useError ? "msgError" : "msgContent", initialMsgContent, theme, config)}`,
		() => {
			const now = Date.now();
			const msgLabel = ` msg ▸ `;
			const msgPrefix = `${msgTree}${msgLabel}`;
			const freshRawMsg = (r.exitCode === -1 ? getLiveTextWithFallback(id) : undefined) ?? rawMsg;
			const needsTail = r.exitCode === -1 || streamingText != null;
			const displayMsg = needsTail ? tailText(freshRawMsg, msgBudget) : truncateChars(freshRawMsg, msgBudget);
			const result = scrambleManager.updateMsg(id, displayMsg, now, isComplete, undefined, true);
			return `${applyRole("treeChars", msgTree, theme, config)}${applyRole("prefixLabel", msgLabel, theme, config)}${applyRole(useError ? "msgError" : "msgContent", result.content, theme, config)}`;
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
	config?: FlowColorConfig,
): Container | Text {
	const baseId = toolCallId || "multi";
	const results = details.results;
	const successCount = results.filter((r) => isFlowSuccess(r)).length;
	const failCount = results.filter((r) => isFlowError(r)).length;
	const icon = failCount > 0 ? theme.fg("warning", "(!)") : theme.fg("success", "(ok)");
	const now = Date.now();

	if (expanded) {
		return renderMultiFlowExpanded(results, successCount, icon, theme, baseId, now, config);
	}
	return renderMultiFlowCollapsed(results, theme, baseId, config);
}

function renderMultiFlowExpanded(
	results: SingleResult[],
	successCount: number,
	icon: string,
	theme: FlowTheme,
	baseId: string,
	now: number,
	config?: FlowColorConfig,
): Container {
	const mdTheme = getMarkdownTheme();
	const container = new Container();

	// Summary: just show count, no icon
	container.addChild(new Text(
		applyRole("flowName", `${results.length} flows`, theme, config),
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
		const headerStatic = applyRole("prefixLabel", sectionHeader(typeName), theme, config);
		container.addChild(new DynamicScrambleText(
			headerStatic,
			() => {
				const result = scrambleManager.updateText(flowId, 'header', typeName, Date.now(), isComplete, true);
				return result.isAnimating ? applyRole("prefixLabel", result.content, theme, config) : headerStatic;
			}
		));

		// Stats: dashboard format
		const flowStats = formatCompactStats(r.usage, r.model);
		container.addChild(new DynamicScrambleText(
			applyRole("stats", flowStats, theme, config),
			() => {
				const result = scrambleManager.updateText(flowId, 'stats', stripAnsi(flowStats), Date.now(), isComplete, true);
				return result.isAnimating ? applyRole("stats", result.content, theme, config) : applyRole("stats", flowStats, theme, config);
			}
		));

		// Intent: just show text, no prefix (budget computed dynamically for resize recalculation)
		const intentBudget = getTruncationBudget(0);
		const displayIntent = truncateChars(r.intent, intentBudget);
		container.addChild(new DynamicScrambleText(
			applyRole("aimContent", displayIntent, theme, config),
			() => {
				const budget = getTruncationBudget(0);
				const text = truncateChars(r.intent, budget);
				const result = scrambleManager.updateText(flowId, 'intent', text, Date.now(), isComplete, true);
				return result.isAnimating ? applyRole("aimContent", result.content, theme, config) : applyRole("aimContent", text, theme, config);
			}
		));

		if (r.acceptance) {
			const acceptanceRaw = r.acceptance;
			const acceptancePrefix = "Acceptance: ";
			const acceptanceBudget = getTruncationBudget(visibleLength(acceptancePrefix));
			const acceptanceText = truncateChars(acceptanceRaw, acceptanceBudget);
			const acceptanceStatic = applyRole("aimContent", `${acceptancePrefix}${acceptanceText}`, theme, config);
			container.addChild(new DynamicScrambleText(
				acceptanceStatic,
				() => {
					const budget = getTruncationBudget(visibleLength(acceptancePrefix));
					const text = truncateChars(acceptanceRaw, budget);
					const result = scrambleManager.updateText(flowId, 'acceptance', text, Date.now(), isComplete, true);
					return result.isAnimating ? applyRole("aimContent", `${acceptancePrefix}${result.content}`, theme, config) : applyRole("aimContent", `${acceptancePrefix}${text}`, theme, config);
				}
			));
		}

		// Output: animate streaming text; show clean markdown when complete
		if (!isComplete && r.streamingText != null) {
			const streamingRaw = r.streamingText;
			const msgBudget = getTruncationBudget(0);
			const displayMsg = tailText(stripAnsi(streamingRaw), msgBudget);
			container.addChild(new DynamicScrambleText(
				displayMsg,
				() => {
					const budget = getTruncationBudget(0);
					const freshStreamingText = getLiveTextWithFallback(flowId) ?? streamingRaw;
					const text = tailText(stripAnsi(freshStreamingText), budget);
					return scrambleManager.updateMsg(flowId, text, Date.now(), isComplete, undefined, true).content;
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
			container.addChild(new Text(applyRole("prefixLabel", sectionHeader("tool calls"), theme, config), 0, 0));
			const toolPrefixLen = visibleLength("→ ");
			const toolBudget = getTruncationBudget(toolPrefixLen);
			for (let i = 0; i < toolCallItems.length; i++) {
				const item = toolCallItems[i] as Extract<DisplayItem, { type: "toolCall" }>;
				const lineText = applyRole("prefixLabel", "→ ", theme, config) + formatFlowToolCall(item.name, item.args, theme.fg.bind(theme));
				const plainText = stripAnsi(lineText);
				const displayTool = truncateChars(plainText, toolBudget);
				const initialScrambled = scrambleManager.updateText(flowId, `tool#${i}`, displayTool, now, isComplete).content;
				container.addChild(new DynamicScrambleText(
					initialScrambled,
					() => {
						const budget = getTruncationBudget(toolPrefixLen);
						const freshPlain = stripAnsi(lineText);
						const text = truncateChars(freshPlain, budget);
						return scrambleManager.updateText(flowId, `tool#${i}`, text, Date.now(), isComplete).content;
					}
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
	container.addChild(new Text(applyRole("stats", totalStats, theme, config), 0, 0));

	return container;
}

function renderActivityPanel(
	results: SingleResult[],
	theme: FlowTheme,
	baseId?: string,
	config?: FlowColorConfig,
): Container {
	const idPrefix = baseId || "panel";
	const container = new Container();
	const maxWidth = process.stdout.columns ?? 80;
	const now = Date.now();

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const isLast = i === results.length - 1;
		const flowId = `${idPrefix}#${i}`;
		const typeName = formatCollapsedFlowHeaderTypeName(r.type);
		const modelLabel = formatModelLabel(r.model);
		const headerPrefix = isLast ? "└─" : "├─";
		const headerPrefixLen = visibleLength(headerPrefix) + 1 + visibleLength(typeName) + visibleLength(modelLabel ? `    ${modelLabel} · ` : "    ");

		// Build header stats: countdown · tok/s
		const countdown = formatCountdownRemaining(r.deadlineAtMs);
		const statsParts: string[] = [];
		if (countdown) statsParts.push(countdown);
		const tpsValue = r.usage.smoothedTps;
		const tpsDisplay = tpsValue && tpsValue >= 100 ? `${Math.round(tpsValue)}` : (tpsValue && tpsValue > 0 ? tpsValue.toFixed(1) : undefined);
		if (tpsDisplay) statsParts.push(`${tpsDisplay} tok/s`);
		else statsParts.push("-- tok/s");
		let displayStats = statsParts.join(" · ");

		const flowComplete = r.exitCode !== -1;

		// Flash TPS value when it changes
		if (tpsDisplay) {
			const scrambledTps = scrambleManager.updateTps(flowId, tpsDisplay, now, flowComplete, true);
			if (scrambledTps !== tpsDisplay) {
				displayStats = displayStats.replace(`${tpsDisplay} tok/s`, `${scrambledTps} tok/s`);
			}
		}

		const error = isFlowError(r);

		// Header line
		let headerLine = `${applyRole("treeChars", headerPrefix, theme, config)} ${applyRole("flowName", typeName, theme, config)}${applyRole("modelName", modelLabel ? `    ${modelLabel} · ` : "    ", theme, config)}${applyRole("stats", displayStats, theme, config)}`;
		if (error && r.stopReason) {
			headerLine += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
		}
		const plainHeader = headerPrefix + " " + typeName + (modelLabel ? `    ${modelLabel} · ` : "    ") + stripAnsi(displayStats) + (error && r.stopReason ? ` [${r.stopReason}]` : "");
		container.addChild(new DynamicScrambleText(
			headerLine,
			() => {
				const result = scrambleManager.updateText(flowId, 'header', plainHeader, Date.now(), flowComplete, true);
				return result.isAnimating ? applyRole("flowName", result.content, theme, config) : headerLine;
			},
			true,
		));

		// Continuation indent for sub-lines
		const indent = isLast ? "   " : "│  ";

		// aim: line — glitch on text change
		if (r.aim) {
			const aimTree = indent + "├─";
			const aimLabel = ` aim ▸ `;
			const aimPrefix = `${aimTree}${aimLabel}`;
			const budget = getTruncationBudget(visibleLength(aimPrefix));
			const displayAim = truncateChars(lowerFirstWord(r.aim), budget);
			container.addChild(new DynamicScrambleText(
				`${applyRole("treeChars", aimTree, theme, config)}${applyRole("prefixLabel", aimLabel, theme, config)}${applyRole("aimContent", displayAim, theme, config)}`,
				() => {
					const now = Date.now();
					const freshAimLabel = ` aim ▸ `;
					const freshAimPrefix = `${aimTree}${freshAimLabel}`;
					const freshBudget = getTruncationBudget(visibleLength(freshAimPrefix));
					const freshText = truncateChars(lowerFirstWord(r.aim), freshBudget);
					const result = scrambleManager.updateAim(flowId, freshText, now, flowComplete, true);
					return `${applyRole("treeChars", aimTree, theme, config)}${applyRole("prefixLabel", freshAimLabel, theme, config)}${applyRole("aimContent", result.content, theme, config)}`;
				},
				true,
			));
		}

		// act: line (last tool call with count)
		const lastTool = getLastToolCall(r.messages);
		const actStr = lastTool ? formatFlowToolCall(lastTool.name, lastTool.args, theme.fg.bind(theme)) : "[n/a]";
		const actTree = `${indent}├─`;
		const actLabel = ` cmd ▸ `;
		const prefixStub = `${actTree}${actLabel}`;
		const budget = getTruncationBudget(visibleLength(prefixStub));
		const actFullText = stripAnsi(lowerFirstWord(actStr));
		const initialActContent = actFullText.length > budget ? tailText(actFullText, budget) : actFullText;
		container.addChild(new DynamicScrambleText(
			`${applyRole("treeChars", actTree, theme, config)}${applyRole("prefixLabel", actLabel, theme, config)}${applyRole("actContent", initialActContent, theme, config)}`,
			() => {
				const now = Date.now();
				const actLabel = ` cmd ▸ `;
				const actPrefix = `${actTree}${actLabel}`;
				const freshBudget = getTruncationBudget(visibleLength(actPrefix));
				const displayAct = tailText(actFullText, freshBudget);
				const actContent = scrambleManager.updateAct(flowId, displayAct, now, flowComplete, true).content;
				return `${applyRole("treeChars", actTree, theme, config)}${applyRole("prefixLabel", actLabel, theme, config)}${applyRole("actContent", actContent, theme, config)}`;
			},
			true,
		));

		// msg: line (live streaming text or last assistant text)
		const msgTree = `${indent}└─`;
		const msgLabel = ` msg ▸ `;
		const msgPrefixStub = `${msgTree}${msgLabel}`;
		const msgBudget = getTruncationBudget(visibleLength(msgPrefixStub));
		const liveText = r.exitCode === -1 ? r.streamingText : undefined;
		const lastText = liveText || getLastAssistantText(r.messages);

		let rawMsg: string;
		let useError = false;
		const liveText_ = flowComplete ? undefined : getLiveTextWithFallback(flowId);
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

		const initialNeedsTail = Boolean(liveText_ || liveText || lastText);
		const initialDisplayMsg = initialNeedsTail ? tailText(rawMsg, msgBudget) : truncateChars(rawMsg, msgBudget);
		container.addChild(new DynamicScrambleText(
			`${applyRole("treeChars", msgTree, theme, config)}${applyRole("prefixLabel", msgLabel, theme, config)}${applyRole(useError ? "msgError" : "msgContent", initialDisplayMsg, theme, config)}`,
			() => {
				const now = Date.now();
				const msgLabel = ` msg ▸ `;
				const msgPrefix = `${msgTree}${msgLabel}`;
				const freshBudget = getTruncationBudget(visibleLength(msgPrefix));
				const freshRawMsg = flowComplete ? rawMsg : (getLiveTextWithFallback(flowId) ?? rawMsg);
				const needsTail = Boolean(getLiveTextWithFallback(flowId) || liveText || lastText);
				const displayMsg = needsTail ? tailText(freshRawMsg, freshBudget) : truncateChars(freshRawMsg, freshBudget);
				const result = scrambleManager.updateMsg(flowId, displayMsg, now, flowComplete, undefined, true);
				return `${applyRole("treeChars", msgTree, theme, config)}${applyRole("prefixLabel", msgLabel, theme, config)}${applyRole(useError ? "msgError" : "msgContent", result.content, theme, config)}`;
			},
			true,
		));

		if (flowComplete) {
			scrambleManager.completeFlow(flowId);
		}

		// Add blank line separator between flows (with continuation pipe)
		if (!isLast) {
			container.addChild(new TruncatedText(applyRole("treeChars", "│", theme, config), 0, 0));
		}
	}

	container.addChild(new TruncatedText(applyRole("prefixLabel", "(Ctrl+O to expand tool traces)", theme, config), 0, 0));

	return container;
}

function renderMultiFlowCollapsed(
	results: SingleResult[],
	theme: FlowTheme,
	baseId?: string,
	config?: FlowColorConfig,
): Container {
	return renderActivityPanel(results, theme, baseId, config);
}
