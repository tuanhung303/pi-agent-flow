import { mkdtempSync, readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createHatchetRunRecord,
  loadHatchetRunRegistry,
  markHatchetRunSubmitted,
  saveHatchetRunRegistry,
  updateHatchetRunResult,
  updateHatchetRunFailure,
  markHatchetGoalRecorded,
  listActiveHatchetRuns,
  appendHatchetRunRecord,
} from "../src/hatchet-run-registry.js";
import { emptyFlowUsage } from "../src/types/flow.js";

describe("Hatchet run registry", () => {
  it("writes .pi/hatchet-runs.json atomically with 0600 permissions", () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-registry-"));
    const record = createHatchetRunRecord({
      cwd,
      sessionId: "session-1",
      goalId: "goal-1",
      toolCallId: "tool-1",
      flowType: "build",
      intent: "Implement durable resume",
      aim: "Durable Hatchet resume",
      paramIndex: 0,
      attemptIndex: 0,
      payloadHash: "sha256:test",
    });

    saveHatchetRunRegistry(cwd, { version: 1, runs: [record] });

    const raw = readFileSync(join(cwd, ".pi", "hatchet-runs.json"), "utf8");
    expect(JSON.parse(raw).runs[0].status).toBe("submitting");
    expect(statSync(join(cwd, ".pi", "hatchet-runs.json")).mode & 0o777).toBe(0o600);
  });

  it("updates submission and final result without duplicating records", () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-registry-"));
    const record = createHatchetRunRecord({
      cwd,
      sessionId: "s",
      flowType: "build",
      intent: "i",
      aim: "a",
      paramIndex: 0,
      attemptIndex: 0,
      payloadHash: "h",
    });
    saveHatchetRunRegistry(cwd, { version: 1, runs: [record] });

    markHatchetRunSubmitted(cwd, record.id, { hatchetRunId: "remote-1", status: "running" });
    updateHatchetRunResult(cwd, record.id, {
      type: "build",
      agentSource: "project",
      intent: "i",
      aim: "a",
      exitCode: 0,
      messages: [],
      stderr: "done",
      usage: emptyFlowUsage(),
    });

    const loaded = loadHatchetRunRegistry(cwd);
    expect(loaded.runs).toHaveLength(1);
    expect(loaded.runs[0].hatchetRunId).toBe("remote-1");
    expect(loaded.runs[0].status).toBe("completed");
    expect(loaded.runs[0].result?.stderr).toBe("done");
  });

  it("recovers from corrupt JSON by preserving the corrupt file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-registry-"));
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "hatchet-runs.json"), "not-json", { encoding: "utf8" });
    const loaded = loadHatchetRunRegistry(cwd);
    expect(loaded.runs).toEqual([]);
  });

  it("creates record with submitting status and all fields", () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-registry-"));
    const record = createHatchetRunRecord({
      cwd,
      sessionId: "s",
      goalId: "g",
      toolCallId: "t",
      flowType: "scout",
      intent: "Explore codebase",
      aim: "Map code",
      paramIndex: 1,
      attemptIndex: 2,
      payloadHash: "sha256:abc",
    });
    expect(record.status).toBe("submitting");
    expect(record.flowType).toBe("scout");
    expect(record.sessionId).toBe("s");
    expect(record.goalId).toBe("g");
    expect(record.toolCallId).toBe("t");
    expect(record.paramIndex).toBe(1);
    expect(record.attemptIndex).toBe(2);
    expect(record.payloadHash).toBe("sha256:abc");
    expect(record.id).toBeTruthy();
    expect(record.clientRunId).toBeTruthy();
    expect(record.createdAt).toBeTruthy();
    expect(record.updatedAt).toBeTruthy();
  });

  it("appendHatchetRunRecord persists record to disk", () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-registry-"));
    const record = createHatchetRunRecord({
      cwd,
      flowType: "build",
      intent: "i",
      aim: "a",
      paramIndex: 0,
      attemptIndex: 0,
      payloadHash: "h",
    });
    appendHatchetRunRecord(cwd, record);
    const loaded = loadHatchetRunRegistry(cwd);
    expect(loaded.runs).toHaveLength(1);
    expect(loaded.runs[0].id).toBe(record.id);
  });

  it("markHatchetRunSubmitted updates run with remote handle", () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-registry-"));
    const record = createHatchetRunRecord({
      cwd,
      flowType: "build",
      intent: "i",
      aim: "a",
      paramIndex: 0,
      attemptIndex: 0,
      payloadHash: "h",
    });
    appendHatchetRunRecord(cwd, record);
    const updated = markHatchetRunSubmitted(cwd, record.id, { hatchetRunId: "hatchet-xyz", status: "queued" });
    expect(updated?.hatchetRunId).toBe("hatchet-xyz");
    expect(updated?.status).toBe("queued");
    const loaded = loadHatchetRunRegistry(cwd);
    expect(loaded.runs[0].hatchetRunId).toBe("hatchet-xyz");
  });

  it("updateHatchetRunFailure marks run failed with error message", () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-registry-"));
    const record = createHatchetRunRecord({
      cwd,
      flowType: "build",
      intent: "i",
      aim: "a",
      paramIndex: 0,
      attemptIndex: 0,
      payloadHash: "h",
    });
    appendHatchetRunRecord(cwd, record);
    updateHatchetRunFailure(cwd, record.id, "failed", "Submission timed out");
    const loaded = loadHatchetRunRegistry(cwd);
    expect(loaded.runs[0].status).toBe("failed");
    expect(loaded.runs[0].errorMessage).toBe("Submission timed out");
  });

  it("markHatchetGoalRecorded sets goalRecordedAt field", () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-registry-"));
    const record = createHatchetRunRecord({
      cwd,
      flowType: "build",
      intent: "i",
      aim: "a",
      paramIndex: 0,
      attemptIndex: 0,
      payloadHash: "h",
    });
    appendHatchetRunRecord(cwd, record);
    const updated = markHatchetGoalRecorded(cwd, record.id);
    expect(updated?.goalRecordedAt).toBeTruthy();
    const loaded = loadHatchetRunRegistry(cwd);
    expect(loaded.runs[0].goalRecordedAt).toBeTruthy();
  });

  it("listActiveHatchetRuns returns only active (submitting/queued/running) runs", () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-registry-"));
    const r1 = createHatchetRunRecord({ cwd, flowType: "build", intent: "i", aim: "a", paramIndex: 0, attemptIndex: 0, payloadHash: "h1" });
    const r2 = createHatchetRunRecord({ cwd, flowType: "scout", intent: "i", aim: "a", paramIndex: 0, attemptIndex: 0, payloadHash: "h2" });
    const r3 = createHatchetRunRecord({ cwd, flowType: "audit", intent: "i", aim: "a", paramIndex: 0, attemptIndex: 0, payloadHash: "h3" });
    saveHatchetRunRegistry(cwd, { version: 1, runs: [r1, r2, r3] });
    markHatchetRunSubmitted(cwd, r1.id, { hatchetRunId: "h-1", status: "running" });
    updateHatchetRunResult(cwd, r2.id, { type: "scout", agentSource: "project", intent: "i", aim: "a", exitCode: 0, messages: [], stderr: "", usage: emptyFlowUsage() });
    const active = listActiveHatchetRuns(cwd);
    expect(active.map((r) => r.id)).toContain(r1.id);
    expect(active.map((r) => r.id)).toContain(r3.id); // still submitting
    expect(active.map((r) => r.id)).not.toContain(r2.id); // completed
  });

  it("returns empty registry when no file exists", () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-registry-"));
    const loaded = loadHatchetRunRegistry(cwd);
    expect(loaded.runs).toEqual([]);
    expect(loaded.version).toBe(1);
  });

  it("does not store snapshot or secret fields in registry", () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-registry-"));
    const record = createHatchetRunRecord({
      cwd,
      flowType: "build",
      intent: "i",
      aim: "a",
      paramIndex: 0,
      attemptIndex: 0,
      payloadHash: "sha256:test",
    });
    appendHatchetRunRecord(cwd, record);
    const raw = readFileSync(join(cwd, ".pi", "hatchet-runs.json"), "utf8");
    expect(raw).not.toContain("forkSessionSnapshotJsonl");
    expect(raw).not.toContain("context-seal");
    expect(raw).not.toContain("HATCHET_CLIENT");
  });
});
