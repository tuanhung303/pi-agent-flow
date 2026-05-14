import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runFlow, getOptimizedTools, type RunFlowOptions } from "../src/flow.js";
import type { FlowConfig } from "../src/agents.js";
import type { FlowDetails } from "../src/types.js";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Mock spawn to avoid real process execution
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return {
		...actual,
		spawn: vi.fn(),
	};
});

describe("runFlow case-insensitive lookup", () => {
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

	it("finds flow by case-insensitive name", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [mockFlow],
			flowName: "SCOUT",
			intent: "Test intent",
			aim: "Test aim",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			makeDetails: (results) => ({
				mode: "flow",
				flowStyle: "fork",
				projectAgentsDir: null,
				results,
			}),
		};

		const promise = runFlow(opts);

		// Simulate process exit
		setTimeout(() => {
			mockProc.stdout.emit("data", Buffer.from('{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n'));
			mockProc.emit("close", 0);
		}, 10);

		const result = await promise;
		expect(result.type).toBe("scout");
		expect(result.exitCode).toBe(0);
	});

	it("includes long session mode and 900s budget in the child prompt", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

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
			sessionMode: "long",
			makeDetails: (results) => ({
				mode: "flow",
				flowStyle: "fork",
				projectAgentsDir: null,
				results,
			}),
		};

		const promise = runFlow(opts);
		const spawnCall = vi.mocked(childProcess.spawn).mock.calls[0];
		const args = spawnCall[1] as string[];
		const prompt = args[args.indexOf("-p") + 1];
		expect(prompt).toContain("Session mode: long. Time budget: 900s total.");
		expect((spawnCall[2] as any).env.PI_FLOW_TOOL_SUMMARY_GRACE_MS).toBe("90000");

		mockProc.emit("close", 0);
		await promise;
	});

	it("does not pass --thinking to child when flow has no thinking frontmatter", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

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
			makeDetails: (results) => ({
				mode: "flow",
				flowStyle: "fork",
				projectAgentsDir: null,
				results,
			}),
		};

		const promise = runFlow(opts);
		const spawnCall = vi.mocked(childProcess.spawn).mock.calls[0];
		const args = spawnCall[1] as string[];
		expect(args).not.toContain("--thinking");

		mockProc.emit("close", 0);
		await promise;
	});

	it("omits structured output appendix when PI_FLOW_SKIP_STRUCTURED_DIRECTIVE is set", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const prev = process.env.PI_FLOW_SKIP_STRUCTURED_DIRECTIVE;
		process.env.PI_FLOW_SKIP_STRUCTURED_DIRECTIVE = "1";
		try {
			const opts: RunFlowOptions = {
				cwd: "/tmp",
				flows: [mockFlow],
				flowName: "scout",
				intent: "Hello",
				aim: "Hello",
				forkSessionSnapshotJsonl: null,
				parentDepth: 0,
				parentFlowStack: [],
				maxDepth: 3,
				preventCycles: true,
				structuredOutput: true,
				model: "some-provider/some-model",
				makeDetails: (results) => ({
					mode: "flow",
					flowStyle: "fork",
					projectAgentsDir: null,
					results,
				}),
			};

			const promise = runFlow(opts);
			const spawnCall = vi.mocked(childProcess.spawn).mock.calls[0];
			const args = spawnCall[1] as string[];
			const prompt = args[args.indexOf("-p") + 1];
			expect(prompt).not.toContain("## Structured Output");

			mockProc.emit("close", 0);
			await promise;
		} finally {
			if (prev === undefined) delete process.env.PI_FLOW_SKIP_STRUCTURED_DIRECTIVE;
			else process.env.PI_FLOW_SKIP_STRUCTURED_DIRECTIVE = prev;
		}
	});

	it("includes structured output appendix when structuredOutput is on and env is unset", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const prev = process.env.PI_FLOW_SKIP_STRUCTURED_DIRECTIVE;
		delete process.env.PI_FLOW_SKIP_STRUCTURED_DIRECTIVE;
		try {
			const opts: RunFlowOptions = {
				cwd: "/tmp",
				flows: [mockFlow],
				flowName: "scout",
				intent: "Hello",
				aim: "Hello",
				forkSessionSnapshotJsonl: null,
				parentDepth: 0,
				parentFlowStack: [],
				maxDepth: 3,
				preventCycles: true,
				structuredOutput: true,
				model: "some-provider/some-model",
				makeDetails: (results) => ({
					mode: "flow",
					flowStyle: "fork",
					projectAgentsDir: null,
					results,
				}),
			};

			const promise = runFlow(opts);
			const spawnCall = vi.mocked(childProcess.spawn).mock.calls[0];
			const args = spawnCall[1] as string[];
			const prompt = args[args.indexOf("-p") + 1];
			expect(prompt).toContain("## Structured Output");

			mockProc.emit("close", 0);
			await promise;
		} finally {
			if (prev === undefined) delete process.env.PI_FLOW_SKIP_STRUCTURED_DIRECTIVE;
			else process.env.PI_FLOW_SKIP_STRUCTURED_DIRECTIVE = prev;
		}
	});

	it("passes --thinking only when set on flow frontmatter", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const flowWithThinking: FlowConfig = {
			...mockFlow,
			thinking: "medium",
		};

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [flowWithThinking],
			flowName: "scout",
			intent: "Test intent",
			aim: "Test aim",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			makeDetails: (results) => ({
				mode: "flow",
				flowStyle: "fork",
				projectAgentsDir: null,
				results,
			}),
		};

		const promise = runFlow(opts);
		const spawnCall = vi.mocked(childProcess.spawn).mock.calls[0];
		const args = spawnCall[1] as string[];
		const ti = args.indexOf("--thinking");
		expect(ti).not.toBe(-1);
		expect(args[ti + 1]).toBe("medium");

		mockProc.emit("close", 0);
		await promise;
	});

	it("streams cumulative text to onUpdate", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);
		const updates: string[] = [];
		const outputUpdates: number[] = [];
		const detailStreamingText: Array<string | undefined> = [];

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
				updates.push(partial.content[0]?.text || "");
				outputUpdates.push(partial.details?.results[0]?.usage.output ?? 0);
				detailStreamingText.push(partial.details?.results[0]?.streamingText);
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
			mockProc.stdout.emit("data", Buffer.from('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hel"}}\n'));
			mockProc.stdout.emit("data", Buffer.from('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"lo"}}\n'));
			mockProc.emit("close", 0);
		}, 10);

		await promise;
		expect(updates).toEqual(["Hel", "Hello"]);
		expect(outputUpdates).toEqual([0, 1]);
		expect(detailStreamingText).toEqual(["Hel", "Hello"]);
	});

	it("accumulates estimated output tokens across streaming updates", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);
		const outputUpdates: number[] = [];

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
			onUpdate: (partial) => outputUpdates.push(partial.details?.results[0]?.usage.output ?? 0),
			makeDetails: (results) => ({
				mode: "flow",
				flowStyle: "fork",
				projectAgentsDir: null,
				results,
			}),
		};

		const promise = runFlow(opts);
		setTimeout(() => {
			mockProc.stdout.emit("data", Buffer.from('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"aaaaaaaa"}}\n'));
			mockProc.stdout.emit("data", Buffer.from('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"bbbbbbbb"}}\n'));
			mockProc.emit("close", 0);
		}, 10);

		await promise;
		expect(outputUpdates).toEqual([2, 4]);
	});

	it("returns error for unknown flow regardless of casing", async () => {
		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [mockFlow],
			flowName: "UNKNOWN",
			intent: "Test intent",
			aim: "Test aim",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			makeDetails: (results) => ({
				mode: "flow",
				flowStyle: "fork",
				projectAgentsDir: null,
				results,
			}),
		};

		const result = await runFlow(opts);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Unknown flow");
		expect(result.stderr).toContain("UNKNOWN");
	});
});

describe("getOptimizedTools", () => {
	it("returns undefined when flowTools is undefined", () => {
		const result = getOptimizedTools(undefined, true);
		expect(result).toBeUndefined();
	});

	it("returns original tools when toolOptimize is false", () => {
		const tools = ["read", "write", "edit", "bash"];
		const result = getOptimizedTools(tools, false);
		expect(result).toEqual(["read", "write", "edit", "bash"]);
	});

	it("replaces read/write/edit with batch when toolOptimize is true", () => {
		const tools = ["read", "write", "edit", "bash"];
		const result = getOptimizedTools(tools, true);
		expect(result).toEqual(["bash", "batch"]);
	});

	it("adds batch to tools without read/write/edit", () => {
		const tools = ["bash", "grep", "find"];
		const result = getOptimizedTools(tools, true);
		expect(result).toEqual(["bash", "grep", "find"]);
	});

	it("handles only read tool", () => {
		const tools = ["read", "bash"];
		const result = getOptimizedTools(tools, true);
		expect(result).toEqual(["bash", "batch"]);
	});

	it("handles only write tool", () => {
		const tools = ["write"];
		const result = getOptimizedTools(tools, true);
		expect(result).toEqual(["batch"]);
	});

	it("handles only edit tool", () => {
		const tools = ["edit", "bash"];
		const result = getOptimizedTools(tools, true);
		expect(result).toEqual(["bash", "batch"]);
	});

	it("handles empty array", () => {
		const tools: string[] = [];
		const result = getOptimizedTools(tools, true);
		expect(result).toEqual([]);
	});

	it("does not duplicate batch if already present", () => {
		const tools = ["read", "batch"];
		const result = getOptimizedTools(tools, true);
		expect(result.filter((t) => t === "batch")).toHaveLength(1);
		expect(result).toEqual(["batch"]);
	});

	it("does not duplicate batch when mixed with legacy tools", () => {
		const tools = ["read", "write", "batch", "bash"];
		const result = getOptimizedTools(tools, true);
		expect(result.filter((t) => t === "batch")).toHaveLength(1);
		expect(result).toEqual(["bash", "batch"]);
	});

	it("preserves batch_read when no legacy tools", () => {
		const tools = ["batch_read", "bash", "find", "grep", "ls"];
		const result = getOptimizedTools(tools, true);
		expect(result).toEqual(["batch_read", "bash", "find", "grep", "ls"]);
	});

	it("replaces legacy tools with batch and removes batch_read if mixed", () => {
		const tools = ["read", "batch_read", "bash"];
		const result = getOptimizedTools(tools, true);
		expect(result).toEqual(["bash", "batch"]);
		expect(result).not.toContain("batch_read");
	});
});



describe("agent_end grace period behavior", () => {
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
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("after agent_end grace, does NOT remove stdout listeners or terminate child", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [{ name: "scout", description: "Explore", systemPrompt: "You are scout.", source: "bundled", filePath: "/agents/scout.md" }],
			flowName: "scout",
			intent: "Test",
			aim: "Test aim",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			makeDetails: (results) => ({ mode: "flow", flowStyle: "fork", projectAgentsDir: null, results }),
		};

		const promise = runFlow(opts);

		// Emit agent_end to trigger sawAgentEnd
		await vi.advanceTimersByTimeAsync(10);
		mockProc.stdout.emit("data", Buffer.from('{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"done"}]}]}\n'));

		// Advance past the 2000ms grace period
		await vi.advanceTimersByTimeAsync(2500);

		// stdout listeners should still be attached (not removed)
		const stdoutListeners = mockProc.stdout.listeners("data");
		expect(stdoutListeners.length).toBeGreaterThan(0);

		// kill should NOT have been called (no terminateChild)
		expect(mockProc.kill).not.toHaveBeenCalled();

		// Now close the process naturally
		mockProc.emit("close", 0);

		const result = await promise;
		expect(result.exitCode).toBe(0);
	});

	it("still drains buffer on agent_end grace timeout", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [{ name: "scout", description: "Explore", systemPrompt: "You are scout.", source: "bundled", filePath: "/agents/scout.md" }],
			flowName: "scout",
			intent: "Test",
			aim: "Test aim",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			makeDetails: (results) => ({ mode: "flow", flowStyle: "fork", projectAgentsDir: null, results }),
		};

		const promise = runFlow(opts);

		// Emit agent_end
		await vi.advanceTimersByTimeAsync(10);
		mockProc.stdout.emit("data", Buffer.from('{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"final"}]}]}\n'));

		// Advance past grace
		await vi.advanceTimersByTimeAsync(2500);

		// Close process
		mockProc.emit("close", 0);

		const result = await promise;
		expect(result.exitCode).toBe(0);
		expect(result.messages).toHaveLength(1);
	});
});

describe("child flow harness tools", () => {
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

	it("includes batch when flow.tools has legacy tools and toolOptimize is true", async () => {
		const mockFlow: FlowConfig = {
			name: "build",
			description: "Code flow",
			systemPrompt: "You are code.",
			source: "bundled",
			filePath: "/agents/code.md",
			tools: ["read", "write", "edit", "bash", "flow"],
		};

		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [mockFlow],
			flowName: "build",
			intent: "Test intent",
			aim: "Test aim",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			toolOptimize: true,
			makeDetails: (results) => ({
				mode: "flow",
				flowStyle: "fork",
				projectAgentsDir: null,
				results,
			}),
		};

		const promise = runFlow(opts);
		setTimeout(() => {
			mockProc.stdout.emit("data", Buffer.from('{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n'));
			mockProc.emit("close", 0);
		}, 10);

		await promise;

		const spawnCall = vi.mocked(childProcess.spawn).mock.calls[0];
		const args = spawnCall[1] as string[];
		const toolsIndex = args.indexOf("--tools");
		expect(toolsIndex).toBeGreaterThan(-1);
		const toolsValue = args[toolsIndex + 1];
		expect(toolsValue).toContain("batch");
		expect(toolsValue).not.toContain("read");
		expect(toolsValue).not.toContain("write");
		expect(toolsValue).not.toContain("edit");
	});

	it("passes web tool through to child flow tools", async () => {
		const mockFlow: FlowConfig = {
			name: "build",
			description: "Code flow",
			systemPrompt: "You are code.",
			source: "bundled",
			filePath: "/agents/code.md",
			tools: ["read", "bash", "flow", "web"],
		};

		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [mockFlow],
			flowName: "build",
			intent: "Test intent",
			aim: "Test aim",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			toolOptimize: false,
			makeDetails: (results) => ({
				mode: "flow",
				flowStyle: "fork",
				projectAgentsDir: null,
				results,
			}),
		};

		const promise = runFlow(opts);
		setTimeout(() => {
			mockProc.stdout.emit("data", Buffer.from('{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n'));
			mockProc.emit("close", 0);
		}, 10);

		await promise;

		const spawnCall = vi.mocked(childProcess.spawn).mock.calls[0];
		const args = spawnCall[1] as string[];
		const toolsIndex = args.indexOf("--tools");
		expect(toolsIndex).toBeGreaterThan(-1);
		const toolsValue = args[toolsIndex + 1];
		expect(toolsValue).toContain("web");
		expect(toolsValue).toContain("read");
		expect(toolsValue).toContain("bash");
		expect(toolsValue).toContain("flow");
	});

	it("defaults to batch+bash+flow+web when flow.tools is undefined, toolOptimize is true, and canFlow", async () => {
		const mockFlow: FlowConfig = {
			name: "build",
			description: "Code flow",
			systemPrompt: "You are code.",
			source: "bundled",
			filePath: "/agents/code.md",
			// no tools field
		};

		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [mockFlow],
			flowName: "build",
			intent: "Test intent",
			aim: "Test aim",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			toolOptimize: true,
			makeDetails: (results) => ({
				mode: "flow",
				flowStyle: "fork",
				projectAgentsDir: null,
				results,
			}),
		};

		const promise = runFlow(opts);
		setTimeout(() => {
			mockProc.stdout.emit("data", Buffer.from('{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n'));
			mockProc.emit("close", 0);
		}, 10);

		await promise;

		const spawnCall = vi.mocked(childProcess.spawn).mock.calls[0];
		const args = spawnCall[1] as string[];
		const toolsIndex = args.indexOf("--tools");
		expect(toolsIndex).toBeGreaterThan(-1);
		const toolsValue = args[toolsIndex + 1];
		expect(toolsValue).toContain("batch");
		expect(toolsValue).toContain("bash");
		expect(toolsValue).toContain("flow");
		expect(toolsValue).toContain("web");
		expect(toolsValue).not.toContain("read");
		expect(toolsValue).not.toContain("write");
		expect(toolsValue).not.toContain("edit");
	});

	it("defaults to batch+bash+web without flow when canFlow is false and toolOptimize is true", async () => {
		const mockFlow: FlowConfig = {
			name: "build",
			description: "Code flow",
			systemPrompt: "You are code.",
			source: "bundled",
			filePath: "/agents/code.md",
		};

		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [mockFlow],
			flowName: "build",
			intent: "Test intent",
			aim: "Test aim",
			forkSessionSnapshotJsonl: null,
			parentDepth: 2,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			toolOptimize: true,
			makeDetails: (results) => ({
				mode: "flow",
				flowStyle: "fork",
				projectAgentsDir: null,
				results,
			}),
		};

		const promise = runFlow(opts);
		setTimeout(() => {
			mockProc.stdout.emit("data", Buffer.from('{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n'));
			mockProc.emit("close", 0);
		}, 10);

		await promise;

		const spawnCall = vi.mocked(childProcess.spawn).mock.calls[0];
		const args = spawnCall[1] as string[];
		const toolsIndex = args.indexOf("--tools");
		expect(toolsIndex).toBeGreaterThan(-1);
		const toolsValue = args[toolsIndex + 1];
		expect(toolsValue).toContain("batch");
		expect(toolsValue).toContain("bash");
		expect(toolsValue).toContain("web");
		expect(toolsValue).not.toContain("flow");
	});

	it("falls back to defaultTools when harnessTools becomes empty after optimization", async () => {
		const mockFlow: FlowConfig = {
			name: "build",
			description: "Code flow",
			systemPrompt: "You are code.",
			source: "bundled",
			filePath: "/agents/code.md",
			tools: [], // empty tools triggers fallback
		};

		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [mockFlow],
			flowName: "build",
			intent: "Test intent",
			aim: "Test aim",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			toolOptimize: true,
			makeDetails: (results) => ({
				mode: "flow",
				flowStyle: "fork",
				projectAgentsDir: null,
				results,
			}),
		};

		const promise = runFlow(opts);
		setTimeout(() => {
			mockProc.stdout.emit("data", Buffer.from('{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n'));
			mockProc.emit("close", 0);
		}, 10);

		await promise;

		const spawnCall = vi.mocked(childProcess.spawn).mock.calls[0];
		const args = spawnCall[1] as string[];
		const toolsIndex = args.indexOf("--tools");
		expect(toolsIndex).toBeGreaterThan(-1);
		const toolsValue = args[toolsIndex + 1];
		expect(toolsValue).not.toBe("");
		expect(toolsValue).toContain("batch");
		expect(toolsValue).toContain("bash");
		expect(toolsValue).toContain("flow");
		expect(toolsValue).toContain("web");
	});

	it("falls back to defaultTools when toolOptimize is false and tools list is empty", async () => {
		const mockFlow: FlowConfig = {
			name: "build",
			description: "Code flow",
			systemPrompt: "You are code.",
			source: "bundled",
			filePath: "/agents/code.md",
			tools: [], // empty tools triggers fallback
		};

		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [mockFlow],
			flowName: "build",
			intent: "Test intent",
			aim: "Test aim",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			toolOptimize: false,
			makeDetails: (results) => ({
				mode: "flow",
				flowStyle: "fork",
				projectAgentsDir: null,
				results,
			}),
		};

		const promise = runFlow(opts);
		setTimeout(() => {
			mockProc.stdout.emit("data", Buffer.from('{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n'));
			mockProc.emit("close", 0);
		}, 10);

		await promise;

		const spawnCall = vi.mocked(childProcess.spawn).mock.calls[0];
		const args = spawnCall[1] as string[];
		const toolsIndex = args.indexOf("--tools");
		expect(toolsIndex).toBeGreaterThan(-1);
		const toolsValue = args[toolsIndex + 1];
		expect(toolsValue).not.toBe("");
		expect(toolsValue).toContain("read");
		expect(toolsValue).toContain("write");
		expect(toolsValue).toContain("edit");
		expect(toolsValue).toContain("batch");
		expect(toolsValue).toContain("bash");
		expect(toolsValue).toContain("flow");
		expect(toolsValue).toContain("web");
	});

	it("merges defaultTools when flow.tools has only non-essential tools (e.g. just web)", async () => {
		const mockFlow: FlowConfig = {
			name: "build",
			description: "Code flow",
			systemPrompt: "You are code.",
			source: "bundled",
			filePath: "/agents/code.md",
			tools: ["web"], // only non-essential tool — triggers hasEssentials fallback
		};

		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [mockFlow],
			flowName: "build",
			intent: "Test intent",
			aim: "Test aim",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			toolOptimize: true,
			makeDetails: (results) => ({
				mode: "flow",
				flowStyle: "fork",
				projectAgentsDir: null,
				results,
			}),
		};

		const promise = runFlow(opts);
		setTimeout(() => {
			mockProc.stdout.emit("data", Buffer.from('{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n'));
			mockProc.emit("close", 0);
		}, 10);

		await promise;

		const spawnCall = vi.mocked(childProcess.spawn).mock.calls[0];
		const args = spawnCall[1] as string[];
		const toolsIndex = args.indexOf("--tools");
		expect(toolsIndex).toBeGreaterThan(-1);
		const toolsValue = args[toolsIndex + 1];
		// Essential tools must be present from defaultTools
		expect(toolsValue).toContain("batch");
		expect(toolsValue).toContain("bash");
		expect(toolsValue).toContain("flow");
		expect(toolsValue).toContain("web");
		// The original "web" tool is preserved (not dropped)
		const toolsList = toolsValue.split(",");
		expect(toolsList.filter((t) => t === "web")).toHaveLength(1);
	});
});

describe("PI_FLOW_SPAWN_COMMAND env override", () => {
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
		delete process.env["PI_FLOW_SPAWN_COMMAND"];
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env["PI_FLOW_SPAWN_COMMAND"];
	});

	it("uses PI_FLOW_SPAWN_COMMAND when set", async () => {
		process.env["PI_FLOW_SPAWN_COMMAND"] = "/custom/pi";
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

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
			makeDetails: (results) => ({ mode: "flow", flowStyle: "fork", projectAgentsDir: null, results }),
		};

		const promise = runFlow(opts);
		setTimeout(() => {
			mockProc.stdout.emit("data", Buffer.from('{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"done"}]}]}\n'));
			mockProc.emit("close", 0);
		}, 10);

		await promise;
		const spawnCall = vi.mocked(childProcess.spawn).mock.calls[0];
		expect(spawnCall[0]).toBe("/custom/pi");
	});
});

describe("timeout two-stage behavior", () => {
	function makeMockProcess() {
		const proc = new EventEmitter() as any;
		proc.stdin = new EventEmitter();
		proc.stdin.end = vi.fn();
		proc.stdin.write = vi.fn();
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		proc.pid = 12345;
		proc.kill = vi.fn();
		return proc;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("emits live countdown metadata for rendering", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);
		vi.setSystemTime(new Date("2026-05-07T00:00:00.000Z"));
		const updates: Array<import("@mariozechner/pi-agent-core").AgentToolResult<FlowDetails>> = [];

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [{ name: "scout", description: "Explore", systemPrompt: "You are scout.", source: "bundled", filePath: "/agents/scout.md" }],
			flowName: "scout",
			intent: "Test",
			aim: "Test aim",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			sessionMode: "fast",
			onUpdate: (partial) => updates.push(partial),
			makeDetails: (results) => ({ mode: "flow", flowStyle: "fork", projectAgentsDir: null, results }),
		};

		const startedAtMs = Date.now();
		const promise = runFlow(opts);
		const spawnCall = vi.mocked(childProcess.spawn).mock.calls[0];
		expect((spawnCall[2] as any).env.PI_FLOW_DEADLINE_MS).toBe(String(startedAtMs + 300_000));

		await vi.advanceTimersByTimeAsync(1_000);
		expect(updates.length).toBeGreaterThan(0);
		const firstResult = updates[0].details?.results[0];
		expect(firstResult?.startedAtMs).toBe(startedAtMs);
		expect(firstResult?.deadlineAtMs).toBe(startedAtMs + 300_000);

		mockProc.emit("close", 0);
		await promise;
	});

	it("sends final urge message 135s before timeout", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [{ name: "scout", description: "Explore", systemPrompt: "You are scout.", source: "bundled", filePath: "/agents/scout.md" }],
			flowName: "scout",
			intent: "Test",
			aim: "Test aim",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			sessionMode: "fast",
			makeDetails: (results) => ({ mode: "flow", flowStyle: "fork", projectAgentsDir: null, results }),
		};

		const promise = runFlow(opts);

		// stdin should be ended immediately after spawn so the child doesn't hang
		expect(mockProc.stdin.end).toHaveBeenCalledTimes(1);
		const spawnCall = vi.mocked(childProcess.spawn).mock.calls[0];
		const args = spawnCall[1] as string[];
		const prompt = args[args.indexOf("-p") + 1];
		expect(prompt).toContain("Session mode: fast. Time budget: 300s total.");
		expect(prompt).toContain("Long-running tools may be interrupted near the deadline");
		expect(prompt).toContain("output structured findings immediately");
		expect((spawnCall[2] as any).env.PI_FLOW_TOOL_SUMMARY_GRACE_MS).toBe("30000");

		// Advance to 135s before timeout (165s elapsed, urge fires here)
		await vi.advanceTimersByTimeAsync(165_000);
		expect(mockProc.stdin.write).not.toHaveBeenCalled();
		expect(mockProc.kill).not.toHaveBeenCalled();

		// Advance another 15s to 180s (well past the urge timer)
		await vi.advanceTimersByTimeAsync(15_000);
		expect(mockProc.stdin.write).not.toHaveBeenCalled();
		expect(mockProc.kill).not.toHaveBeenCalled();

		// Now advance past the urge timer
		await vi.advanceTimersByTimeAsync(1);

		// Still shouldn't have killed or written stdin
		expect(mockProc.stdin.write).not.toHaveBeenCalled();
		expect(mockProc.kill).not.toHaveBeenCalled();

		// Complete the flow so the promise resolves
		mockProc.emit("close", 0);
		await promise;
	});

	it("waits for grace period before killing on timeout", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [{ name: "scout", description: "Explore", systemPrompt: "You are scout.", source: "bundled", filePath: "/agents/scout.md" }],
			flowName: "scout",
			intent: "Test",
			aim: "Test aim",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			sessionMode: "fast",
			makeDetails: (results) => ({ mode: "flow", flowStyle: "fork", projectAgentsDir: null, results }),
		};

		const promise = runFlow(opts);

		// stdin should be ended immediately after spawn
		expect(mockProc.stdin.end).toHaveBeenCalledTimes(1);

		// Advance past timeout
		await vi.advanceTimersByTimeAsync(300_000);

		// Should NOT have killed yet (grace period)
		expect(mockProc.kill).not.toHaveBeenCalled();

		// Advance into grace period but not past it
		await vi.advanceTimersByTimeAsync(5_000);
		expect(mockProc.kill).not.toHaveBeenCalled();

		// Advance past grace period (90s now)
		await vi.advanceTimersByTimeAsync(85_000);
		expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");

		// Simulate process death after SIGKILL timeout
		await vi.advanceTimersByTimeAsync(8_000);
		mockProc.emit("close", null);
		const result = await promise;
		expect(result.stopReason).toBe("timeout");
		expect(result.errorMessage).toContain("timed out");
	});

	it("does not kill if child exits gracefully during grace period", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [{ name: "scout", description: "Explore", systemPrompt: "You are scout.", source: "bundled", filePath: "/agents/scout.md" }],
			flowName: "scout",
			intent: "Test",
			aim: "Test aim",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			sessionMode: "fast",
			makeDetails: (results) => ({ mode: "flow", flowStyle: "fork", projectAgentsDir: null, results }),
		};

		const promise = runFlow(opts);

		// stdin should be ended immediately after spawn
		expect(mockProc.stdin.end).toHaveBeenCalledTimes(1);

		// Advance past timeout
		await vi.advanceTimersByTimeAsync(300_000);
		expect(mockProc.kill).not.toHaveBeenCalled();

		// Child exits during grace period
		await vi.advanceTimersByTimeAsync(3_000);
		mockProc.emit("close", 0);

		const result = await promise;
		expect(mockProc.kill).not.toHaveBeenCalled();
		expect(result.exitCode).toBe(0);
		expect(result.stopReason).not.toBe("timeout");
	});
});

describe("acceptance field propagation", () => {
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

	it("includes Acceptance line in mission when acceptance is provided", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [mockFlow],
			flowName: "scout",
			intent: "Test intent",
			aim: "Test aim",
			acceptance: "Done when all tests pass",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			makeDetails: (results) => ({
				mode: "flow",
				flowStyle: "fork",
				projectAgentsDir: null,
				results,
			}),
		};

		const promise = runFlow(opts);
		const spawnCall = vi.mocked(childProcess.spawn).mock.calls[0];
		const args = spawnCall[1] as string[];
		const prompt = args[args.indexOf("-p") + 1];

		expect(prompt).toContain("<mission>");
		expect(prompt).toContain("Acceptance: Done when all tests pass");
		expect(prompt).toContain("</mission>");

		mockProc.emit("close", 0);
		await promise;
	});

	it("omits Acceptance line when acceptance is not provided", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

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
			makeDetails: (results) => ({
				mode: "flow",
				flowStyle: "fork",
				projectAgentsDir: null,
				results,
			}),
		};

		const promise = runFlow(opts);
		const spawnCall = vi.mocked(childProcess.spawn).mock.calls[0];
		const args = spawnCall[1] as string[];
		const prompt = args[args.indexOf("-p") + 1];

		expect(prompt).toContain("<mission>");
		expect(prompt).not.toContain("Acceptance:");

		mockProc.emit("close", 0);
		await promise;
	});

	it("dumps snapshot and prompt to file when PI_FLOW_DUMP_SNAPSHOT is set", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const dumpFile = path.join(os.tmpdir(), `pi-flow-dump-test-${Date.now()}.md`);
		const prev = process.env.PI_FLOW_DUMP_SNAPSHOT;
		process.env.PI_FLOW_DUMP_SNAPSHOT = dumpFile;
		try {
			const jsonl = '{"type":"header","systemPrompt":"test"}\n{"type":"message","message":{"role":"user","content":"hello"}}\n';
			const opts: RunFlowOptions = {
				cwd: "/tmp",
				flows: [mockFlow],
				flowName: "scout",
				intent: "Test intent",
				aim: "Test aim",
				forkSessionSnapshotJsonl: jsonl,
				parentDepth: 0,
				parentFlowStack: [],
				maxDepth: 3,
				preventCycles: true,
				makeDetails: (results) => ({
					mode: "flow",
					flowStyle: "fork",
					projectAgentsDir: null,
					results,
				}),
			};

			const promise = runFlow(opts);
			setTimeout(() => {
				mockProc.stdout.emit("data", Buffer.from('{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n'));
				mockProc.emit("close", 0);
			}, 10);

			await promise;
			const dumped = fs.readFileSync(dumpFile, "utf-8");
			expect(dumped).toContain("## Session Snapshot (JSONL)");
			expect(dumped).toContain("## Activation Prompt (-p)");
			expect(dumped).toContain('"type":"header"');
			expect(dumped).toContain("<activation flow=\"scout\"");
		} finally {
			if (prev === undefined) delete process.env.PI_FLOW_DUMP_SNAPSHOT;
			else process.env.PI_FLOW_DUMP_SNAPSHOT = prev;
			try { fs.unlinkSync(dumpFile); } catch { /* ignore */ }
		}
	});

	it("does not dump when PI_FLOW_DUMP_SNAPSHOT is unset", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const dumpFile = path.join(os.tmpdir(), `pi-flow-dump-test-missing-${Date.now()}.md`);
		const prev = process.env.PI_FLOW_DUMP_SNAPSHOT;
		delete process.env.PI_FLOW_DUMP_SNAPSHOT;
		try {
			const jsonl = '{"type":"header","systemPrompt":"test"}\n';
			const opts: RunFlowOptions = {
				cwd: "/tmp",
				flows: [mockFlow],
				flowName: "scout",
				intent: "Test intent",
				aim: "Test aim",
				forkSessionSnapshotJsonl: jsonl,
				parentDepth: 0,
				parentFlowStack: [],
				maxDepth: 3,
				preventCycles: true,
				makeDetails: (results) => ({
					mode: "flow",
					flowStyle: "fork",
					projectAgentsDir: null,
					results,
				}),
			};

			const promise = runFlow(opts);
			setTimeout(() => {
				mockProc.stdout.emit("data", Buffer.from('{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n'));
				mockProc.emit("close", 0);
			}, 10);

			await promise;
			expect(fs.existsSync(dumpFile)).toBe(false);
		} finally {
			if (prev === undefined) delete process.env.PI_FLOW_DUMP_SNAPSHOT;
			else process.env.PI_FLOW_DUMP_SNAPSHOT = prev;
		}
	});

	it("omits Acceptance line when acceptance is empty string", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [mockFlow],
			flowName: "scout",
			intent: "Test intent",
			aim: "Test aim",
			acceptance: "",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			makeDetails: (results) => ({
				mode: "flow",
				flowStyle: "fork",
				projectAgentsDir: null,
				results,
			}),
		};

		const promise = runFlow(opts);
		const spawnCall = vi.mocked(childProcess.spawn).mock.calls[0];
		const args = spawnCall[1] as string[];
		const prompt = args[args.indexOf("-p") + 1];

		expect(prompt).toContain("<mission>");
		expect(prompt).not.toContain("Acceptance:");

		mockProc.emit("close", 0);
		await promise;
	});
});
