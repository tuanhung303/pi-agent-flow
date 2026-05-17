import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shouldAutoWarp, buildAutoWarpPrompt } from "../src/flow/auto-warp.js";
import { setGoal, clearGoal } from "../src/flow/store.js";
import { setLoop, clearLoop } from "../src/flow/loop.js";
import type { LoopState } from "../src/flow/types.js";

describe("auto-warp orchestration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-auto-warp-test-"));
  });

  afterEach(() => {
    clearGoal(tmpDir);
    clearLoop(tmpDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeLoop(overrides: Partial<LoopState> = {}): LoopState {
    return {
      objective: "Refactor tests",
      status: "active",
      sessionCount: 2,
      totalTokensAcrossSessions: 8000,
      totalFlowsAcrossSessions: 5,
      ...overrides,
    };
  }

  it("shouldAutoWarp returns false when no active loop", () => {
    const exceededGoal = {
      id: "goal-test",
      objective: "Test",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      status: "active" as const,
      completedFlows: Array(10).fill({ type: "build", intent: "x", aim: "x", completedAt: "2026-01-01T00:00:00Z" }),
      totalTokens: 0,
      maxTokens: 100,
      maxFlows: 10,
    };
    expect(shouldAutoWarp(tmpDir, exceededGoal)).toBe(false);
  });

  it("shouldAutoWarp returns true when loop active and token budget exceeded", () => {
    setLoop(tmpDir, makeLoop());
    const goal = setGoal(tmpDir, "Test", { maxTokens: 100 });
    const exceededGoal = { ...goal, totalTokens: 150 };
    expect(shouldAutoWarp(tmpDir, exceededGoal)).toBe(true);
  });

  it("shouldAutoWarp returns true when loop active and flow budget exceeded", () => {
    setLoop(tmpDir, makeLoop());
    const goal = setGoal(tmpDir, "Test", { maxFlows: 3 });
    const exceededGoal = {
      ...goal,
      completedFlows: Array(4).fill({ type: "build", intent: "x", aim: "x", completedAt: "2026-01-01T00:00:00Z" }),
    };
    expect(shouldAutoWarp(tmpDir, exceededGoal)).toBe(true);
  });

  it("shouldAutoWarp returns false when loop active but budgets not exceeded", () => {
    setLoop(tmpDir, makeLoop());
    const goal = setGoal(tmpDir, "Test", { maxTokens: 100, maxFlows: 10 });
    expect(shouldAutoWarp(tmpDir, goal)).toBe(false);
  });

  it("buildAutoWarpPrompt includes all loop context placeholders", () => {
    const loop = makeLoop({ sessionCount: 3, totalTokensAcrossSessions: 9000, totalFlowsAcrossSessions: 7 });
    const goal = setGoal(tmpDir, "Refactor all tests", { maxTokens: 5000, acceptance: "All pass" });
    const prompt = buildAutoWarpPrompt(goal, loop);
    expect(prompt).toContain("Refactor all tests");
    expect(prompt).toContain("Acceptance: All pass");
    expect(prompt).toContain("3 sessions");
    expect(prompt).toContain("7 flows");
    expect(prompt).toContain("9000/5000 tokens");
    expect(prompt).toContain("<flow-loop-warp>");
  });

  it("buildAutoWarpPrompt omits acceptance when not set", () => {
    const loop = makeLoop();
    const goal = setGoal(tmpDir, "Refactor all tests", { maxTokens: 5000 });
    const prompt = buildAutoWarpPrompt(goal, loop);
    expect(prompt).not.toContain("Acceptance:");
  });
});
