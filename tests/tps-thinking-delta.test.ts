import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runFlow, type RunFlowOptions } from "../src/core/flow.js";
import type { FlowConfig } from "../src/core/agents.js";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return {
		...actual,
		spawn: vi.fn(),
	};
});

describe("TPS with thinking_delta", () => {
	const mockFlow: FlowConfig = {
		name: "scout",
		description: "Discovery flow",
		systemPrompt: "You are scout.",
		source: "bundled",
		filePath: "/agents/scout.md",
	};

	function makeMockProcess() {
		const proc = new EventEmitter() as any;
		proc.stdin = new EventEmitter();
		proc.stdin.end = vi.fn();
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		proc.pid = 12345;
		proc.kill = vi.fn();
		return proc;
	}

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("includes thinking_delta tokens in TPS estimation", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const tpsValues: number[] = [];

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [mockFlow],
			flowName: "scout",
			intent: "Test intent",
			aim: "Test aim",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			onUpdate: (partial) => {
				const tps = partial.details?.results[0]?.usage?.smoothedTps ?? 0;
				tpsValues.push(tps);
			},
			makeDetails: (results) => ({
				mode: "flow",
				flowStyle: "fork",
				projectAgentsDir: null,
				results,
			}),
		};

		const promise = runFlow(opts);

		// Simulate extended thinking: many thinking_delta events
		for (let i = 0; i < 10; i++) {
			setTimeout(() => {
				mockProc.stdout.emit("data", Buffer.from(JSON.stringify({
					type: "message_update",
					assistantMessageEvent: { type: "thinking_delta", delta: "thinking about this carefully...".repeat(5) },
				}) + "\n"));
			}, 10 + i * 20);
		}

		// Then a short text_delta
		setTimeout(() => {
			mockProc.stdout.emit("data", Buffer.from(JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "Done." },
			}) + "\n"));
		}, 220);

		// agent_end
		setTimeout(() => {
			mockProc.stdout.emit("data", Buffer.from(JSON.stringify({
				type: "agent_end",
				messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
			}) + "\n"));
			mockProc.emit("close", 0);
		}, 400);

		const result = await promise;
		console.log("Final smoothedTps:", result.usage.smoothedTps);
		console.log("All TPS values:", tpsValues);
		// Before the fix, thinking_delta was ignored so TPS stayed at 0.
		// After the fix, thinking tokens contribute to TPS.
		expect(tpsValues.some((v) => v > 0)).toBe(true);
	});

	it("includes toolcall_delta tokens in TPS estimation", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const tpsValues: number[] = [];

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [mockFlow],
			flowName: "scout",
			intent: "Test intent",
			aim: "Test aim",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			onUpdate: (partial) => {
				const tps = partial.details?.results[0]?.usage?.smoothedTps ?? 0;
				tpsValues.push(tps);
			},
			makeDetails: (results) => ({
				mode: "flow",
				flowStyle: "fork",
				projectAgentsDir: null,
				results,
			}),
		};

		const promise = runFlow(opts);

		// Simulate tool call argument streaming
		for (let i = 0; i < 10; i++) {
			setTimeout(() => {
				mockProc.stdout.emit("data", Buffer.from(JSON.stringify({
					type: "message_update",
					assistantMessageEvent: { type: "toolcall_delta", delta: JSON.stringify({ file_path: "/some/really/long/path/to/a/file.ts", content: "x".repeat(100) }) },
				}) + "\n"));
			}, 10 + i * 20);
		}

		// agent_end
		setTimeout(() => {
			mockProc.stdout.emit("data", Buffer.from(JSON.stringify({
				type: "agent_end",
				messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
			}) + "\n"));
			mockProc.emit("close", 0);
		}, 300);

		const result = await promise;
		console.log("Final smoothedTps (toolcall):", result.usage.smoothedTps);
		console.log("All TPS values:", tpsValues);
		expect(tpsValues.some((v) => v > 0)).toBe(true);
	});
});
