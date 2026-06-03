import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { stableStringify, processFlowJsonLine, type FlowResult } from "../../src/snapshot/runner-events.js";
import { loadFlowSettings, _clearSettingsCache, flushAllSettingsCachesSync } from "../../src/config/config.js";
import { setupNotify } from "../../src/notify/notify.js";
import { resetNotifyState } from "../../src/notify/notify-state.js";
import { FLOW_DEPTH_ENV } from "../../src/flow/depth.js";
import * as childProcess from "node:child_process";

vi.mock("node:child_process", async (importOriginal) => {
	const original = (await importOriginal()) as typeof import("node:child_process");
	return {
		...original,
		execFile: vi.fn((_cmd, _args, cb) => {
			if (cb) cb(null, "" as any, "" as any);
		}),
	};
});

function createTempProject(config: object = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-caching-test-"));
	const piDir = path.join(dir, ".pi");
	mkdirSync(piDir);
	writeFileSync(path.join(piDir, "notify.json"), JSON.stringify(config));
	return dir;
}

function makeFlowResult(): FlowResult {
	return {
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, toolCalls: 0 },
	};
}

function makeMessageEndLine(content: string): string {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content,
		},
	});
}

/** Helper to trigger agent_end and extract listeners from setupNotify. */
async function triggerAgentEnd(cwd: string, hasUI = true) {
	const listeners: Record<string, Function[]> = {};
	const on = vi.fn((event: string, handler: Function) => {
		(listeners[event] ||= []).push(handler);
	});
	const pi = { on } as any;
	setupNotify(pi);

	const turnStartHandler = listeners["turn_start"]?.[0];
	if (turnStartHandler) turnStartHandler();

	const handler = listeners["agent_end"]?.[0];
	if (!handler) throw new Error("agent_end not registered");
	await handler(null, { cwd, hasUI });
}

describe("stableStringify caching", () => {
	it("P1-1: stableStringify caches repeated calls — same result on second call", () => {
		const obj = { b: 2, a: 1, c: [3, 2, 1] };
		const result1 = stableStringify(obj);
		const result2 = stableStringify(obj);
		expect(result2).toBe(result1);
		expect(result2).toBe('{"a":1,"b":2,"c":[3,2,1]}');
	});

	it("P1-2: stableStringify handles circular refs without crashing on repeated calls", () => {
		const obj: any = { a: 1 };
		obj.self = obj;
		expect(() => stableStringify(obj)).not.toThrow();
		const result1 = stableStringify(obj);
		const result2 = stableStringify(obj);
		expect(result2).toBe(result1);
		expect(result2).toContain("[Circular]");
	});

	it("P13-1: stableStringify cache hit is significantly faster on second call", () => {
		// Build a moderately large nested object to amortize stringify cost
		const obj: any = {};
		for (let i = 0; i < 200; i++) {
			obj[`key${i}`] = { nested: [i, i + 1, i + 2], flag: i % 2 === 0 };
		}

		// Warm up any JIT
		stableStringify(obj);

		const coldStart = performance.now();
		// Force a fresh object to bypass the WeakMap cache
		const freshObj = JSON.parse(JSON.stringify(obj));
		stableStringify(freshObj);
		const coldTime = performance.now() - coldStart;

		const warmStart = performance.now();
		stableStringify(freshObj);
		const warmTime = performance.now() - warmStart;

		// Cache hit should be at least 5× faster (WeakMap lookup vs full traversal)
		expect(warmTime).toBeLessThan(coldTime / 5);
	});
});

describe("seenSignaturesMap LRU eviction", () => {
	it("P8-1: addSeenSignature evicts oldest entries when exceeding 10000", () => {
		const result = makeFlowResult();

		// Seed 15000 unique assistant messages
		for (let i = 0; i < 15000; i++) {
			const line = makeMessageEndLine(`msg-${i}`);
			processFlowJsonLine(line, result);
		}

		// The first message should have been evicted, so re-adding it succeeds
		const line = makeMessageEndLine("msg-0");
		const accepted = processFlowJsonLine(line, result);
		expect(accepted).toBe(true);

		// A recent message (the last one) should still be in the set, so re-adding it fails
		const recentLine = makeMessageEndLine("msg-14999");
		const recentAccepted = processFlowJsonLine(recentLine, result);
		expect(recentAccepted).toBe(false);
	});
});

describe("settings cache", () => {
	let tmpDir: string;
	let originalHome: string | undefined;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "pi-settings-cache-test-"));
		originalHome = process.env.HOME;
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.HOME = tmpDir;
		delete process.env.PI_CODING_AGENT_DIR;
		_clearSettingsCache();
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		if (originalAgentDir !== undefined) {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		} else {
			delete process.env.PI_CODING_AGENT_DIR;
		}
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeGlobalSettings(content: Record<string, unknown>) {
		const dir = path.join(tmpDir, ".pi", "agent");
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "settings.json"), JSON.stringify(content, null, 2), "utf-8");
	}

	it("P17-1: second loadFlowSettings read does not hit disk when cached", () => {
		writeGlobalSettings({
			flowSettings: {
				toolOptimize: true,
			},
		});

		// First call: prime the cache
		const result1 = loadFlowSettings(tmpDir);
		expect(result1).toEqual({ toolOptimize: true });

		// Delete the file from disk — if the second call hits disk it will fail or return {}
		const settingsPath = path.join(tmpDir, ".pi", "agent", "settings.json");
		if (existsSync(settingsPath)) {
			rmSync(settingsPath);
		}

		// Second call: should still return the cached value
		const result2 = loadFlowSettings(tmpDir);
		expect(result2).toEqual({ toolOptimize: true });
	});
});

describe("notification config cache", () => {
	const originalPlatform = process.platform;
	let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
	let tempDir: string;
	let originalEnv: Record<string, string | undefined>;
	let originalFlowDepth: string | undefined;

	beforeEach(() => {
		originalFlowDepth = process.env[FLOW_DEPTH_ENV];
		delete process.env[FLOW_DEPTH_ENV];
		originalEnv = {
			TERM_PROGRAM: process.env.TERM_PROGRAM,
			KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID,
		};
		delete process.env.TERM_PROGRAM;
		delete process.env.KITTY_WINDOW_ID;
		Object.defineProperty(process, "platform", { value: "darwin" });
		stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.mocked(childProcess.execFile).mockClear();
		resetNotifyState();
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform });
		if (originalEnv.TERM_PROGRAM === undefined) {
			delete process.env.TERM_PROGRAM;
		} else {
			process.env.TERM_PROGRAM = originalEnv.TERM_PROGRAM;
		}
		if (originalEnv.KITTY_WINDOW_ID === undefined) {
			delete process.env.KITTY_WINDOW_ID;
		} else {
			process.env.KITTY_WINDOW_ID = originalEnv.KITTY_WINDOW_ID;
		}
		if (originalFlowDepth !== undefined) {
			process.env[FLOW_DEPTH_ENV] = originalFlowDepth;
		} else {
			delete process.env[FLOW_DEPTH_ENV];
		}
		stdoutWriteSpy.mockRestore();
		resetNotifyState();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "" as any;
		}
	});

	it("P18-1: notification config cache invalidates on mtime change", async () => {
		// Step 1: create project with bell enabled
		tempDir = createTempProject({
			channels: { terminal: false, desktop: false, bell: true, sound: false },
			enabled: true,
			onlyWhenInteractive: false,
		});

		await triggerAgentEnd(tempDir);
		// Bell should ring
		expect(stdoutWriteSpy).toHaveBeenCalledWith("\x07");

		// Step 2: overwrite config to disable bell
		writeFileSync(
			path.join(tempDir, ".pi", "notify.json"),
			JSON.stringify({
				channels: { terminal: false, desktop: false, bell: false, sound: false },
				enabled: true,
				onlyWhenInteractive: false,
			}),
		);
		// Mutate mtime so the cache invalidates
		const future = new Date(Date.now() + 10000);
		utimesSync(path.join(tempDir, ".pi", "notify.json"), future, future);

		stdoutWriteSpy.mockClear();
		await triggerAgentEnd(tempDir);
		// Bell should NOT ring because the config was re-read and bell is now false
		expect(stdoutWriteSpy).not.toHaveBeenCalledWith("\x07");
	});
});
