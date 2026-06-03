import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return {
		...actual,
		spawn: vi.fn(),
	};
});

import { runFlow, type RunFlowOptions } from "../../src/flow/runner.js";
import * as processLifecycle from "../../src/flow/process-lifecycle.js";
import * as sessionRegistry from "../../src/flow/session-registry.js";
import {
	setupContinuation,
	clearAllContinuationState,
	cleanupContinuationState,
	shutdownWakeup,
} from "../../src/flow/continuation.js";
import {
	setGoal,
	clearGoal,
	getGoal,
	flushAllStoreCaches,
	_clearStoreCache,
} from "../../src/flow/store.js";
import { BashProcessTracker } from "../../src/batch/batch-bash.js";
import registerExtension from "../../src/index.js";
import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function createMockPi() {
	const handlers: Record<string, Function[]> = {};
	const flags: Record<string, unknown> = {};
	const tools: any[] = [];
	return {
		registerFlag: vi.fn(),
		on: vi.fn((event, handler) => {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
		}),
		registerTool: vi.fn((tool) => {
			tools.push(tool);
		}),
		setActiveTools: vi.fn(),
		getActiveTools: vi.fn(() => [
			"read",
			"write",
			"edit",
			"bash",
			"find",
			"grep",
			"ls",
			"flow",
			"web",
		]),
		getAllTools: vi.fn(() => [
			{ name: "read" },
			{ name: "write" },
			{ name: "edit" },
			{ name: "bash" },
			{ name: "flow" },
			{ name: "web" },
		]),
		getFlag: vi.fn((name: string) => flags[name]),
		setFlag: (name: string, value: unknown) => {
			flags[name] = value;
		},
		emit: vi.fn(),
		registerCommand: vi.fn(),
		sendUserMessage: vi.fn(),
		sendMessage: vi.fn(),
		trigger: (event: string, ...args: any[]) =>
			Promise.all((handlers[event] || []).map((h) => h(...args))),
		getTool: (name: string) => tools.find((t) => t.name === name),
	};
}

function makeMockCtx(cwd: string) {
	return {
		cwd,
		sessionManager: {
			getHeader: () => ({}),
			getBranch: () => [],
			getSessionId: () => "test-session-id",
		},
		hasUI: false,
		ui: { confirm: vi.fn() },
	};
}

function makeTurnEndEvent(text: string): TurnEndEvent {
	return {
		message: {
			role: "user",
			content: [{ type: "text" as const, text }],
		},
	} as any;
}

// ---------------------------------------------------------------------------
// L1: runner process-lifecycle cleanup
// ---------------------------------------------------------------------------

describe("L1: runner process-lifecycle cleanup", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("L1-1: error handler unregisters child group", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);
		const unregisterSpy = vi.spyOn(processLifecycle, "unregisterChildGroup");

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [
				{
					name: "scout",
					description: "Explore",
					systemPrompt: "You are scout.",
					source: "bundled",
					filePath: "/agents/scout.md",
				},
			],
			flowName: "scout",
			intent: "Test",
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
		mockProc.emit("error", new Error("spawn error"));
		const result = await promise;

		expect(result.exitCode).toBe(1);
		expect(unregisterSpy).toHaveBeenCalledWith(12345);
		unregisterSpy.mockRestore();
	});

	it("L1-2: close handler unregisters child group", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);
		const unregisterSpy = vi.spyOn(processLifecycle, "unregisterChildGroup");

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [
				{
					name: "scout",
					description: "Explore",
					systemPrompt: "You are scout.",
					source: "bundled",
					filePath: "/agents/scout.md",
				},
			],
			flowName: "scout",
			intent: "Test",
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
		mockProc.emit("close", 0);
		const result = await promise;

		expect(result.exitCode).toBe(0);
		expect(unregisterSpy).toHaveBeenCalledWith(12345);
		unregisterSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// L2: session registry cleanup
// ---------------------------------------------------------------------------

describe("L2: session registry cleanup", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-agent-flow-memory-l2-"),
		);
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		sessionRegistry.unregister(tmpDir);
		_clearStoreCache();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("L2-1: session_shutdown unregisters session", async () => {
		const pi = createMockPi();
		registerExtension(pi as any);

		const unregisterSpy = vi.spyOn(sessionRegistry, "unregister");

		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));
		expect(sessionRegistry.getSessionId(tmpDir)).toBe("test-session-id");

		await pi.trigger("session_shutdown");
		expect(unregisterSpy).toHaveBeenCalledWith(tmpDir);
		expect(sessionRegistry.getSessionId(tmpDir)).toBeUndefined();

		unregisterSpy.mockRestore();
	});

	it("L2-2: duplicate session_start removed — verify only one registration per session start", async () => {
		const pi = createMockPi();
		registerExtension(pi as any);

		// Trigger session_start once
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));
		expect(sessionRegistry.getSessionId(tmpDir)).toBe("test-session-id");
		expect(sessionRegistry.getCwd()).toBe(tmpDir);

		// Trigger again with a different session ID
		const differentCtx = makeMockCtx(tmpDir);
		(differentCtx.sessionManager as any).getSessionId = () => "different-session-id";
		await pi.trigger("session_start", {}, differentCtx);

		// Registry should have exactly one entry per cwd, updated to the new session
		expect(sessionRegistry.getSessionId(tmpDir)).toBe("different-session-id");
		expect(sessionRegistry.getCwd()).toBe(tmpDir);
	});
});

// ---------------------------------------------------------------------------
// L3: continuation Maps cleanup
// ---------------------------------------------------------------------------

describe("L3: continuation Maps cleanup", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-agent-flow-memory-l3-"),
		);
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		_clearStoreCache();
		clearAllContinuationState();
		shutdownWakeup();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("L3-1: continuation Maps cleaned on goal clear", async () => {
		const pi = createMockPi();
		setupContinuation(pi as any);

		// Register session
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		// Set a goal
		setGoal(tmpDir, "test goal", { sessionId: "test-session-id" });
		await flushAllStoreCaches();

		// Trigger turn_end to establish cooldown
		await pi.trigger("turn_end", makeTurnEndEvent("hello"));
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		// Clear continuation state (simulates what /flow:goal clear does)
		clearAllContinuationState();

		// Set a new goal and trigger turn_end again — should NOT be blocked
		vi.clearAllMocks();
		setGoal(tmpDir, "test goal 2", { sessionId: "test-session-id" });
		await flushAllStoreCaches();
		await pi.trigger("turn_end", makeTurnEndEvent("hello again"));
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("L3-2: continuation Maps cleared on shutdown", async () => {
		const pi = createMockPi();
		registerExtension(pi as any);

		// Register session
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));

		// Set a goal
		setGoal(tmpDir, "test goal", { sessionId: "test-session-id" });
		await flushAllStoreCaches();

		// Trigger turn_end to establish cooldown
		await pi.trigger("turn_end", makeTurnEndEvent("hello"));
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		// Trigger session_shutdown (calls clearAllContinuationState)
		await pi.trigger("session_shutdown");

		// Re-register a new session and set a new goal
		vi.clearAllMocks();
		await pi.trigger("session_start", {}, makeMockCtx(tmpDir));
		setGoal(tmpDir, "test goal 2", { sessionId: "test-session-id" });
		await flushAllStoreCaches();

		// Trigger turn_end — should NOT be blocked by old cooldown
		await pi.trigger("turn_end", makeTurnEndEvent("hello again"));
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// L4: chunk array caps
// ---------------------------------------------------------------------------

describe("L4: chunk array caps", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("L4-1: chunk arrays capped at MAX_CHUNKS", async () => {
		const mockChild = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockChild);

		const tracker = new BashProcessTracker();
		// Use "pi" as a passthrough command so compressOutput doesn't compress
		tracker.launch("test-id", "pi", "/tmp");

		// Emit 2000 small chunks
		for (let i = 0; i < 2000; i++) {
			mockChild.stdout.emit(
				"data",
				Buffer.from(`line_${String(i).padStart(4, "0")}\n`),
			);
		}

		// Close the process
		mockChild.emit("close", 0);

		const result = tracker.popCompleted("test-id");
		expect(result).toBeDefined();
		const lines = result!.stdout.split("\n").filter((l) => l.trim());
		// With capChunks, only 1000 chunks remain. Without cap, 2000.
		// truncateBashOutput maxLines=2000, so both pass; but cap limits to 1000.
		expect(lines.length).toBeLessThanOrEqual(1000);
		expect(result!.stdout).not.toContain("line_0000");
		expect(result!.stdout).toContain("line_1999");
	});

	it("L4-2: chunk arrays capped at MAX_CHUNK_BYTES", async () => {
		const mockChild = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockChild);

		const tracker = new BashProcessTracker();
		tracker.launch("test-id", "pi", "/tmp");

		// Emit 10 chunks of ~1MB each
		const chunk = "a".repeat(1024 * 1024);
		for (let i = 0; i < 10; i++) {
			mockChild.stdout.emit("data", Buffer.from(chunk + "\n"));
		}

		// Check running tail while process is still running
		const tail = tracker.getRunningTail("test-id");
		// With cap, only ~5 chunks remain (5MB). Without cap, 10 chunks (10MB).
		// getRunningTail joins all chunks and returns last 50 lines (10 lines here).
		expect(tail.length).toBeLessThanOrEqual(5 * 1024 * 1024 + 1000);

		// Close the process
		mockChild.emit("close", 0);

		const result = tracker.popCompleted("test-id");
		expect(result).toBeDefined();
		// truncateBashOutput caps at ~50KB
		expect(result!.stdout.length).toBeLessThanOrEqual(51200 + 1000);
	});
});
