import { describe, it, expect } from "vitest";
import { sanitizeForkSnapshot } from "../src/snapshot.js";
import type { CompressedFlowResult } from "../src/types.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(entries: any[]): string {
	return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function parseSnapshot(snapshot: string): any[] {
	return snapshot
		.trimEnd()
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l));
}

const VALID_PASS_NAMES = new Set([
	"forkMetadataInjection",
	"stripSystemPrompt",
	"dropSlidingSystemPrompts",
	"dropSystemEvents",
	"dropCustomMessages",
	"dropConfigEvents",
	"normalizeToolResultRole",
	"stripReasoning",
	"stripTimestamps",
	"stripApiMetadata",
	"stripDetails",
	"stripSteeringHints",
	"stripStrategicHints",
	"reparentOrphans",
	"stripBatchRead",
	"compressToolResults",
]);

const KNOWN_DEAD_PASS_NAMES = new Set(["sanitizeMessages"]);

function getPackageVersion(): string {
	const packageJsonPath = path.join(process.cwd(), "package.json");
	const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
	return pkg.version;
}

// ---------------------------------------------------------------------------
// 1. ORPHAN-FREE SNAPSHOT TEST
// ---------------------------------------------------------------------------

describe("ORPHAN-FREE SNAPSHOT TEST", () => {
	it("produces a sanitized snapshot with zero orphaned parentIds, zero batch_read calls, zero cost fields, zero inner timestamps, and zero details in tool results", () => {
		const flowCache = new Map<string, CompressedFlowResult[]>();
		flowCache.set("flow-tc-1", [
			{
				type: "scout",
				status: "accomplished",
				files: [{ path: "src/a.ts" }],
				commands: [{ tool: "grep", command: "TODO" }],
			},
		]);

		const snapshot = makeSnapshot([
			{ type: "session", id: "session-1", systemPrompt: "You are helpful" },
			{ type: "system", content: "test system" },
			{
				type: "message",
				message: {
					role: "user",
					content: "Read the codebase",
					id: "msg-user-1",
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					id: "msg-assistant-1",
					parentId: "msg-user-1",
					content: [
						{ type: "text", text: "I'll read the files." },
						{
							type: "toolCall",
							id: "br-tc-1",
							name: "batch_read",
							arguments: { o: [{ o: "read", p: "src/a.ts" }, { o: "read", p: "src/b.ts" }] },
						},
					],
					timestamp: 1715724000000,
					api: "openai",
					provider: "wafer",
					model: "glm-5.1",
					usage: { input: 10, output: 5, totalTokens: 8821, cost: { total: 0 } },
					stopReason: "stop",
					responseId: "resp_1",
					responseModel: "glm-5.1",
					reasoning: "I should read the files first",
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					id: "msg-tool-1",
					parentId: "msg-assistant-1",
					toolCallId: "br-tc-1",
					content: [{ type: "text", text: "Full file content of a.ts and b.ts..." }],
					timestamp: 1715724001000,
					details: { flowStyle: "scout", mode: "flow" },
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					id: "msg-assistant-2",
					parentId: "msg-tool-1",
					content: [
						{ type: "text", text: "Delegating to scout flow." },
						{
							type: "toolCall",
							id: "flow-tc-1",
							name: "flow",
							arguments: { flow: [{ type: "scout", intent: "Map the codebase" }] },
						},
					],
					timestamp: 1715724002000,
					api: "openai",
					provider: "wafer",
					model: "glm-5.1",
					usage: { input: 20, output: 10, totalTokens: 9000, cost: { total: 0 } },
					stopReason: "stop",
					responseId: "resp_2",
					responseModel: "glm-5.1",
					reasoning: "I should delegate to scout",
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					id: "msg-tool-2",
					parentId: "msg-assistant-2",
					toolCallId: "flow-tc-1",
					content: [{ type: "text", text: "Very long flow result that should be compressed..." }],
					timestamp: 1715724003000,
					details: { flowStyle: "scout", mode: "flow" },
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					id: "msg-assistant-3",
					parentId: "msg-tool-2",
					content: [
						{ type: "text", text: "Searching the web." },
						{
							type: "toolCall",
							id: "web-tc-1",
							name: "web",
							arguments: { o: [{ o: "search", q: "node.js streams" }] },
						},
					],
					timestamp: 1715724004000,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					id: "msg-tool-3",
					parentId: "msg-assistant-3",
					toolCallId: "web-tc-1",
					content: "1. Node.js Streams\n   https://nodejs.org/api/stream.html\n   Everything you need to know about streams\n\n2. Stream Handbook\n   https://github.com/substack/stream-handbook\n   How to use streams",
					timestamp: 1715724005000,
					details: { flowStyle: "scout" },
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					id: "msg-assistant-4",
					parentId: "msg-tool-3",
					content: [
						{ type: "text", text: "Asking user." },
						{
							type: "toolCall",
							id: "ask-tc-1",
							name: "ask_user",
							arguments: { question: "Should we use Docker?" },
						},
					],
					timestamp: 1715724006000,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					id: "msg-tool-4",
					parentId: "msg-assistant-4",
					toolCallId: "ask-tc-1",
					content: "User answered: Yes",
					timestamp: 1715724007000,
					details: { flowStyle: "scout" },
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					id: "msg-assistant-5",
					parentId: "msg-tool-4",
					content: [{ type: "text", text: "Here is the summary." }],
					timestamp: 1715724008000,
				},
			},
			{
				type: "message",
				message: {
					role: "user",
					id: "msg-user-2",
					parentId: "msg-assistant-5",
					content: "Now implement the feature",
					timestamp: 1715724009000,
				},
			},
		]);

		const { result } = sanitizeForkSnapshot(snapshot, flowCache, {
			forkedFrom: "orchestrator",
			forkedAt: new Date().toISOString(),
			parentFlow: "root",
			depth: 1,
		});

		expect(result).toBeDefined();
		const entries = parseSnapshot(result!);

		// (a) Zero parentId references pointing to IDs that don't exist in the output.
		const survivingIds = new Set<string>();
		for (const entry of entries) {
			const id = entry?.message?.id ?? entry?.id;
			if (typeof id === "string") survivingIds.add(id);
		}
		for (const entry of entries) {
			const entryParentId = entry?.parentId ?? entry?.parentMessageId;
			const msgParentId = entry?.message?.parentId ?? entry?.message?.parentMessageId;
			const parentId = entryParentId ?? msgParentId;
			if (typeof parentId === "string") {
				expect(
					survivingIds.has(parentId),
					`orphaned parentId: ${parentId} in entry ${JSON.stringify(entry).slice(0, 200)}`,
				).toBe(true);
			}
		}

		// (b) Zero batch_read tool calls remain.
		for (const entry of entries) {
			const content = entry?.message?.content;
			if (Array.isArray(content)) {
				for (const part of content) {
					expect(part?.name).not.toBe("batch_read");
				}
			}
		}

		// (c) Zero 'cost' fields in any message.
		for (const entry of entries) {
			if (entry?.message) {
				expect("cost" in entry.message).toBe(false);
				if (entry.message?.usage && typeof entry.message.usage === "object") {
					expect("cost" in entry.message.usage).toBe(false);
				}
			}
		}

		// (d) Zero inner message.timestamp fields.
		for (const entry of entries) {
			if (entry?.message) {
				expect("timestamp" in entry.message).toBe(false);
			}
		}

		// (e) Zero 'details' fields in tool results.
		for (const entry of entries) {
			if (
				entry?.message?.role === "tool" ||
				entry?.message?.role === "toolResult"
			) {
				expect("details" in entry.message).toBe(false);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// 2. DEAD PASS NAME TEST
// ---------------------------------------------------------------------------

describe("DEAD PASS NAME TEST", () => {
	it("does not contain any known-dead pass names in passesApplied", () => {
		const snapshot = makeSnapshot([
			{ type: "session", id: "session-1", systemPrompt: "You are helpful" },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					timestamp: 1234567890,
					api: "openai",
					provider: "wafer",
					model: "glm-5.1",
					usage: { totalTokens: 100, cost: { total: 0 } },
					stopReason: "stop",
					responseId: "resp_1",
					responseModel: "glm-5.1",
					reasoning: "I should greet",
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "Result\n\n[Hint: Plan next step.]",
					details: { flowStyle: "scout" },
				},
			},
		]);

		const { result, passesApplied } = sanitizeForkSnapshot(snapshot, new Map());
		expect(result).toBeDefined();

		// Assert no dead pass names appear
		for (const pass of passesApplied) {
			expect(
				KNOWN_DEAD_PASS_NAMES.has(pass),
				`dead pass name found: ${pass}`,
			).toBe(false);
		}

		// Assert every pass name is in the valid set
		for (const pass of passesApplied) {
			expect(
				VALID_PASS_NAMES.has(pass),
				`unknown pass name found: ${pass}`,
			).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// 3. HEADER ROUND-TRIP TEST
// ---------------------------------------------------------------------------

describe("HEADER ROUND-TRIP TEST", () => {
	it("builds a dump file with a header that round-trips correctly against compression-stats", () => {
		const flowCache = new Map<string, CompressedFlowResult[]>();
		flowCache.set("flow-tc-1", [{ type: "scout", status: "accomplished" }]);

		const snapshot = makeSnapshot([
			{ type: "session", id: "session-1", systemPrompt: "You are helpful" },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					timestamp: 1234567890,
					api: "openai",
					provider: "wafer",
					model: "glm-5.1",
					usage: { totalTokens: 100, cost: { total: 0 } },
					stopReason: "stop",
					responseId: "resp_1",
					responseModel: "glm-5.1",
					reasoning: "I should greet",
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					content: "Result\n\n[Hint: Plan next step.]",
					details: { flowStyle: "scout" },
				},
			},
		]);

		const { result } = sanitizeForkSnapshot(snapshot, flowCache);
		expect(result).toBeDefined();

		// Extract compression-stats from the trailing entry (same pipeline as flow.ts)
		const lines = result!.trimEnd().split("\n");
		const lastLine = lines[lines.length - 1];
		const lastEntry = JSON.parse(lastLine);
		expect(lastEntry?.type).toBe("compression-stats");

		const passesApplied: string[] = Array.isArray(lastEntry.passesApplied)
			? lastEntry.passesApplied
			: [];
		const preBytes = lastEntry.preBytes;
		const postBytes = lastEntry.postBytes;
		const reductionPercent = lastEntry.reductionPercent;

		// Replicate the exact dump-building logic from src/flow.ts
		const flowName = "scout";
		const tier = "lite";
		const pipelineVersion = getPackageVersion();
		const passesList = passesApplied.length > 0
			? passesApplied.join(", ")
			: "sanitizeForkSnapshot (see src/snapshot.ts)";
		const generatedIso = new Date().toISOString();

		const sanitizationHeader = `<!-- pi-agent-flow dump | State: post-sanitization | Passes: ${passesList} | Flow: ${flowName} | Tier: ${tier} | Pipeline: ${pipelineVersion} | Generated: ${generatedIso} -->`;

		const compressionStatsMarkdown =
			`\n\n## Compression Stats\n\n` +
			`- Pre-sanitization: ${preBytes} bytes\n` +
			`- Post-sanitization: ${postBytes} bytes\n` +
			`- Reduction: ${reductionPercent}%`;

		const markdown = [
			sanitizationHeader,
			``,
			`## Session Snapshot (JSONL)`,
			``,
			...result!.split("\n"),
			``,
			`## Activation Prompt (-p)`,
			``,
			"mock prompt",
			compressionStatsMarkdown,
		].join("\n");

		// Parse the HTML comment header from the markdown.
		const headerMatch = markdown.match(
			/<!-- pi-agent-flow dump \| State: ([^|]+) \| Passes: ([^|]+) \| Flow: ([^|]+) \| Tier: ([^|]+) \| Pipeline: ([^|]+) \| Generated: ([^ ]+) -->/,
		);
		expect(headerMatch).toBeTruthy();
		const [, state, passesStr, flow, tierParsed, pipeline, generated] = headerMatch!;

		// (a) State is 'post-sanitization'.
		expect(state.trim()).toBe("post-sanitization");

		// (b) Passes listed in header match passesApplied in compression-stats.
		const headerPasses = passesStr.split(", ").map((p) => p.trim());
		expect(headerPasses).toEqual(passesApplied);

		// (c) Flow name matches.
		expect(flow.trim()).toBe(flowName);

		// (d) Generated timestamp is valid ISO.
		expect(() => new Date(generated).toISOString()).not.toThrow();
		expect(new Date(generated).toISOString()).toBe(generated);

		// (e) Tier is present.
		expect(tierParsed.trim()).toBe(tier);
		expect(tierParsed.trim().length).toBeGreaterThan(0);

		// (f) Pipeline version is present.
		expect(pipeline.trim()).toBe(pipelineVersion);
		expect(pipeline.trim().length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// 4. CUSTOM MESSAGE / CONFIG EVENT DROP TEST
// ---------------------------------------------------------------------------

describe("CUSTOM MESSAGE / CONFIG EVENT DROP TEST", () => {
	it("drops custom_message, model_change, and thinking_level_change entries", () => {
		const snapshot = makeSnapshot([
			{ type: "session", id: "session-1", systemPrompt: "You are helpful" },
			{ type: "model_change", id: "mc-1", parentId: "session-1", provider: "wafer", modelId: "glm-5.1" },
			{ type: "thinking_level_change", id: "tc-1", parentId: "mc-1", thinkingLevel: "high" },
			{
				type: "custom_message",
				id: "cm-1",
				parentId: "tc-1",
				content: "You MUST call the flow tool now...",
				display: false,
			},
			{
				type: "message",
				message: {
					role: "user",
					content: "hello",
					id: "msg-1",
					parentId: "cm-1",
				},
			},
		]);

		const { result, passesApplied } = sanitizeForkSnapshot(snapshot, new Map());
		expect(result).toBeDefined();
		const entries = parseSnapshot(result!);

		// custom_message, model_change, thinking_level_change must be gone
		expect(entries.some((e: any) => e?.type === "custom_message")).toBe(false);
		expect(entries.some((e: any) => e?.type === "model_change")).toBe(false);
		expect(entries.some((e: any) => e?.type === "thinking_level_change")).toBe(false);

		// The visible user message should survive
		expect(entries.some((e: any) => e?.message?.role === "user")).toBe(true);

		// Pass names should be recorded
		expect(passesApplied).toContain("dropCustomMessages");
		expect(passesApplied).toContain("dropConfigEvents");
	});
});
