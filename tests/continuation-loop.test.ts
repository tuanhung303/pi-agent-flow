import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setupContinuation, markFlowCompleted } from "../src/flow/continuation.js";
import { setGoal, clearGoal, getGoal } from "../src/flow/store.js";
import { setLoop, clearLoop, disableLoop } from "../src/flow/loop.js";
import * as sessionRegistry from "../src/core/session-registry.js";
import type { TurnEndEvent } from "@mariozechner/pi-coding-agent";

describe("continuation loop integration", () => {
  let tmpDir: string;
  let sentMessages: Array<{ content: string; display: boolean; opts: { triggerTurn?: boolean } }>;
  let turnEndHandler: ((event: TurnEndEvent) => Promise<void>) | undefined;
  let sessionStartHandler: ((_event: any, ctx: any) => void) | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-continuation-loop-test-"));
    sentMessages = [];
    turnEndHandler = undefined;
    sessionStartHandler = undefined;

    const mockPi = {
      on: vi.fn((event: string, handler: any) => {
        if (event === "turn_end") turnEndHandler = handler;
        if (event === "session_start") sessionStartHandler = handler;
      }),
      sendMessage: vi.fn((msg: any, opts: any) => {
        sentMessages.push({ content: msg.content, display: msg.display, opts });
      }),
    };

    setupContinuation(mockPi as any);
  });

  afterEach(() => {
    clearGoal(tmpDir);
    clearLoop(tmpDir);
    sessionRegistry.unregister(tmpDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function registerSession(sessionId: string) {
    const mockCtx = {
      cwd: tmpDir,
      sessionManager: { getSessionId: () => sessionId },
    };
    if (sessionStartHandler) sessionStartHandler(undefined, mockCtx);
  }

  function makeTurnEndEvent(text: string): TurnEndEvent {
    return {
      message: { role: "user", content: [{ type: "text" as const, text }] },
    } as any;
  }

  it("budget exceeded + loop inactive sends pause message (existing behavior preserved)", async () => {
    registerSession("session-a");
    setGoal(tmpDir, "Test goal", { maxTokens: 100, sessionId: "session-a" });
    // exceed token budget manually
    const goal = getGoal(tmpDir)!;
    goal.totalTokens = 150;
    // re-save goal with exceeded tokens (store doesn't expose direct overwrite, simulate via addTokens)
    // Actually addTokens increments. Let's just use addTokens after setting low max.
    // Re-create with fresh state
    clearGoal(tmpDir);
    setGoal(tmpDir, "Test goal", { maxTokens: 100, sessionId: "session-a" });
    disableLoop(tmpDir);
    // Manually write state to exceed budget
    const statePath = path.join(tmpDir, ".pi", "flow.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    state.current.totalTokens = 150;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

    if (!turnEndHandler) throw new Error("turnEndHandler not set");
    await turnEndHandler(makeTurnEndEvent("hello"));

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].content).toContain("<flow-budget>");
    expect(sentMessages[0].content).toContain("exceeded its budget");
    expect(sentMessages[0].opts.triggerTurn).toBe(true);
  });

  it("budget exceeded + loop active sends auto-warp trigger with triggerTurn true", async () => {
    registerSession("session-b");
    setGoal(tmpDir, "Loop goal", { maxTokens: 200, sessionId: "session-b" });
    setLoop(tmpDir, {
      objective: "Loop goal",
      status: "active",
      sessionCount: 1,
      totalTokensAcrossSessions: 250,
      totalFlowsAcrossSessions: 3,
    });
    // Exceed token budget
    const statePath = path.join(tmpDir, ".pi", "flow.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    state.current.totalTokens = 250;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

    if (!turnEndHandler) throw new Error("turnEndHandler not set");
    await turnEndHandler(makeTurnEndEvent("hello"));

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].content).toContain("<flow-loop-warp>");
    expect(sentMessages[0].opts.triggerTurn).toBe(true);
  });

  it("flow budget exceeded + loop active sends auto-warp trigger", async () => {
    registerSession("session-c");
    setGoal(tmpDir, "Loop goal", { maxFlows: 2, sessionId: "session-c" });
    setLoop(tmpDir, {
      objective: "Loop goal",
      status: "active",
      sessionCount: 1,
      totalTokensAcrossSessions: 100,
      totalFlowsAcrossSessions: 5,
    });
    // Exceed flow budget
    const statePath = path.join(tmpDir, ".pi", "flow.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    state.current.completedFlows = [
      { type: "build", intent: "a", aim: "a", completedAt: "2026-01-01T00:00:00Z" },
      { type: "build", intent: "b", aim: "b", completedAt: "2026-01-01T00:00:00Z" },
      { type: "build", intent: "c", aim: "c", completedAt: "2026-01-01T00:00:00Z" },
    ];
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

    if (!turnEndHandler) throw new Error("turnEndHandler not set");
    await turnEndHandler(makeTurnEndEvent("hello"));

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].content).toContain("<flow-loop-warp>");
  });

  it("budget not exceeded + loop active sends loop continuation prompt (not regular)", async () => {
    registerSession("session-d");
    setGoal(tmpDir, "Loop goal", { maxTokens: 1000, maxFlows: 10, sessionId: "session-d" });
    setLoop(tmpDir, {
      objective: "Loop goal",
      status: "active",
      sessionCount: 2,
      totalTokensAcrossSessions: 500,
      totalFlowsAcrossSessions: 4,
    });

    if (!turnEndHandler) throw new Error("turnEndHandler not set");
    await turnEndHandler(makeTurnEndEvent("do the thing"));

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].content).toContain("<flow-continuation>");
    expect(sentMessages[0].content).toContain("endless loop session");
    expect(sentMessages[0].content).toContain("2 sessions");
    expect(sentMessages[0].content).toContain("500 tokens total");
    expect(sentMessages[0].opts.triggerTurn).toBe(true);
  });

  it("pendingWarpSessionId blocks turn_end from old session", async () => {
    registerSession("session-e");
    setGoal(tmpDir, "Loop goal", { sessionId: "session-e" });
    setLoop(tmpDir, {
      objective: "Loop goal",
      status: "active",
      sessionCount: 1,
      totalTokensAcrossSessions: 100,
      totalFlowsAcrossSessions: 2,
      pendingWarpSessionId: "session-f",
    });

    if (!turnEndHandler) throw new Error("turnEndHandler not set");
    await turnEndHandler(makeTurnEndEvent("hello"));

    expect(sentMessages.length).toBe(0);
  });
});
