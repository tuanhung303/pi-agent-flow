import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FLOW_DEPTH_ENV } from "../src/depth.js";

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

	it("registers agent_end listener when depth is 0 (root orchestrator)", async () => {
		process.env[FLOW_DEPTH_ENV] = "0";
		const { setupNotify } = await import("../src/notify.js");
		const on = vi.fn();
		const pi = { on } as any;
		setupNotify(pi);
		expect(on).toHaveBeenCalledWith("agent_end", expect.any(Function));
	});

	it("registers agent_end listener when PI_FLOW_DEPTH is unset", async () => {
		// Ensure no depth env is set
		delete process.env[FLOW_DEPTH_ENV];
		const { setupNotify } = await import("../src/notify.js");
		const on = vi.fn();
		const pi = { on } as any;
		setupNotify(pi);
		expect(on).toHaveBeenCalledWith("agent_end", expect.any(Function));
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
