import { describe, it, expect } from "vitest";
import { buildCore2Snapshot } from "../src/core2/snapshot.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSource(entries: unknown[]) {
	return {
		getHeader: () => ({ version: 1, id: "test-session" }),
		getBranch: () => entries,
	};
}

function parseSnapshot(snapshot: string | null): unknown[] {
	if (!snapshot) return [];
	return snapshot
		.trimEnd()
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l));
}

function makeSnapshot(entries: unknown[]): string {
	return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}
function expectProviderNeutralHistory(entries: unknown[]): void {
	const protocolTypes: Record<string, true> = {
		toolCall: true,
		tool_call: true,
		function_call: true,
		toolResult: true,
		tool_result: true,
		function_call_output: true,
	};
	const forbiddenMessageKeys = [
		"toolCalls",
		"tool_calls",
		"toolCallId",
		"tool_call_id",
		"call_id",
		"signature",
		"signatures",
		"api",
		"provider",
		"model",
	];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		expect(protocolTypes[String(record.type)]).not.toBe(true);
		if (record.type !== "message" || !record.message || typeof record.message !== "object") continue;
		const message = record.message as Record<string, unknown>;
		expect(message.role).not.toBe("tool");
		expect(message.role).not.toBe("toolResult");
		for (const key of forbiddenMessageKeys) expect(message).not.toHaveProperty(key);
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (!block || typeof block !== "object") continue;
			expect(protocolTypes[String((block as Record<string, unknown>).type)]).not.toBe(true);
		}
	}
}

// ---------------------------------------------------------------------------
// Retention tests — non-batch content preserved verbatim
// ---------------------------------------------------------------------------

describe("buildCore2Snapshot — retention", () => {
	it("returns null when header is null", () => {
		const source = { getHeader: () => null, getBranch: () => [] };
		expect(buildCore2Snapshot(source)).toBeNull();
	});

	it("preserves header and branch verbatim when no tool results", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "Hello" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } },
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		const parsed = parseSnapshot(snapshot);
		expect(parsed).toHaveLength(4); // header + context map + 2 messages
		expect(parsed[0]).toMatchObject({ version: 1, id: "test-session" });
		expect(parsed[1]).toMatchObject({ type: "message", message: { role: "system", content: expect.stringContaining("[SHARED CONTEXT]") } });
		expect(parsed[2]).toMatchObject({ type: "message", message: { role: "user", content: "Hello" } });
		expect(parsed[3]).toMatchObject({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } });
	});

	it("preserves canonical Pi images while dropping provider-specific image blocks", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "Inspect this image" },
						{ type: "image", data: "base64-image", mimeType: "image/png", dimensions: { width: 1, height: 1 } },
						{ type: "image_url", image_url: "data:image/png;base64,provider-specific" },
					],
				},
			},
		];

		const parsed = parseSnapshot(buildCore2Snapshot(makeSource(entries)));
		const user = parsed.find((entry: any) => entry.message?.role === "user") as any;
		expect(user.message.content).toEqual([
			{ type: "text", text: "Inspect this image" },
			{ type: "image", data: "base64-image", mimeType: "image/png" },
		]);
		expect(JSON.stringify(user)).not.toContain("provider-specific");
		expectProviderNeutralHistory(parsed);
	});

	it("drops malformed canonical image blocks without dropping surrounding text", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "image", data: "", mimeType: "image/png" },
						{ type: "image", data: "base64-image", mimeType: "text/plain" },
						{ type: "text", text: "Keep this text" },
					],
				},
			},
		];

		const parsed = parseSnapshot(buildCore2Snapshot(makeSource(entries)));
		const user = parsed.find((entry: any) => entry.message?.role === "user") as any;
		expect(user.message.content).toEqual([{ type: "text", text: "Keep this text" }]);
	});

	it("flattens completed non-batch tool results into assistant history", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", name: "bash", toolCallId: "bash-1", arguments: { command: "echo hello" } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "bash-1",
					content: [{ type: "text", text: "hello\nworld" }],
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		const parsed = parseSnapshot(snapshot);
		expect(snapshot).toContain("[Historical tool interaction]");
		expect(snapshot).toContain("Tool: bash");
		expect(snapshot).toContain("hello\\nworld");
		expect(snapshot).not.toContain("bash-1");
		expectProviderNeutralHistory(parsed);
	});

	it("drops user messages that become empty after nested tool protocol flattening", () => {
		const entries = [
			{
				type: "message",
				id: "empty-wrapper",
				message: {
					role: "user",
					content: [{ type: "toolCall", name: "bash", toolCallId: "unmatched", arguments: { command: "echo orphan" } }],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "bash", toolCallId: "paired", arguments: { command: "echo hi" } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "paired",
					content: [{ type: "text", text: "hi" }],
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		const parsed = parseSnapshot(snapshot);
		expect(parsed.some((entry) => {
			if (!entry || typeof entry !== "object") return false;
			const message = (entry as Record<string, unknown>).message;
			return message && typeof message === "object" && (message as Record<string, unknown>).role === "user";
		})).toBe(false);
		expect(snapshot).toContain("[Historical tool interaction]");
		expect(snapshot).toContain("Tool: bash");
		expect(snapshot).toContain("hi");
		expectProviderNeutralHistory(parsed);
	});

	it("preserves system messages verbatim", () => {
		const entries = [
			{ type: "message", message: { role: "system", content: "<pi-flow-steering-hint>Steer</pi-flow-steering-hint>" } },
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).toContain("<pi-flow-steering-hint>");
	});

	it("strips assistant reasoning and thinking", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					thinking: "SECRET_THINKING",
					reasoning: "SECRET_REASONING",
					content: [
						{ type: "thinking", text: "THINKING_PART" },
						{ type: "text", text: "Visible text" },
					],
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).not.toContain("SECRET_THINKING");
		expect(snapshot).not.toContain("SECRET_REASONING");
		expect(snapshot).not.toContain("THINKING_PART");
		expect(snapshot).toContain("Visible text");
	});

	it("flattens completed flow calls and results", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", name: "flow", toolCallId: "flow-1", arguments: { flow: [{ type: "scout" }] } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "flow-1",
					content: [{ type: "text", text: "Prior flow result should be inherited semantically" }],
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).toContain("Prior flow result should be inherited semantically");
		expect(snapshot).toContain("Tool: flow");
		expect(snapshot).not.toContain('"name":"flow"');
		expectProviderNeutralHistory(parseSnapshot(snapshot));
	});

	it("preserves id and strips parentId from entries", () => {
		const entry = { type: "message", id: "msg-1", parentId: "parent-abc", message: { role: "user", content: "hi" } };
		const snapshot = buildCore2Snapshot(makeSource([entry]));
		expect(snapshot).toContain('"id":"msg-1"');
		expect(snapshot).not.toContain("parentId");
	});

	it("removes pairing IDs after retaining a completed interaction", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "tc-1", name: "bash", arguments: { command: "echo output" } },
					],
				},
			},
			{
				type: "message",
				message: { role: "toolResult", toolCallId: "tc-1", content: [{ type: "text", text: "output" }] },
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).not.toContain("tc-1");
		expect(snapshot).not.toContain("toolCallId");
		expect(snapshot).toContain("Tool: bash");
		expect(snapshot).toContain("output");
	});
	it("sanitizes nested directives in canonical tool arguments without mutating the calls", () => {
		const objectArguments = {
			command: "echo safe\n\n[Directive: discard this instruction.]",
			nested: { hint: "keep this\n\n[Hint: discard this hint.]" },
			items: ["plain", "also keep\n\n[Directive: discard this too.]"],
			count: 2,
		};
		const encodedArguments = JSON.stringify({
			path: "src/file.ts",
			nested: ["encoded value\n\n[Directive: discard encoded instruction.]"],
		});
		const originalArguments = structuredClone(objectArguments);
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", toolCallId: "argument-object", name: "bash", arguments: objectArguments },
						{ type: "toolCall", toolCallId: "argument-encoded", name: "read", arguments: encodedArguments },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "argument-object",
					content: [{ type: "text", text: "object result" }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "argument-encoded",
					content: [{ type: "text", text: "encoded result" }],
				},
			},
		];

		const snapshot = buildCore2Snapshot(makeSource(entries));
		const argumentTexts = parseSnapshot(snapshot)
			.flatMap((entry) => {
				const candidate = entry && typeof entry === "object" ? (entry as Record<string, unknown>).message : undefined;
				const message = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : undefined;
				return Array.isArray(message?.content)
					? message.content
						.filter((block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "text" && typeof (block as Record<string, unknown>).text === "string")
						.map((block) => (block as Record<string, unknown>).text as string)
					: [];
			})
			.filter((text) => text.startsWith("[Historical tool interaction]"))
			.map((text) => {
				const start = text.indexOf("Arguments:\n") + "Arguments:\n".length;
				return JSON.parse(text.slice(start, text.indexOf("\n\nResult:", start)));
			});

		expect(snapshot).not.toContain("[Directive:");
		expect(snapshot).not.toContain("[Hint:");
		expect(argumentTexts).toEqual([
			{ command: "echo safe", nested: { hint: "keep this" }, items: ["plain", "also keep"], count: 2 },
			{ path: "src/file.ts", nested: ["encoded value"] },
		]);
		expect(objectArguments).toEqual(originalArguments);
	});

	it("strips directive blocks from tool result text", () => {
		const text =
			"✔ 1 read\n--- src/file.ts (3 lines) ---\na\nb\nc\n\n[Directive: Close what you start. Dispatch a [build] or [scout] flow to verify before advancing.]";
		const entry = {
			type: "message",
			message: { role: "toolResult", content: [{ type: "text", text }] },
		};
		const snapshot = buildCore2Snapshot(makeSource([entry]));
		expect(snapshot).not.toContain("[Directive:");
		expect(snapshot).toContain("--- src/file.ts (3 lines) ---");
		expect(snapshot).toContain("a");
	});

	it("strips directive blocks from non-batch tool result text", () => {
		const text =
			"exit 0\n\n[Directive: Close what you start. Dispatch a [build] or [scout] flow to verify before advancing.]";
		const entry = {
			type: "message",
			message: { role: "toolResult", content: [{ type: "text", text }] },
		};
		const snapshot = buildCore2Snapshot(makeSource([entry]));
		expect(snapshot).not.toContain("[Directive:");
		expect(snapshot).not.toContain("Dispatch a [build]");
		expect(snapshot).toContain("exit 0");
	});

	it("strips legacy [Hint:] blocks from tool result text", () => {
		const text = "hello world\n\n[Hint: Do something useful.]";
		const entry = {
			type: "message",
			message: { role: "toolResult", content: [{ type: "text", text }] },
		};
		const snapshot = buildCore2Snapshot(makeSource([entry]));
		expect(snapshot).not.toContain("[Hint:");
		expect(snapshot).not.toContain("Do something useful");
		expect(snapshot).toContain("hello world");
	});

	it("preserves batch bash and rg sections verbatim", () => {
		const batchText =
			"✔ 1 bash\n\n" +
			"--- bash [abc] exit 0 ---\n" +
			"[Execution time: 0.5s]\n" +
			"output line 1\n" +
			"output line 2\n\n" +
			"--- rg: pattern ---\n" +
			"src/a.ts:1:match\n" +
			"src/b.ts:2:match";
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: batchText }],
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).toContain("output line 1");
		expect(snapshot).toContain("output line 2");
		expect(snapshot).toContain("src/a.ts:1:match");
		expect(snapshot).toContain("src/b.ts:2:match");
	});
});

// ---------------------------------------------------------------------------
// Tool-call pairing cleanup tests
// ---------------------------------------------------------------------------

describe("buildCore2Snapshot — tool-call pairing cleanup", () => {
	it("flattens valid camelCase assistant toolCall and matching toolResult", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", name: "bash", toolCallId: "tc-camel", arguments: { command: "echo ok" } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc-camel",
					content: [{ type: "text", text: "ok" }],
				},
			},
		];

		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).not.toContain("tc-camel");
		expect(snapshot).toContain("Tool: bash");
		expect(snapshot).toContain("ok");
	});

	it("flattens valid snake_case assistant toolCall and matching toolResult", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", name: "bash", tool_call_id: "tc-snake", arguments: { command: "echo ok" } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					tool_call_id: "tc-snake",
					content: [{ type: "text", text: "snake ok" }],
				},
			},
		];

		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).not.toContain("tc-snake");
		expect(snapshot).toContain("Tool: bash");
		expect(snapshot).toContain("snake ok");
	});

	it("strips orphaned camelCase toolResults with no matching toolCall", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "missing-camel",
					content: [{ type: "text", text: "orphan output" }],
				},
			},
		];

		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).not.toContain("missing-camel");
		expect(snapshot).not.toContain("orphan output");
	});

	it("strips orphaned snake_case toolResults with no matching toolCall", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					tool_call_id: "missing-snake",
					content: [{ type: "text", text: "snake orphan output" }],
				},
			},
		];

		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).not.toContain("missing-snake");
		expect(snapshot).not.toContain("snake orphan output");
	});

	it("strips identified toolResults when message limiting drops all matching assistant toolCalls", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", name: "bash", toolCallId: "dropped-call", arguments: { command: "echo old" } },
					],
				},
			},
			...Array.from({ length: 30 }, (_, i) => ({
				type: "message",
				message: { role: "user" as const, content: `newer-${i}` },
			})),
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "dropped-call",
					content: [{ type: "text", text: "late orphan output" }],
				},
			},
		];

		const snapshot = buildCore2Snapshot(makeSource(entries), { tier: "lite" });
		expect(snapshot).not.toContain("dropped-call");
		expect(snapshot).not.toContain("late orphan output");
		expect(snapshot).toContain("newer-29");
	});

	it("strips batch_read toolCalls and their matching toolResults", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", name: "batch_read", toolCallId: "batch-read-1", arguments: { cmd: "read src/index.ts" } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "batch-read-1",
					content: [{ type: "text", text: "batch read output" }],
				},
			},
		];

		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).not.toContain("batch_read");
		expect(snapshot).not.toContain("batch-read-1");
		expect(snapshot).not.toContain("batch read output");
	});

	it("drops assistant messages that become empty after batch_read removal", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", name: "batch_read", toolCallId: "batch-only", arguments: { cmd: "read README.md" } },
					],
				},
			},
		];

		const snapshot = buildCore2Snapshot(makeSource(entries));
		const parsed = parseSnapshot(snapshot);
		expect(parsed.some((entry) => {
			if (!entry || typeof entry !== "object") return false;
			const message = (entry as Record<string, unknown>).message;
			return !!message && typeof message === "object" && (message as Record<string, unknown>).role === "assistant";
		})).toBe(false);
		expect(snapshot).not.toContain("batch-only");
	});

	it("keeps assistant messages with mixed batch_read and other toolCalls", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", name: "batch_read", toolCallId: "batch-mixed", arguments: { cmd: "read README.md" } },
						{ type: "toolCall", name: "bash", toolCallId: "bash-mixed", arguments: { command: "npm test" } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "batch-mixed",
					content: [{ type: "text", text: "batch mixed output" }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "bash-mixed",
					content: [{ type: "text", text: "bash mixed output" }],
				},
			},
		];

		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).not.toContain("batch-mixed");
		expect(snapshot).not.toContain("batch mixed output");
		expect(snapshot).not.toContain("bash-mixed");
		expect(snapshot).toContain("Tool: bash");
		expect(snapshot).toContain("bash mixed output");
	});

	it("preserves toolResults without identifiable ID as fallback", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: "unidentified output" }],
				},
			},
		];

		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).toContain("unidentified output");
	});

	it("strips identified toolResults when no assistant toolCalls remain in snapshot", () => {
		// If all assistant messages were dropped by compression, identified
		// toolResults are orphaned and must be stripped to keep provider replay valid.
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "no-assistant",
					content: [{ type: "text", text: "survived output" }],
				},
			},
		];

		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).not.toContain("no-assistant");
		expect(snapshot).not.toContain("survived output");
	});
	it("pairs all ID shapes, preserves message IDs, and drops text-block metadata", () => {
		const entries = [
			{
				type: "message",
				id: "entry-id",
				message: {
					role: "assistant",
					id: "message-id",
					api: "responses",
					provider: "terra",
					model: "gpt",
					signature: "provider-signature",
					content: [
						{ type: "text", id: "text-part-id", text: "before", data: { call_id: "domain-call" } },
						{
							type: "function_call",
							id: "fc-terra",
							call_id: "call-terra",
							name: "bash",
							arguments: '{"command":"terra"}',
						},
						{ type: "text", text: "after" },
					],
					toolCalls: [{ toolCallId: "camel-id", name: "read", arguments: { path: "a.ts" } }],
					tool_calls: [{ tool_call_id: "snake-id", function: { name: "write", arguments: '{"path":"b.ts"}' } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					call_id: "other|call-terra",
					content: [{ type: "text", text: "terra output" }],
				},
			},
			{
				type: "message",
				message: {
					role: "tool",
					toolCallId: "camel-id",
					content: [{ type: "text", text: "read output" }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					tool_call_id: "snake-id",
					content: [{ type: "text", text: "write output" }],
				},
			},
		];

		const snapshot = buildCore2Snapshot(makeSource(entries));
		const parsed = parseSnapshot(snapshot);
		const assistantEntry = parsed[2] as Record<string, unknown>;
		const assistantMessage = assistantEntry.message as Record<string, unknown>;
		const content = assistantMessage.content as Array<Record<string, unknown>>;
		const texts = content.map((part) => part.text).filter((text): text is string => typeof text === "string");

		expect(assistantEntry.id).toBe("entry-id");
		expect(assistantMessage.id).toBe("message-id");
		expect(content[0]).toEqual({ type: "text", text: "before" });
		expect(texts[0]).toBe("before");
		expect(texts[1]).toContain("Tool: bash");
		expect(texts[2]).toBe("after");
		expect(texts[3]).toContain("Tool: read");
		expect(texts[4]).toContain("Tool: write");
		expect(snapshot).toContain("terra output");
		expect(snapshot).not.toContain("fc-terra");
		expect(snapshot).not.toContain("call-terra");
		expect(snapshot).not.toContain("provider-signature");
		expectProviderNeutralHistory(parsed);
	});

	it("removes an active flow pair before deduplication", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "flow-1", name: "flow", arguments: { flow: [{ type: "scout" }] } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "flow-1",
					content: [{ type: "text", text: "completed flow output" }],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{
						type: "toolCall",
						id: "fc-active",
						call_id: "call-active",
						name: "flow",
						arguments: { flow: [{ type: "scout" }] },
					}],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					call_id: "call-active",
					content: [{ type: "text", text: "active output" }],
				},
			},
		];

		const snapshot = buildCore2Snapshot(makeSource(entries), { activeToolCallId: "call-active|fc-active" });
		expect(snapshot).toContain("completed flow output");
		expect(snapshot).toContain("Tool: flow");
		expect(snapshot).not.toContain("active output");
		expect(snapshot).not.toContain("fc-active");
		expectProviderNeutralHistory(parseSnapshot(snapshot));
	});

	it("sanitizes multipart results and applies deterministic batch_read policy", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "multi", name: "trace", arguments: { intent: "inspect" } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "multi",
					content: [
						{ type: "text", text: "first\n\n[Directive: remove one]" },
						{ type: "text", text: "second\n\n[Hint: remove two]" },
						{
							type: "tool_result",
							output: [
								{ type: "text", text: "nested call_literal fc_literal\n\n[Directive: remove nested]" },
								{ type: "image_url", image_url: "data:image/png;base64,abc" },
							],
						},
						{ type: "image", data: "abc" },
						{ type: "audio", data: "abc" },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					name: "batch_read",
					content: [{ type: "text", text: "named batch output" }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: "unidentifiable output" }],
				},
			},
		];

		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).toContain("first");
		expect(snapshot).toContain("second");
		expect(snapshot).toContain("nested call_literal fc_literal");
		expect(snapshot.match(/\[image output omitted\]/g)).toHaveLength(2);
		expect(snapshot).toContain("[audio output omitted]");
		expect(snapshot).not.toContain("[Directive:");
		expect(snapshot).not.toContain("[Hint:");
		expect(snapshot).not.toContain("named batch output");
		expect(snapshot).toContain("[Historical tool result]");
		expect(snapshot).toContain("Tool: unknown");
		expect(snapshot).toContain("unidentifiable output");
		expectProviderNeutralHistory(parseSnapshot(snapshot));
	});
});

// ---------------------------------------------------------------------------
// Chronology tests — order maintained
// ---------------------------------------------------------------------------

describe("buildCore2Snapshot — chronology", () => {
	it("maintains exact chronological order of all messages", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "A", id: "1" } },
			{ type: "message", message: { role: "assistant", content: "B", id: "2" } },
			{ type: "message", message: { role: "system", content: "C", id: "3" } },
			{ type: "message", message: { role: "assistant", content: "D", id: "4" } },
			{ type: "message", message: { role: "user", content: "E", id: "5" } },
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		const parsed = parseSnapshot(snapshot);
		expect(parsed.slice(2).map((entry) => {
			if (!entry || typeof entry !== "object") return undefined;
			const message = (entry as Record<string, unknown>).message;
			return message && typeof message === "object" ? (message as Record<string, unknown>).id : undefined;
		})).toEqual(["1", "2", "3", "4", "5"]);
	});

	it("does not drop or reorder messages", () => {
		const entries = [
			{ type: "message", message: { role: "system", content: "system" } },
			{ type: "message", message: { role: "user", content: "user" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "assistant" }] } },
			{ type: "message", message: { role: "tool", content: "tool" } },
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		const parsed = parseSnapshot(snapshot);
		expect(parsed).toHaveLength(6);
		expect(parsed[1]).toMatchObject({ type: "message", message: { role: "system", content: expect.stringContaining("[SHARED CONTEXT]") } });
		expect(parsed[2]).toMatchObject({ type: "message", message: { role: "system" } });
		expect(parsed[3]).toMatchObject({ type: "message", message: { role: "user" } });
		expect(parsed[4]).toMatchObject({ type: "message", message: { role: "assistant" } });
		expect(parsed[5]).toMatchObject({ type: "message", message: { role: "assistant", content: [{ text: expect.stringContaining("[Historical tool result]") }] } });
	});
});

// ---------------------------------------------------------------------------
// Nuance tests — batch body stripping
// ---------------------------------------------------------------------------

describe("buildCore2Snapshot — nuance (batch body stripping)", () => {
	it("strips read body keeping first 3 + last 3 lines", () => {
		const content =
			"line 1\n" +
			"line 2\n" +
			"line 3\n" +
			"line 4\n" +
			"line 5\n" +
			"line 6\n" +
			"line 7\n" +
			"line 8\n" +
			"line 9\n" +
			"line 10";
		const batchText = `✔ 1 read\n\n--- src/file.ts (10 lines) ---\n${content}`;
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: batchText }],
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).toContain("line 1");
		expect(snapshot).toContain("line 2");
		expect(snapshot).toContain("line 3");
		expect(snapshot).toContain("[...4 lines truncated...]");
		expect(snapshot).toContain("line 8");
		expect(snapshot).toContain("line 9");
		expect(snapshot).toContain("line 10");
		expect(snapshot).not.toContain("line 4\n");
		expect(snapshot).not.toContain("line 5\n");
		expect(snapshot).not.toContain("line 6\n");
		expect(snapshot).not.toContain("line 7\n");
	});

	it("strips write body keeping first 3 + last 3 lines", () => {
		const body = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj";
		const batchText = `✔ 1 write\n\n--- write: src/out.ts (20 bytes) ---\n${body}`;
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: batchText }],
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).toContain("--- write: src/out.ts (20 bytes) ---");
		expect(snapshot).toContain("a");
		expect(snapshot).toContain("b");
		expect(snapshot).toContain("c");
		expect(snapshot).toContain("[...4 lines truncated...]");
		expect(snapshot).toContain("h");
		expect(snapshot).toContain("i");
		expect(snapshot).toContain("j");
	});

	it("strips edit body keeping first 3 + last 3 lines", () => {
		const body = "x\ny\nz\n1\n2\n3\n4\n5\n6\n7";
		const batchText = `✔ 1 edit\n\n--- edit: src/file.ts (2 blocks) ---\n${body}`;
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: batchText }],
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).toContain("--- edit: src/file.ts (2 blocks) ---");
		expect(snapshot).toContain("x");
		expect(snapshot).toContain("y");
		expect(snapshot).toContain("z");
		expect(snapshot).toContain("[...4 lines truncated...]");
		expect(snapshot).toContain("5");
		expect(snapshot).toContain("6");
		expect(snapshot).toContain("7");
	});

	it("keeps small bodies intact (<= 6 lines)", () => {
		const body = "a\nb\nc\nd\ne\nf";
		const batchText = `✔ 1 read\n\n--- src/short.ts (6 lines) ---\n${body}`;
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: batchText }],
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).toContain("a");
		expect(snapshot).toContain("b");
		expect(snapshot).toContain("c");
		expect(snapshot).toContain("d");
		expect(snapshot).toContain("e");
		expect(snapshot).toContain("f");
		expect(snapshot).not.toContain("truncated");
	});

	it("strips context map / file summary bodies", () => {
		const body = "Total lines: 100\nLanguage: ts\n\nContext map:\n- class Foo 1-10\n- class Bar 11-20\n- class Baz 21-30\n- class Qux 31-40\n- class Quux 41-50";
		const batchText = `✔ 1 read\n\n--- src/large.ts context map ---\n${body}`;
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: batchText }],
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).toContain("--- src/large.ts context map ---");
		expect(snapshot).toContain("Total lines: 100");
		expect(snapshot).toContain("Language: ts");
		expect(snapshot).toContain("[...3 lines truncated...]");
		expect(snapshot).toContain("class Quux 41-50");
		expect(snapshot).not.toContain("Context map:");
	});

	it("strips multiple batch sections in a single result", () => {
		const text =
			"✔ 2 reads\n\n" +
			"--- src/a.ts (10 lines) ---\n" +
			"a1\na2\na3\na4\na5\na6\na7\na8\na9\na10\n\n" +
			"--- src/b.ts (8 lines) ---\n" +
			"b1\nb2\nb3\nb4\nb5\nb6\nb7\nb8";
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "text", text }],
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).toContain("a1");
		expect(snapshot).toContain("a2");
		expect(snapshot).toContain("a3");
		expect(snapshot).toContain("[...5 lines truncated...]");
		expect(snapshot).toContain("a9");
		expect(snapshot).toContain("a10");
		expect(snapshot).toContain("b1");
		expect(snapshot).toContain("b2");
		expect(snapshot).toContain("b3");
		expect(snapshot).toContain("[...2 lines truncated...]");
		expect(snapshot).toContain("b7");
		expect(snapshot).toContain("b8");
	});

	it("preserves user messages that happen to contain --- headers", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "user",
					content: "Here is a markdown block:\n--- file.ts (10 lines) ---\nline 1\nline 2",
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).toContain("line 1");
		expect(snapshot).toContain("line 2");
		expect(snapshot).not.toContain("truncated");
	});

	it("handles string content in tool results", () => {
		const batchText = "✔ 1 read\n\n--- src/file.ts (8 lines) ---\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nl8";
		const entries = [
			{
				type: "message",
				message: {
					role: "tool",
					content: batchText,
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).toContain("l1");
		expect(snapshot).toContain("l2");
		expect(snapshot).toContain("l3");
		expect(snapshot).toContain("[...2 lines truncated...]");
		expect(snapshot).toContain("l7");
		expect(snapshot).toContain("l8");
	});

	it("compresses cwd in header to relative path", () => {
		const source = {
			getHeader: () => ({ version: 1, cwd: process.cwd() + "/subdir" }),
			getBranch: () => [],
		};
		const snapshot = buildCore2Snapshot(source);
		expect(snapshot).toContain('"cwd":"subdir"');
	});

	it("skips header injection when branch already starts with identical header", () => {
		const header = { version: 1, id: "session-1", type: "session" };
		const source = {
			getHeader: () => header,
			getBranch: () => [header, { type: "message", message: { role: "user", content: "Hi" } }],
		};
		const snapshot = buildCore2Snapshot(source);
		const parsed = parseSnapshot(snapshot);
		expect(parsed).toHaveLength(3);
		expect(parsed[0]).toMatchObject({ version: 1, type: "session" });
		expect(parsed[0]).toHaveProperty("id", "session-1");
		expect(parsed[1]).toMatchObject({ type: "message", message: { role: "system", content: expect.stringContaining("[SHARED CONTEXT]") } });
	});

	it("strips activeToolCallId matching tool call and omits empty assistant message", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "Hi" } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "active-call-1", name: "trace" }
					]
				}
			}
		];
		const snapshot = buildCore2Snapshot(makeSource(entries), { activeToolCallId: "active-call-1" });
		const parsed = parseSnapshot(snapshot);
		expect(parsed).toHaveLength(3); // header + context map + 1 message (user)
		expect(parsed[1]).toMatchObject({ type: "message", message: { role: "system", content: expect.stringContaining("[SHARED CONTEXT]") } });
		expect(parsed[2]).toMatchObject({ type: "message", message: { role: "user", content: "Hi" } });
	});

	it("strips Responses transport metadata and unmatched protocol", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Visible response" },
						{ type: "toolCall", id: "call_123|fc_123", name: "trace", arguments: {} },
					],
					api: "openai-codex-responses",
					provider: "openai-codex",
					model: "gpt-5.6-terra",
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		const parsed = parseSnapshot(snapshot);
		expect(snapshot).toContain("Visible response");
		expect(snapshot).not.toContain("call_123");
		expectProviderNeutralHistory(parsed);
	});

	it("strips transport metadata and unmatched tool_calls fields", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: "I am using tools in tool_calls",
					tool_calls: [{ id: "call_123", type: "function", function: { name: "trace", arguments: "{}" } }],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-4o",
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).toContain("I am using tools in tool_calls");
		expect(snapshot).not.toContain("call_123");
		expectProviderNeutralHistory(parseSnapshot(snapshot));
	});

	it("strips all assistant transport and response metadata", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Visible text" },
						{ type: "toolCall", id: "call_123|fc_123", name: "trace", arguments: {} },
					],
					api: "openai-codex-responses",
					provider: "openai-codex",
					model: "gpt-5.6-terra",
					cost: { input: 0.001, output: 0.002 },
					details: "some details",
					responseId: "resp-123",
					responseModel: "gpt-5.6-terra",
					timestamp: "2026-01-01T00:00:00Z",
					isError: false,
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		const parsed = parseSnapshot(snapshot);
		expect(snapshot).toContain("Visible text");
		expect(snapshot).not.toContain("resp-123");
		expectProviderNeutralHistory(parsed);
	});

	it("keeps assistant message when it contains other substance/tool calls after filtering", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "some text" },
						{ type: "toolCall", id: "active-call-1", name: "trace" }
					]
				}
			}
		];
		const snapshot = buildCore2Snapshot(makeSource(entries), { activeToolCallId: "active-call-1" });
		const parsed = parseSnapshot(snapshot);
		expect(parsed).toHaveLength(3); // header + context map + assistant message
		expect(parsed[1]).toMatchObject({ type: "message", message: { role: "system", content: expect.stringContaining("[SHARED CONTEXT]") } });
		expect(parsed[2].message.content).toHaveLength(1);
		expect(parsed[2].message.content[0]).toMatchObject({ type: "text", text: "some text" });
	});
});

// ---------------------------------------------------------------------------
// Compaction filtering tests
// ---------------------------------------------------------------------------

describe("buildCore2Snapshot — compaction filtering", () => {
	it("strips compaction_trigger entries entirely", () => {
		const entries = [
			{ type: "compaction_trigger", trigger: "manual" },
			{ type: "message", message: { role: "user", content: "Keep" } },
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		const parsed = parseSnapshot(snapshot);
		expect(parsed).toHaveLength(3); // header + context map + 1 message
		expect(parsed[1]).toMatchObject({ type: "message", message: { role: "system", content: expect.stringContaining("[SHARED CONTEXT]") } });
		expect(parsed[2]).toMatchObject({ type: "message", message: { content: "Keep" } });
		expect(snapshot).not.toContain("compaction_trigger");
	});

	it("summarizes compaction entries", () => {
		const entries = [
			{
				type: "compaction",
				summary: "Everything so far.",
				tokensBefore: 1000,
				encrypted_content: "HUGE_ENCRYPTED_BLOB",
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		const parsed = parseSnapshot(snapshot);
		expect(parsed).toHaveLength(3); // header + context map + 1 message
		expect(parsed[1]).toMatchObject({ type: "message", message: { role: "system", content: expect.stringContaining("[SHARED CONTEXT]") } });
		expect(parsed[2]).toMatchObject({
			type: "message",
			message: {
				role: "system",
				content: [{ type: "text", text: "[Context Compacted] Everything so far. (1000 tokens summarized)" }],
			},
		});
		expect(snapshot).not.toContain("HUGE_ENCRYPTED_BLOB");
	});

	it("summarizes context_compaction entries with fallback summary", () => {
		const entries = [
			{
				type: "context_compaction",
				tokensBefore: 500,
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		const parsed = parseSnapshot(snapshot);
		expect(parsed[1]).toMatchObject({ type: "message", message: { role: "system", content: expect.stringContaining("[SHARED CONTEXT]") } });
		expect(parsed[2]).toMatchObject({
			type: "message",
			message: {
				content: [{ type: "text", text: "[Context Compacted] Parent context was compacted. (500 tokens summarized)" }],
			},
		});
	});

	it("removes tool transport metadata while retaining usage and semantic history", () => {
		const entries = [
			{
				type: "message",
				id: "msg-1",
				timestamp: "2026-05-23T15:35:19.588Z",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Hello" },
						{ type: "toolCall", name: "bash", toolCallId: "bash-1", arguments: { command: "true" } },
					],
					api: "openai-completions",
					provider: "kimi-coding",
					model: "kimi-k2p6",
					usage: { input: 100, output: 200, totalTokens: 300 },
					cost: { input: 0.001, output: 0.002, total: 0.003 },
					stopReason: "stop",
					responseId: "resp-123",
					responseModel: "kimi-k2p6",
					timestamp: 1779550519587,
				},
			},
			{
				type: "message",
				id: "msg-2",
				message: {
					role: "toolResult",
					toolCallId: "bash-1",
					toolName: "bash",
					content: [{ type: "text", text: "exit 0" }],
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		const parsed = parseSnapshot(snapshot);
		const firstMessageEntry = parsed[2] as Record<string, unknown>;
		const firstMessage = firstMessageEntry.message as Record<string, unknown>;
		expect(firstMessageEntry).not.toHaveProperty("timestamp");
		expect(firstMessage.usage).toEqual({
			input: 100,
			output: 200,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 300,
		});
		expect(firstMessage).not.toHaveProperty("stopReason");
		expect(snapshot).toContain("Hello");
		expect(snapshot).toContain("Tool: bash");
		expect(snapshot).toContain("exit 0");
		expect(snapshot).not.toContain("bash-1");
		expectProviderNeutralHistory(parsed);
	});

	it("strips api, provider, and model from standard assistant replies", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Hello" }],
					api: "openai-completions",
					provider: "fireworks.ai",
					model: "kimi-k2p6-turbo",
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		const parsed = parseSnapshot(snapshot);
		const msg1 = parsed[2] as any;
		expect(msg1.message).not.toHaveProperty("api");
		expect(msg1.message).not.toHaveProperty("provider");
		expect(msg1.message).not.toHaveProperty("model");
	});

	it("strips API metadata and slims usage with snake_case fields", () => {
		const entries = [
			{
				type: "message",
				id: "msg-1",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Hello" }],
					api: "openai-completions",
					provider: "fireworks.ai",
					model: "kimi-k2p6-turbo",
					usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		const parsed = parseSnapshot(snapshot);
		const msg1 = parsed[2] as any;
		expect(msg1.message.usage).toEqual({
			input: 100,
			output: 200,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 300,
		});
	});

	it("whitelists headers and message content against unknown provider protocol shapes", () => {
		const snapshot = buildCore2Snapshot({
			getHeader: () => ({
				type: "session",
				version: 1,
				id: "safe-session",
				provider: "future-provider",
				model: "future-model",
				transportState: { resumeToken: "secret-header-token" },
			}),
			getBranch: () => [
				{
					type: "session",
					version: 1,
					id: "safe-session",
					provider: "future-provider",
					transportState: { resumeToken: "secret-branch-token" },
				},
				{ type: "vendor_transport_event", payload: "drop-root-event" },
				{ type: "message", message: { role: "vendor_tool", content: "drop-unknown-role" } },
				{
					type: "message",
					id: "safe-entry-id",
					message: {
						role: "assistant",
						id: "safe-message-id",
						content: [
							{ type: "text", text: "safe text" },
							{ type: "vendor_tool_invocation", call_id: "future-call", payload: "drop-content-block" },
						],
						provider: "future-provider",
						transportState: { opaque: "drop-message-metadata" },
					},
				},
			],
		});
		const parsed = parseSnapshot(snapshot);
		const assistantEntry = parsed.find((entry) => {
			const message = entry && typeof entry === "object" ? (entry as Record<string, unknown>).message : undefined;
			return message && typeof message === "object" && (message as Record<string, unknown>).role === "assistant";
		}) as Record<string, unknown>;

		expect(parsed[0]).toEqual({ type: "session", version: 1, id: "safe-session" });
		expect(snapshot).toContain("safe text");
		expect(snapshot).not.toContain("future-provider");
		expect(snapshot).not.toContain("future-model");
		expect(snapshot).not.toContain("secret-header-token");
		expect(snapshot).not.toContain("secret-branch-token");
		expect(snapshot).not.toContain("drop-root-event");
		expect(snapshot).not.toContain("drop-unknown-role");
		expect(snapshot).not.toContain("future-call");
		expect(snapshot).not.toContain("drop-content-block");
		expect(snapshot).not.toContain("drop-message-metadata");
		expect(assistantEntry).toEqual({
			type: "message",
			id: "safe-entry-id",
			message: {
				role: "assistant",
				id: "safe-message-id",
				content: [{ type: "text", text: "safe text" }],
			},
		});
	});
});

// ---------------------------------------------------------------------------
// Tier-based compression tests
// ---------------------------------------------------------------------------

describe("buildCore2Snapshot — tier compression", () => {
	it("lite tier strips toolResult content to placeholder", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					name: "bash",
					content: [{ type: "text", text: "long output here\nline2\nline3" }],
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries), { tier: "lite" });
		expect(snapshot).not.toContain("long output here");
		expect(snapshot).toContain("[toolResult: bash]");
	});

	it("lite tier strips tool content to placeholder", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "tool",
					content: "tool output text",
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries), { tier: "lite" });
		expect(snapshot).not.toContain("tool output text");
		expect(snapshot).toContain("[tool result omitted]");
	});

	it("lite tier keeps only the last 30 messages", () => {
		const entries = Array.from({ length: 50 }, (_, i) => ({
			type: "message",
			message: { role: "user" as const, content: `msg-${i}` },
		}));
		const snapshot = buildCore2Snapshot(makeSource(entries), { tier: "lite" });
		const parsed = parseSnapshot(snapshot);
		// header + context map + 30 messages = 32 total
		expect(parsed).toHaveLength(32);
		expect(snapshot).toContain("msg-49");
		expect(snapshot).toContain("msg-20");
		expect(snapshot).not.toContain("msg-19");
	});

	it("flash tier keeps only the last 50 messages", () => {
		const entries = Array.from({ length: 70 }, (_, i) => ({
			type: "message",
			message: { role: "user" as const, content: `msg-${i}` },
		}));
		const snapshot = buildCore2Snapshot(makeSource(entries), { tier: "flash" });
		const parsed = parseSnapshot(snapshot);
		// header + context map + 50 messages = 52 total
		expect(parsed).toHaveLength(52);
		expect(snapshot).toContain("msg-69");
		expect(snapshot).toContain("msg-20");
		expect(snapshot).not.toContain("msg-19");
	});

	it("full tier keeps only the last 80 messages", () => {
		const entries = Array.from({ length: 100 }, (_, i) => ({
			type: "message",
			message: { role: "user" as const, content: `msg-${i}` },
		}));
		const snapshot = buildCore2Snapshot(makeSource(entries), { tier: "full" });
		const parsed = parseSnapshot(snapshot);
		// header + context map + 80 messages = 82 total
		expect(parsed).toHaveLength(82);
		expect(snapshot).toContain("msg-99");
		expect(snapshot).toContain("msg-20");
		expect(snapshot).not.toContain("msg-19");
	});

	it("lite tier respects PI_FLOW_LITE_MAX_MESSAGES env override", () => {
		process.env.PI_FLOW_LITE_MAX_MESSAGES = "5";
		const entries = Array.from({ length: 10 }, (_, i) => ({
			type: "message",
			message: { role: "user" as const, content: `msg-${i}` },
		}));
		const snapshot = buildCore2Snapshot(makeSource(entries), { tier: "lite" });
		const parsed = parseSnapshot(snapshot);
		expect(parsed).toHaveLength(7); // header + context map + 5
		delete process.env.PI_FLOW_LITE_MAX_MESSAGES;
	});

	it("flash tier respects PI_FLOW_FLASH_MAX_MESSAGES env override", () => {
		process.env.PI_FLOW_FLASH_MAX_MESSAGES = "7";
		const entries = Array.from({ length: 15 }, (_, i) => ({
			type: "message",
			message: { role: "user" as const, content: `msg-${i}` },
		}));
		const snapshot = buildCore2Snapshot(makeSource(entries), { tier: "flash" });
		const parsed = parseSnapshot(snapshot);
		expect(parsed).toHaveLength(9); // header + context map + 7
		delete process.env.PI_FLOW_FLASH_MAX_MESSAGES;
	});

	it("full tier respects PI_FLOW_FULL_MAX_MESSAGES env override", () => {
		process.env.PI_FLOW_FULL_MAX_MESSAGES = "9";
		const entries = Array.from({ length: 20 }, (_, i) => ({
			type: "message",
			message: { role: "user" as const, content: `msg-${i}` },
		}));
		const snapshot = buildCore2Snapshot(makeSource(entries), { tier: "full" });
		const parsed = parseSnapshot(snapshot);
		expect(parsed).toHaveLength(11); // header + context map + 9
		delete process.env.PI_FLOW_FULL_MAX_MESSAGES;
	});

	it("flash tier strips toolResult content to placeholder", () => {
		const longText = "a".repeat(600);
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					name: "bash",
					content: [{ type: "text", text: longText }],
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries), { tier: "flash" });
		expect(snapshot).not.toContain("a".repeat(10));
		expect(snapshot).toContain("[toolResult: bash]");
	});

	it("flash tier strips tool content to placeholder", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "tool",
					content: "short",
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries), { tier: "flash" });
		expect(snapshot).not.toContain("short");
		expect(snapshot).toContain("[tool result omitted]");
	});

	it("full tier strips toolResult content to placeholder", () => {
		const longText = "b".repeat(600);
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					name: "trace",
					content: [{ type: "text", text: longText }],
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries), { tier: "full" });
		expect(snapshot).not.toContain("b".repeat(10));
		expect(snapshot).toContain("[toolResult: trace]");
	});

	it("lite tier significantly reduces snapshot size", () => {
		const entries = Array.from({ length: 40 }, (_, i) => ({
			type: "message",
			message: {
				role: i % 2 === 0 ? ("user" as const) : ("toolResult" as const),
				content:
					i % 2 === 0
						? `user message ${i}`
						: [{ type: "text" as const, text: "x".repeat(1000) }],
			},
		}));
		const fullSnapshot = buildCore2Snapshot(makeSource(entries));
		const liteSnapshot = buildCore2Snapshot(makeSource(entries), { tier: "lite" });
		expect(fullSnapshot!.length).toBeGreaterThan(liteSnapshot!.length * 2);
	});

	it("tier compression runs after sanitize and compaction", () => {
		const entries = [
			{ type: "model_change", model: "kimi" },
			{
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: "output" }],
				},
			},
		];
		const snapshot = buildCore2Snapshot(makeSource(entries), { tier: "lite" });
		expect(snapshot).not.toContain("model_change");
		expect(snapshot).not.toContain("output");
		expect(snapshot).toContain("[toolResult result omitted]");
	});

	it("lite limit preserves session header inside branchEntries", () => {
		const entries: unknown[] = [
			{ type: "session", id: "test-session", version: 1 },
			...Array.from({ length: 50 }, (_, i) => ({
				type: "message" as const,
				message: { role: "user" as const, content: `msg-${i}` },
			})),
		];
		const source = {
			getHeader: () => ({ version: 1, id: "test-session" }),
			getBranch: () => entries,
		};
		const snapshot = buildCore2Snapshot(source, { tier: "lite" });
		const parsed = parseSnapshot(snapshot);
		// Header inside branch + context map + 30 messages = 32 total
		expect(parsed).toHaveLength(32);
		expect(parsed[0]).toMatchObject({ type: "session", id: "test-session" });
		expect(snapshot).toContain("msg-49");
		expect(snapshot).toContain("msg-20");
		expect(snapshot).not.toContain("msg-19");
	});

	it("deduplicates repeated identical bash commands, keeping only the latest run's output", () => {
		const entries = [
			// Turn 1
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "npm run build" } }
					]
				}
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "bash-1",
					content: [{ type: "text", text: "first build failed" }]
				}
			},
			// Turn 2
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "bash-2", name: "bash", arguments: { command: "npm run build" } }
					]
				}
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "bash-2",
					content: [{ type: "text", text: "second build passed" }]
				}
			}
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).toContain("[Bash output omitted; re-run 1 more time]");
		expect(snapshot).toContain("second build passed");
		expect(snapshot).toContain("Tool: bash");
	});

	it("deduplicates repeated identical bash commands with count-aware placeholder for 3+ runs", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "npm test" } }
					]
				}
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "bash-1",
					content: [{ type: "text", text: "test 1" }]
				}
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "bash-2", name: "bash", arguments: { command: "npm test" } }
					]
				}
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "bash-2",
					content: [{ type: "text", text: "test 2" }]
				}
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "bash-3", name: "bash", arguments: { command: "npm test" } }
					]
				}
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "bash-3",
					content: [{ type: "text", text: "test 3" }]
				}
			}
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot.match(/\[Bash output omitted; re-run 2 more times\]/g)).toHaveLength(2);
		expect(snapshot).toContain("test 3");
		expect(snapshot.match(/Tool: bash/g)).toHaveLength(3);
	});

	it("deduplicates repeated read/write/edit operations on the same file path", () => {
		const entries = [
			// Turn 1
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "batch-1", name: "batch", arguments: { o: [{ o: "read", p: "src/a.ts" }] } }
					]
				}
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "batch-1",
					content: [{ type: "text", text: "file a content old" }]
				}
			},
			// Turn 2
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "batch-2", name: "batch", arguments: { o: [{ o: "read", p: "src/a.ts" }] } }
					]
				}
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "batch-2",
					content: [{ type: "text", text: "file a content new" }]
				}
			}
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).toContain("[File read output omitted; read 1 more time]");
		expect(snapshot).toContain("file a content new");
		expect(snapshot).toContain("Tool: batch");
	});

	it("deduplicates repeated edit operations with count-aware placeholder", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "batch-1", name: "batch", arguments: { o: [{ o: "edit", p: "src/a.ts" }] } }
					]
				}
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "batch-1",
					content: [{ type: "text", text: "edit 1" }]
				}
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "batch-2", name: "batch", arguments: { o: [{ o: "edit", p: "src/a.ts" }] } }
					]
				}
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "batch-2",
					content: [{ type: "text", text: "edit 2" }]
				}
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "batch-3", name: "batch", arguments: { o: [{ o: "edit", p: "src/a.ts" }] } }
					]
				}
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "batch-3",
					content: [{ type: "text", text: "edit 3" }]
				}
			}
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot.match(/\[File edit output omitted; edited 2 more times\]/g)).toHaveLength(2);
		expect(snapshot).toContain("edit 3");
	});

	it("deduplicates repeated write operations with count-aware placeholder", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "batch-1", name: "batch", arguments: { o: [{ o: "write", p: "src/a.ts" }] } }
					]
				}
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "batch-1",
					content: [{ type: "text", text: "write 1" }]
				}
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "batch-2", name: "batch", arguments: { o: [{ o: "write", p: "src/a.ts" }] } }
					]
				}
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "batch-2",
					content: [{ type: "text", text: "write 2" }]
				}
			}
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).toContain("[File write output omitted; written 1 more time]");
		expect(snapshot).toContain("write 2");
	});

	it("deduplicates repeated flow tool calls, keeping only the latest run's output", () => {
		const entries = [
			// Turn 1
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "flow-1", name: "flow", arguments: { flow: [{ type: "scout" }] } }
					]
				}
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "flow-1",
					content: [{ type: "text", text: "first scout result" }]
				}
			},
			// Turn 2
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "flow-2", name: "flow", arguments: { flow: [{ type: "scout" }] } }
					]
				}
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "flow-2",
					content: [{ type: "text", text: "second scout result" }]
				}
			}
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).toContain("[Flow scout output omitted; superseded by later run]");
		expect(snapshot).toContain("second scout result");
		expect(snapshot.match(/Tool: flow/g)).toHaveLength(2);
	});

	it("deduplicates multi-flow tool calls, tracking each flow type separately", () => {
		const entries = [
			// Turn 1: scout + build
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "flow-1", name: "flow", arguments: { flow: [{ type: "scout" }, { type: "build" }] } }
					]
				}
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "flow-1",
					content: [{ type: "text", text: "scout+build result" }]
				}
			},
			// Turn 2: scout only
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "flow-2", name: "flow", arguments: { flow: [{ type: "scout" }] } }
					]
				}
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "flow-2",
					content: [{ type: "text", text: "scout result 2" }]
				}
			}
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		const parsed = parseSnapshot(snapshot);
		
		// First result should be preserved because build was not superseded
		// (isLatest is true if ANY key is still the latest)
		const firstResult = parsed.find((e: any) => e.message?.content?.[0]?.text && e.message.content[0].text.includes("scout+build result")) as any;
		expect(firstResult).toBeDefined();

		// Second result should be preserved because scout is the latest for its type
		const secondResult = parsed.find((e: any) => e.message?.content?.[0]?.text && e.message.content[0].text.includes("scout result 2")) as any;
		expect(secondResult).toBeDefined();
	});

	it("deduplicates repeated trace tool calls, keeping only the latest run's output", () => {
		const entries = [
			// Turn 1
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "trace-1", name: "trace", arguments: { intent: "audit auth" } }
					]
				}
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "trace-1",
					content: [{ type: "text", text: "first audit result" }]
				}
			},
			// Turn 2
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "trace-2", name: "trace", arguments: { intent: "audit auth" } }
					]
				}
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "trace-2",
					content: [{ type: "text", text: "second audit result" }]
				}
			}
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		expect(snapshot).toContain("[Trace output omitted; superseded by later trace]");
		expect(snapshot).toContain("second audit result");
	});

	it("does not collapse trace tool calls with distinct intents", () => {
		const entries = [
			// Turn 1
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "trace-1", name: "trace", arguments: { intent: "audit auth" } }
					]
				}
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "trace-1",
					content: [{ type: "text", text: "audit auth result" }]
				}
			},
			// Turn 2
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "trace-2", name: "trace", arguments: { intent: "check routes" } }
					]
				}
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "trace-2",
					content: [{ type: "text", text: "check routes result" }]
				}
			}
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		const parsed = parseSnapshot(snapshot);

		// Both results should be preserved because intents differ
		const firstResult = parsed.find((e: any) => e.message?.content?.[0]?.text && e.message.content[0].text.includes("audit auth result")) as any;
		expect(firstResult).toBeDefined();

		const secondResult = parsed.find((e: any) => e.message?.content?.[0]?.text && e.message.content[0].text.includes("check routes result")) as any;
		expect(secondResult).toBeDefined();
	});

	it("keeps the first (and only) trace call verbatim when there is no later trace", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "trace-1", name: "trace", arguments: {} }
					]
				}
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "trace-1",
					content: [{ type: "text", text: "only trace result" }]
				}
			}
		];
		const snapshot = buildCore2Snapshot(makeSource(entries));
		const parsed = parseSnapshot(snapshot);

		const result = parsed.find((e: any) => e.message?.content?.[0]?.text && e.message.content[0].text.includes("only trace result")) as any;
		expect(result).toBeDefined();
	});
});
