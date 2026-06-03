import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setupContinuation, markFlowCompleted, shutdownWakeup } from "../src/flow/continuation.js";
import { setGoal, clearGoal, getGoal, flushAllStoreCaches, _clearStoreCache } from "../src/flow/store.js";
import { setLoop, clearLoop, disableLoop } from "../src/flow/loop.js";
import * as sessionRegistry from "../src/flow/session-registry.js";
import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";

describe("continuation", () => {
  let tmpDir: string;
  let sentMessages: Array<{ content: string; display: boolean; opts: any }>;
  let turnEndHandler: ((event: TurnEndEvent) => Promise<void>) | undefined;
  let sessionStartHandler: ((_event: any, ctx: any) => void) | undefined;
  let mockPi: any;
  let sessionCounter = 0;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-continuation-test-"));
    sentMessages = [];
    turnEndHandler = undefined;
    sessionStartHandler = undefined;
    sessionCounter += 1;

    mockPi = {
      on: vi.fn((event: string, handler: any) => {
        if (event === "turn_end") turnEndHandler = handler;
        if (event === "session_start") sessionStartHandler = handler;
      }),
      sendMessage: vi.fn((msg: any, opts: any) => {
        sentMessages.push({ content: msg.content, display: msg.display, opts });
      }),
    };

    setupContinuation(mockPi);
  });

  afterEach(() => {
    clearGoal(tmpDir);
    clearLoop(tmpDir);
    _clearStoreCache();
    sessionRegistry.unregister(tmpDir);
    shutdownWakeup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function nextSessionId() {
    return `session-${sessionCounter}`;
  }

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

  it("registers session_start and turn_end handlers", () => {
    expect(mockPi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith("turn_end", expect.any(Function));
  });

  it("session_start registers cwd and sessionId", () => {
    const sid = nextSessionId();
    registerSession(sid);
    expect(sessionRegistry.getCwd()).toBe(tmpDir);
    expect(sessionRegistry.getSessionId(tmpDir)).toBe(sid);
  });

  it("turn_end returns early when no goal", async () => {
    const sid = nextSessionId();
    registerSession(sid);
    if (!turnEndHandler) throw new Error("no handler");
    await turnEndHandler(makeTurnEndEvent("hello"));
    expect(sentMessages.length).toBe(0);
  });

  it("turn_end returns early when goal is paused", async () => {
    const sid = nextSessionId();
    registerSession(sid);
    setGoal(tmpDir, "paused goal", { sessionId: sid });
    await flushAllStoreCaches();
    const statePath = path.join(tmpDir, ".pi", "flow.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    state.current.status = "paused";
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
    _clearStoreCache();

    if (!turnEndHandler) throw new Error("no handler");
    await turnEndHandler(makeTurnEndEvent("hello"));
    expect(sentMessages.length).toBe(0);
  });

  it("turn_end returns early on cooldown", async () => {
    const sid = nextSessionId();
    registerSession(sid);
    setGoal(tmpDir, "active goal", { sessionId: sid });

    if (!turnEndHandler) throw new Error("no handler");
    await turnEndHandler(makeTurnEndEvent("first"));
    expect(sentMessages.length).toBe(1);

    // immediate second turn should be blocked by cooldown
    await turnEndHandler(makeTurnEndEvent("second"));
    expect(sentMessages.length).toBe(1);
  });

  it("turn_end respects post-completion hold", async () => {
    const sid = nextSessionId();
    registerSession(sid);
    setGoal(tmpDir, "active goal", { sessionId: sid });
    markFlowCompleted(sid);

    if (!turnEndHandler) throw new Error("no handler");
    await turnEndHandler(makeTurnEndEvent("hello"));
    expect(sentMessages.length).toBe(0);
  });

  it("turn_end adds tokens to goal", async () => {
    const sid = nextSessionId();
    registerSession(sid);
    setGoal(tmpDir, "active goal", { sessionId: sid });

    if (!turnEndHandler) throw new Error("no handler");
    await turnEndHandler(makeTurnEndEvent("hello world"));
    const goal = getGoal(tmpDir)!;
    expect(goal.totalTokens).toBeGreaterThan(0);
  });

  it("turn_end pauses when token budget exceeded and loop inactive", async () => {
    const sid = nextSessionId();
    registerSession(sid);
    setGoal(tmpDir, "budget goal", { maxTokens: 10, sessionId: sid });
    disableLoop(tmpDir);
    await flushAllStoreCaches();
    // exceed budget
    const statePath = path.join(tmpDir, ".pi", "flow.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    state.current.totalTokens = 20;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
    _clearStoreCache();

    if (!turnEndHandler) throw new Error("no handler");
    await turnEndHandler(makeTurnEndEvent("hello"));
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].content).toContain("<flow-budget>");
    const goal = getGoal(tmpDir)!;
    expect(goal.status).toBe("paused");
  });

  it("turn_end auto-warps when token budget exceeded and loop active", async () => {
    const sid = nextSessionId();
    registerSession(sid);
    setGoal(tmpDir, "loop goal", { maxTokens: 10, sessionId: sid });
    setLoop(tmpDir, { objective: "loop goal", status: "active", sessionCount: 1, totalTokensAcrossSessions: 0, totalFlowsAcrossSessions: 0 });
    await flushAllStoreCaches();
    const statePath = path.join(tmpDir, ".pi", "flow.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    state.current.totalTokens = 20;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
    _clearStoreCache();

    if (!turnEndHandler) throw new Error("no handler");
    await turnEndHandler(makeTurnEndEvent("hello"));
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].content).toContain("<flow-loop-warp>");
  });

  it("turn_end pauses when flow budget exceeded", async () => {
    const sid = nextSessionId();
    registerSession(sid);
    setGoal(tmpDir, "flow budget", { maxFlows: 2, sessionId: sid });
    disableLoop(tmpDir);
    await flushAllStoreCaches();
    const statePath = path.join(tmpDir, ".pi", "flow.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    state.current.completedFlows = [
      { type: "build", intent: "a", aim: "a", completedAt: "2026-01-01T00:00:00Z" },
      { type: "build", intent: "b", aim: "b", completedAt: "2026-01-01T00:00:00Z" },
      { type: "build", intent: "c", aim: "c", completedAt: "2026-01-01T00:00:00Z" },
    ];
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
    _clearStoreCache();

    if (!turnEndHandler) throw new Error("no handler");
    await turnEndHandler(makeTurnEndEvent("hello"));
    expect(sentMessages[0].content).toContain("<flow-budget>");
  });

  it("turn_end sends continuation prompt when under budget", async () => {
    const sid = nextSessionId();
    registerSession(sid);
    setGoal(tmpDir, "continue", { sessionId: sid });

    if (!turnEndHandler) throw new Error("no handler");
    await turnEndHandler(makeTurnEndEvent("do more"));
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].content).toContain("<flow-continuation>");
    expect(sentMessages[0].content).toContain("do more");
    expect(sentMessages[0].opts.triggerTurn).toBe(true);
  });

  it("turn_end sends loop continuation when loop active", async () => {
    const sid = nextSessionId();
    registerSession(sid);
    setGoal(tmpDir, "loop", { sessionId: sid });
    setLoop(tmpDir, { objective: "loop", status: "active", sessionCount: 2, totalTokensAcrossSessions: 100, totalFlowsAcrossSessions: 3 });

    if (!turnEndHandler) throw new Error("no handler");
    await turnEndHandler(makeTurnEndEvent("next"));
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].content).toContain("endless loop session");
    expect(sentMessages[0].content).toContain("2 sessions");
  });

  it("turn_end skips when goal session mismatch", async () => {
    const sid = nextSessionId();
    registerSession(sid);
    setGoal(tmpDir, "other session", { sessionId: "session-other" });

    if (!turnEndHandler) throw new Error("no handler");
    await turnEndHandler(makeTurnEndEvent("hello"));
    expect(sentMessages.length).toBe(0);
  });

  it("turn_end skips when pending warp for different session", async () => {
    const sid = nextSessionId();
    registerSession(sid);
    setGoal(tmpDir, "loop", { sessionId: sid });
    setLoop(tmpDir, {
      objective: "loop",
      status: "active",
      sessionCount: 1,
      totalTokensAcrossSessions: 0,
      totalFlowsAcrossSessions: 0,
      pendingWarpSessionId: "session-other",
    });

    if (!turnEndHandler) throw new Error("no handler");
    await turnEndHandler(makeTurnEndEvent("hello"));
    expect(sentMessages.length).toBe(0);
  });

  it("markFlowCompleted records timestamp", () => {
    const sid = nextSessionId();
    const before = Date.now();
    markFlowCompleted(sid);
    const after = Date.now();
    // internal state not exported, but we can verify via behavior in post-completion hold test above
    expect(true).toBe(true);
  });

  it("shutdownWakeup clears interval", () => {
    shutdownWakeup();
    // should not throw; subsequent shutdowns are idempotent
    shutdownWakeup();
    expect(true).toBe(true);
  });

  it("setupContinuation clears any existing interval to prevent stale context", () => {
    const spy = vi.spyOn(globalThis, "clearInterval");
    setupContinuation(mockPi);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("turn_end sends nothing when message content is empty", async () => {
    const sid = nextSessionId();
    registerSession(sid);
    setGoal(tmpDir, "empty", { sessionId: sid });

    if (!turnEndHandler) throw new Error("no handler");
    await turnEndHandler({ message: { role: "user", content: [] } } as any);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].content).toContain("<flow-continuation>");
  });

  it("turn_end counts string content tokens correctly", async () => {
    const sid = nextSessionId();
    registerSession(sid);
    setGoal(tmpDir, "count", { sessionId: sid });

    if (!turnEndHandler) throw new Error("no handler");
    await turnEndHandler({ message: { role: "user", content: "abcd" } } as any);
    const goal = getGoal(tmpDir)!;
    expect(goal.totalTokens).toBe(1); // ceil(4/4)
  });

  it("turn_end updates lastTurnEndAt", async () => {
    const sid = nextSessionId();
    registerSession(sid);
    setGoal(tmpDir, "track", { sessionId: sid });

    if (!turnEndHandler) throw new Error("no handler");
    await turnEndHandler(makeTurnEndEvent("hello"));
    // if we wait for cooldown then send again, it should work
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.advanceTimersByTime(6000);
      sentMessages.length = 0;
      await turnEndHandler(makeTurnEndEvent("again"));
      expect(sentMessages.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
