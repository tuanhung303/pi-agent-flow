import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getLoop,
  enableLoop,
  disableLoop,
  resetLoop,
  terminateLoop,
  recordSessionWarp,
} from "../src/flow/loop.js";
import { setGoal, readState } from "../src/flow/store.js";
import type { LoopState, LoopTerminationReason } from "../src/flow/types.js";

describe("loop state management", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("(1) enableLoop creates active loop with objective", () => {
    setGoal(tmpDir, "test objective");
    const loop = enableLoop(tmpDir, "test objective");
    expect(loop.status).toBe("active");
    expect(loop.objective).toBe("test objective");
    expect(loop.sessionCount).toBe(1);
    expect(loop.totalTokensAcrossSessions).toBe(0);
    expect(loop.totalFlowsAcrossSessions).toBe(0);
  });

  it("(2) getLoop returns undefined when no loop", () => {
    const result = getLoop(tmpDir);
    expect(result).toBeUndefined();
  });

  it("(3) getLoop returns saved loop state", () => {
    setGoal(tmpDir, "test objective");
    enableLoop(tmpDir, "test objective");
    const result = getLoop(tmpDir);
    expect(result).toBeDefined();
    expect(result?.status).toBe("active");
    expect(result?.objective).toBe("test objective");
  });

  it("(4) disableLoop sets status paused and returns loop", () => {
    setGoal(tmpDir, "test objective");
    enableLoop(tmpDir, "test objective");
    const loop = disableLoop(tmpDir);
    expect(loop?.status).toBe("paused");
  });

  it("(5) disableLoop returns undefined when no loop", () => {
    const result = disableLoop(tmpDir);
    expect(result).toBeUndefined();
  });

  it("(6) resetLoop resets counters sets status active preserves objective", () => {
    setGoal(tmpDir, "test objective");
    enableLoop(tmpDir, "test objective");
    recordSessionWarp(tmpDir);
    const state = readState(tmpDir);
    expect(state.loop?.sessionCount).toBe(2);
    const loop = resetLoop(tmpDir);
    expect(loop?.status).toBe("active");
    expect(loop?.objective).toBe("test objective");
    expect(loop?.sessionCount).toBe(0);
    expect(loop?.totalTokensAcrossSessions).toBe(0);
    expect(loop?.totalFlowsAcrossSessions).toBe(0);
  });

  it("(7) terminateLoop sets status terminated records reason and terminatedAt", () => {
    setGoal(tmpDir, "test objective");
    enableLoop(tmpDir, "test objective");
    const loop = terminateLoop(tmpDir, "user_disabled");
    expect(loop?.status).toBe("terminated");
    expect(loop?.terminationReason).toBe("user_disabled");
    expect(loop?.terminatedAt).toBeDefined();
  });

  it("(8) recordSessionWarp increments sessionCount when loop active", () => {
    setGoal(tmpDir, "test objective");
    enableLoop(tmpDir, "test objective");
    const loop = recordSessionWarp(tmpDir);
    expect(loop?.sessionCount).toBe(2);
  });

  it("(9) recordSessionWarp returns undefined when loop paused or missing", () => {
    setGoal(tmpDir, "test objective");
    enableLoop(tmpDir, "test objective");
    disableLoop(tmpDir);
    expect(recordSessionWarp(tmpDir)).toBeUndefined();

    // Missing loop
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-empty-"));
    try {
      expect(recordSessionWarp(emptyDir)).toBeUndefined();
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("(10) loop state round-trips through flow.json", () => {
    setGoal(tmpDir, "test objective");
    enableLoop(tmpDir, "test objective");
    disableLoop(tmpDir);
    const fromFile = getLoop(tmpDir);
    expect(fromFile?.status).toBe("paused");
    expect(fromFile?.objective).toBe("test objective");
  });

  it("(11) enableLoop errors when no active goal", () => {
    expect(() => enableLoop(tmpDir, "test objective")).toThrow(/no active goal/);
  });

  it("(12) terminateLoop with goal_completed reason", () => {
    setGoal(tmpDir, "test objective");
    enableLoop(tmpDir, "test objective");
    const loop = terminateLoop(tmpDir, "goal_completed");
    expect(loop?.status).toBe("terminated");
    expect(loop?.terminationReason).toBe("goal_completed" as LoopTerminationReason);
  });
});
