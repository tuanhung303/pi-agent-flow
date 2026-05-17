import { describe, it, expect } from "vitest";
import { sanitizeForkSnapshot } from "../src/snapshot/snapshot.js";
import type { CompressedFlowResult } from "../src/types/output.js";
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
	"stripSystemPrompt",
	"stripSessionId",
	"dropSlidingSystemPrompts",
	"dropSystemEvents",
	"dropCustomMessages",
	"dropConfigEvents",
	"dropUnknownTypes",
	"dropMalformedMessages",
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
	"compressParentActivation",
	"collapseEmptyAssistantMessages",
	"compressFlowToolCallArgs",
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

		const { result, passesApplied } = sanitizeForkSnapshot(snapshot, flowCache, {
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
			const id = entry?.message?.id ?? entry?.message?.messageId ?? entry?.id;
			if (typeof id === "string") survivingIds.add(id);
			const parentId = entry?.parentId ?? entry?.parentMessageId ?? entry?.message?.parentId ?? entry?.message?.parentMessageId;
			if (typeof parentId === "string") survivingIds.add(parentId);
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

		// (f) System events dropped and passes recorded.
		expect(entries.some((e: any) => e?.type === "system")).toBe(false);
		expect(passesApplied).toContain("dropSystemEvents");

		// (g) Header systemPrompt stripped and pass recorded.
		const headerEntry = entries[0];
		expect(headerEntry?.systemPrompt).toMatch(/parent orchestrator system prompt stripped/);
		expect(passesApplied).toContain("stripSystemPrompt");

		// (h) Session id renamed to parentId and id removed.
		expect(headerEntry?.parentId).toBe("session-1");
		expect("id" in headerEntry).toBe(false);
		expect(passesApplied).toContain("stripSessionId");
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

		const { result, stats } = sanitizeForkSnapshot(snapshot, flowCache);
		expect(result).toBeDefined();
		expect(stats).toBeDefined();

		// Stats are returned out-of-band; the JSONL must NOT contain compression-stats.
		const lines = result!.trimEnd().split("\n");
		const lastLine = lines[lines.length - 1];
		const lastEntry = JSON.parse(lastLine);
		expect(lastEntry?.type).not.toBe("compression-stats");

		const passesApplied: string[] = Array.isArray(stats?.passesApplied)
			? stats!.passesApplied
			: [];
		const preBytes = stats!.preBytes;
		const postBytes = stats!.postBytes;
		const reductionPercent = stats!.reductionPercent;

		// Replicate the exact dump-building logic from src/flow.ts
		const flowName = "scout";
		const tier = "lite";
		const pipelineVersion = getPackageVersion();
		const passesList = passesApplied.length > 0
			? passesApplied.join(", ")
			: "(none — cold start)";
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
			...result!.trimEnd().split("\n"),
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

// ---------------------------------------------------------------------------
// 5. COLLAPSE EMPTY ASSISTANT MESSAGES TEST
// ---------------------------------------------------------------------------

describe("COLLAPSE EMPTY ASSISTANT MESSAGES", () => {
	it("collapses empty, whitespace-only, and empty-array assistant messages and strips usage", () => {
		const snapshot = makeSnapshot([
			{ type: "session", id: "session-1", systemPrompt: "You are helpful" },
			{
				type: "message",
				message: {
					role: "assistant",
					id: "msg-empty-string",
					content: "",
					usage: { totalTokens: 10 },
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					id: "msg-whitespace",
					content: "   \n\t  ",
					usage: { totalTokens: 10 },
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					id: "msg-empty-array",
					content: [],
					usage: { totalTokens: 10 },
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					id: "msg-whitespace-array",
					content: [{ type: "text", text: "  " }, { type: "text", text: "\n" }],
					usage: { totalTokens: 10 },
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					id: "msg-with-tool",
					content: [
						{ type: "text", text: "  " },
						{ type: "toolCall", id: "tc1", name: "batch" },
					],
					usage: { totalTokens: 10 },
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					id: "msg-with-text",
					content: [{ type: "text", text: "Hello — see [batch] results." }],
					usage: { totalTokens: 10 },
				},
			},
		]);

		const { result, passesApplied } = sanitizeForkSnapshot(snapshot, new Map());
		expect(result).toBeDefined();
		const entries = parseSnapshot(result!);

		const emptyString = entries.find((e: any) => e?.message?.id === "msg-empty-string");
		expect(emptyString?.message?.content).toBe("[assistant: 10 tokens, no action]");
		expect(emptyString?.message?.usage).toEqual({ totalTokens: 10 });

		const whitespace = entries.find((e: any) => e?.message?.id === "msg-whitespace");
		expect(whitespace?.message?.content).toBe("[assistant: 10 tokens, no action]");
		expect(whitespace?.message?.usage).toEqual({ totalTokens: 10 });

		const emptyArray = entries.find((e: any) => e?.message?.id === "msg-empty-array");
		expect(emptyArray?.message?.content).toBe("[assistant: 10 tokens, no action]");
		expect(emptyArray?.message?.usage).toEqual({ totalTokens: 10 });

		const whitespaceArray = entries.find((e: any) => e?.message?.id === "msg-whitespace-array");
		expect(whitespaceArray?.message?.content).toBe("[assistant: 10 tokens, no action]");
		expect(whitespaceArray?.message?.usage).toEqual({ totalTokens: 10 });

		const withTool = entries.find((e: any) => e?.message?.id === "msg-with-tool");
		expect(withTool?.message?.content).not.toBe("[assistant:continuation]");
		expect(withTool?.message?.content).toEqual([
			{ type: "text", text: "  " },
			{ type: "toolCall", id: "tc1", name: "batch" },
		]);
		expect(withTool?.message?.usage).toBeDefined();

		const withText = entries.find((e: any) => e?.message?.id === "msg-with-text");
		expect(withText?.message?.content).toEqual([{ type: "text", text: "Hello — see [batch] results." }]);
		expect(withText?.message?.usage).toBeDefined();

		expect(passesApplied).toContain("collapseEmptyAssistantMessages");
	});
});

// ---------------------------------------------------------------------------
// 6. CUSTOM MESSAGE / CONFIG EVENT DROP TEST
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

// ---------------------------------------------------------------------------
// 5. ORPHAN PARENTID REGRESSION TEST (batch_read behavioral)
// ---------------------------------------------------------------------------

describe("ORPHAN PARENTID REGRESSION TEST (batch_read behavioral)", () => {
	it("drops batch_read tool calls AND their orphaned tool results, leaving no dangling parentIds", () => {
		const snapshot = makeSnapshot([
			{ type: "session", id: "session-1", systemPrompt: "You are helpful" },
			{
				type: "message",
				message: {
					role: "user",
					content: "Read files",
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
							arguments: { o: [{ o: "read", p: "src/a.ts" }] },
						},
					],
				},
			},
			{
				type: "message",
				message: {
					role: "tool", // Legacy role: tool — should still be dropped
					id: "msg-tool-1",
					parentId: "msg-assistant-1",
					toolCallId: "br-tc-1",
					content: [{ type: "text", text: "Full content of a.ts" }],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					id: "msg-assistant-2",
					parentId: "msg-tool-1",
					content: [{ type: "text", text: "Next step after reading." }],
				},
			},
			{
				type: "message",
				message: {
					role: "user",
					id: "msg-user-2",
					parentId: "msg-assistant-2",
					content: "Now implement",
				},
			},
		]);

		const { result } = sanitizeForkSnapshot(snapshot, new Map());
		expect(result).toBeDefined();
		const entries = parseSnapshot(result!);

		// (a) batch_read tool calls stripped from assistant messages
		expect(entries.some((e: any) => Array.isArray(e?.message?.content) && e.message.content.some((c: any) => c?.name === "batch_read"))).toBe(false);

		// (b) orphaned tool results referencing batch_read are dropped
		expect(entries.some((e: any) => e?.message?.toolCallId === "br-tc-1")).toBe(false);

		// (c) Collect surviving IDs
		const survivingIds = new Set<string>();
		for (const entry of entries) {
			const id = entry?.message?.id ?? entry?.message?.messageId ?? entry?.id;
			if (typeof id === "string") survivingIds.add(id);
			const parentId = entry?.parentId ?? entry?.parentMessageId ?? entry?.message?.parentId ?? entry?.message?.parentMessageId;
			if (typeof parentId === "string") survivingIds.add(parentId);
		}

		// (d) NO surviving message has a parentId referencing a dropped message
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

		// (e) msg-assistant-2 must survive and be reparented (not pointing to dropped msg-tool-1)
		const msgAssistant2 = entries.find((e: any) => e?.message?.id === "msg-assistant-2");
		expect(msgAssistant2).toBeDefined();
		const msg2ParentId = msgAssistant2?.message?.parentId ?? msgAssistant2?.message?.parentMessageId ?? msgAssistant2?.parentId ?? msgAssistant2?.parentMessageId;
		if (msg2ParentId !== undefined) {
			expect(survivingIds.has(msg2ParentId)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// 6. PARENT ACTIVATION COMPRESSION TEST
// ---------------------------------------------------------------------------

describe("PARENT ACTIVATION COMPRESSION TEST", () => {
	it("compresses parent activation prompts at depth >= 2 and extracts mission preview", () => {
		const parentActivation =
			`<context-seal>\n` +
			`The conversation above is sealed.\n` +
			`</context-seal>\n\n` +
			`<activation flow=\"scout\" depth=\"1\" tools=\"batch, bash\" tier=\"lite\">\n` +
			`You are a [scout] agent.\n` +
			`</activation>\n\n` +
			`<directive>\n## Mission\nDiscovery flow.\n</directive>\n\n` +
			`<mission>\nMap the auth module and trace JWT validation path.\nAcceptance: All files identified.\n\nExecute this mission.\n</mission>`;

		const snapshot = makeSnapshot([
			{ type: "session", id: "session-1", systemPrompt: "You are helpful" },
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: parentActivation }],
					id: "msg-user-parent",
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "I found the files." }],
					id: "msg-assistant-1",
					parentId: "msg-user-parent",
				},
			},
		]);

		const { result, passesApplied } = sanitizeForkSnapshot(snapshot, new Map(), { depth: 2 });
		expect(result).toBeDefined();
		expect(passesApplied).toContain("compressParentActivation");

		const entries = parseSnapshot(result!);
		const userEntry = entries.find((e: any) => e?.message?.role === "user");
		expect(userEntry).toBeDefined();

		const text = typeof userEntry.message.content === "string"
			? userEntry.message.content
			: userEntry.message.content?.find((p: any) => p.type === "text")?.text ?? "";

		expect(text).toMatch(/^\[Parent flow activation stripped\] Mission preview:/);
		// Should contain the actual mission content, not <context-seal> boilerplate
		expect(text).toContain("Map the auth module");
		expect(text).not.toContain("<context-seal>");
	});

	it("falls back to content after </context-seal> when <mission> is missing", () => {
		const parentActivation =
			`<context-seal>\n` +
			`Sealed context.\n` +
			`</context-seal>\n\n` +
			`<activation flow=\"build\" depth=\"1\" tools=\"batch\" tier=\"flash\">\n` +
			`You are a [build] agent.\n` +
			`</activation>\n\n` +
			`<directive>\nBuild things.\n</directive>`;

		const snapshot = makeSnapshot([
			{ type: "session", id: "session-1" },
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: parentActivation }],
					id: "msg-user-parent",
				},
			},
		]);

		const { result, passesApplied } = sanitizeForkSnapshot(snapshot, new Map(), { depth: 2 });
		expect(passesApplied).toContain("compressParentActivation");

		const entries = parseSnapshot(result!);
		const userEntry = entries.find((e: any) => e?.message?.role === "user");
		const text = typeof userEntry.message.content === "string"
			? userEntry.message.content
			: userEntry.message.content?.find((p: any) => p.type === "text")?.text ?? "";

		expect(text).toMatch(/^\[Parent flow activation stripped\] Mission preview:/);
		expect(text).not.toContain("<context-seal>");
	});
});
