import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runFlow, getOptimizedTools, type RunFlowOptions } from "../flow.js";
import type { FlowConfig } from "../agents.js";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";

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
		name: "explore",
		description: "Discovery flow",
		systemPrompt: "You are explore.",
		source: "bundled",
		filePath: "/agents/explore.md",
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
			flowName: "EXPLORE",
			intent: "Test intent",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			makeDetails: (results) => ({
				mode: "flow",
				delegationMode: "fork",
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
		expect(result.type).toBe("explore");
		expect(result.exitCode).toBe(0);
	});

	it("returns error for unknown flow regardless of casing", async () => {
		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [mockFlow],
			flowName: "UNKNOWN",
			intent: "Test intent",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			makeDetails: (results) => ({
				mode: "flow",
				delegationMode: "fork",
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

	it("replaces read/write/edit with weave_patch when toolOptimize is true", () => {
		const tools = ["read", "write", "edit", "bash"];
		const result = getOptimizedTools(tools, true);
		expect(result).toEqual(["bash", "weave_patch"]);
	});

	it("adds weave_patch to tools without read/write/edit", () => {
		const tools = ["bash", "grep", "find"];
		const result = getOptimizedTools(tools, true);
		expect(result).toEqual(["bash", "grep", "find"]);
	});

	it("handles only read tool", () => {
		const tools = ["read", "bash"];
		const result = getOptimizedTools(tools, true);
		expect(result).toEqual(["bash", "weave_patch"]);
	});

	it("handles only write tool", () => {
		const tools = ["write"];
		const result = getOptimizedTools(tools, true);
		expect(result).toEqual(["weave_patch"]);
	});

	it("handles only edit tool", () => {
		const tools = ["edit", "bash"];
		const result = getOptimizedTools(tools, true);
		expect(result).toEqual(["bash", "weave_patch"]);
	});

	it("handles empty array", () => {
		const tools: string[] = [];
		const result = getOptimizedTools(tools, true);
		expect(result).toEqual([]);
	});

	it("does not duplicate weave_patch if already present", () => {
		const tools = ["read", "weave_patch"];
		const result = getOptimizedTools(tools, true);
		expect(result).toEqual(["weave_patch"]);
	});

	it("does not duplicate weave_patch when mixed with legacy tools", () => {
		const tools = ["read", "write", "weave_patch", "bash"];
		const result = getOptimizedTools(tools, true);
		expect(result).toEqual(["weave_patch", "bash"]);
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
			flows: [{ name: "explore", description: "Explore", systemPrompt: "You are explore.", source: "bundled", filePath: "/agents/explore.md" }],
			flowName: "explore",
			intent: "Test",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			makeDetails: (results) => ({ mode: "flow", delegationMode: "fork", projectAgentsDir: null, results }),
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
			flows: [{ name: "explore", description: "Explore", systemPrompt: "You are explore.", source: "bundled", filePath: "/agents/explore.md" }],
			flowName: "explore",
			intent: "Test",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			makeDetails: (results) => ({ mode: "flow", delegationMode: "fork", projectAgentsDir: null, results }),
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

	it("includes weave_patch when flow.tools has legacy tools and toolOptimize is true", async () => {
		const mockFlow: FlowConfig = {
			name: "code",
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
			flowName: "code",
			intent: "Test intent",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			toolOptimize: true,
			makeDetails: (results) => ({
				mode: "flow",
				delegationMode: "fork",
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
		expect(toolsValue).toContain("weave_patch");
		expect(toolsValue).not.toContain("read");
		expect(toolsValue).not.toContain("write");
		expect(toolsValue).not.toContain("edit");
	});

	it("filters out web from child flow tools", async () => {
		const mockFlow: FlowConfig = {
			name: "explore",
			description: "Explore flow",
			systemPrompt: "You are explore.",
			source: "bundled",
			filePath: "/agents/explore.md",
			tools: ["read", "bash", "flow", "web"],
		};

		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [mockFlow],
			flowName: "explore",
			intent: "Test intent",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			toolOptimize: false,
			makeDetails: (results) => ({
				mode: "flow",
				delegationMode: "fork",
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
		expect(toolsValue).not.toContain("web");
		expect(toolsValue).toContain("read");
		expect(toolsValue).toContain("bash");
		expect(toolsValue).toContain("flow");
	});

	it("defaults to weave_patch+bash+flow when flow.tools is undefined and toolOptimize is true", async () => {
		const mockFlow: FlowConfig = {
			name: "code",
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
			flowName: "code",
			intent: "Test intent",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			toolOptimize: true,
			makeDetails: (results) => ({
				mode: "flow",
				delegationMode: "fork",
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
		expect(toolsValue).toContain("weave_patch");
		expect(toolsValue).toContain("bash");
		expect(toolsValue).toContain("flow");
		expect(toolsValue).not.toContain("read");
		expect(toolsValue).not.toContain("write");
		expect(toolsValue).not.toContain("edit");
	});

	it("falls back to defaultTools when harnessTools becomes empty after web filtering", async () => {
		const mockFlow: FlowConfig = {
			name: "explore",
			description: "Explore flow",
			systemPrompt: "You are explore.",
			source: "bundled",
			filePath: "/agents/explore.md",
			tools: ["web"], // only web, which gets filtered out
		};

		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [mockFlow],
			flowName: "explore",
			intent: "Test intent",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			toolOptimize: true,
			makeDetails: (results) => ({
				mode: "flow",
				delegationMode: "fork",
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
		expect(toolsValue).toContain("weave_patch");
		expect(toolsValue).toContain("bash");
		expect(toolsValue).toContain("flow");
	});

	it("falls back to legacy defaultTools when toolOptimize is false and only web is configured", async () => {
		const mockFlow: FlowConfig = {
			name: "explore",
			description: "Explore flow",
			systemPrompt: "You are explore.",
			source: "bundled",
			filePath: "/agents/explore.md",
			tools: ["web"],
		};

		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [mockFlow],
			flowName: "explore",
			intent: "Test intent",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			toolOptimize: false,
			makeDetails: (results) => ({
				mode: "flow",
				delegationMode: "fork",
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
		expect(toolsValue).toContain("bash");
		expect(toolsValue).toContain("flow");
	});
});
