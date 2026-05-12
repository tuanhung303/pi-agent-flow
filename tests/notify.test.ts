import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { FLOW_DEPTH_ENV } from "../src/depth.js";
import { resetNotifyState, setPendingDecision, setFlowComplete } from "../src/notify-state.js";

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
	const dir = mkdtempSync(path.join(tmpdir(), "pi-notify-test-"));
	const piDir = path.join(dir, ".pi");
	mkdirSync(piDir);
	writeFileSync(path.join(piDir, "notify.json"), JSON.stringify(config));
	return dir;
}

describe("setupNotify depth guard", () => {
	const originalEnv = process.env[FLOW_DEPTH_ENV];

	beforeEach(() => {
		delete process.env[FLOW_DEPTH_ENV];
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env[FLOW_DEPTH_ENV];
		} else {
			process.env[FLOW_DEPTH_ENV] = originalEnv;
		}
	});

	it("registers agent_end and turn_start listeners when depth is 0 (root orchestrator)", async () => {
		process.env[FLOW_DEPTH_ENV] = "0";
		const { setupNotify } = await import("../src/notify.js");
		const on = vi.fn();
		const pi = { on } as any;
		setupNotify(pi);
		expect(on).toHaveBeenCalledWith("agent_end", expect.any(Function));
		expect(on).toHaveBeenCalledWith("turn_start", expect.any(Function));
	});

	it("registers agent_end and turn_start listeners when PI_FLOW_DEPTH is unset", async () => {
		delete process.env[FLOW_DEPTH_ENV];
		const { setupNotify } = await import("../src/notify.js");
		const on = vi.fn();
		const pi = { on } as any;
		setupNotify(pi);
		expect(on).toHaveBeenCalledWith("agent_end", expect.any(Function));
		expect(on).toHaveBeenCalledWith("turn_start", expect.any(Function));
	});

	it("skips registering agent_end listener when depth > 0 (child flow)", async () => {
		process.env[FLOW_DEPTH_ENV] = "1";
		const { setupNotify } = await import("../src/notify.js");
		const on = vi.fn();
		const pi = { on } as any;
		setupNotify(pi);
		expect(on).not.toHaveBeenCalled();
	});

	it("skips registering agent_end listener for deeper nesting (depth=2)", async () => {
		process.env[FLOW_DEPTH_ENV] = "2";
		const { setupNotify } = await import("../src/notify.js");
		const on = vi.fn();
		const pi = { on } as any;
		setupNotify(pi);
		expect(on).not.toHaveBeenCalled();
	});

	it("treats invalid PI_FLOW_DEPTH as 0 (registers listener)", async () => {
		process.env[FLOW_DEPTH_ENV] = "abc";
		const { setupNotify } = await import("../src/notify.js");
		const on = vi.fn();
		const pi = { on } as any;
		setupNotify(pi);
		expect(on).toHaveBeenCalledWith("agent_end", expect.any(Function));
	});
});

describe("setupNotify dynamic content", () => {
	const originalPlatform = process.platform;
	let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
	let tempDir: string;

	beforeEach(() => {
		delete process.env[FLOW_DEPTH_ENV];
		delete process.env.TERM_PROGRAM;
		delete process.env.KITTY_WINDOW_ID;
		Object.defineProperty(process, "platform", { value: "darwin" });
		stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.mocked(childProcess.execFile).mockClear();
		resetNotifyState();
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform });
		delete process.env.TERM_PROGRAM;
		delete process.env.KITTY_WINDOW_ID;
		stdoutWriteSpy.mockRestore();
		resetNotifyState();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "" as any;
		}
	});

	async function triggerAgentEnd(cwd: string, setupState?: () => void) {
		const { setupNotify } = await import("../src/notify.js");
		const listeners: Record<string, Function[]> = {};
		const on = vi.fn((event: string, handler: Function) => {
			(listeners[event] ||= []).push(handler);
		});
		const pi = { on } as any;
		setupNotify(pi);

		// Simulate turn_start reset (clears stale state from previous turn)
		const turnStartHandler = listeners["turn_start"]?.[0];
		if (turnStartHandler) turnStartHandler();

		// In real usage, tools set state DURING the turn (after turn_start, before agent_end).
		// The optional callback simulates that phase.
		if (setupState) setupState();

		const handler = listeners["agent_end"]?.[0];
		if (!handler) throw new Error("agent_end not registered");
		await handler(null, { cwd, hasUI: true });
	}

	it("shows 'Ready for next steps!' when no flows and no ask_user", async () => {
		tempDir = createTempProject();
		await triggerAgentEnd(tempDir);
		expect(stdoutWriteSpy).toHaveBeenCalledWith(
			expect.stringContaining("Ready for next steps!"),
		);
	});

	it("shows 'Need your decision!' when ask_user was invoked", async () => {
		tempDir = createTempProject();
		await triggerAgentEnd(tempDir, () => setPendingDecision());
		expect(stdoutWriteSpy).toHaveBeenCalledWith(
			expect.stringContaining("Need your decision!"),
		);
	});

	it("shows acceptance and 'finished.' when flow has acceptance", async () => {
		tempDir = createTempProject();
		await triggerAgentEnd(tempDir, () => setFlowComplete("build", "All tests pass", 0, 1));
		expect(stdoutWriteSpy).toHaveBeenCalledWith(
			expect.stringContaining("All tests pass — finished."),
		);
	});

	it("shows flow name and 'finished.' when flow has no acceptance", async () => {
		tempDir = createTempProject();
		await triggerAgentEnd(tempDir, () => setFlowComplete("scout", undefined, 0, 1));
		expect(stdoutWriteSpy).toHaveBeenCalledWith(
			expect.stringContaining("scout finished."),
		);
	});

	it("ask_user takes priority over flow results", async () => {
		tempDir = createTempProject();
		await triggerAgentEnd(tempDir, () => {
			setFlowComplete("scout", "Mapped codebase", 0, 1);
			setPendingDecision();
		});
		expect(stdoutWriteSpy).toHaveBeenCalledWith(
			expect.stringContaining("Need your decision!"),
		);
	});

	it("includes 'Decision Required' in title for ask_user on desktop", async () => {
		tempDir = createTempProject({ channels: { terminal: false, desktop: true, bell: false, sound: false } });
		setPendingDecision();
		const { setupNotify } = await import("../src/notify.js");
		const listeners: Record<string, Function[]> = {};
		const on = vi.fn((event: string, handler: Function) => {
			(listeners[event] ||= []).push(handler);
		});
		const pi = { on } as any;
		setupNotify(pi);
		const handler = listeners["agent_end"]?.[0];
		if (!handler) throw new Error("agent_end not registered");
		await handler(null, { cwd: tempDir, hasUI: true });
		expect(childProcess.execFile).toHaveBeenCalledWith(
			"osascript",
			expect.arrayContaining([expect.stringContaining("Decision Required")]),
			expect.any(Function),
		);
	});
});

describe("setupNotify deduplication", () => {
	const originalPlatform = process.platform;
	let originalEnv: Record<string, string | undefined>;
	let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
	let tempDir: string;

	beforeEach(() => {
		delete process.env[FLOW_DEPTH_ENV];
		// Save original env vars before clearing them so we can restore in afterEach
		originalEnv = {
			TERM_PROGRAM: process.env.TERM_PROGRAM,
			KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID,
		};
		delete process.env.TERM_PROGRAM;
		delete process.env.KITTY_WINDOW_ID;
		// Force macOS so desktop backend is predictable (osascript)
		Object.defineProperty(process, "platform", { value: "darwin" });
		stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.mocked(childProcess.execFile).mockClear();
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
		stdoutWriteSpy.mockRestore();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "" as any;
		}
	});

	async function triggerAgentEnd(cwd: string, envVars: Record<string, string> = {}) {
		for (const [k, v] of Object.entries(envVars)) {
			process.env[k] = v;
		}
		const { setupNotify } = await import("../src/notify.js");
		const listeners: Record<string, Function[]> = {};
		const on = vi.fn((event: string, handler: Function) => {
			(listeners[event] ||= []).push(handler);
		});
		const pi = { on } as any;
		setupNotify(pi);
		const handler = listeners["agent_end"]?.[0];
		if (!handler) throw new Error("agent_end not registered");
		await handler(null, { cwd, hasUI: true });
	}

	it("skips desktop notification in Warp to avoid double notification", async () => {
		tempDir = createTempProject();
		await triggerAgentEnd(tempDir, { TERM_PROGRAM: "WarpTerminal" });
		expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining("\x1b]777;notify;"));
		expect(childProcess.execFile).not.toHaveBeenCalled();
	});

	it("skips desktop notification in kitty to avoid double notification", async () => {
		tempDir = createTempProject();
		await triggerAgentEnd(tempDir, { KITTY_WINDOW_ID: "1" });
		expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining("\x1b]99;i=1:d=0;"));
		expect(childProcess.execFile).not.toHaveBeenCalled();
	});

	it("skips desktop notification in iTerm2 to avoid double notification", async () => {
		tempDir = createTempProject();
		await triggerAgentEnd(tempDir, { TERM_PROGRAM: "iTerm.app" });
		expect(stdoutWriteSpy).toHaveBeenCalled();
		expect(childProcess.execFile).not.toHaveBeenCalled();
	});

	it("sends desktop notification when terminal is not known to support OSC", async () => {
		tempDir = createTempProject();
		await triggerAgentEnd(tempDir, {});
		expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining("\x1b]777;notify;"));
		expect(childProcess.execFile).toHaveBeenCalledWith(
			"osascript",
			expect.any(Array),
			expect.any(Function),
		);
	});

	it("sends desktop notification when terminal channel is disabled", async () => {
		tempDir = createTempProject({ channels: { terminal: false, desktop: true, bell: false, sound: false } });
		await triggerAgentEnd(tempDir, { TERM_PROGRAM: "WarpTerminal" });
		expect(stdoutWriteSpy).not.toHaveBeenCalledWith(expect.stringContaining("\x1b]777;notify;"));
		expect(childProcess.execFile).toHaveBeenCalledWith(
			"osascript",
			expect.any(Array),
			expect.any(Function),
		);
	});

	it("sends desktop notification when desktop backend is explicitly configured", async () => {
		tempDir = createTempProject({ desktop: { backend: "macos" } });
		await triggerAgentEnd(tempDir, { TERM_PROGRAM: "WarpTerminal" });
		expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining("\x1b]777;notify;"));
		expect(childProcess.execFile).toHaveBeenCalledWith(
			"osascript",
			expect.any(Array),
			expect.any(Function),
		);
	});
});