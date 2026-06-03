/**
 * Core-2 snapshot builder — dead-simple fork snapshot.
 *
 * Strips batch read/write/edit bodies (keeping first 3 + last 3 lines as
 * orientation) and preserves all other conversation verbatim in
 * chronological order.
 */

import { stripDirectives } from "../steering/tool-utils.js";
import type { FlowTier, ContextProfile, ToolResultCategory } from "../flow/agents.js";
import { logWarn } from "../config/log.js";

export type CompressionLevel = "none" | "light" | "medium" | "aggressive";

export interface CompressionStats {
	preBytes: number;
	postBytes: number;
	level: CompressionLevel;
	profileName?: string;
	messagesDropped: number;
	syntheticSummary?: string;
}

/**
 * Build a snapshot with optional context compression. If the estimated token
 * count exceeds the threshold (or an override is set), a second pass applies
 * the resolved compression level and profile.
 */
export function buildSnapshotWithCompression(
	sessionManager: SessionSnapshotSource,
	options?: BuildCore2SnapshotOptions,
	maxContextTokens?: number,
): { snapshot: string | null; stats?: CompressionStats } {
	const rawSnapshot = buildCore2Snapshot(sessionManager, options);
	if (!rawSnapshot) return { snapshot: null };

	const estimatedTokens = estimateTotalContextTokens(rawSnapshot);

	const thresholdEnv = process.env.PI_FLOW_CONTEXT_THRESHOLD;
	const threshold = thresholdEnv ? Number(thresholdEnv) : 70_000;
	const overrideRaw = process.env.PI_FLOW_CONTEXT_COMPRESSION?.trim().toLowerCase();
	const envOverride =
		overrideRaw === "none" || overrideRaw === "light" || overrideRaw === "medium" || overrideRaw === "aggressive"
			? overrideRaw
			: undefined;
	const override = options?.compressionLevel ?? envOverride;

	const effectiveThreshold =
		maxContextTokens && maxContextTokens > 0 && Number.isFinite(maxContextTokens)
			? Math.min(threshold, Math.floor(maxContextTokens * 0.6))
			: threshold;

	const lightThreshold = effectiveThreshold;
	const mediumThreshold = Math.floor(effectiveThreshold * 1.21);
	const aggressiveThreshold = Math.floor(effectiveThreshold * 1.43);

	let level: CompressionLevel;
	if (override) {
		level = override;
	} else if (estimatedTokens < lightThreshold) {
		return { snapshot: rawSnapshot };
	} else if (estimatedTokens < mediumThreshold) {
		level = "light";
	} else if (estimatedTokens < aggressiveThreshold) {
		level = "medium";
	} else {
		level = "aggressive";
	}

	if (level === "none") return { snapshot: rawSnapshot };

	const stats: CompressionStats = {
		preBytes: rawSnapshot.length,
		postBytes: 0,
		level,
		messagesDropped: 0,
	};
	const compressedSnapshot = buildCore2Snapshot(sessionManager, {
		...options,
		compressionLevel: level,
		compressionProfile: options?.compressionProfile,
		compressionStats: stats,
	});

	if (stats && compressedSnapshot) {
		stats.preBytes = rawSnapshot.length;
		stats.postBytes = compressedSnapshot.length;
	}

	// Emergency warp fallback: if aggressive compression is still too large,
	// and PI_FLOW_EMERGENCY_WARP is enabled, distill to a minimal snapshot.
	if (
		level === "aggressive" &&
		compressedSnapshot &&
		estimateTotalContextTokens(compressedSnapshot) > (maxContextTokens ?? 100_000) * 0.6 &&
		(process.env.PI_FLOW_EMERGENCY_WARP === "1" || process.env.PI_FLOW_EMERGENCY_WARP === "true")
	) {
		const allEntries = compressedSnapshot
			.split("\n")
			.filter((l) => l.length > 0)
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch (e) {
					logWarn(`[pi-agent-flow] Failed to parse JSONL line in emergency warp: ${e}`);
					return null;
				}
			})
			.filter((e) => e !== null);
		const summary = generateSyntheticSummary(allEntries);
		const lastMessages = allEntries.slice(-2);
		const distilled = [
			allEntries[0],
			CONTEXT_MAP_ENTRY,
			{
				type: "message",
				message: {
					role: "system",
					content: `[Emergency Warp] Context exceeds safe limits after aggressive compression. Distilled summary:\n${summary ?? "(no summary generated)"}`,
				},
			},
			...lastMessages,
		];
		const emergencySnapshot = distilled.map((e) => JSON.stringify(e)).join("\n") + "\n";
		stats.postBytes = emergencySnapshot.length;
		return { snapshot: emergencySnapshot, stats };
	}

	return { snapshot: compressedSnapshot, stats };
}

export interface SessionSnapshotSource {
	getHeader: () => unknown;
	getBranch: () => unknown[];
}

export interface BuildCore2SnapshotOptions {
	forkedFrom?: string;
	forkedAt?: string;
	parentFlow?: string;
	depth?: number;
	activeToolCallId?: string;
	tier?: FlowTier;
	compressionLevel?: CompressionLevel;
	compressionProfile?: ContextProfile;
	/** If provided, compression stats are written here after the snapshot is built. */
	compressionStats?: CompressionStats;
}

/** Normalize toolCalls field from various input shapes. */
function normalizeToolCalls(msg: unknown): unknown[] {
	if (!msg || typeof msg !== "object") return [];
	const m = msg as Record<string, unknown>;
	const tcs = m.toolCalls ?? m.tool_calls;
	if (Array.isArray(tcs)) return tcs;
	return [];
}

// Fallback for external APIs that use snake_case
const SNAKE_TOOL_CALL_ID = "tool_call_id";

/** Normalize tool call id from various input shapes. */
function normalizeToolCallId(tc: unknown): string | undefined {
	if (!tc || typeof tc !== "object") return undefined;
	const t = tc as Record<string, unknown>;
	return (t.id as string | undefined) || (t.toolCallId as string | undefined) || (t[SNAKE_TOOL_CALL_ID] as string | undefined);
}

/** Rough token estimate for a snapshot string (1 token ≈ 4 chars). */
export function estimateTotalContextTokens(snapshotJsonl: string): number {
	return Math.ceil(snapshotJsonl.length / 4);
}

/** Extract plain text from a message entry for scoring / classification. */
function extractMessageText(msg: Record<string, unknown>): string {
	if (typeof msg.content === "string") {
		return msg.content;
	}
	if (Array.isArray(msg.content)) {
		return msg.content
			.filter((b: any) => b && b.type === "text" && typeof b.text === "string")
			.map((b: any) => b.text)
			.join("\n");
	}
	return "";
}

/** Classify a tool/toolResult message into a category for profile-aware compression. */
export function classifyToolResult(entry: unknown): ToolResultCategory {
	if (!entry || typeof entry !== "object") return "other";
	const e = entry as Record<string, unknown>;
	if (e.type !== "message" || !e.message || typeof e.message !== "object") return "other";
	const msg = e.message as Record<string, unknown>;
	if (msg.role !== "tool" && msg.role !== "toolResult") return "other";

	const text = extractMessageText(msg);
	const toolName = typeof msg.toolName === "string" ? msg.toolName : typeof msg.name === "string" ? msg.name : "";

	// Fix P16: Replace multiple includes() with regex-based matching
	// Error / stack-trace heuristics
	if (/Error:|error:|FAIL|failed|Exception|exception|AssertionError|TypeError|ReferenceError/.test(text)) {
		// Stack trace detection: lines starting with "  at " or "    at "
		const stackPattern = /^\s+at\s+\S+/gm;
		if (stackPattern.test(text)) return "stackTrace";
		return "error";
	}

	// Test failure
	if (
		/Test failed|test failure|Assertion failed|✕/.test(text) ||
		(text.includes("expected") && text.includes("received")) ||
		(text.includes("FAIL") && text.includes("test"))
	) {
		return "testFailure";
	}

	// Git diff
	if (/diff --git|--- a\/|\+\+\+ b\/|@@ -/.test(text)) {
		return "gitDiff";
	}

	// Batch file operations (read / write / edit)
	if (
		/--- read:|--- write:|--- edit:|--- delete:/.test(text) ||
		(text.includes("✔") && (text.includes("read") || text.includes("write") || text.includes("edit")))
	) {
		return "fileContent";
	}

	// Grep / find / ls results
	if (
		/--- rg:|--- find:|--- ls:|grep results/.test(text) ||
		/^[^\n]+:\d+:.+/m.test(text)
	) {
		return "grepResult";
	}

	// Bash success
	if (toolName === "bash" || /--- bash \[/.test(text) || (text.includes("--- [") && text.includes("exit"))) {
		return "bashSuccess";
	}

	return "other";
}

/** Synthetic system message providing the context architecture map. */
const CONTEXT_MAP_ENTRY = {
	type: "message",
	message: {
		role: "system",
		content: `   ┌─────────────────────────────┐
   │  [SHARED CONTEXT]           │
   │  Inherited conversation     │
   │  history. Situational       │
   │  awareness only.            │
   │                             │
   │  Do NOT reply to anything   │
   │  above this line.           │
   ├─────────────────────────────┤  ◀ <context-seal>
   │  [YOUR MISSION]             │
   │  <activation> · role, tier  │
   │  <directive>  · rules       │
   │  <mission>    · intent      │
   │                             │
   │  Execute from here.         │
   └─────────────────────────────┘`,
	},
};

export function buildCore2Snapshot(
	sessionManager: SessionSnapshotSource,
	options?: BuildCore2SnapshotOptions,
): string | null {
	const header = sessionManager.getHeader();
	if (!header || typeof header !== "object") return null;

	// Compress cwd in session header: relative to repo root if under it,
	// otherwise basename only. Saves ~50-100 bytes per snapshot.
	const repoRoot = process.cwd();
	let compressedHeader = { ...(header as Record<string, unknown>) };
	delete compressedHeader.timestamp;
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
			compressedHeader.cwd = compressedCwd;
		}
	}

	const branchEntries = sessionManager.getBranch();
	const optimizedEntries = optimizeSharedContext(branchEntries);
	const lines: string[] = [];

	// Emit session header once, unless getBranch() already includes it as the
	// first entry (some session managers include the header in the branch).
	const firstBranch = optimizedEntries[0];
	const headerId = (header as Record<string, unknown>)?.id;
	const firstId =
		firstBranch && typeof firstBranch === "object"
			? (firstBranch as Record<string, unknown>)?.id
			: undefined;
	const firstType =
		firstBranch && typeof firstBranch === "object"
			? (firstBranch as Record<string, unknown>)?.type
			: undefined;
	if (
		!firstBranch ||
		typeof firstBranch !== "object" ||
		(firstType !== "session" && firstType !== "header") ||
		firstId !== headerId
	) {
		lines.push(JSON.stringify(compressedHeader));
	}

	const processedEntries: unknown[] = [];
	for (const entry of optimizedEntries) {
		let processedEntry = sanitizeSnapshotEntry(entry);
		if (!processedEntry) continue;

		processedEntry = maybeStripCompaction(processedEntry);
		if (!processedEntry) continue;

		processedEntry = compressSnapshotEntry(processedEntry, options?.tier, options?.compressionLevel, options?.compressionProfile);
		processedEntry = truncateStandaloneBashResult(processedEntry, options?.compressionLevel, options?.compressionProfile);

		if (options?.activeToolCallId) {
			processedEntry = stripActiveToolCall(processedEntry, options.activeToolCallId);
			if (!processedEntry) continue;
		}

		processedEntries.push(processedEntry);
	}

	const finalEntries = applyMessageLimit(processedEntries, options?.tier);
	const compressedResult = applyContextCompression(finalEntries, options?.compressionLevel, options?.compressionProfile);
	const entriesWithMap = insertContextMap(compressedResult.entries);

	for (const entry of entriesWithMap) {
		// Fix P1: Eliminate double JSON.stringify by operating on objects before serialization
		const processedEntry = stripBatchBodiesFromEntry(entry as Record<string, unknown>, options?.compressionLevel);
		const line = JSON.stringify(processedEntry);
		lines.push(line);
	}

	const snapshot = `${lines.join("\n")}\n`;

	if (options?.compressionStats) {
		const preBytes = processedEntries.reduce((sum: number, e) => sum + JSON.stringify(e).length, 0);
		const postBytes = snapshot.length;
		options.compressionStats.preBytes = preBytes;
		options.compressionStats.postBytes = postBytes;
		options.compressionStats.level = options.compressionLevel ?? "none";
		options.compressionStats.profileName = options.compressionProfile?.name;
		options.compressionStats.messagesDropped = compressedResult.droppedCount;
		options.compressionStats.syntheticSummary = compressedResult.syntheticSummary;
	}

	return snapshot;
}

/**
 * Keep only the usage fields pi-coding-agent needs for context accounting.
 * Full usage objects (~150+ chars) are stripped; deleting usage entirely breaks
 * forked child sessions (calculateContextTokens reads usage.totalTokens).
 */
function slimAssistantUsage(usage: unknown): Record<string, number> | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const u = usage as Record<string, unknown>;
	const input = typeof u.input === "number" ? u.input : (typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0);
	const output = typeof u.output === "number" ? u.output : (typeof u.completion_tokens === "number" ? u.completion_tokens : 0);
	const cacheRead = typeof u.cacheRead === "number" ? u.cacheRead : (typeof u.cache_read === "number" ? u.cache_read : 0);
	const cacheWrite = typeof u.cacheWrite === "number" ? u.cacheWrite : (typeof u.cache_write === "number" ? u.cache_write : 0);
	const totalTokens =
		typeof u.totalTokens === "number"
			? u.totalTokens
			: (typeof u.total_tokens === "number" ? u.total_tokens : input + output + cacheRead + cacheWrite);
	if (totalTokens <= 0 && input <= 0 && output <= 0) return undefined;
	return { input, output, cacheRead, cacheWrite, totalTokens };
}

/**
 * Pattern-based sanitization of snapshot entries.
 * Strips out:
 * - config/model/thinking-level events (model_change, thinking_level_change)
 * - assistant thinking/reasoning content blocks and fields
 * - empty messages resulting from stripping
 */
function sanitizeSnapshotEntry(entry: unknown): unknown | null {
	if (!entry || typeof entry !== "object") return entry;
	const e = entry as Record<string, unknown>;

	// 1. Drop config/control events that aren't needed by child flows
	if (e.type === "model_change" || e.type === "thinking_level_change") {
		return null;
	}

	const result = { ...e };
	delete result.timestamp;
	delete result.parentId; // Tree linkage irrelevant to linear replay
	// result.id is preserved for child session manager deduplication

	// 2. Process message entries
	if (result.type === "message" && result.message && typeof result.message === "object") {
		const msg = { ...result.message as Record<string, unknown> };

		// Strip message-level reasoning/thinking fields
		delete msg.thinking;
		delete msg.reasoning;
		delete msg.reasoningContent;

		// Strip model execution metadata and noise fields
		delete msg.api;
		delete msg.provider;
		delete msg.model;
		delete msg.cost;
		delete msg.details;
		delete msg.responseId;
		delete msg.responseModel;
		delete msg.timestamp;
		delete msg.isError;
		// Slim usage for assistant messages — pi child needs totalTokens for compaction.
		if (msg.role === "assistant" && "usage" in msg) {
			const slim = slimAssistantUsage(msg.usage);
			if (slim) {
				msg.usage = slim;
			} else {
				delete msg.usage;
			}
		} else {
			delete msg.usage;
		}

		// Strip tool correlation IDs — child flows replay linearly, no invocation by ID
		if (msg.role === "toolResult" || msg.role === "tool") {
			delete msg.toolCallId;
		}

		// Defensive: upstream host assumes content is always an array for tool/toolResult
		// messages. Normalize string / null / undefined into a block array so .filter()
		// never explodes on the platform side.
		if ((msg.role === "toolResult" || msg.role === "tool") && !Array.isArray(msg.content)) {
			const text = typeof msg.content === "string" ? msg.content : "";
			msg.content = text ? [{ type: "text", text }] : [];
		}

		// Strip block-level thinking/reasoning elements from content array
		if (Array.isArray(msg.content)) {
			const filteredContent = msg.content.filter((block: any) => {
				return block && block.type !== "thinking" && block.type !== "reasoning";
			});

			// If the content array is now empty or only has empty text blocks,
			// and there are no tool calls, check if we should discard the message
			const hasSubstance = filteredContent.some((block: any) => {
				if (!block) return false;
				if (block.type === "text" && typeof block.text === "string" && block.text.trim() === "") {
					return false;
				}
				if (block.type === "toolCall") {
					return true;
				}
				return true;
			});

			const hasToolCalls = normalizeToolCalls(msg).length > 0 || filteredContent.some(b => b && b.type === "toolCall");

			if (filteredContent.length === 0 || !hasSubstance) {
				// If assistant message has no substance and no tool calls, drop it
				if (msg.role === "assistant" && !hasToolCalls) {
					return null;
				}
			}
			msg.content = filteredContent;
		} else if (typeof msg.content === "string" && msg.content.trim() === "") {
			const hasToolCalls = normalizeToolCalls(msg).length > 0;
			if (msg.role === "assistant" && !hasToolCalls) {
				return null;
			}
		}

		result.message = msg;
	}

	return result;
}

/**
 * Filter compaction-related entries from the snapshot.
 * - Strips compaction_trigger entirely (internal signal).
 * - Replaces compaction/context_compaction with a lightweight readable summary.
 */
function maybeStripCompaction(entry: unknown): unknown | null {
	if (!entry || typeof entry !== "object") return entry;
	const e = entry as Record<string, unknown>;

	if (e.type === "compaction_trigger") {
		return null;
	}

	if (e.type === "compaction" || e.type === "context_compaction") {
		// Replace potentially large and encrypted compaction entries with a
		// lightweight verbatim summary for child flows.
		const summary = typeof e.summary === "string" ? e.summary : "Parent context was compacted.";
		const tokensSaved = typeof e.tokensBefore === "number" ? e.tokensBefore : undefined;

		return {
			type: "message",
			message: {
				role: "system",
				content: [{ type: "text", text: `[Context Compacted] ${summary}${tokensSaved ? ` (${tokensSaved} tokens summarized)` : ""}` }],
			},
		};
	}

	return entry;
}

// ---------------------------------------------------------------------------
// Shared context optimizations (Deduplication)
// ---------------------------------------------------------------------------

function optimizeSharedContext(branchEntries: unknown[]): unknown[] {
	const toolCallMap = new Map<string, { toolName: string; keys: string[]; isReadWrite: boolean; op: string }>();
	const lastExecution = new Map<string, { toolCallId: string; count: number }>();

	// Scan to populate toolCallMap and lastExecution
	for (const entry of branchEntries) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		if (e.type === "message" && e.message && typeof e.message === "object") {
			const msg = e.message as Record<string, unknown>;
			
			// Gather tool calls from content array and toolCalls/tool_calls field
			const tcs = normalizeToolCalls(msg);
			const contentBlocks = Array.isArray(msg.content) ? msg.content : [];
			const allCalls = [...tcs, ...contentBlocks.filter((b) => b && b.type === "toolCall")];

			for (const tc of allCalls) {
				const id = normalizeToolCallId(tc);
				const name = (tc as Record<string, unknown>).name || ((tc as Record<string, unknown>).toolCall as Record<string, unknown> | undefined)?.name;
				if (!id || !name) continue;

				if (name === "bash" && tc.arguments) {
					const cmd = (tc.arguments.command || tc.arguments.c || "").trim();
					if (cmd) {
						toolCallMap.set(id, { toolName: "bash", keys: [`bash:${cmd}`], isReadWrite: false, op: "bash" });
						const existing = lastExecution.get(`bash:${cmd}`);
						lastExecution.set(`bash:${cmd}`, { toolCallId: id, count: (existing?.count ?? 0) + 1 });
					}
				} else if ((name === "batch" || name === "batch_read") && tc.arguments) {
					const ops = tc.arguments.ops || tc.arguments.o || [];
					if (Array.isArray(ops)) {
						const keys: string[] = [];
						let opType = "read";
						for (const op of ops) {
							const operation = op.o;
							const path = (op.p || "").trim();
							if (path && (operation === "read" || operation === "write" || operation === "edit")) {
								const key = `${operation}:${path}`;
								keys.push(key);
								opType = operation;
								const existing = lastExecution.get(key);
								lastExecution.set(key, { toolCallId: id, count: (existing?.count ?? 0) + 1 });
							}
						}
						if (keys.length > 0) {
							toolCallMap.set(id, { toolName: name, keys, isReadWrite: true, op: opType });
						}
					}
				} else if (name === "flow" && tc.arguments) {
					const flowArray = tc.arguments.flow || [];
					if (Array.isArray(flowArray)) {
						const keys: string[] = [];
						for (const f of flowArray) {
							const type = (f as Record<string, unknown>).type;
							if (typeof type === "string") {
								const key = `flow:${type}`;
								keys.push(key);
								const existing = lastExecution.get(key);
								lastExecution.set(key, { toolCallId: id, count: (existing?.count ?? 0) + 1 });
							}
						}
						if (keys.length > 0) {
							toolCallMap.set(id, { toolName: "flow", keys, isReadWrite: false, op: "flow" });
						}
					}
				} else if (name === "trace" && tc.arguments) {
					// Trace is a leaf tool with disposable child transcripts.
					// Key by intent so the latest trace of the same exploration
					// supersedes earlier ones. Empty/missing intent falls back to
					// a generic "trace" key (matches existing flow dedup semantics
					// where the latest run always wins).
					const intent = (tc.arguments.intent || "").trim();
					const key = intent ? `trace:${intent.slice(0, 80)}` : "trace";
					toolCallMap.set(id, { toolName: "trace", keys: [key], isReadWrite: false, op: "trace" });
					const existing = lastExecution.get(key);
					lastExecution.set(key, { toolCallId: id, count: (existing?.count ?? 0) + 1 });
				}
			}
		}
	}

	// Re-process branch entries using the maps
	return branchEntries.map((entry) => {
		if (!entry || typeof entry !== "object") return entry;
		const e = entry as Record<string, unknown>;
		if (e.type !== "message" || !e.message || typeof e.message !== "object") return entry;
		const msg = { ...(e.message as Record<string, unknown>) };

		if (msg.role !== "tool" && msg.role !== "toolResult") return entry;
		const toolCallId = normalizeToolCallId(msg);
		if (typeof toolCallId !== "string") return entry;

		const info = toolCallMap.get(toolCallId);
		if (!info) return entry;

		const isLatest = info.keys.some((k) => lastExecution.get(k)?.toolCallId === toolCallId);

		if (!isLatest) {
			let newContent: string;
			if (info.toolName === "flow") {
				const flowType = info.keys[0]?.split(":")[1] || "output";
				newContent = `[Flow ${flowType} output omitted; superseded by later run]`;
			} else if (info.toolName === "trace") {
				newContent = `[Trace output omitted; superseded by later trace]`;
			} else if (info.isReadWrite) {
				const countEntry = lastExecution.get(info.keys[0]);
				const count = countEntry?.count ?? 1;
				if (count > 1) {
					const suffix = count - 1 === 1 ? "1 more time" : `${count - 1} more times`;
					if (info.op === "edit") {
						newContent = `[File edit output omitted; edited ${suffix}]`;
					} else if (info.op === "read") {
						newContent = `[File read output omitted; read ${suffix}]`;
					} else if (info.op === "write") {
						newContent = `[File write output omitted; written ${suffix}]`;
					} else {
						newContent = `[File ${info.op} output omitted; file was accessed/modified later]`;
					}
				} else {
					newContent = `[File ${info.op} output omitted; file was accessed/modified later]`;
				}
			} else {
				const countEntry = lastExecution.get(info.keys[0]);
				const count = countEntry?.count ?? 1;
				if (count > 1) {
					const suffix = count - 1 === 1 ? "1 more time" : `${count - 1} more times`;
					newContent = `[Bash output omitted; re-run ${suffix}]`;
				} else {
					newContent = `[Bash output omitted; command was re-run later]`;
				}
			}
			
			const contentVal = typeof msg.content === "string" 
				? newContent 
				: [{ type: "text", text: newContent }];
			return {
				...e,
				message: {
					...msg,
					content: contentVal,
				},
			};
		}

		return entry;
	});
}

// ---------------------------------------------------------------------------
// Standalone bash result truncation
// ---------------------------------------------------------------------------

function truncateStandaloneBashResult(entry: unknown, level?: CompressionLevel, profile?: ContextProfile): unknown {
	if (!entry || typeof entry !== "object") return entry;
	const e = entry as Record<string, unknown>;
	if (e.type !== "message" || !e.message || typeof e.message !== "object") return entry;
	const msg = e.message as Record<string, unknown>;

	if (msg.role !== "tool" && msg.role !== "toolResult") return entry;

	const toolName = typeof msg.toolName === "string" ? msg.toolName : typeof msg.name === "string" ? msg.name : undefined;
	if (toolName !== "bash") return entry;

	// Respect profile: if bashSuccess is in keepCategories, skip truncation
	if (profile?.keepCategories?.includes("bashSuccess")) return entry;

	let text: string | undefined;
	let textIndex: number | undefined;

	if (typeof msg.content === "string") {
		text = msg.content;
	} else if (Array.isArray(msg.content)) {
		for (let idx = 0; idx < msg.content.length; idx++) {
			const part = msg.content[idx] as Record<string, unknown>;
			if (part.type === "text" && typeof part.text === "string") {
				text = part.text;
				textIndex = idx;
				break;
			}
		}
	}

	if (!text) return entry;

	const lines = text.split("\n");
	let head: number;
	let tail: number;
	if (level === "light") {
		head = 15;
		tail = 10;
	} else if (level === "medium") {
		head = 10;
		tail = 5;
	} else if (level === "aggressive") {
		head = 5;
		tail = 3;
	} else {
		head = 30;
		tail = 20;
	}
	if (lines.length <= head + tail) return entry;

	const kept = [...lines.slice(0, head), `[...${lines.length - head - tail} lines of bash output truncated...]`, ...lines.slice(-tail)];
	const truncatedText = kept.join("\n");

	const newMsg = { ...msg };
	if (typeof msg.content === "string") {
		newMsg.content = truncatedText;
	} else if (textIndex !== undefined) {
		newMsg.content = (msg.content as Array<Record<string, unknown>>).map((part, idx) => {
			if (idx === textIndex) {
				return { ...part, text: truncatedText };
			}
			return part;
		});
	}

	return {
		...e,
		message: newMsg,
	};
}

// ---------------------------------------------------------------------------
// Tier-based context compression
// ---------------------------------------------------------------------------

const DEFAULT_LITE_MAX_MESSAGES = 30;
const DEFAULT_FLASH_MAX_MESSAGES = 50;
const DEFAULT_FULL_MAX_MESSAGES = 80;

function getTierMaxMessages(tier: FlowTier | undefined): number {
	if (!tier) return Number.MAX_SAFE_INTEGER;
	const env =
		tier === "lite"
			? process.env.PI_FLOW_LITE_MAX_MESSAGES
			: tier === "flash"
				? process.env.PI_FLOW_FLASH_MAX_MESSAGES
				: process.env.PI_FLOW_FULL_MAX_MESSAGES;
	const defaultVal =
		tier === "lite"
			? DEFAULT_LITE_MAX_MESSAGES
			: tier === "flash"
				? DEFAULT_FLASH_MAX_MESSAGES
				: DEFAULT_FULL_MAX_MESSAGES;
	if (!env) return defaultVal;
	const n = Number(env);
	return Number.isFinite(n) && n > 0 ? n : defaultVal;
}

/**
 * Compress a single snapshot entry based on tier and optional compression level.
 *
 * When no compression level is set, all tiers strip tool/toolResult content to
 * placeholders (e.g. [toolResult: bash]) — the legacy behavior.
 *
 * When a compression level is active, the profile determines which categories
 * are essential (kept verbatim) vs non-essential (compressed to placeholder).
 * Aggressive always compresses everything regardless of profile.
 */
function compressSnapshotEntry(
	entry: unknown,
	tier: FlowTier | undefined,
	level?: CompressionLevel,
	profile?: ContextProfile,
): unknown {
	if (!tier) return entry;
	if (!entry || typeof entry !== "object") return entry;
	const e = entry as Record<string, unknown>;
	if (e.type !== "message" || !e.message || typeof e.message !== "object") {
		return entry;
	}
	const msg = { ...(e.message as Record<string, unknown>) };
	const role = msg.role;
	if (role !== "tool" && role !== "toolResult") {
		return entry;
	}

	// Legacy behavior when no compression level is active
	if (!level || level === "none") {
		const toolName = typeof msg.toolName === "string" ? msg.toolName : typeof msg.name === "string" ? msg.name : undefined;
		const placeholder = toolName ? `[${role}: ${toolName}]` : `[${role} result omitted]`;
		msg.content = [{ type: "text", text: placeholder }];
		return { ...e, message: msg };
	}

	// Aggressive compresses all tool results regardless of profile
	if (level === "aggressive") {
		const toolName = typeof msg.toolName === "string" ? msg.toolName : typeof msg.name === "string" ? msg.name : undefined;
		const placeholder = toolName ? `[${role}: ${toolName}]` : `[${role} result omitted]`;
		msg.content = [{ type: "text", text: placeholder }];
		return { ...e, message: msg };
	}

	// Profile-aware selective compression for light / medium
	const category = classifyToolResult(entry);
	const keep = profile?.keepCategories ?? [];
	const compress = profile?.compressCategories ?? [];

	if (keep.includes(category)) {
		// Keep this tool result verbatim
		return entry;
	}

	// Compress to placeholder (default for unknown categories too)
	const toolName = typeof msg.toolName === "string" ? msg.toolName : typeof msg.name === "string" ? msg.name : undefined;
	const placeholder = toolName ? `[${role}: ${toolName}]` : `[${role} result omitted]`;
	msg.content = [{ type: "text", text: placeholder }];
	return { ...e, message: msg };
}

/**
 * Apply array-level message limit based on tier: keep only the last N messages.
 * Header/session entries at the start of the branch are preserved; only
 * `type: "message"` entries count toward the limit.
 */
function insertContextMap(entries: unknown[]): unknown[] {
	const insertIndex = entries.findIndex((e) => {
		if (!e || typeof e !== "object") return false;
		const type = (e as Record<string, unknown>).type;
		return type !== "session" && type !== "header";
	});
	if (insertIndex === -1) {
		return [...entries, CONTEXT_MAP_ENTRY];
	}
	return [
		...entries.slice(0, insertIndex),
		CONTEXT_MAP_ENTRY,
		...entries.slice(insertIndex),
	];
}

function applyMessageLimit(entries: unknown[], tier: FlowTier | undefined): unknown[] {
	const max = getTierMaxMessages(tier);

	// Extract leading header/session entries so they survive the slice
	let headerEnd = 0;
	for (; headerEnd < entries.length; headerEnd++) {
		const e = entries[headerEnd];
		if (e && typeof e === "object") {
			const type = (e as Record<string, unknown>).type;
			if (type === "session" || type === "header") continue;
		}
		break;
	}

	const headers = entries.slice(0, headerEnd);
	const rest = entries.slice(headerEnd);

	if (rest.length <= max) return entries;

	let messageCount = 0;
	for (let i = rest.length - 1; i >= 0; i--) {
		const e = rest[i];
		if (e && typeof e === "object" && (e as Record<string, unknown>).type === "message") {
			messageCount++;
		}
		if (messageCount >= max) {
			// Keep headers + everything from this index onward in rest
			return [...headers, ...rest.slice(i)];
		}
	}
	return entries;
}

// ---------------------------------------------------------------------------
// Context compression (token-gate progressive reduction)
// ---------------------------------------------------------------------------

function scoreMessageForProfile(entry: unknown, profile?: ContextProfile): number {
	if (!entry || typeof entry !== "object") return 1;
	const e = entry as Record<string, unknown>;
	if (e.type !== "message" || !e.message || typeof e.message !== "object") return 1;
	const msg = e.message as Record<string, unknown>;

	// Base score: newer messages win ties via caller sorting
	let score = 10;

	if (profile?.name === "intent-first") {
		if (msg.role === "user") return 100;
		if (msg.role === "assistant") {
			const text = extractMessageText(msg);
			if (/\b(decision|design|plan|architecture|goal|objective)\b/i.test(text)) return 90;
			return 50;
		}
		return 5;
	}

	if (profile?.name === "files-first") {
		if (msg.role === "toolResult" || msg.role === "tool") {
			const cat = classifyToolResult(entry);
			if (cat === "fileContent") return 90;
			if (cat === "error") return 80;
			return 20;
		}
		if (msg.role === "assistant") {
			const content = msg.content;
			if (Array.isArray(content)) {
				const hasFileOps = content.some((block: any) => {
					if (block?.type === "toolCall") {
						const name = block.name || block.toolCall?.name;
						return name === "batch" || name === "batch_read";
					}
					return false;
				});
				if (hasFileOps) return 85;
			}
		}
		return 40;
	}

	if (profile?.name === "errors-first") {
		if (msg.role === "toolResult" || msg.role === "tool") {
			const cat = classifyToolResult(entry);
			if (cat === "error" || cat === "stackTrace" || cat === "testFailure") return 100;
			return 15;
		}
		return 40;
	}

	if (profile?.name === "edits-first") {
		if (msg.role === "toolResult" || msg.role === "tool") {
			const cat = classifyToolResult(entry);
			if (cat === "fileContent" || cat === "gitDiff") return 95;
			if (cat === "error") return 80;
			return 20;
		}
		return 40;
	}

	if (profile?.name === "discovery-first") {
		if (msg.role === "toolResult" || msg.role === "tool") {
			const cat = classifyToolResult(entry);
			if (cat === "grepResult") return 95;
			if (cat === "fileContent") return 80;
			if (cat === "error") return 70;
			return 20;
		}
		return 40;
	}

	if (profile?.name === "code-first") {
		if (msg.role === "toolResult" || msg.role === "tool") {
			const cat = classifyToolResult(entry);
			if (cat === "fileContent") return 100;
			if (cat === "error") return 80;
			return 15;
		}
		return 40;
	}

	// Default scoring
	if (msg.role === "user") return 60;
	if (msg.role === "assistant") return 50;
	if (msg.role === "toolResult" || msg.role === "tool") {
		const cat = classifyToolResult(entry);
		if (cat === "error") return 45;
		return 30;
	}
	return 20;
}

function stripOldSystemMessages(entries: unknown[], _profile?: ContextProfile): unknown[] {
	return entries.filter((entry) => {
		if (!entry || typeof entry !== "object") return true;
		const e = entry as Record<string, unknown>;
		if (e.type !== "message" || !e.message || typeof e.message !== "object") return true;
		const msg = e.message as Record<string, unknown>;
		if (msg.role !== "system") return true;
		// Keep the context map entry (it hasn't been inserted yet here, but be defensive)
		const text = extractMessageText(msg);
		if (text.includes("[SHARED CONTEXT]") || text.includes("<context-seal>")) return true;
		// Drop old system messages
		return false;
	});
}

function generateSyntheticSummary(droppedEntries: unknown[]): string | undefined {
	if (droppedEntries.length === 0) return undefined;

	const files = new Set<string>();
	const commands = new Set<string>();
	const errors = new Set<string>();
	const decisions = new Set<string>();

	for (const entry of droppedEntries) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		if (e.type !== "message" || !e.message || typeof e.message !== "object") continue;
		const msg = e.message as Record<string, unknown>;
		const text = extractMessageText(msg);

		// Extract file paths from read/write/edit headers
		const fileMatches = text.match(/--- (?:read|write|edit|delete): ([^\s()]+)/g);
		if (fileMatches) {
			for (const m of fileMatches) {
				const path = m.replace(/^--- (?:read|write|edit|delete): /, "").trim();
				if (path) files.add(path);
			}
		}

		// Extract bash commands — permissive header matching + fallback scan
		let foundBash = false;
		const bashHeaderPattern = /--- bash(?:\s*\[.*?\])?\s*(?:exit\s*\d+|pending|error)?\s*---\s*([\s\S]*?)(?=\n---|\n###\s|$)/g;
		let bashMatch: RegExpExecArray | null;
		while ((bashMatch = bashHeaderPattern.exec(text)) !== null) {
			const block = bashMatch[1].trim();
			const firstLine = block.split("\n").find((l) => l.trim().length > 0);
			if (firstLine) {
				commands.add(firstLine.trim().slice(0, 120));
				foundBash = true;
			}
		}
		if (!foundBash) {
			// Fallback: scan for bash-like lines or JSONL tool call blocks
			const fallbackBash: string[] = [];
			const bashLikeRe = /\bbash\b.*?:\s*(.+)/gim;
			let m: RegExpExecArray | null;
			while ((m = bashLikeRe.exec(text)) !== null) {
				fallbackBash.push(m[1].trim());
			}
			const jsonCmdRe = /"command"\s*:\s*"([^"]+)"/g;
			while ((m = jsonCmdRe.exec(text)) !== null) {
				fallbackBash.push(m[1].trim());
			}
			if (fallbackBash.length > 0) {
				for (const cmd of fallbackBash) {
					if (cmd) commands.add(cmd.slice(0, 120));
				}
			}
		}
		// Also extract from tool call arguments if present
		const tcs = (msg.toolCalls ?? msg.tool_calls ?? []) as unknown[];
		for (const tc of tcs) {
			if (!tc || typeof tc !== "object") continue;
			const t = tc as Record<string, unknown>;
			const args = (t as any).arguments ?? (t as any).function?.arguments;
			if (args && typeof args === "object") {
				const a = args as Record<string, unknown>;
				if (typeof a.command === "string") commands.add(a.command);
				if (typeof a.c === "string") commands.add(a.c);
			}
		}
		if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block && typeof block === "object" && block.type === "toolCall" && block.arguments) {
					const args = block.arguments as Record<string, unknown>;
					if (typeof args.command === "string") commands.add(args.command);
					if (typeof args.c === "string") commands.add(args.c);
				}
			}
		}

		// Extract errors (first line only, capped)
		const errorPattern = /\b(Error|FAIL|failed|Exception|AssertionError)\b/i;
		if (errorPattern.test(text)) {
			const firstErrorLine = text.split("\n").find((l) => errorPattern.test(l));
			if (firstErrorLine) {
				const truncated = firstErrorLine.trim().slice(0, 120);
				if (truncated) errors.add(truncated);
			}
		}

		// Extract decisions with word boundaries
		const decisionPattern = /\b(decision|design|plan|agreed|chose|selected|will use)\b/i;
		if (decisionPattern.test(text)) {
			const decisionLine = text.split("\n").find((l) => decisionPattern.test(l));
			if (decisionLine) {
				const truncated = decisionLine.trim().slice(0, 120);
				if (truncated) decisions.add(truncated);
			}
		}
	}

	// Fallback: if regex-based extraction found nothing, do a simple keyword scan
	if (files.size === 0 && commands.size === 0 && errors.size === 0 && decisions.size === 0) {
		for (const entry of droppedEntries) {
			if (!entry || typeof entry !== "object") continue;
			const e = entry as Record<string, unknown>;
			if (e.type !== "message" || !e.message || typeof e.message !== "object") continue;
			const msg = e.message as Record<string, unknown>;
			const text = extractMessageText(msg);
			const lines = text.split("\n");
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				if (/\b(?:src\/|lib\/|tests\/|\.ts|\.js|\.json|\.md)\b/.test(trimmed)) {
					const path = trimmed.split(/\s+/)[0];
					if (path && path.includes("/")) files.add(path.slice(0, 120));
				}
				if (/^(?:npm|yarn|pnpm|node|git|cargo|go|python|pytest|eslint|tsc|vitest|docker|kubectl|make|curl|wget)\b/.test(trimmed)) {
					commands.add(trimmed.slice(0, 120));
				}
				if (/\b(error|fail|exception|panic|timeout)\b/i.test(trimmed)) {
					errors.add(trimmed.slice(0, 120));
				}
				if (/\b(decided|decision|plan|design|agreed|selected|will|should|recommend)\b/i.test(trimmed)) {
					decisions.add(trimmed.slice(0, 120));
				}
			}
		}
	}

	if (files.size === 0 && commands.size === 0 && errors.size === 0 && decisions.size === 0) {
		return undefined;
	}

	const parts: string[] = ["[Context summary — earlier messages omitted]"];
	if (files.size > 0) {
		parts.push(`Files: ${Array.from(files).slice(0, 10).join(", ")}${files.size > 10 ? "…" : ""}`);
	}
	if (commands.size > 0) {
		parts.push(`Commands: ${Array.from(commands).slice(0, 5).join(", ")}${commands.size > 5 ? "…" : ""}`);
	}
	if (errors.size > 0) {
		parts.push(`Errors: ${Array.from(errors).slice(0, 3).join("; ")}${errors.size > 3 ? "…" : ""}`);
	}
	if (decisions.size > 0) {
		parts.push(`Decisions: ${Array.from(decisions).slice(0, 3).join("; ")}${decisions.size > 3 ? "…" : ""}`);
	}

	return parts.join("\n");
}

export interface CompressionResult {
	entries: unknown[];
	droppedCount: number;
	syntheticSummary?: string;
}

export function applyContextCompression(
	entries: unknown[],
	level: CompressionLevel | undefined,
	profile?: ContextProfile,
): CompressionResult {
	if (!level || level === "none") {
		return { entries, droppedCount: 0 };
	}

	// Count current messages
	const messageIndices: number[] = [];
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		if (e && typeof e === "object" && (e as Record<string, unknown>).type === "message") {
			messageIndices.push(i);
		}
	}
	const currentMessageCount = messageIndices.length;

	let targetMessageCount: number;
	if (level === "light") {
		targetMessageCount = Math.max(5, Math.floor(currentMessageCount * 0.6));
	} else if (level === "medium") {
		targetMessageCount = Math.max(5, Math.floor(currentMessageCount * 0.4));
	} else {
		targetMessageCount = Math.max(3, 15);
	}

	if (currentMessageCount <= targetMessageCount) {
		let result = entries;
		if (level === "medium" || level === "aggressive") {
			result = stripOldSystemMessages(result, profile);
		}
		return { entries: result, droppedCount: 0 };
	}

	// Need to drop messages — prioritize based on profile score
	let headerEnd = 0;
	for (; headerEnd < entries.length; headerEnd++) {
		const e = entries[headerEnd];
		if (e && typeof e === "object") {
			const type = (e as Record<string, unknown>).type;
			if (type === "session" || type === "header") continue;
		}
		break;
	}

	const headers = entries.slice(0, headerEnd);
	const rest = entries.slice(headerEnd);

	// Fix P7: Reduce applyContextCompression from 5-6 passes to 2 passes
	// Pass 1: Score all entries in a single pass, collecting message tuples separately
	const messageTuples: { entry: unknown; originalIndex: number; score: number }[] = [];
	const restLength = rest.length;
	for (let i = 0; i < restLength; i++) {
		const entry = rest[i];
		const isMessage = entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "message";
		if (isMessage) {
			messageTuples.push({
				entry,
				originalIndex: headerEnd + i,
				score: scoreMessageForProfile(entry, profile),
			});
		}
	}

	// Sort messages by score desc, then originalIndex desc (prefer newer)
	messageTuples.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return b.originalIndex - a.originalIndex;
	});

	// Take top N messages; build a Set of their original indices for O(1) lookup
	const keptMessageIndices = new Set<number>();
	for (let i = 0; i < targetMessageCount && i < messageTuples.length; i++) {
		keptMessageIndices.add(messageTuples[i].originalIndex);
	}

	// Pass 2: Single pass to reconstruct in original order, keeping all non-messages and top-N messages
	let result: unknown[] = [...headers];
	const droppedEntries: unknown[] = [];
	for (let i = 0; i < restLength; i++) {
		const entry = rest[i];
		const originalIndex = headerEnd + i;
		const isMessage = entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "message";
		if (!isMessage || keptMessageIndices.has(originalIndex)) {
			result.push(entry);
		} else {
			droppedEntries.push(entry);
		}
	}

	const syntheticSummaryText = generateSyntheticSummary(droppedEntries);

	if (level === "medium" || level === "aggressive") {
		result = stripOldSystemMessages(result, profile);
	}

	if (syntheticSummaryText) {
		// Insert synthetic summary after headers but before other entries
		const syntheticEntry = {
			type: "message",
			message: {
				role: "system",
				content: [{ type: "text", text: syntheticSummaryText }],
			},
		};
		result.splice(headerEnd, 0, syntheticEntry);
	}

	return {
		entries: result,
		droppedCount: droppedEntries.length,
		syntheticSummary: syntheticSummaryText,
	};
}

// ---------------------------------------------------------------------------
// Batch body stripping
// ---------------------------------------------------------------------------

/** Headers that delimit the end of any batch tool section. */
function isKnownSectionHeader(line: string): boolean {
	return [
		/^--- (.+) \((\d+) lines\) ---$/,
		/^--- (.+) (context map|file summary) ---$/,
		/^--- bash \[.+\] (exit (\d+)|pending|error) ---$/,
		/^--- \[.+\] (exit (\d+)|interrupted) ---$/,
		/^--- \[.+\] still running ---$/,
		/^--- edit: .+ ---$/,
		/^--- write: .+ ---$/,
		/^--- delete: .+ ---$/,
		/^--- read: .+ ---$/,
		/^--- rg: .+ ---$/,
		/^--- patch: .+ ---$/,
		/^--- (?!bash \[|edit:|write:|delete:|read:|rg:|patch:)(.+) ---$/,
	].some((re) => re.test(line));
}

/** Headers that identify a batch read/write/edit section to strip. */
function isBatchSectionHeader(line: string): boolean {
	return (
		/^--- (.+) \((\d+) lines\) ---$/.test(line) ||
		/^--- (.+) (context map|file summary) ---$/.test(line) ||
		/^--- read: (.+) ---$/.test(line) ||
		/^--- write: (.+) \((\d+) bytes\) ---$/.test(line) ||
		/^--- write: (.+) ---$/.test(line) ||
		/^--- edit: (.+) \(([^)]*)\) ---$/.test(line) ||
		/^--- edit: (.+) ---$/.test(line) ||
		/^--- bash \[.+\] (exit (\d+)|pending|error) ---$/.test(line) ||
		/^--- \[.+\] (exit (\d+)|interrupted) ---$/.test(line) ||
		/^--- \[.+\] still running ---$/.test(line)
	);
}

/** Replace batch section bodies with first N + last N lines as orientation. */
function stripBatchBodies(text: string, level?: CompressionLevel): string {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const out: string[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		if (isBatchSectionHeader(line)) {
			out.push(line);
			i++;
			const body: string[] = [];
			while (i < lines.length && !isKnownSectionHeader(lines[i])) {
				body.push(lines[i]);
				i++;
			}
			const isBash = line.includes("--- bash [") || line.includes("--- [");
			if (isBash) {
				let head: number;
				let tail: number;
				if (level === "light") { head = 15; tail = 10; }
				else if (level === "medium") { head = 10; tail = 5; }
				else if (level === "aggressive") { head = 5; tail = 3; }
				else { head = 30; tail = 20; }
				if (body.length > head + tail) {
					out.push(...body.slice(0, head));
					out.push(`[...${body.length - head - tail} lines of bash output truncated...]`);
					out.push(...body.slice(-tail));
				} else {
					out.push(...body);
				}
			} else {
				let head: number;
				let tail: number;
				if (level === "light") { head = 2; tail = 2; }
				else if (level === "medium") { head = 1; tail = 1; }
				else if (level === "aggressive") { head = 0; tail = 0; }
				else { head = 3; tail = 3; }
				if (body.length > head + tail) {
					out.push(...body.slice(0, head));
					out.push(`[...${body.length - head - tail} lines truncated...]`);
					out.push(...body.slice(-tail));
				} else {
					out.push(...body);
				}
			}
		} else {
			out.push(line);
			i++;
		}
	}

	return out.join("\n");
}

/** If the entry is a tool/toolResult message, strip batch bodies from its text.
 *  Fix P1: Operates on the parsed object directly to eliminate double JSON.stringify/parse.
 */
function stripBatchBodiesFromEntry(entry: Record<string, unknown>, level?: CompressionLevel): Record<string, unknown> {
	if (entry.type !== "message" || !entry.message) {
		return entry;
	}

	const message = entry.message as Record<string, unknown>;
	if (message.role !== "tool" && message.role !== "toolResult") {
		return entry;
	}

	// Extract text content (string or first text part in array)
	let text: string | undefined;
	let textIndex: number | undefined;

	if (typeof message.content === "string") {
		text = message.content;
	} else if (Array.isArray(message.content)) {
		for (let idx = 0; idx < message.content.length; idx++) {
			const part = message.content[idx] as Record<string, unknown>;
			if (part.type === "text" && typeof part.text === "string") {
				text = part.text;
				textIndex = idx;
				break;
			}
		}
	}

	// Fast path: no batch section headers or directive/hint markers present
	if (!text || (!text.includes("\n--- ") && !text.includes("[Directive:") && !text.includes("[Hint:"))) {
		return entry;
	}

	const stripped = stripBatchBodies(text, level);
	const cleaned = stripDirectives(stripped);
	if (cleaned === text) {
		return entry;
	}

	if (typeof message.content === "string") {
		return {
			...entry,
			message: { ...message, content: cleaned },
		};
	} else if (textIndex !== undefined) {
		const newContent = (message.content as Array<Record<string, unknown>>).map((part, idx) => {
			if (idx === textIndex && part.type === "text" && typeof part.text === "string") {
				return { ...part, text: cleaned };
			}
			return part;
		});
		return {
			...entry,
			message: { ...message, content: newContent },
		};
	}

	return entry;
}

/**
 * Filter out the active tool call from assistant messages in snapshot.
 * If the assistant message becomes empty (e.g. no other tool calls, no text/thinking),
 * it returns null to omit the message entirely from the snapshot.
 */
function stripActiveToolCall(entry: unknown, activeToolCallId: string | undefined): unknown | null {
	if (!activeToolCallId || !entry || typeof entry !== "object") return entry;
	const e = entry as Record<string, unknown>;

	if (e.type !== "message" || !e.message || typeof e.message !== "object") {
		return entry;
	}

	const message = e.message as Record<string, unknown>;
	if (message.role !== "assistant" || !Array.isArray(message.content)) {
		return entry;
	}

	const newContent = message.content.filter((block: any) => {
		if (block && block.type === "toolCall") {
			const id = normalizeToolCallId(block);
			if (id === activeToolCallId) {
				return false;
			}
		}
		return true;
	});

	const hasSubstance = newContent.some((block: any) => {
		if (!block) return false;
		if (block.type === "text" && typeof block.text === "string" && block.text.trim() === "") {
			return false;
		}
		if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim() === "") {
			return false;
		}
		return true;
	});

	if (newContent.length === 0 || !hasSubstance) {
		return null;
	}

	return {
		...e,
		message: {
			...message,
			content: newContent,
		},
	};
}

// ---------------------------------------------------------------------------
// Shared context
// ---------------------------------------------------------------------------

export interface SharedContext {
	messageCount: number;
	userMessageCount: number;
	assistantMessageCount: number;
	toolCalls: Record<string, number>;
	totalTokens: number;
	preview: string;
}

export function parseSharedContext(snapshotJsonl: string | null): SharedContext | undefined {
	if (!snapshotJsonl) return undefined;
	let messageCount = 0;
	let userMessageCount = 0;
	let assistantMessageCount = 0;
	let totalTokens = 0;
	const toolCalls: Record<string, number> = {};
	let preview = "";
	for (const line of snapshotJsonl.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (entry.type === "message" && entry.message && typeof entry.message === "object") {
				const msg = entry.message;
				messageCount++;
				if (msg.role === "user") {
					userMessageCount++;
					if (!preview) {
						if (typeof msg.content === "string") {
							preview = msg.content;
						} else if (Array.isArray(msg.content)) {
							for (const part of msg.content) {
								if (part && part.type === "text" && typeof part.text === "string") {
									preview = part.text;
									break;
								}
							}
						}
					}
				} else if (msg.role === "assistant") {
					assistantMessageCount++;
					const usage = entry.usage || msg.usage;
					if (usage && typeof usage === "object") {
						const u = usage as Record<string, unknown>;
						const explicit =
							typeof u.totalTokens === "number"
								? u.totalTokens
								: typeof u.total_tokens === "number"
									? u.total_tokens
									: undefined;
						if (typeof explicit === "number" && explicit > 0) {
							totalTokens = explicit;
						} else {
							const input =
								typeof u.input === "number"
									? u.input
									: typeof u.prompt_tokens === "number"
										? u.prompt_tokens
										: 0;
							const output =
								typeof u.output === "number"
									? u.output
									: typeof u.completion_tokens === "number"
										? u.completion_tokens
										: 0;
							const cacheRead =
								typeof u.cacheRead === "number"
									? u.cacheRead
									: typeof u.cache_read === "number"
										? u.cache_read
										: 0;
							const cacheWrite =
								typeof u.cacheWrite === "number"
									? u.cacheWrite
									: typeof u.cache_write === "number"
										? u.cache_write
										: 0;
							const computed = input + output + cacheRead + cacheWrite;
							if (computed > 0) {
								totalTokens = computed;
							}
						}
					}
				}
				// Aggregate tool calls from any message
				const tcs = normalizeToolCalls(msg);
				if (tcs.length > 0) {
					for (const tc of tcs) {
						const t = tc as Record<string, unknown>;
						const name = t.name || (t.function as Record<string, unknown> | undefined)?.name;
						if (typeof name === "string") {
							toolCalls[name] = (toolCalls[name] || 0) + 1;
						}
					}
				}
				if (Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block && block.type === "toolCall") {
							const name = block.name || block.toolCall?.name || block.function?.name;
							if (typeof name === "string") {
								toolCalls[name] = (toolCalls[name] || 0) + 1;
							}
						}
					}
				}
			}
		} catch (e) {
			logWarn(`[pi-agent-flow] Skipping invalid JSONL line in snapshot: ${e}`);
		}
	}
	if (messageCount === 0) return undefined;
	return { messageCount, userMessageCount, assistantMessageCount, toolCalls, totalTokens, preview };
}

