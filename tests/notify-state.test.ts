import { describe, it, expect, beforeEach } from "vitest";
import {
	getNotifyState,
	resetNotifyState,
	setPendingDecision,
	setFlowComplete,
} from "../src/notify/notify-state.js";

describe("notify-state", () => {
	beforeEach(() => {
		resetNotifyState();
	});

	it("returns default state when nothing has been set", () => {
		const state = getNotifyState();
		expect(state.pendingDecision).toBe(false);
		expect(state.lastFlowName).toBeUndefined();
		expect(state.lastFlowAcceptance).toBeUndefined();
		expect(state.completedFlows).toBe(0);
		expect(state.totalFlows).toBe(0);
	});

	it("setPendingDecision sets the flag", () => {
		setPendingDecision();
		expect(getNotifyState().pendingDecision).toBe(true);
	});

	it("setFlowComplete populates flow info", () => {
		setFlowComplete("build", "All tests pass", 0, 3);
		const state = getNotifyState();
		expect(state.lastFlowName).toBe("build");
		expect(state.lastFlowAcceptance).toBe("All tests pass");
		expect(state.completedFlows).toBe(1);
		expect(state.totalFlows).toBe(3);
	});

	it("setFlowComplete handles undefined acceptance", () => {
		setFlowComplete("scout", undefined, 0, 1);
		const state = getNotifyState();
		expect(state.lastFlowName).toBe("scout");
		expect(state.lastFlowAcceptance).toBeUndefined();
		expect(state.completedFlows).toBe(1);
		expect(state.totalFlows).toBe(1);
	});

	it("setFlowComplete for last flow in batch uses the last index", () => {
		setFlowComplete("debug", "Root cause found", 2, 3);
		const state = getNotifyState();
		expect(state.lastFlowName).toBe("debug");
		expect(state.completedFlows).toBe(3);
		expect(state.totalFlows).toBe(3);
	});

	it("resetNotifyState clears everything", () => {
		setPendingDecision();
		setFlowComplete("build", "Done", 0, 2);
		resetNotifyState();
		const state = getNotifyState();
		expect(state.pendingDecision).toBe(false);
		expect(state.lastFlowName).toBeUndefined();
		expect(state.lastFlowAcceptance).toBeUndefined();
		expect(state.completedFlows).toBe(0);
		expect(state.totalFlows).toBe(0);
	});

	it("pendingDecision can coexist with flow info", () => {
		setFlowComplete("scout", "Mapped terrain", 0, 1);
		setPendingDecision();
		const state = getNotifyState();
		expect(state.pendingDecision).toBe(true);
		expect(state.lastFlowName).toBe("scout");
	});
});
