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

describe("runFlow TPS streaming", () => {
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

	it("includes smoothedTps in onUpdate during streaming", async () => {
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

		setTimeout(() => {
			mockProc.stdout.emit("data", Buffer.from('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"' + "a".repeat(40) + '"}}\n'));
		}, 50);

		setTimeout(() => {
			mockProc.stdout.emit("data", Buffer.from('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"' + "b".repeat(40) + '"}}\n'));
		}, 150);

		setTimeout(() => {
			mockProc.stdout.emit("data", Buffer.from('{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"done"}]}]}\n'));
			mockProc.emit("close", 0);
		}, 300);

		const result = await promise;
		console.log("Final smoothedTps:", result.usage.smoothedTps);
		console.log("All TPS values:", tpsValues);
		expect(tpsValues.some((v) => v > 0)).toBe(true);
	});
});
