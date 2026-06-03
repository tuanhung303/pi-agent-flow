import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runFlow, type RunFlowOptions } from "../../src/flow/runner.js";
import { shutdownWakeup, setupContinuation } from "../../src/flow/continuation.js";
import {
	registerChildGroup,
	unregisterChildGroup,
	terminateAllChildGroups,
	terminateChildProcess,
} from "../../src/flow/process-lifecycle.js";
import { setGoal, clearGoal, _clearStoreCache } from "../../src/flow/store.js";
import * as sessionRegistry from "../../src/flow/session-registry.js";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeMockProcess } from "./helpers.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return {
		...actual,
		spawn: vi.fn(),
	};
});

function baseOpts(onUpdate?: (partial: any) => void): RunFlowOptions {
	return {
		cwd: "/tmp",
		complexity: "snap",
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
		onUpdate,
		makeDetails: (results) => ({
			mode: "flow",
			flowStyle: "fork",
			projectAgentsDir: null,
			results,
		}),
	};
}

describe("timer cleanup", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	describe("L2-1 runner finish clears all timers", () => {
		it("leaves no lingering setInterval or setTimeout after flow completes", async () => {
			vi.useFakeTimers();
			const mockProc = makeMockProcess();
			vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

			const promise = runFlow(baseOpts());

			await vi.advanceTimersByTimeAsync(10);
			mockProc.stdout.emit(
				"data",
				Buffer.from(
					'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n',
				),
			);
			mockProc.emit("close", 0);

			await promise;

			// Advance past snap timeout (120s) + grace (18s) so any remaining
			// timers fire and self-clean via settled/didClose guards.
			await vi.advanceTimersByTimeAsync(140_000);

			expect(vi.getTimerCount()).toBe(0);
		});
	});

	describe("L2-2 runner finish removes abort handler", () => {
		it("does not fire abort handler after flow completes", async () => {
			vi.useFakeTimers();
			const mockProc = makeMockProcess();
			vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

			const controller = new AbortController();
			const opts = { ...baseOpts(), signal: controller.signal };
			const promise = runFlow(opts);

			await vi.advanceTimersByTimeAsync(10);
			mockProc.stdout.emit(
				"data",
				Buffer.from(
					'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n',
				),
			);
			mockProc.emit("close", 0);

			await promise;

			// After flow completes, abort should not trigger kill.
			controller.abort();
			expect(mockProc.kill).not.toHaveBeenCalled();
		});
	});

	describe("L2-3 render timer skips when no data (P3)", () => {
		it("does not emit additional update when no new streaming data arrives", async () => {
			vi.useFakeTimers();
			const mockProc = makeMockProcess();
			vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

			const updates: any[] = [];
			const opts = {
				...baseOpts(),
				onUpdate: (partial: any) => updates.push(partial),
			};
			const promise = runFlow(opts);

			await vi.advanceTimersByTimeAsync(10);
			// No stdout data emitted.

			const initialCount = updates.length;
			// Advance past multiple render intervals (200ms) and countdown intervals (1000ms).
			await vi.advanceTimersByTimeAsync(600);

			expect(updates.length).toBe(initialCount);

			mockProc.emit("close", 0);
			await promise;
		});
	});

	describe("L2-4 render timer fires when data arrives", () => {
		it("emits update when new streaming data arrives", async () => {
			vi.useFakeTimers();
			const mockProc = makeMockProcess();
			vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

			const updates: any[] = [];
			const opts = {
				...baseOpts(),
				onUpdate: (partial: any) => updates.push(partial),
			};
			const promise = runFlow(opts);

			await vi.advanceTimersByTimeAsync(10);
			mockProc.stdout.emit(
				"data",
				Buffer.from(
					'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}\n',
				),
			);

			const initialCount = updates.length;
			// Advance past render interval so the dirty flag triggers emitUpdate.
			await vi.advanceTimersByTimeAsync(250);

			expect(updates.length).toBeGreaterThan(initialCount);

			mockProc.emit("close", 0);
			await promise;
		});
	});

	describe("L2-5 shutdownWakeup clears interval", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-timer-cleanup-test-"),
			);
			_clearStoreCache();
		});

		afterEach(() => {
			clearGoal(tmpDir);
			_clearStoreCache();
			sessionRegistry.unregister(tmpDir);
			shutdownWakeup();
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it("removes the wakeup interval so no ticks remain", () => {
			vi.useFakeTimers();
			const mockPi = { on: vi.fn(), sendMessage: vi.fn() };
			setupContinuation(mockPi);
			expect(vi.getTimerCount()).toBeGreaterThan(0);

			shutdownWakeup();
			expect(vi.getTimerCount()).toBe(0);
		});
	});

	describe("L2-6 process-lifecycle SIGKILL timer is unref'd", () => {
		it("calls unref on the SIGKILL timer in terminateAllChildGroups", () => {
			vi.useFakeTimers();
			const unrefSpies: Array<ReturnType<typeof vi.fn>> = [];
			const originalSetTimeout = global.setTimeout;
			vi.spyOn(global, "setTimeout").mockImplementation((fn, ms) => {
				const timer = originalSetTimeout(fn as any, ms as any);
				const unrefSpy = vi.spyOn(timer as any, "unref");
				unrefSpies.push(unrefSpy);
				return timer;
			});

			registerChildGroup(12345, "test");
			terminateAllChildGroups();
			unregisterChildGroup(12345);

			expect(unrefSpies.length).toBeGreaterThan(0);
			const lastUnref = unrefSpies[unrefSpies.length - 1];
			expect(lastUnref).toHaveBeenCalled();
			vi.restoreAllMocks();
		});
	});
});
