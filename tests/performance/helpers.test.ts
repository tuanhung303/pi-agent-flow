import { describe, it, expect, vi } from "vitest";
import {
	makeMockProcess,
	makeMockPi,
	forceGC,
	trackMapSize,
	withTmpDir,
} from "./helpers.js";

describe("makeMockProcess", () => {
	it("returns a process with the given pid", () => {
		const proc = makeMockProcess(9999);
		expect(proc.pid).toBe(9999);
	});

	it("has stdin, stdout, stderr as Writable streams", () => {
		const proc = makeMockProcess();
		expect(proc.stdin).toBeDefined();
		expect(proc.stdout).toBeDefined();
		expect(proc.stderr).toBeDefined();
		expect(typeof proc.stdin?.write).toBe("function");
		expect(typeof proc.stdout?.write).toBe("function");
		expect(typeof proc.stderr?.write).toBe("function");
	});

	it("has a kill method that is a vi.fn() mock", () => {
		const proc = makeMockProcess();
		expect(vi.isMockFunction(proc.kill)).toBe(true);
		const result = proc.kill("SIGTERM");
		expect(result).toBe(true);
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("can emit events like a real EventEmitter", () => {
		const proc = makeMockProcess();
		const listener = vi.fn();
		proc.on("close", listener);
		proc.emit("close", 0);
		expect(listener).toHaveBeenCalledWith(0);
	});

	it("stdout can emit data events", () => {
		const proc = makeMockProcess();
		const listener = vi.fn();
		proc.stdout.on("data", listener);
		proc.stdout.emit("data", Buffer.from("hello"));
		expect(listener).toHaveBeenCalledWith(Buffer.from("hello"));
	});
});

describe("makeMockPi", () => {
	it("returns an object with expected ExtensionAPI methods", () => {
		const pi = makeMockPi();
		expect(typeof pi.registerFlag).toBe("function");
		expect(typeof pi.getFlag).toBe("function");
		expect(typeof pi.on).toBe("function");
		expect(typeof pi.emit).toBe("function");
		expect(typeof pi.registerTool).toBe("function");
		expect(typeof pi.setActiveTools).toBe("function");
		expect(typeof pi.sendUserMessage).toBe("function");
	});

	it("on() registers event handlers and trigger() invokes them", async () => {
		const pi = makeMockPi();
		const handler = vi.fn(() => "result");
		pi.on("session_start", handler);
		const results = await pi.trigger("session_start", { id: "1" });
		expect(handler).toHaveBeenCalledWith({ id: "1" });
		expect(results).toEqual(["result"]);
	});

	it("getTool returns a registered tool", () => {
		const pi = makeMockPi();
		const tool = { name: "test-tool", execute: vi.fn() };
		pi.registerTool(tool);
		expect(pi.getTool("test-tool")).toBe(tool);
		expect(pi.getTool("missing")).toBeUndefined();
	});

	it("getHandlers returns registered handlers for an event", () => {
		const pi = makeMockPi();
		const h1 = vi.fn();
		const h2 = vi.fn();
		pi.on("ev", h1);
		pi.on("ev", h2);
		expect(pi.getHandlers("ev")).toHaveLength(2);
		expect(pi.getHandlers("unknown")).toEqual([]);
	});

	it("all non-trigger methods are vi.fn() mocks", () => {
		const pi = makeMockPi();
		expect(vi.isMockFunction(pi.registerFlag)).toBe(true);
		expect(vi.isMockFunction(pi.getFlag)).toBe(true);
		expect(vi.isMockFunction(pi.setActiveTools)).toBe(true);
		expect(vi.isMockFunction(pi.sendUserMessage)).toBe(true);
	});
});

describe("forceGC", () => {
	it("resolves after at least 50ms", async () => {
		const start = Date.now();
		await forceGC();
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(45);
	});
});

describe("trackMapSize", () => {
	it("returns the current size of a map", () => {
		const map = new Map([["a", 1], ["b", 2]]);
		expect(trackMapSize(map)).toEqual({ size: 2 });
		map.clear();
		expect(trackMapSize(map)).toEqual({ size: 0 });
	});
});

describe("withTmpDir", () => {
	it("creates a temp dir, runs fn, and cleans up", async () => {
		let capturedDir: string | null = null;
		const result = await withTmpDir("pi-test-", async (dir) => {
			capturedDir = dir;
			expect(typeof dir).toBe("string");
			expect(dir).toContain("pi-test-");
			return 42;
		});
		expect(result).toBe(42);
		expect(capturedDir).not.toBeNull();
		const fs = await import("node:fs");
		expect(fs.existsSync(capturedDir!)).toBe(false);
	});

	it("cleans up even when fn throws", async () => {
		let capturedDir: string | null = null;
		await expect(
			withTmpDir("pi-test-", async (dir) => {
				capturedDir = dir;
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		const fs = await import("node:fs");
		expect(fs.existsSync(capturedDir!)).toBe(false);
	});
});
