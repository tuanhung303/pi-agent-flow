/**
 * Two JSONL protocols are used in this codebase:
 *
 * 1. Fork Snapshot Protocol (snapshot.ts):
 *    Types: session, model_change, thinking_level_change, message
 *    Purpose: Serialized session state passed to child flows via --session.
 *              Emitted by buildForkSessionSnapshotJsonl() and consumed by
 *              sanitizeForkSnapshot() before forking.
 *
 * 2. Streaming Stdout Protocol (runner-events.ts):
 *    Types: session, agent_start, turn_start, message_start, message_end,
 *           message_update
 *    Sub-events under message_update: thinking_start, thinking_delta, text_delta
 *    Purpose: Real-time events emitted by the pi process stdout during flow
 *              execution. Parsed by processFlowJsonLine().
 */

/**
 * Session snapshot building, sanitization, and tool result compression.
 *
 * Extracted from index.ts for single-responsibility and testability.
 */

import type { CompressedFlowResult, DepthPolicy } from "../types/output.js";
import { stripReasoningFromAssistantMessage } from "./reasoning-strip.js";
import {
	stripSteeringHintFromContent,
	contentContainsSteeringHintTag,
	isJsonEqual,
} from "../steering/sliding-prompt.js";
import { stripStrategicHintsFromContent } from "../steering/tool-utils.js";
import { logWarn, logError } from "../config/log.js";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionSnapshotSource {
	getHeader: () => unknown;
	getBranch: () => unknown[];
}
// ---------------------------------------------------------------------------
// Snapshot JSONL types
// ---------------------------------------------------------------------------

/** A text part in message content. */
interface TextPart {
	type: "text";
	text: string;
}

/** A tool call part in assistant message content. */
interface ToolCallPart {
	type: "toolCall";
	name?: string;
	toolName?: string;
	id?: string;
	toolCallId?: string;
	arguments?: unknown;
	input?: unknown;
}

/** A tool result part in tool message content. */
interface ToolResultPart {
	type: "toolResult";
	toolCallId?: string;
	content?: string | unknown;
}

/** Union of all content part types in snapshot messages. */
type ContentPart = TextPart | ToolCallPart | ToolResultPart;

/** Token usage attached to assistant messages. */
interface MessageUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
	totalTokens?: number;
	[key: string]: unknown;
}

/** A message inside a snapshot JSONL entry. */
interface SnapshotMessage {
	role: string;
	content?: string | ContentPart[];
	toolCallId?: string;
	toolName?: string;
	usage?: MessageUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	details?: unknown;
	id?: string;
	parentId?: string;
	parentMessageId?: string;
	messageId?: string;
	timestamp?: number;
	[key: string]: unknown;
}

/** A session header entry (first line of snapshot JSONL). */
interface SessionEntry {
	type?: "session" | "header";
	id?: string;
	systemPrompt?: string;
	version?: string;
	timestamp?: string;
	cwd?: string;
	forkedFrom?: string;
	forkedAt?: string;
	parentFlow?: string;
	depth?: number;
	parentId?: string;
	[key: string]: unknown;
}

/** A message entry in snapshot JSONL. */
interface MessageEntry {
	type: "message";
	message: SnapshotMessage;
	parentId?: string;
	parentMessageId?: string;
	id?: string;
	[key: string]: unknown;
}

/** Config change entries that are dropped during sanitization. */
interface ConfigEntry {
	type: "model_change" | "thinking_level_change";
	[key: string]: unknown;
}

/** Custom message entries that are dropped during sanitization. */
interface CustomMessageEntry {
	type: "custom_message";
	[key: string]: unknown;
}

/** Parsed snapshot JSONL line with known fields. */
interface SnapshotEntry {
	type?: string;
	message?: SnapshotMessage;
	id?: string;
	parentId?: string;
	parentMessageId?: string;
	systemPrompt?: string;
	content?: string;
	version?: string;
	timestamp?: string | number;
	cwd?: string;
	forkedFrom?: string;
	forkedAt?: string;
	parentFlow?: string;
	depth?: number;
	preBytes?: number;
	postBytes?: number;
	reductionPercent?: number;
	passesApplied?: string[];
	[key: string]: unknown;
}


// ---------------------------------------------------------------------------
// Session snapshot serialization
// ---------------------------------------------------------------------------

export function buildForkSessionSnapshotJsonl(
	sessionManager: SessionSnapshotSource,
): string | null {
	const header = sessionManager.getHeader();
	if (!header || typeof header !== "object") return null;

	// Compress cwd in session header: relative to repo root if under it,
	// otherwise basename only. Saves ~50-100 bytes per snapshot.
	const repoRoot = process.cwd();
	let compressedHeader = header as SessionEntry;
	if (typeof compressedHeader.cwd === "string") {
		const cwd = compressedHeader.cwd;
		let compressedCwd: string;
		if (cwd === repoRoot) {
			compressedCwd = ".";
		} else if (cwd.startsWith(repoRoot + "/") || cwd.startsWith(repoRoot + "\\")) {
			compressedCwd = cwd.slice(repoRoot.length + 1);
		} else {
			const lastSep = Math.max(cwd.lastIndexOf("/"), cwd.lastIndexOf("\\"));
			compressedCwd = lastSep >= 0 ? cwd.slice(lastSep + 1) : cwd;
		}
		if (compressedCwd !== cwd) {
			compressedHeader = { ...compressedHeader, cwd: compressedCwd };
		}
	}

	const branchEntries = sessionManager.getBranch();
	const lines: string[] = [];

	// Emit session header once, unless getBranch() already includes it as the
	// first entry (some session managers include the header in the branch).
	const firstBranch = branchEntries[0];
	const headerId = (header as SessionEntry)?.id;
	const firstId = firstBranch && typeof firstBranch === "object" ? (firstBranch as SessionEntry)?.id : undefined;
	const firstType = firstBranch && typeof firstBranch === "object" ? (firstBranch as SessionEntry)?.type : undefined;
	if (
		!firstBranch ||
		typeof firstBranch !== "object" ||
		(firstType !== "session" && firstType !== "header") ||
		firstId !== headerId
	) {
		lines.push(JSON.stringify(compressedHeader));
	}

	for (const entry of branchEntries) lines.push(JSON.stringify(entry));
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Flow result compression
// ---------------------------------------------------------------------------

/**
 * Render a compressed flow result as compact text for child context.
 */
export function renderCompressedFlowResult(r: CompressedFlowResult): string | undefined {
	const parts: string[] = [`[Flow: ${r.type} ${r.status}]`];
	if (r.intent) parts.push(`Intent: ${r.intent}`);
	if (r.aim) parts.push(`Aim: ${r.aim}`);
	if (r.summary) parts.push(`Summary: ${r.summary}`);
	if (r.files?.length) {
		const fileLines = r.files
			.map((f) => {
				if (!f.path) return undefined;
				const role = f.role ? ` (${f.role})` : "";
				const desc = f.description ? ` — ${f.description}` : "";
				return `  ${f.path}${role}${desc}`;
			})
			.filter((line): line is string => line !== undefined);
		// Safety net: if >50% of file entries were invalid (no path), compression is
		// producing garbage. Return undefined so caller falls back to truncated raw.
		if (fileLines.length === 0 || fileLines.length < r.files.length / 2) {
			return undefined;
		}
		parts.push(`Files:\n${fileLines.join("\n")}`);
	}
	if (r.actions?.length) {
		const actionLines = r.actions.map((a) => {
			const result = a.result ? ` → ${a.result}` : "";
			const target = a.target ? ` (${a.target})` : "";
			return `  [${a.type}] ${a.description}${target}${result}`;
		});
		parts.push(`Actions:\n${actionLines.join("\n")}`);
	}
	if (r.commands?.length) {
		const cmdLines = r.commands.map((c) => `  ${c.tool ?? "cmd"}: ${c.command}`);
		parts.push(`Commands:\n${cmdLines.join("\n")}`);
	}
	if (r.notDone?.length) {
		const ndLines = r.notDone.map((n) => {
			const reason = n.reason ? ` — ${n.reason}` : "";
			return `  ${n.item}${reason}`;
		});
		parts.push(`Not done:\n${ndLines.join("\n")}`);
	}
	if (r.nextSteps?.length) {
		parts.push(`Next steps:\n${r.nextSteps.map((s) => `  ${s}`).join("\n")}`);
	}
	if (r.reasoning?.length) {
		parts.push(`Reasoning:\n${r.reasoning.map((s) => `  ${s}`).join("\n")}`);
	}
	if (r.notes?.length) {
		parts.push(`Notes:\n${r.notes.map((s) => `  ${s}`).join("\n")}`);
	}
	if (r.error) parts.push(`Error: ${r.error}`);
	// Safety net: reject malformed runtime data where required fields are missing.
	// This is more precise than a substring search that would false-positive on
	// legitimate content containing the word "undefined".
	if (!r.type || !r.status) return undefined;
	if (r.actions?.some((a) => !a.type || !a.description)) return undefined;
	if (r.commands?.some((c) => !c.command)) return undefined;
	if (r.notDone?.some((n) => !n.item)) return undefined;
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Additional tool result compressors
// ---------------------------------------------------------------------------

const DEBUG_CONTEXT = typeof process !== "undefined" && process.env.PI_FLOW_DEBUG_CONTEXT === "1";

function logCompress(toolName: string, before: number, after: number) {
	if (!DEBUG_CONTEXT) return;
	const reduction = before > 0 ? ((1 - after / before) * 100).toFixed(0) : "0";
	logError(`[context-compress] ${toolName}: ${before} → ${after} bytes (${reduction}% reduction)`);
}

const KNOWN_SECTION_HEADERS = [
	/^--- (.+) \((\d+) lines\) ---$/,
	/^--- (.+) (context map|file summary) ---$/,
	/^--- bash \[.+\] exit (\d+) ---$/,
	/^--- bash \[.+\] pending ---$/,
	/^--- bash \[.+\] error ---$/,
	/^--- edit: .+ ---$/,
	/^--- write: .+ ---$/,
	/^--- delete: .+ ---$/,
	/^--- read: .+ ---$/,
	/^--- rg: .+ ---$/,
	/^--- (?!bash \[|edit:|write:|delete:|read:|rg:)(.+) ---$/,
];

function isKnownSectionHeader(line: string): boolean {
	return KNOWN_SECTION_HEADERS.some((re) => re.test(line));
}

/** Compress a single bash block into the X1 compact format. */
/** Convert legacy depth number to DepthPolicy. */
export function depthToPolicy(depth: number): DepthPolicy {
	const isDepth1 = depth < 2;
	return { showPreviews: isDepth1, showBytes: isDepth1, showSupersededBreadcrumbs: isDepth1, showEditBlocks: isDepth1 };
}

function compressBashSection(
	bashId: string,
	status: "ok" | "pending" | "error",
	exitCode: number | undefined,
	timingTier: string | undefined,
	stdoutLines: string[],
	stderrLines: string[],
	policy: DepthPolicy,
): string {
	const isDepth1 = policy.showPreviews;
	const tier = timingTier ? ` · ${timingTier}` : "";
	// Trim trailing empty lines inserted by multi-bash formatting
	while (stdoutLines.length > 0 && stdoutLines[stdoutLines.length - 1] === "") stdoutLines.pop();
	while (stderrLines.length > 0 && stderrLines[stderrLines.length - 1] === "") stderrLines.pop();

	if (status === "ok") {
		const lineCount = stdoutLines.length;
		const linesLabel = lineCount === 1 ? "1 line" : `${lineCount} lines`;
		if (isDepth1) {
			if (lineCount === 0) {
				return `[bash:ok] ${bashId} · exit ${exitCode}${tier} · 0 lines`;
			}
			const head = stdoutLines.slice(0, 3).join("\n");
			return `[bash:ok] ${bashId} · exit ${exitCode}${tier} · ${linesLabel}\n> head:\n${head}`;
		}
		return `[bash:ok] ${bashId} · exit ${exitCode}`;
	}

	if (status === "pending") {
		const lineCount = stdoutLines.length;
		const linesLabel = lineCount === 1 ? "1 line partial" : `${lineCount} lines partial`;
		if (isDepth1) {
			if (lineCount === 0) {
				return `[bash:pending] ${bashId} · still running · 0 lines partial`;
			}
			const head = stdoutLines.slice(0, 3).join("\n");
			return `[bash:pending] ${bashId} · still running · ${linesLabel}\n> head:\n${head}`;
		}
		return `[bash:pending] ${bashId} · still running`;
	}

	if (status === "error") {
		const lineCount = stderrLines.length;
		const linesLabel = lineCount === 1 ? "1 line stderr" : `${lineCount} lines stderr`;
		const exit = exitCode !== undefined ? ` · exit ${exitCode}` : "";
		if (isDepth1) {
			if (lineCount === 0) {
				return `[bash:err] ${bashId}${exit}${tier} · 0 lines`;
			}
			const head = stderrLines.slice(0, 3).join("\n");
			return `[bash:err] ${bashId}${exit}${tier} · ${linesLabel}\n> stderr:\n${head}`;
		}
		return `[bash:err] ${bashId}${exit}`;
	}

	return `[bash] ${bashId} · status unknown`;
}


// ---------------------------------------------------------------------------
// Dedup index for batch tool results (W1 + E1)
// ---------------------------------------------------------------------------

interface DedupIndex {
	latestWrite: Map<string, string>;
	latestEdit: Map<string, string>;
	latestDelete: Map<string, string>;
	latestWebSearch: Map<string, string>;
	latestWebFetch: Map<string, string>;
	latestAskUser: Map<string, string>;
	bashIdToCommand: Map<string, string>;
	latestBash: Map<string, string>;
}


/**
 * Normalize a bash command string for use as a dedup key.
 */
function normalizeBashCommand(cmd: string): string {
	return cmd.trim().replace(/\s+/g, " ");
}

/**
 * Normalize a file path for use as a dedup key.
 */
function normalizeDedupPath(rawPath: string, cwd: string): string {
	let p = rawPath.replace(/\\/g, "/");
	if (p.startsWith("./")) {
		p = p.slice(2);
	}
	p = path.resolve(cwd, p);
	p = path.normalize(p);
	return p;
}

/**
 * Scan all batch tool results in the snapshot and build a DedupIndex.
 * Only successful writes/edits/deletes are tracked; error operations are exempt.
 */
function buildDedupIndex(
	lines: string[],
	toolCallIdToName: Map<string, string>,
	toolCallIdToArgs: Map<string, unknown>,
	sessionCwd?: string,
): DedupIndex {
	const cwd = sessionCwd ?? process.cwd();
	const latestWrite = new Map<string, string>();
	const latestEdit = new Map<string, string>();
	const latestDelete = new Map<string, string>();
	const latestWebSearch = new Map<string, string>();
	const latestWebFetch = new Map<string, string>();
	const latestAskUser = new Map<string, string>();
	const bashIdToCommand = new Map<string, string>();
	const latestBash = new Map<string, string>();

	for (const line of lines) {
		let entry: SnapshotEntry;
		try { entry = JSON.parse(line) as SnapshotEntry; } catch { continue; }
		if (entry?.type !== "message" || (entry.message?.role !== "tool" && entry.message?.role !== "toolResult")) continue;

		const toolCallId = entry.message?.toolCallId;
		if (typeof toolCallId !== "string") continue;
		const toolName = toolCallIdToName.get(toolCallId);
		if (toolName === "batch") {

		const text = extractToolResultText(entry as MessageEntry) ?? "";
		const textLines = text.replace(/\r\n/g, "\n").split("\n");

		for (let i = 0; i < textLines.length; i++) {
			const l = textLines[i];

			// Successful write
			const writeMatch = l.match(/^--- write: (.+) \((\d+) bytes\) ---$/);
			if (writeMatch) {
				const normPath = normalizeDedupPath(writeMatch[1].trim(), cwd);
				latestWrite.set(normPath, toolCallId);
				latestEdit.delete(normPath); // write supersedes earlier edits
				continue;
			}

			// Error write — exempt from dedup
			const errorWriteMatch = l.match(/^--- write: (.+) ---$/);
			if (errorWriteMatch) {
				continue;
			}

			// Successful edit
			const editMatch = l.match(/^--- edit: (.+) \(([^)]*)\) ---$/);
			if (editMatch) {
				const normPath = normalizeDedupPath(editMatch[1].trim(), cwd);
				latestEdit.set(normPath, toolCallId);
				continue;
			}

			// Error edit — exempt from dedup
			const errorEditMatch = l.match(/^--- edit: (.+) ---$/);
			if (errorEditMatch) {
				continue;
			}

			// Delete
			const deleteMatch = l.match(/^--- delete: (.+) ---$/);
			if (deleteMatch) {
				const normPath = normalizeDedupPath(deleteMatch[1].trim(), cwd);
				latestDelete.set(normPath, toolCallId);
				latestWrite.delete(normPath); // delete supersedes earlier writes
				latestEdit.delete(normPath);   // delete supersedes earlier edits
			}
		}

		// B1: Extract bash commands from batch args for cross-turn dedup
		const args = toolCallIdToArgs.get(toolCallId);
		if (args && typeof args === "object") {
			const a = args as Record<string, unknown>;
			const ops = Array.isArray(a.o) ? a.o : Array.isArray(a.op) ? a.op : undefined;
			if (ops) {
				for (const op of ops) {
					if (op && typeof op === "object") {
						const opObj = op as Record<string, unknown>;
						if (opObj.o === "bash" || opObj.op === "bash") {
							const cmd = typeof opObj.c === "string" ? opObj.c : "";
							const id = typeof opObj.i === "string" ? opObj.i : "";
							if (cmd && id) {
								const normCmd = normalizeBashCommand(cmd);
								bashIdToCommand.set(id, normCmd);
								latestBash.set(normCmd, id);
							}
						}
					}
				}
			}
		}
		}

		// Ask_user tool results — build A1 dedup index
		if (toolName === "ask_user") {
			const args = toolCallIdToArgs.get(toolCallId);
			if (args && typeof args === "object") {
				const question = (args as Record<string, unknown>).question;
				if (typeof question === "string") {
					const norm = question.trim().toLowerCase().slice(0, 120);
					if (norm) {
						latestAskUser.set(norm, toolCallId);
					}
				}
			}
		}

		// Web tool results — build Q1 dedup index
		if (toolName === "web") {
			const args = toolCallIdToArgs.get(toolCallId);
			if (args && typeof args === "object") {
				const a = args as Record<string, unknown>;
				const ops = Array.isArray(a.o) ? a.o : Array.isArray(a.op) ? a.op : undefined;
				if (ops && ops.length > 0) {
					const firstOp = ops[0];
					if (firstOp && typeof firstOp === "object") {
						const query = typeof firstOp.q === "string" ? firstOp.q.trim().toLowerCase() : undefined;
						const url = typeof firstOp.u === "string" ? firstOp.u.trim().replace(/\/$/, "") : undefined;
						if (query) latestWebSearch.set(query, toolCallId);
						if (url) latestWebFetch.set(url, toolCallId);
					}
				}
			}
		}
	}

	return { latestWrite, latestEdit, latestDelete, latestWebSearch, latestWebFetch, latestAskUser, bashIdToCommand, latestBash };
}

/** Check if a web tool result is superseded by a later result with the same query or URL. */
function checkWebDedup(
	args: unknown,
	toolCallId: string,
	dedupIndex: DedupIndex,
): { isSuperseded: boolean; marker?: string } {
	if (!args || typeof args !== "object") return { isSuperseded: false };
	const a = args as Record<string, unknown>;
	const ops = Array.isArray(a.o) ? a.o : Array.isArray(a.op) ? a.op : undefined;
	if (!ops || ops.length === 0) return { isSuperseded: false };
	const firstOp = ops[0];
	if (!firstOp || typeof firstOp !== "object") return { isSuperseded: false };

	if (typeof firstOp.q === "string") {
		const normQuery = firstOp.q.trim().toLowerCase();
		if (normQuery) {
			const latestTc = dedupIndex.latestWebSearch.get(normQuery);
			if (latestTc !== toolCallId) {
				return {
					isSuperseded: true,
					marker: `[web:search] "${firstOp.q}" (superseded by later search)`,
				};
			}
		}
	}

	if (typeof firstOp.u === "string") {
		const normUrl = firstOp.u.trim().replace(/\/$/, "");
		if (normUrl) {
			const latestTc = dedupIndex.latestWebFetch.get(normUrl);
			if (latestTc !== toolCallId) {
				return {
					isSuperseded: true,
					marker: `[web:fetch] ${firstOp.u} (superseded by later fetch)`,
				};
			}
		}
	}

	return { isSuperseded: false };
}

/** Compress batch tool result: compress bash sections, truncate read content, dedup writes/edits/deletes (W1 + E1). */
function compressBatchResult(
	text: string,
	options: {
		depthPolicy?: DepthPolicy;
		toolCallId?: string;
		latestWrite?: Map<string, string>;
		latestEdit?: Map<string, string>;
		latestDelete?: Map<string, string>;
		bashIdToCommand?: Map<string, string>;
		latestBash?: Map<string, string>;
		cwd?: string;
	} = {},
): string {
	const policy = options.depthPolicy ?? depthToPolicy(1);
	const { toolCallId, latestWrite, latestEdit, latestDelete, bashIdToCommand, latestBash } = options;
	const cwd = options.cwd ?? process.cwd();

	const lines = text.replace(/\r\n/g, "\n").split("\n");

	// Pre-scan to find the last occurrence of each operation within this result.
	// This handles the edge case where a single batch result contains multiple
	// writes/edits/deletes to the same path.
	const lastWriteIndex = new Map<string, number>();
	const lastEditIndex = new Map<string, number>();
	const lastDeleteIndex = new Map<string, number>();
	for (let j = 0; j < lines.length; j++) {
		const w = lines[j].match(/^--- write: (.+) \((\d+) bytes\) ---$/);
		if (w) lastWriteIndex.set(normalizeDedupPath(w[1].trim(), cwd), j);
		const e = lines[j].match(/^--- edit: (.+) \(([^)]*)\) ---$/);
		if (e) lastEditIndex.set(normalizeDedupPath(e[1].trim(), cwd), j);
		const d = lines[j].match(/^--- delete: (.+) ---$/);
		if (d) lastDeleteIndex.set(normalizeDedupPath(d[1].trim(), cwd), j);
	}

	const out: string[] = [];
	let i = 0;

	const isSupersededWrite = (normPath: string, index: number) => {
		if (!toolCallId) return false;
		const latestTc = latestWrite?.get(normPath);
		if (latestTc !== toolCallId) return true;
		return lastWriteIndex.get(normPath) !== index;
	};
	const isSupersededEdit = (normPath: string, index: number) => {
		if (!toolCallId) return false;
		const latestTc = latestEdit?.get(normPath);
		if (latestTc !== toolCallId) return true;
		return lastEditIndex.get(normPath) !== index;
	};
	const isSupersededDelete = (normPath: string, index: number) => {
		if (!toolCallId) return false;
		const latestTc = latestDelete?.get(normPath);
		if (latestTc !== toolCallId) return true;
		return lastDeleteIndex.get(normPath) !== index;
	};

	while (i < lines.length) {
		const line = lines[i];

		// Bash section — compress with X1 protocol
		const bashMatch = line.match(/^--- bash \[([^\]]+)\] (exit (\d+)|pending|error) ---$/);
		if (bashMatch) {
			const bashId = bashMatch[1];
			const rawStatus = bashMatch[2];
			const status: "ok" | "pending" | "error" = rawStatus.startsWith("exit") ? "ok" : rawStatus as "pending" | "error";
			const exitCode = bashMatch[3] !== undefined ? Number(bashMatch[3]) : undefined;
			// Stricter section-end check for bash content: don't treat generic
			// `--- text ---` lines as section headers (they could be bash output).
			const isBashSectionEnd = (l: string) =>
				/^--- bash \[.+\]/.test(l) ||
				/^--- (.+) \((\d+) lines\) ---$/.test(l) ||
				/^--- (.+) (context map|file summary) ---$/.test(l) ||
				/^--- edit: .+ ---$/.test(l) ||
				/^--- write: .+ ---$/.test(l) ||
				/^--- delete: .+ ---$/.test(l) ||
				/^--- read: .+ ---$/.test(l) ||
				/^--- rg: .+ ---$/.test(l);

			// B1 cross-turn bash dedup
			const normCmd = bashIdToCommand?.get(bashId);
			const isSupersededBash = normCmd ? latestBash?.get(normCmd) !== bashId : false;
			if (isSupersededBash) {
				if (policy.showSupersededBreadcrumbs) {
					const statusTag = status === "ok" ? "ok" : status === "pending" ? "pending" : "err";
					out.push(`[bash:${statusTag}] ${bashId} (superseded)`);
				}
				i++;
				while (i < lines.length && !isBashSectionEnd(lines[i])) {
					i++;
				}
				continue;
			}

			i++;
			let timingTier: string | undefined;
			const stdoutLines: string[] = [];
			let stderrLines: string[] = [];
			let inStderr = false;
			while (i < lines.length && !isBashSectionEnd(lines[i])) {
				const contentLine = lines[i];
				const timingMatch = contentLine.match(/^\[Execution time: (.+)\]$/);
				if (timingMatch) {
					timingTier = timingMatch[1];
				} else if (contentLine === "[stderr]") {
					inStderr = true;
				} else if (contentLine === "[partial output]") {
					// pending partial output marker — stdout follows
					inStderr = false;
				} else if (contentLine.startsWith("[Use batch_bash_poll")) {
					// skip poll hint lines
				} else {
					if (inStderr) {
						stderrLines.push(contentLine);
					} else {
						stdoutLines.push(contentLine);
					}
				}
				i++;
			}
			// If error bash has no stderr but produced stdout, preserve the stdout
			// as the error output so it isn't silently lost.
			if (status === "error" && stderrLines.length === 0 && stdoutLines.length > 0) {
				stderrLines = stdoutLines;
			}
			out.push(compressBashSection(bashId, status, exitCode, timingTier, stdoutLines, stderrLines, policy));
			continue;
		}

		// R1: rg output compression
		const rgMatch = line.match(/^--- rg: (.+) ---$/);
		if (rgMatch) {
			const rgPath = rgMatch[1].trim();
			i++;
			const rgLines: string[] = [];
			while (i < lines.length && !isKnownSectionHeader(lines[i])) {
				rgLines.push(lines[i]);
				i++;
			}
			// Trim trailing empty lines
			while (rgLines.length > 0 && rgLines[rgLines.length - 1] === "") rgLines.pop();
			const matchCount = rgLines.length;
			// Detect error: batch tool outputs "Error: <msg>" for failed rg ops
			const firstNonEmpty = rgLines.find((l) => l.trim() !== "");
			const isError = firstNonEmpty?.startsWith("Error:") ?? false;
			if (isError) {
				const lineCount = rgLines.filter((l) => l.trim() !== "").length;
				const linesLabel = lineCount === 1 ? "1 line" : `${lineCount} lines`;
				out.push(`[rg:err] ${rgPath} · ${linesLabel}`);
			} else if (matchCount === 0) {
				out.push(`[rg:ok] ${rgPath} · 0 matches`);
			} else {
				// Extract unique file paths from rg output (format: path:line:content)
				const fileSet = new Set(
					rgLines
						.map((l) => {
							const colonIdx = l.indexOf(":");
							return colonIdx > 0 ? l.slice(0, colonIdx) : "";
						})
						.filter(Boolean),
				);
				const fileCount = fileSet.size;
				if (policy.showPreviews) {
					const head = rgLines.slice(0, 3).join("\n");
					out.push(`[rg:ok] ${rgPath} · ${matchCount} matches · ${fileCount} files\n> head:\n${head}`);
				} else {
					out.push(`[rg:ok] ${rgPath} · ${matchCount} matches · ${fileCount} files`);
				}
			}
			i--; // will be incremented by loop
			continue;
		}

		// File read section with content — preview or truncate
		const readMatch = line.match(/^--- (.+) \((\d+) lines\) ---$/);
		if (readMatch) {
			if (policy.showPreviews) {
				i++;
				const contentLines: string[] = [];
				while (i < lines.length && !isKnownSectionHeader(lines[i])) {
					contentLines.push(lines[i]);
					i++;
				}
				const head = contentLines.slice(0, 2).join("\n");
				const tail = contentLines.slice(-2).join("\n");
				let previewText: string;
				if (contentLines.length > 4) {
					previewText = `${head}\n[...${contentLines.length - 4} lines truncated...]\n${tail}`;
				} else {
					previewText = contentLines.join("\n");
				}
				out.push(`--- ${readMatch[1]} (${readMatch[2]} lines, preview) ---\n${previewText}`);
			} else {
				out.push(`--- ${readMatch[1]} (${readMatch[2]} lines, content truncated) ---`);
				i++;
				while (i < lines.length && !isKnownSectionHeader(lines[i])) {
					i++;
				}
			}
			continue;
		}

		// Context map / file summary section — truncate
		const ctxMapMatch = line.match(/^--- (.+) (context map|file summary) ---$/);
		if (ctxMapMatch) {
			out.push(`--- ${ctxMapMatch[1]} (${ctxMapMatch[2]}, truncated) ---`);
			i++;
			while (i < lines.length && !isKnownSectionHeader(lines[i])) {
				i++;
			}
			continue;
		}

		// File read without line count — preview or truncate
		// Negative lookahead excludes bash/edit/write/delete/read-error sections that should be kept verbatim
		const fallbackReadMatch = line.match(/^--- (?!bash \[|edit:|write:|delete:|read:)(.+) ---$/);
		if (fallbackReadMatch) {
			if (policy.showPreviews) {
				i++;
				const contentLines: string[] = [];
				while (i < lines.length && !isKnownSectionHeader(lines[i])) {
					contentLines.push(lines[i]);
					i++;
				}
				const head = contentLines.slice(0, 2).join("\n");
				const tail = contentLines.slice(-2).join("\n");
				let previewText: string;
				if (contentLines.length > 4) {
					previewText = `${head}\n[...${contentLines.length - 4} lines truncated...]\n${tail}`;
				} else {
					previewText = contentLines.join("\n");
				}
				out.push(`--- ${fallbackReadMatch[1]} (preview) ---\n${previewText}`);
			} else {
				out.push(`--- ${fallbackReadMatch[1]} (content truncated) ---`);
				i++;
				while (i < lines.length && !isKnownSectionHeader(lines[i])) {
					i++;
				}
			}
			continue;
		}

		// Write section — W1 dedup and compression
		const writeMatch = line.match(/^--- write: (.+) \((\d+) bytes\) ---$/);
		if (writeMatch) {
			const rawPath = writeMatch[1].trim();
			const normPath = normalizeDedupPath(rawPath, cwd);
			const bytes = writeMatch[2];
			if (isSupersededWrite(normPath, i)) {
				if (policy.showSupersededBreadcrumbs) {
					out.push(`[batch:write] ${rawPath} (superseded)`);
				}
				i++;
				while (i < lines.length && !isKnownSectionHeader(lines[i])) {
					i++;
				}
				continue;
			}
			if (policy.showBytes) {
				out.push(`[batch:write] ${rawPath} (${bytes} bytes)`);
			} else {
				out.push(`[batch:write] ${rawPath}`);
			}
			i++;
			while (i < lines.length && !isKnownSectionHeader(lines[i])) {
				i++;
			}
			continue;
		}

		// Error write — exempt from dedup, keep verbatim
		const errorWriteMatch = line.match(/^--- write: (.+) ---$/);
		if (errorWriteMatch) {
			out.push(line);
			i++;
			while (i < lines.length && !isKnownSectionHeader(lines[i])) {
				out.push(lines[i]);
				i++;
			}
			continue;
		}

		// Edit section — E1 dedup and compression
		const editMatch = line.match(/^--- edit: (.+) \(([^)]*)\) ---$/);
		if (editMatch) {
			const rawPath = editMatch[1].trim();
			const normPath = normalizeDedupPath(rawPath, cwd);
			const blockInfo = editMatch[2];
			if (isSupersededEdit(normPath, i)) {
				if (policy.showSupersededBreadcrumbs) {
					out.push(`[batch:edit] ${rawPath} (superseded)`);
				}
				i++;
				while (i < lines.length && !isKnownSectionHeader(lines[i])) {
					i++;
				}
				continue;
			}
			if (policy.showEditBlocks) {
				const blocksLabel = blockInfo ? ` (${blockInfo})` : "";
				out.push(`[batch:edit] ${rawPath}${blocksLabel}`);
			} else {
				out.push(`[batch:edit] ${rawPath}`);
			}
			i++;
			while (i < lines.length && !isKnownSectionHeader(lines[i])) {
				i++;
			}
			continue;
		}

		// Error edit — exempt from dedup, keep verbatim
		const errorEditMatch = line.match(/^--- edit: (.+) ---$/);
		if (errorEditMatch) {
			out.push(line);
			i++;
			while (i < lines.length && !isKnownSectionHeader(lines[i])) {
				out.push(lines[i]);
				i++;
			}
			continue;
		}

		// Delete section — keep existing format for non-superseded, skip superseded
		const deleteMatch = line.match(/^--- delete: (.+) ---$/);
		if (deleteMatch) {
			const rawPath = deleteMatch[1].trim();
			const normPath = normalizeDedupPath(rawPath, cwd);
			if (isSupersededDelete(normPath, i)) {
				if (policy.showSupersededBreadcrumbs) {
					out.push(`[batch:delete] ${rawPath} (superseded)`);
				}
				i++;
				while (i < lines.length && !isKnownSectionHeader(lines[i])) {
					i++;
				}
				continue;
			}
			out.push(line);
			i++;
			while (i < lines.length && !isKnownSectionHeader(lines[i])) {
				out.push(lines[i]);
				i++;
			}
			continue;
		}

		// Everything else (summary, error generic, etc.) — keep as-is
		out.push(line);
		i++;
	}

	// B1: If every line in out is superseded or truncated noise, collapse to single summary
	const meaningfulOut = out.filter((l) => l.trim() !== "");
	// Single-pass rollup check: matches superseded breadcrumbs, truncated reads,
	// and compact bash/rg lines. Equivalent to the previous multi-check logic.
	const SUPERSEDED_OR_TRUNCATED_RE = /\(superseded\)|\(content truncated\)|\(context map, truncated\)|^\[bash:(ok|pending|err)\] |^\[bash:poll\] |^\[rg:(ok|err)\] /;
	const isAllSupersededOrTruncated = meaningfulOut.length > 0 && meaningfulOut.every((l) => SUPERSEDED_OR_TRUNCATED_RE.test(l));
	// At depth 2+, superseded writes/edits are dropped entirely (no breadcrumbs),
	// leaving out empty. If the original text had only section headers and no
	// summary or other kept content, rollup to a single line.
	const meaningfulLines = lines.filter((l) => l.trim() !== "");
	const allLinesWereSectionHeaders = meaningfulLines.length > 0 && meaningfulLines.every((l) => isKnownSectionHeader(l));
	if (isAllSupersededOrTruncated || (allLinesWereSectionHeaders && meaningfulOut.length === 0)) {
		const opCount = meaningfulLines.length > 0 ? String(meaningfulLines.length) : "0";
		return policy.showSupersededBreadcrumbs
			? `[batch] ${opCount} ops (all superseded or truncated by later operations)`
			: `[batch] ${opCount} ops (superseded)`;
	}

	return out.join("\n");
}

/** Compress web tool result into compact metadata. */
function compressWebResult(text: string, args?: unknown): string {
	// Try to extract query/url from args
	let query: string | undefined;
	let url: string | undefined;
	if (args && typeof args === "object") {
		const a = args as Record<string, unknown>;
		const ops = Array.isArray(a.o) ? a.o : Array.isArray(a.op) ? a.op : undefined;
		if (ops && ops.length > 0) {
			const firstOp = ops[0];
			if (firstOp && typeof firstOp === "object") {
				query = typeof firstOp.q === "string" ? firstOp.q : undefined;
				url = typeof firstOp.u === "string" ? firstOp.u : undefined;
			}
		}
	}

	// Search result format: numbered list
	if (text.match(/^\d+\. .+\n   https?:\/\//m)) {
		const lines = text.split("\n\n");
		const count = lines.length;
		const firstTitle = lines[0]?.match(/^\d+\. (.+)\n/)?.[1] ?? "unknown";
		const q = query ? ` "${query}"` : "";
		return `[web:search]${q} · ${count} results · first: ${firstTitle}`;
	}

	// Fetch result format: File/Title/Content length/Preview
	const fileMatch = text.match(/^File: (.+)\n/m);
	const titleMatch = text.match(/^Title: (.+)\n/m);
	const lengthMatch = text.match(/^Content length: (\d+) chars\n/m);
	if (fileMatch || titleMatch || lengthMatch || url) {
		const file = url ?? fileMatch?.[1] ?? "";
		const title = titleMatch?.[1] ?? "";
		const length = lengthMatch?.[1] ?? "0";
		return `[web:fetch] ${file} · "${title}" · ${length} chars`;
	}

	return `[web] result truncated (${text.length} chars)`;
}

/** Compress ask_user tool result into compact metadata. */
function compressAskUserResult(text: string, args?: unknown): string {
	let question = "";
	if (args && typeof args === "object") {
		const q = (args as Record<string, unknown>).question;
		if (typeof q === "string") {
			question = q.length > 80 ? q.slice(0, 77) + "..." : q;
		}
	}

	const answeredMatch = text.match(/^User answered: (.+)$/ms);
	if (answeredMatch) {
		const q = question ? ` "${question}"` : "";
		return `[ask_user]${q} → "${answeredMatch[1]}"`;
	}
	if (text.match(/^User cancelled/m)) {
		const q = question ? ` "${question}"` : "";
		return `[ask_user]${q} → cancelled`;
	}
	return `[ask_user] · ${text.length} chars`;
}

/** Compress batch_bash_poll tool result into compact metadata (S4 + B1). */
function compressBatchBashPollResult(
	text: string,
	policy: DepthPolicy,
	options?: {
		bashIdToCommand?: Map<string, string>;
		latestBash?: Map<string, string>;
	},
): string {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const out: string[] = [];
	let i = 0;
	const isDepth1 = policy.showPreviews;
	const isPollSectionEnd = (l: string) => /^--- \[.+\]/.test(l);

	while (i < lines.length) {
		const line = lines[i];
		const completedMatch = line.match(/^--- \[([^\]]+)\] (exit (\d+)|interrupted) ---$/);
		const pendingMatch = line.match(/^--- \[([^\]]+)\] still running ---$/);

		if (completedMatch || pendingMatch) {
			const id = (completedMatch ?? pendingMatch)![1];
			const isCompleted = !!completedMatch;
			const exitCode = completedMatch?.[3] !== undefined ? Number(completedMatch[3]) : undefined;

			// B1 cross-turn bash dedup for poll results
			const normCmd = options?.bashIdToCommand?.get(id);
			const isSuperseded = normCmd ? options?.latestBash?.get(normCmd) !== id : false;
			if (isSuperseded) {
				if (policy.showSupersededBreadcrumbs) {
					out.push(`[bash:poll] ${id} (superseded)`);
				}
				i++;
				while (i < lines.length && !isPollSectionEnd(lines[i])) {
					i++;
				}
				continue;
			}

			i++;
			let timingTier: string | undefined;
			const stdoutLines: string[] = [];
			let stderrLines: string[] = [];
			let inStderr = false;
			while (i < lines.length && !isPollSectionEnd(lines[i])) {
				const contentLine = lines[i];
				const timingMatch = contentLine.match(/^\[Execution time: (.+)\]$/);
				if (timingMatch) {
					timingTier = timingMatch[1];
				} else if (contentLine === "[stderr]") {
					inStderr = true;
				} else if (contentLine === "[output so far]") {
					inStderr = false;
				} else if (contentLine.trim() === "") {
					// skip empty lines between sections
				} else {
					if (inStderr) {
						stderrLines.push(contentLine);
					} else {
						stdoutLines.push(contentLine);
					}
				}
				i++;
			}
			const tier = timingTier ? ` · ${timingTier}` : "";
			if (isCompleted) {
				const statusTag = exitCode !== undefined ? `exit ${exitCode}` : "interrupted";
				const statusLabel = exitCode === 0 ? "ok" : "error";
				if (statusLabel === "error" && stderrLines.length === 0 && stdoutLines.length > 0) {
					stderrLines = stdoutLines;
				}
				const targetLines = statusLabel === "error" ? stderrLines : stdoutLines;
				const lineCount = targetLines.length;
				if (isDepth1) {
					if (lineCount === 0) {
						out.push(`[bash:poll] ${id} · ${statusTag}${tier} · 0 lines`);
					} else {
						const linesLabel = statusLabel === "error"
							? (lineCount === 1 ? "1 line stderr" : `${lineCount} lines stderr`)
							: (lineCount === 1 ? "1 line" : `${lineCount} lines`);
						const headPrefix = statusLabel === "error" ? "> stderr:" : "> head:";
						const head = targetLines.slice(0, 3).join("\n");
						out.push(`[bash:poll] ${id} · ${statusTag}${tier} · ${linesLabel}\n${headPrefix}\n${head}`);
					}
				} else {
					out.push(`[bash:poll] ${id} · ${statusTag}${tier}`);
				}
			} else {
				const lineCount = stdoutLines.length;
				const linesLabel = lineCount === 1 ? "1 line partial" : `${lineCount} lines partial`;
				if (isDepth1) {
					if (lineCount === 0) {
						out.push(`[bash:poll] ${id} · still running · 0 lines partial`);
					} else {
						const head = stdoutLines.slice(0, 3).join("\n");
						out.push(`[bash:poll] ${id} · still running · ${linesLabel}\n> head:\n${head}`);
					}
				} else {
					out.push(`[bash:poll] ${id} · still running`);
				}
			}
			continue;
		}

		out.push(line);
		i++;
	}

	return out.join("\n");
}

// ---------------------------------------------------------------------------
// Shared: toolCallId → toolName mapping
// ---------------------------------------------------------------------------

/**
 * Build a map from toolCallId → toolName by scanning assistant messages.
 */
function buildToolCallIdToNameMap(lines: string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const line of lines) {
		let entry: SnapshotEntry;
		try { entry = JSON.parse(line) as SnapshotEntry; } catch { continue; }
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part.type === "toolCall" && part.name) {
				const tcId = part.id ?? part.toolCallId;
				if (typeof tcId === "string" && tcId.trim()) {
					map.set(tcId, part.name);
				}
			}
		}
	}
	return map;
}

// ---------------------------------------------------------------------------
// Tool result compression (flow + batch_read)
// ---------------------------------------------------------------------------

/**
 * Compress tool results in a sanitized session snapshot.
 *
 * Handles two tool types:
 * - `flow` results: replaced with compact CompressedFlowResult output from cache.
 * - `batch_read` results: replaced with compact metadata (paths + op count)
 *   since children have `batch` and can re-read files themselves.
 */
export function compressToolResults(snapshot: string, cache: Map<string, CompressedFlowResult[]>, depthPolicy?: DepthPolicy): string {
	const policy = depthPolicy ?? depthToPolicy(1);
	const lines = snapshot.trimEnd().split("\n");

	// Quick check: if there are no flow cache entries and no compressible tool calls,
	// nothing to compress — return early.
	if (cache.size === 0) {
		const hasCompressible = lines.some((line) => {
			try {
				const entry: SnapshotEntry = JSON.parse(line) as SnapshotEntry;
				return entry?.type === "message" && entry.message?.role === "assistant" &&
					Array.isArray(entry.message.content) &&
					entry.message.content.some((p: ContentPart) =>
						p.type === "toolCall" &&
						["batch_read", "batch", "web", "ask_user", "batch_bash_poll"].includes(p.name as string),
					);
			} catch { return false; }
		});
		const hasToolResultMessages = lines.some((line) => {
			try {
				const entry: SnapshotEntry = JSON.parse(line) as SnapshotEntry;
				return entry?.type === "message" &&
					(entry.message?.role === "tool" || entry.message?.role === "toolResult");
			} catch { return false; }
		});
		// Must run the pass whenever tool results exist: we drop empty/whitespace
		// toolCallIds and pass through bash/flow/etc. even when the cache is empty.
		if (!hasCompressible && !hasToolResultMessages) return snapshot;
	}

	// Build toolCallId → toolName mapping
	const toolCallIdToName = buildToolCallIdToNameMap(lines);

	// Build toolCallId → arguments mapping for all tools (needed for batch/web/ask_user metadata)
	const toolCallIdToArgs = new Map<string, unknown>();
	for (const line of lines) {
		let entry: SnapshotEntry;
		try { entry = JSON.parse(line) as SnapshotEntry; } catch { continue; }
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part.type === "toolCall" && (part.id || part.toolCallId) && part.arguments) {
				toolCallIdToArgs.set((part.id ?? part.toolCallId) as string, part.arguments);
			}
		}
	}

	// Extract session cwd from header for path normalization
	let sessionCwd = process.cwd();
	for (const line of lines) {
		let entry: SnapshotEntry;
		try { entry = JSON.parse(line) as SnapshotEntry; } catch { continue; }
		if (entry?.type === "session" || entry?.type === "header") {
			if (typeof entry.cwd === "string") {
				sessionCwd = entry.cwd;
				break;
			}
		}
	}

	// === PASS 1 (pre-scan): Build DedupIndex for batch and web tool results (W1 + E1 + Q1) ===
	const dedupIndex = buildDedupIndex(lines, toolCallIdToName, toolCallIdToArgs, sessionCwd);

	const result: string[] = [];
	let webSummaryEmitted = false;

	// Second pass: compress matching tool results
	for (const line of lines) {
		let entry: SnapshotEntry;
		try { entry = JSON.parse(line) as SnapshotEntry; } catch { result.push(line); continue; }

		if (entry?.type !== "message" || (entry.message?.role !== "tool" && entry.message?.role !== "toolResult")) {
			result.push(line);
			continue;
		}

		// Extract toolCallId — message-level or content-level toolResult.
		// Drop only *explicit* empty/whitespace IDs (APIs reject those). Missing
		// toolCallId is treated as legacy shape and passes through unchanged.
		let toolCallId: string | undefined;
		let invalidEmptyId = false;

		if (typeof entry.message.toolCallId === "string") {
			const v = entry.message.toolCallId;
			if (!v.trim()) invalidEmptyId = true;
			else toolCallId = v;
		} else if (Array.isArray(entry.message.content)) {
			for (const part of entry.message.content) {
				if (part.type === "toolResult" && typeof part.toolCallId === "string") {
					if (!part.toolCallId.trim()) {
						invalidEmptyId = true;
						break;
					}
					toolCallId = part.toolCallId;
					break;
				}
			}
		}

		if (invalidEmptyId) continue;

		if (!toolCallId) {
			result.push(line);
			continue;
		}

		const toolName = toolCallIdToName.get(toolCallId);
		let rendered: string | undefined;
		let originalText = "";

		// --- Compress flow tool results ---
		if (toolName === "flow") {
			const compressed = cache.get(toolCallId);
			if (!compressed || compressed.length === 0) {
				// Cache miss (never populated or evicted) — do NOT pass megabytes of raw
				// flow output verbatim into child context. Render a minimal placeholder.
				originalText = extractToolResultText(entry as MessageEntry) ?? "";
				const flowArgs = toolCallIdToArgs.get(toolCallId);
				let flowTypeSuffix = '';
				if (flowArgs && typeof flowArgs === 'object') {
					const flowArr = Array.isArray((flowArgs as Record<string, unknown>).flow)
						? (flowArgs as Record<string, unknown>).flow as Array<Record<string, unknown>>
						: undefined;
					if (flowArr && flowArr.length > 0 && typeof flowArr[0].type === 'string') {
						flowTypeSuffix = `:${flowArr[0].type}`;
					} else if (typeof (flowArgs as Record<string, unknown>).type === 'string') {
						flowTypeSuffix = `:${(flowArgs as Record<string, unknown>).type}`;
					}
				}
				const statusLabel = entry.message.isError ? 'failed' : 'completed';
				rendered = `[flow${flowTypeSuffix}] ${statusLabel} · see prior session`;
			} else {
				const renderedParts: string[] = [];
				for (const r of compressed) {
					const renderedResult = renderCompressedFlowResult(r);
					if (renderedResult === undefined) {
						// Granular fallback: only this element is malformed, don't waste
						// valid siblings by falling back the entire array to raw text.
						const flowType = r.type ?? "unknown";
						const status = r.status ?? "unknown";
						renderedParts.push(`[flow:${flowType}] ${status} (cache miss)`);
					} else {
						renderedParts.push(renderedResult);
					}
				}
				rendered = renderedParts.join("\n\n");
			}
		}

		// --- Compress batch tool results (selective: compress bash, truncate reads, dedup writes/edits/deletes) ---
		else if (toolName === "batch") {
			originalText = extractToolResultText(entry as MessageEntry) ?? "";
			rendered = compressBatchResult(originalText, {
				depthPolicy: policy,
				toolCallId,
				latestWrite: dedupIndex.latestWrite,
				latestEdit: dedupIndex.latestEdit,
				latestDelete: dedupIndex.latestDelete,
				bashIdToCommand: dedupIndex.bashIdToCommand,
				latestBash: dedupIndex.latestBash,
				cwd: sessionCwd,
			});
		}

		// --- Compress batch_bash_poll tool results (S4 + B1) ---
		else if (toolName === "batch_bash_poll") {
			originalText = extractToolResultText(entry as MessageEntry) ?? "";
			rendered = compressBatchBashPollResult(originalText, policy, {
				bashIdToCommand: dedupIndex.bashIdToCommand,
				latestBash: dedupIndex.latestBash,
			});
		}

		// --- Compress web tool results (Q1 dedup) ---
		else if (toolName === "web") {
			originalText = extractToolResultText(entry as MessageEntry) ?? "";
			const args = toolCallIdToArgs.get(toolCallId);
			const { isSuperseded, marker } = checkWebDedup(args, toolCallId, dedupIndex);
			if (isSuperseded) {
				if (policy.showSupersededBreadcrumbs) {
					rendered = marker;
				} else {
					// At depth 2+, drop superseded web results entirely
					continue;
				}
			} else {
				rendered = compressWebResult(originalText, args);
				if (!policy.showSupersededBreadcrumbs && !webSummaryEmitted) {
					const searchCount = dedupIndex.latestWebSearch.size;
					const fetchCount = dedupIndex.latestWebFetch.size;
					const total = searchCount + fetchCount;
					if (total > 0) {
						const fetchLabel = fetchCount === 1 ? "fetch" : "fetches";
						rendered = `[web] ${total} unique queries (${searchCount} searches, ${fetchCount} ${fetchLabel}) · latest per query below\n${rendered}`;
						webSummaryEmitted = true;
					}
				}
			}
		}

		// --- Compress ask_user tool results (A1 dedup) ---
		else if (toolName === "ask_user") {
			originalText = extractToolResultText(entry as MessageEntry) ?? "";
			const args = toolCallIdToArgs.get(toolCallId);
			let question = "";
			if (args && typeof args === "object") {
				const q = (args as Record<string, unknown>).question;
				if (typeof q === "string") {
					question = q;
				}
			}
			const normQuestion = question.trim().toLowerCase().slice(0, 120);
			const latestTc = normQuestion ? dedupIndex.latestAskUser.get(normQuestion) : undefined;
			if (latestTc && latestTc !== toolCallId) {
				if (policy.showSupersededBreadcrumbs) {
					rendered = `[ask_user] "${question}" (superseded by later ask_user)`;
				} else {
					// At depth 2+, drop superseded ask_user results entirely
					continue;
				}
			} else {
				rendered = compressAskUserResult(originalText, args);
			}
		}

		if (rendered !== undefined) {
			logCompress(toolName ?? "unknown", originalText.length || line.length, rendered.length);

			// Strip the 'details' field which carries UI metadata that children don't need.
			// This eliminates ~98% of payload bloat from flow tool results.
			const { details, ...messageWithoutDetails } = entry.message;

			if (typeof entry.message.toolCallId === "string") {
				entry = {
					...entry,
					message: {
						...messageWithoutDetails,
						content: [{ type: "text", text: rendered }],
					},
				};
			} else {
				entry = {
					...entry,
					message: {
						...messageWithoutDetails,
						content: (entry.message!.content as ContentPart[]).map((part: ContentPart) =>
							part.type === "toolResult" && part.toolCallId === toolCallId
								? { ...part, content: rendered }
								: part,
						),
					},
				};
			}

			result.push(JSON.stringify(entry));
			continue;
		}

		// Other tool results pass through unchanged
		result.push(line);
	}

	return `${result.join("\n")}\n`;
}

/** Extract text content from a tool result entry for compression analysis. */
function extractToolResultText(entry: MessageEntry): string | undefined {
	if (typeof entry.message?.content === "string") {
		return entry.message.content;
	}
	if (Array.isArray(entry.message?.content)) {
		for (const part of entry.message.content) {
			if (part.type === "text" && typeof part.text === "string") {
				return part.text;
			}
		}
	}
	return undefined;
}



// ---------------------------------------------------------------------------
// batch_read tool call stripping
// ---------------------------------------------------------------------------

/**
 * Strip batch_read tool calls from assistant messages in a session snapshot.
 *
 * Children don't have batch_read in their active tools, so seeing calls to it
 * could confuse the model. This removes toolCall parts where name === "batch_read"
 * from assistant messages AND drops the corresponding toolResult messages
 * whose toolCallId references a stripped batch_read call. Keeping orphaned tool
 * results causes strict API providers (e.g. kimi-coding, DeepSeek) to reject
 * the request with `tool_call_id is not found`.
 */
/**
 * Check if an assistant message is empty (continuation marker with no semantic value).
 * Empty means: no substantive text, no tool calls.
 */
function isEmptyAssistantMessage(message: SnapshotMessage): boolean {
	if (message.role !== "assistant") return false;

	const content = message.content;

	// Null/undefined/empty string
	if (content === null || content === undefined || content === "") return true;

	// Whitespace-only string
	if (typeof content === "string" && content.trim() === "") return true;

	// Array content: check for no text parts or only whitespace text parts, and NO tool calls
	if (Array.isArray(content)) {
		const hasToolCall = content.some((p) => (p as ContentPart).type === "toolCall");
		if (hasToolCall) return false;

		const textParts = content.filter(
			(p): p is TextPart =>
				(p as ContentPart).type === "text" && typeof (p as TextPart).text === "string",
		);
		if (textParts.length === 0) return true;

		const allWhitespace = textParts.every((p) => p.text.trim() === "");
		if (allWhitespace) return true;

		// Low-signal detection: short text with no actionable markers
		const fullText = textParts.map((p) => p.text).join("");
		if (fullText.length < 300) {
			const hasFilePath = /\w+\.\w+/.test(fullText);
			const hasToolReference = /\[[a-z_]+[^\]]*\]/.test(fullText);
			const hasCodeBlock = fullText.includes("```");
			const hasActionableMarkers = hasFilePath || hasToolReference || hasCodeBlock;
			if (!hasActionableMarkers) return true;
		}
	}

	return false;
}

export function stripBatchReadToolCalls(snapshot: string): string {
	const lines = snapshot.trimEnd().split("\n");

	// Pass 1: Collect all batch_read toolCallIds from assistant messages.
	const batchReadToolCallIds = new Set<string>();
	for (const line of lines) {
		let entry: SnapshotEntry;
		try { entry = JSON.parse(line) as SnapshotEntry; } catch { continue; }

		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;

		for (const part of content) {
			if (part.type === "toolCall" && part.name === "batch_read" && (part.id || part.toolCallId)) {
				batchReadToolCallIds.add((part.id ?? part.toolCallId) as string);
			}
		}
	}

	// Pass 2: Strip batch_read toolCall parts from assistant messages,
	// and remove orphaned tool result messages.
	const result: string[] = [];

	for (const line of lines) {
		let entry: SnapshotEntry;
		try { entry = JSON.parse(line) as SnapshotEntry; } catch { result.push(line); continue; }

		if (entry?.type !== "message") {
			result.push(line);
			continue;
		}

		// Tool result message — skip if it's a batch_read result
		if (entry.message!.role === "tool" || entry.message!.role === "toolResult") {
			const toolCallId = entry.message!.toolCallId ??
				(Array.isArray(entry.message!.content) ? entry.message!.content.find((p: ContentPart) => p.type === "toolResult")?.toolCallId : undefined);
			if (toolCallId && batchReadToolCallIds.has(toolCallId)) continue;
			result.push(line);
			continue;
		}

		if (entry.message!.role !== "assistant") { result.push(line); continue; }

		const content = entry.message!.content;
		if (!Array.isArray(content)) { result.push(line); continue; }

		const hasBatchReadCall = content.some(
			(part: ContentPart) => part.type === "toolCall" && part.name === "batch_read",
		);
		if (!hasBatchReadCall) { result.push(line); continue; }

		const filteredContent = content.filter(
			(part: ContentPart) => !(part.type === "toolCall" && part.name === "batch_read"),
		);

		if (filteredContent.length === 0) {
			// Skip assistant messages that have no content after stripping batch_read
			// — an empty text placeholder wastes tokens and conveys nothing.
			continue;
		}

		result.push(JSON.stringify({
			...entry,
			message: {
				...entry.message,
				content: filteredContent,
			},
		}));
	}

	return `${result.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Flow tool call argument compression
// ---------------------------------------------------------------------------

/**
 * Compress verbose `flow` tool call arguments in assistant messages.
 *
 * The child flow already receives its own `-p` activation prompt, so the full
 * mission text inside the JSONL assistant message is pure duplication.
 * Replaces the arguments with a compact summary `{type, aim, steps}`.
 */
export function compressFlowToolCallArgs(snapshot: string): string {
	const lines = snapshot.trimEnd().split("\n");
	const result: string[] = [];

	for (const line of lines) {
		let entry: SnapshotEntry;
		try { entry = JSON.parse(line) as SnapshotEntry; } catch { result.push(line); continue; }

		if (entry?.type !== "message" || entry.message?.role !== "assistant") {
			result.push(line);
			continue;
		}

		const content = entry.message.content;
		if (!Array.isArray(content)) {
			result.push(line);
			continue;
		}

		let modified = false;
		const newContent = content.map((part: ContentPart) => {
			if (part.type !== "toolCall" || part.name !== "flow") return part;

			const args = part.arguments;
			if (!args || typeof args !== "object") return part;

			const flowArr = Array.isArray((args as Record<string, unknown>).flow)
				? (args as Record<string, unknown>).flow as Array<Record<string, unknown>>
				: undefined;

			if (!flowArr || flowArr.length === 0) return part;

			const firstFlow = flowArr[0];
			const type = typeof firstFlow?.type === "string" ? firstFlow.type : undefined;
			const aim = typeof firstFlow?.aim === "string" ? firstFlow.aim : undefined;
			const steps = Array.isArray(firstFlow?.steps) ? firstFlow.steps.length : undefined;

			if (!type && !aim && steps === undefined) return part;

			modified = true;
			return {
				...part,
				arguments: { type, aim, steps },
			};
		});

		if (!modified) {
			result.push(line);
			continue;
		}

		result.push(JSON.stringify({
			...entry,
			message: {
				...entry.message,
				content: newContent,
			},
		}));
	}

	return `${result.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Reparent orphans
// ---------------------------------------------------------------------------

/**
 * Fix parentId references that point to messages which no longer exist.
 * Call this after any pass that drops messages.
 */
function reparentOrphans(snapshot: string): string {
	const lines = snapshot.trimEnd().split("\n");
	const survivingIds = new Set<string>();
	for (const line of lines) {
		try {
			const entry: SnapshotEntry = JSON.parse(line) as SnapshotEntry;
			const id = entry?.message?.id ?? entry?.message?.messageId ?? entry?.id;
			if (typeof id === "string" && id) survivingIds.add(id);
			// Only ids of actual entries should be in survivingIds; parentId refs
			// are checked in the second pass, not added here.
		} catch (err) {
			logWarn(`[pi-agent-flow] reparentOrphans id scan failed: ${err}`);
		}
	}
	for (let i = 0; i < lines.length; i++) {
		try {
			let entry: SnapshotEntry = JSON.parse(lines[i]) as SnapshotEntry;
			let modified = false;
			const isMessageEntry = entry?.type === "message";

			// Fix top-level parentId only for message entries (not session headers).
			if (isMessageEntry) {
				if (typeof entry.parentId === "string" && entry.parentId && !survivingIds.has(entry.parentId)) {
					const { parentId: _pid, ...restEntry } = entry;
					entry = restEntry;
					modified = true;
				}
				if (typeof entry.parentMessageId === "string" && entry.parentMessageId && !survivingIds.has(entry.parentMessageId)) {
					const { parentMessageId: _pmid, ...restEntry } = entry;
					entry = restEntry;
					modified = true;
				}
			}

			// Fix message-level parentId for all entries.
			const msg = entry.message;
			if (msg) {
				if (typeof msg.parentId === "string" && msg.parentId && !survivingIds.has(msg.parentId)) {
					const { parentId: _pid, ...restMessage } = msg;
					entry = { ...entry, message: restMessage };
					modified = true;
				}
				if (typeof msg.parentMessageId === "string" && msg.parentMessageId && !survivingIds.has(msg.parentMessageId)) {
					const { parentMessageId: _pmid, ...restMessage } = msg;
					entry = { ...entry, message: restMessage };
					modified = true;
				}
			}

			if (modified) {
				lines[i] = JSON.stringify(entry);
			}
		} catch (err) {
			logWarn(`[pi-agent-flow] reparentOrphans breadcrumb fix failed: ${err}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Snapshot sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize a fork session snapshot JSONL to remove non-inheritable
 * artifacts before passing parent context to child flows:
 * sliding system prompts, assistant reasoning/thinking,
 * batch_read tool calls, and compress flow/batch_read tool results.
 */
export interface SanitizeForkSnapshotOptions {
	forkedFrom?: string;
	forkedAt?: string;
	parentFlow?: string;
	depth?: number;
}

export interface SanitizeForkSnapshotResult {
	result: string | null;
	passesApplied: string[];
	stats: { preBytes: number; postBytes: number; reductionPercent: number; passesApplied: string[]; passDeltas?: Record<string, number> } | null;
}

export function sanitizeForkSnapshot(
	snapshot: string | null,
	cache: Map<string, CompressedFlowResult[]> = new Map(),
	options?: SanitizeForkSnapshotOptions,
): SanitizeForkSnapshotResult {
	if (!snapshot) return { result: snapshot, passesApplied: [], stats: null };

	const preBytes = snapshot.length;
	const lines = snapshot.trimEnd().split("\n");
	const sanitizedLines: string[] = [];
	const subPasses = new Set<string>();

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		let entry: SnapshotEntry;
		try {
			entry = JSON.parse(line) as SnapshotEntry;
		} catch (err) {
			logWarn(`[pi-agent-flow] sanitizeForkSnapshot parse failed: ${err}`);
			sanitizedLines.push(line);
			continue;
		}

		let changed = false;

		// Strip outer entry timestamp from all entries — child replay doesn't need it
		// (JSONL line ordering is sufficient).
		if ("timestamp" in entry) {
			const { timestamp, ...restEntry } = entry;
			entry = restEntry;
			changed = true;
			subPasses.add("stripTimestamps");
		}

		// Header (first line): replace parent system prompt.
		if (i === 0 && entry && typeof entry === "object") {
			// Replace the parent root state system prompt with a brief note.
			// Children receive their own directive in the <activation> block.
			if (entry.systemPrompt && typeof entry.systemPrompt === "string") {
				entry = { ...entry, systemPrompt: "[parent root state system prompt stripped — child receives its own directive]" };
				changed = true;
				subPasses.add("stripSystemPrompt");
			}

			// Prevent child from inheriting parent's session identity.
			// Rename id → parentId so lineage is preserved but the child
			// generates its own session identifier.
			if ('id' in entry) {
				entry = { ...entry, parentId: entry.id };
				delete entry.id;
				changed = true;
				subPasses.add('stripSessionId');
			}
		}

		// Whitelist session entry fields to prevent unknown metadata leaks.
		const isSessionHeader = i === 0 || entry?.type === "session";
		if (isSessionHeader && entry && typeof entry === "object") {
			const allowedHeaderKeys = new Set<string>([
				"type", "systemPrompt", "version", "cwd",
				"forkedFrom", "forkedAt", "parentFlow", "depth", "parentId",
				"meta",
			]);
			const entryKeys = Object.keys(entry);
			const hasUnknownHeaderField = entryKeys.some((k) => !allowedHeaderKeys.has(k));
			if (hasUnknownHeaderField) {
				const whitelisted: Record<string, unknown> = {};
				for (const key of entryKeys) {
					if (allowedHeaderKeys.has(key)) {
						whitelisted[key] = (entry as Record<string, unknown>)[key];
					}
				}
				entry = whitelisted as SnapshotEntry;
				changed = true;
				subPasses.add("stripUnknownHeaderFields");
			}
		}

		// Drop type: "system" entries — the parent root state system prompt was already
		// stripped from the header above. Standalone system events leak the full prompt.
		// Children receive their own directive in the <activation> block.
		if (entry?.type === "system") {
			subPasses.add("dropSystemEvents");
			continue;
		}

		// Drop custom_message entries — hidden root state instructions (e.g.
		// flow continuation hook messages with display:false) that children
		// should never see.
		if (entry?.type === "custom_message") {
			subPasses.add("dropCustomMessages");
			continue;
		}

		// Drop parent-specific configuration events; child receives its own
		// model/tier via the <activation> block and CLI args.
		if (entry?.type === "model_change" || entry?.type === "thinking_level_change") {
			subPasses.add("dropConfigEvents");
			continue;
		}

		// Defense-in-depth: drop entries with an explicit unknown type that do not
		// belong in the fork snapshot protocol. Entries without a type field (e.g. bare
		// session headers from getHeader) pass through unchanged.
		if (
			entry?.type !== undefined &&
			entry?.type !== "session" &&
			entry?.type !== "message"
		) {
			subPasses.add("dropUnknownTypes");
			continue;
		}

		// Drop malformed message entries that lack a message payload.
		if (entry?.type === "message" && !entry.message) {
			subPasses.add("dropMalformedMessages");
			continue;
		}

		// Drop sliding system prompt messages entirely.
		if (
			entry?.type === "message" &&
			entry.message?.role === "system" &&
			contentContainsSteeringHintTag(entry.message?.content as string | Array<{ type: string; text?: string }>)
		) {
			subPasses.add("dropSlidingSystemPrompts");
			continue;
		}

		if (entry?.type === "message" && entry.message) {
			let message = entry.message;

			// Normalize internal "toolResult" role to "tool" for API compatibility.
			if (message.role === "toolResult") {
				message = { ...message, role: "tool" };
				changed = true;
				subPasses.add("normalizeToolResultRole");
			}

			// Strip reasoning/thinking from assistant messages.
			// (Reasoning typically only appears in assistant messages, but we
			// also check system/tool roles as a safety net for provider-specific
			// formats. stripReasoningFromAssistantMessage is a no-op on non-assistant
			// shapes, so calling it universally is safe.)
			if (message.role === "assistant" || message.role === "system" || message.role === "tool") {
				const stripped = stripReasoningFromAssistantMessage(message);
				message = stripped.message;
				if (stripped.changed) {
					changed = true;
					subPasses.add("stripReasoning");
				}
			}

			// Strip inner `message.timestamp` — the outer event-level timestamp (ISO string)
			// is sufficient for ordering. The inner epoch-ms timestamp is redundant.
			if ("timestamp" in message) {
				const { timestamp, ...restMessage } = message;
				message = restMessage;
				changed = true;
				subPasses.add("stripTimestamps");
			}

			// Strip API metadata fields that children don't need (~5-7 KB per assistant message).
			// IMPORTANT: keep `usage.totalTokens` ONLY. The child `pi` process replays
			// this JSONL and core/session code reads `message.usage.totalTokens`; stripping
			// `usage` causes: Cannot read properties of undefined (reading 'totalTokens').
			// Other fields (input, output, cacheRead, cacheWrite) are consumed only from
			// live child stdout events (runner-events.ts), never from fork snapshot replay.
			if (message.role === "assistant") {
				const { api, provider, model, stopReason, responseId, responseModel, usage, ...rest } = message;
				let stripped = false;
				if (api !== undefined || provider !== undefined || model !== undefined ||
					stopReason !== undefined || responseId !== undefined || responseModel !== undefined) {
					stripped = true;
				}
				// Compress usage to totalTokens only — child pi replay requires totalTokens.
				// Other fields (input, output, cacheRead, cacheWrite) are consumed only from
				// live child stdout events (runner-events.ts), never from fork snapshot replay.
				let cleanedUsage: { totalTokens?: number } | undefined;
				if (usage && typeof usage === "object") {
					const ttl = (usage as Record<string, unknown>).totalTokens;
					if (typeof ttl === "number") {
						cleanedUsage = { totalTokens: ttl };
						stripped = true;
					}
				}
				if (stripped) {
					message = { ...rest, ...(cleanedUsage !== undefined ? { usage: cleanedUsage } : {}) };
					changed = true;
					subPasses.add("stripApiMetadata");
				}
			}

			// Collapse empty/low-signal assistant messages to a minimal continuation marker.
			if (message.role === "assistant" && isEmptyAssistantMessage(message)) {
				const totalTokens = message.usage?.totalTokens;
				const { usage: _usage, ...rest } = message;
				message = {
					...rest,
					...(totalTokens !== undefined ? { usage: { totalTokens } } : {}),
					content: totalTokens !== undefined
						? `[assistant: ${totalTokens} tokens, no action]`
						: "[assistant:continuation]",
				};
				changed = true;
				subPasses.add("collapseEmptyAssistantMessages");
			}

			// Strip `details` from tool/toolResult messages — carries FlowDetails UI metadata
			// (mode, flowStyle, projectAgentsDir, results) that children never need.
			if (message.role === "tool" || message.role === "toolResult") {
				if ("details" in message) {
					const { details, ...restMessage } = message;
					message = restMessage;
					changed = true;
					subPasses.add("stripDetails");
				}
			}

			if ("content" in message) {
				let modifiedContent = message.content;

				// Strip sliding prompts
				const afterSliding = stripSteeringHintFromContent(modifiedContent as string | Array<{ type: string; text?: string }>);
				if (!isJsonEqual(afterSliding, modifiedContent)) {
					modifiedContent = afterSliding as SnapshotMessage["content"];
					changed = true;
					subPasses.add("stripSteeringHints");
				}

				// Strip strategic hints from all messages
				const afterHints = stripStrategicHintsFromContent(modifiedContent as string | Array<{ type: string; text?: string }>);
				if (!isJsonEqual(afterHints, modifiedContent)) {
					modifiedContent = afterHints as SnapshotMessage["content"];
					changed = true;
					subPasses.add("stripStrategicHints");
				}

				// Compress parent activation prompts in nested snapshot JSONL
				// (detect user messages containing <context-seal> at depth >= 2).
				if (message.role === "user" && options?.depth !== undefined && options.depth >= 2) {
					let hasParentActivation = false;
					let previewText = "";
					const parentActivationRegex = /<context-seal>[\s\S]*?<\/context-seal>/;
					let fullText = "";
					if (typeof modifiedContent === "string") {
						fullText = modifiedContent;
					} else if (Array.isArray(modifiedContent)) {
						fullText = modifiedContent
							.filter((p: ContentPart): p is TextPart => p.type === "text" && typeof p.text === "string")
							.map((p: TextPart) => p.text)
							.join("");
					}
					if (parentActivationRegex.test(fullText)) {
						hasParentActivation = true;
						// Extract mission content for preview; fall back to content after </context-seal>
						const missionMatch = fullText.match(/<mission>([\s\S]*?)<\/mission>/);
						if (missionMatch) {
							previewText = missionMatch[1].trim().replace(/\s+/g, " ").slice(0, 200).trim();
						} else {
							const afterSeal = fullText.split(/<\/context-seal>/).pop() ?? fullText;
							previewText = afterSeal.trim().slice(0, 200).trim();
						}
					}
					if (hasParentActivation) {
						const compact = `[Parent flow activation stripped] Mission preview: ${previewText}`;
						if (typeof modifiedContent === "string") {
							modifiedContent = compact;
						} else {
							modifiedContent = [{ type: "text", text: compact }];
						}
						changed = true;
						subPasses.add("compressParentActivation");
					}
				}

				if (changed) {
					message = { ...message, content: modifiedContent };
				}
			}

			if (changed) {
				entry = { ...entry, message };
			}
		}

		const outLine = changed ? JSON.stringify(entry) : line;
		sanitizedLines.push(outLine);
	}

	const passesApplied: string[] = [];
	const passDeltas: Record<string, number> = {};
	const measureBytes = (s: string) => new TextEncoder().encode(s).length;

	let sanitized = `${sanitizedLines.join("\n")}\n`;
	passesApplied.push(...subPasses);
	passDeltas["mainLoop"] = measureBytes(sanitized);

	// Reparent orphaned parentIds after steering-hint messages were dropped.
	sanitized = reparentOrphans(sanitized);
	passesApplied.push("reparentOrphans");
	passDeltas["reparentOrphans1"] = measureBytes(sanitized);

	// Strip batch_read tool calls from assistant messages.
	// Children don't have batch_read in their active tools.
	sanitized = stripBatchReadToolCalls(sanitized);
	passesApplied.push("stripBatchRead");
	passDeltas["stripBatchRead"] = measureBytes(sanitized);

	// Compress verbose flow tool call arguments in assistant messages.
	sanitized = compressFlowToolCallArgs(sanitized);
	passesApplied.push("compressFlowToolCallArgs");
	passDeltas["compressFlowToolCallArgs"] = measureBytes(sanitized);

	// Compress tool results (flow, batch, web, ask_user).
	sanitized = compressToolResults(sanitized, cache, depthToPolicy(options?.depth ?? 1));
	passesApplied.push("compressToolResults");
	passDeltas["compressToolResults"] = measureBytes(sanitized);

	// Reparent again after stripBatchRead and compressToolResults may have
	// dropped additional messages, leaving new orphaned parentIds.
	sanitized = reparentOrphans(sanitized);
	passesApplied.push("reparentOrphans");
	passDeltas["reparentOrphans2"] = measureBytes(sanitized);

	// Telemetry: measure total delta across sanitization, stripping, and compression.
	const postBytes = sanitized.length;
	const reduction = preBytes > 0 ? Math.round((1 - postBytes / preBytes) * 1000) / 10 : 0;
	if (DEBUG_CONTEXT) {
		logError(`[context-snapshot] pre: ${preBytes} → post: ${postBytes} bytes (${reduction}% reduction)`);
	}
	// Stats are returned out-of-band for dump consumers only.
	// Do NOT append to child-visible JSONL — it's telemetry noise for the model.
	const stats = {
		preBytes,
		postBytes,
		reductionPercent: reduction,
		passesApplied,
		passDeltas,
	};

	return { result: sanitized, passesApplied, stats };
}
