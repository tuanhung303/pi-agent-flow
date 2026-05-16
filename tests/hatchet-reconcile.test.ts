import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HatchetRunAdapter } from "../src/hatchet-run-adapter.js";
import type { HatchetRemoteRunStatus } from "../src/hatchet-run-adapter.js";
import {
  appendHatchetRunRecord,
  createHatchetRunRecord,
  loadHatchetRunRegistry,
  markHatchetRunSubmitted,
} from "../src/hatchet-run-registry.js";
import { reconcileHatchetRuns, type HatchetReconcileOptions } from "../src/hatchet-reconcile.js";
import { emptyFlowUsage, type SingleResult } from "../src/types/flow.js";
import { setGoal } from "../src/flow/store.js";

function makeCompletedResult(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    type: "build",
    agentSource: "project",
    intent: "Implement feature",
    aim: "Implement feature",
    exitCode: 0,
    messages: [],
    stderr: "done",
    usage: emptyFlowUsage(),
    ...overrides,
  };
}

function makeFakeAdapter(statusMap: Record<string, HatchetRemoteRunStatus>): HatchetRunAdapter {
  return {
    submit: vi.fn(async () => ({ runId: "never-submitted" })),
    getResult: vi.fn(async (handle) => {
      const status = statusMap[handle.runId];
      if (!status) return { status: "unknown" as const, errorMessage: "no status for this run" };
      return status;
    }),
  };
}

describe("Hatchet reconciliation", () => {
  it("updates running runs to completed and records goal progress once", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-reconcile-"));
    const goal = setGoal(cwd, "Implement durable resume", { acceptance: "Tests pass" });

    const record = createHatchetRunRecord({ cwd, sessionId: "s1", goalId: goal.id, flowType: "build", intent: "Implement feature", aim: "Implement", paramIndex: 0, attemptIndex: 0, payloadHash: "h" });
    appendHatchetRunRecord(cwd, record);
    markHatchetRunSubmitted(cwd, record.id, { hatchetRunId: "remote-1", status: "running" });

    const result = makeCompletedResult();
    const adapter = makeFakeAdapter({ "remote-1": { status: "completed", result } });

    const opts: HatchetReconcileOptions = { cwd, sessionId: "s1", goalId: goal.id, adapter };
    const summary = await reconcileHatchetRuns(opts);

    expect(summary.checked).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.running).toBe(0);

    const reg = loadHatchetRunRegistry(cwd);
    expect(reg.runs[0].status).toBe("completed");
    expect(reg.runs[0].goalRecordedAt).toBeTruthy();
    expect(reg.runs[0].result?.stderr).toBe("done");
  });

  it("does not double-record a completed run on second reconcile", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-reconcile-"));
    const goal = setGoal(cwd, "Implement durable resume");

    const record = createHatchetRunRecord({ cwd, sessionId: "s1", goalId: goal.id, flowType: "build", intent: "i", aim: "a", paramIndex: 0, attemptIndex: 0, payloadHash: "h" });
    appendHatchetRunRecord(cwd, record);
    markHatchetRunSubmitted(cwd, record.id, { hatchetRunId: "remote-2", status: "running" });

    const result = makeCompletedResult();
    const adapter = makeFakeAdapter({ "remote-2": { status: "completed", result } });
    const opts: HatchetReconcileOptions = { cwd, sessionId: "s1", goalId: goal.id, adapter };

    // First reconcile
    await reconcileHatchetRuns(opts);
    const reg1 = loadHatchetRunRegistry(cwd);
    const recordedAt1 = reg1.runs[0].goalRecordedAt;
    expect(recordedAt1).toBeTruthy();

    // Second reconcile (run is now completed, not active)
    const summary2 = await reconcileHatchetRuns(opts);
    expect(summary2.checked).toBe(0); // no active runs to check

    const reg2 = loadHatchetRunRegistry(cwd);
    expect(reg2.runs[0].goalRecordedAt).toBe(recordedAt1); // unchanged
  });

  it("marks missing-handle submitting runs as unknown", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-reconcile-"));

    const record = createHatchetRunRecord({ cwd, flowType: "build", intent: "i", aim: "a", paramIndex: 0, attemptIndex: 0, payloadHash: "h" });
    appendHatchetRunRecord(cwd, record);
    // No markHatchetRunSubmitted — no hatchetRunId

    const adapter = makeFakeAdapter({});
    const opts: HatchetReconcileOptions = { cwd, adapter };
    const summary = await reconcileHatchetRuns(opts);

    expect(summary.unknown).toBe(1);
    const reg = loadHatchetRunRegistry(cwd);
    expect(reg.runs[0].status).toBe("unknown");
    expect(reg.runs[0].errorMessage).toContain("no remote handle");
  });

  it("keeps active runs active when Hatchet returns running status", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-reconcile-"));

    const record = createHatchetRunRecord({ cwd, flowType: "build", intent: "i", aim: "a", paramIndex: 0, attemptIndex: 0, payloadHash: "h" });
    appendHatchetRunRecord(cwd, record);
    markHatchetRunSubmitted(cwd, record.id, { hatchetRunId: "remote-3", status: "running" });

    const adapter = makeFakeAdapter({ "remote-3": { status: "running" } });
    const opts: HatchetReconcileOptions = { cwd, adapter };
    const summary = await reconcileHatchetRuns(opts);

    expect(summary.running).toBe(1);
    const reg = loadHatchetRunRegistry(cwd);
    expect(reg.runs[0].status).toBe("running");
  });

  it("does not update abandoned goals automatically", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-reconcile-"));
    // No active goal set

    const record = createHatchetRunRecord({ cwd, sessionId: "s1", goalId: "old-goal-id", flowType: "build", intent: "i", aim: "a", paramIndex: 0, attemptIndex: 0, payloadHash: "h" });
    appendHatchetRunRecord(cwd, record);
    markHatchetRunSubmitted(cwd, record.id, { hatchetRunId: "remote-4", status: "running" });

    const result = makeCompletedResult();
    const adapter = makeFakeAdapter({ "remote-4": { status: "completed", result } });
    const opts: HatchetReconcileOptions = { cwd, goalId: "different-goal", adapter };
    await reconcileHatchetRuns(opts);

    const reg = loadHatchetRunRegistry(cwd);
    // Status updated to completed but goal not recorded (goal id mismatch + no current goal)
    expect(reg.runs[0].status).toBe("completed");
    expect(reg.runs[0].goalRecordedAt).toBeUndefined();
  });

  it("handles adapter errors gracefully by keeping runs active", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-reconcile-"));

    const record = createHatchetRunRecord({ cwd, flowType: "build", intent: "i", aim: "a", paramIndex: 0, attemptIndex: 0, payloadHash: "h" });
    appendHatchetRunRecord(cwd, record);
    markHatchetRunSubmitted(cwd, record.id, { hatchetRunId: "remote-5", status: "running" });

    const adapter: HatchetRunAdapter = {
      submit: vi.fn(async () => ({ runId: "never" })),
      getResult: vi.fn(async () => { throw new Error("Hatchet API unavailable"); }),
    };
    const opts: HatchetReconcileOptions = { cwd, adapter };
    const summary = await reconcileHatchetRuns(opts);

    // Should not throw; just surface the issue
    expect(summary.messages.some((m) => m.includes("unavailable") || m.includes("error") || m.includes("Hatchet API"))).toBe(true);
    // Run should still be "running" (not falsely marked as failed)
    const reg = loadHatchetRunRegistry(cwd);
    expect(reg.runs[0].status).toBe("running");
  });

  it("returns correct summary counts for mixed run statuses", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-reconcile-"));

    const r1 = createHatchetRunRecord({ cwd, flowType: "build", intent: "i", aim: "a", paramIndex: 0, attemptIndex: 0, payloadHash: "h1" });
    const r2 = createHatchetRunRecord({ cwd, flowType: "scout", intent: "i", aim: "a", paramIndex: 1, attemptIndex: 0, payloadHash: "h2" });
    appendHatchetRunRecord(cwd, r1);
    appendHatchetRunRecord(cwd, r2);
    markHatchetRunSubmitted(cwd, r1.id, { hatchetRunId: "remote-r1", status: "running" });
    markHatchetRunSubmitted(cwd, r2.id, { hatchetRunId: "remote-r2", status: "running" });

    const adapter = makeFakeAdapter({
      "remote-r1": { status: "completed", result: makeCompletedResult() },
      "remote-r2": { status: "failed", errorMessage: "worker error" },
    });
    const opts: HatchetReconcileOptions = { cwd, adapter };
    const summary = await reconcileHatchetRuns(opts);

    expect(summary.checked).toBe(2);
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(1);
  });
});
