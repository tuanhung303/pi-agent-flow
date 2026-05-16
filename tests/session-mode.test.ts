import { describe, it, expect } from "vitest";
import {
	AGENT_SESSION_TIMEOUTS_MS,
	DEFAULT_AGENT_SESSION_MODE,
	MAX_AGENT_SESSION_TIMEOUT_MS,
	getAgentSessionTimeoutMs,
	parseAgentSessionMode,
	resolveAgentSessionMode,
} from "../src/core/session-mode.js";

describe("agent session modes", () => {
	it("defines snap/fast/default/long/extreme_long budgets with default at 600s and extreme_long capped at 1200s", () => {
		expect(DEFAULT_AGENT_SESSION_MODE).toBe("default");
		expect(AGENT_SESSION_TIMEOUTS_MS).toEqual({
			snap: 90_000,
			fast: 300_000,
			default: 600_000,
			long: 900_000,
			extreme_long: 1_200_000,
		});
		expect(getAgentSessionTimeoutMs("snap")).toBe(90_000);
		expect(getAgentSessionTimeoutMs("extreme_long")).toBe(MAX_AGENT_SESSION_TIMEOUT_MS);
	});

	it("parses modes case-insensitively and rejects arbitrary timeout values", () => {
		expect(parseAgentSessionMode("FAST")).toBe("fast");
		expect(parseAgentSessionMode(" default ")).toBe("default");
		expect(parseAgentSessionMode("900")).toBeUndefined();
		expect(parseAgentSessionMode("snap")).toBe("snap");
		expect(parseAgentSessionMode("extreme_long")).toBe("extreme_long");
		expect(parseAgentSessionMode("extra-long")).toBeUndefined();
	});

	it("falls back to the provided default for invalid values", () => {
		expect(resolveAgentSessionMode("bad", "fast")).toBe("fast");
		expect(resolveAgentSessionMode(undefined)).toBe("default");
	});
});
