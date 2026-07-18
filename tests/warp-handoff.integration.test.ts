import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import setupWarp from "../src/flow/warp.js";
import { setupContinuation, shutdownWakeup } from "../src/flow/continuation.js";
import { beginWarpHandoff, clearGoal, clearWarpHandoff, completeWarpHandoff, getGoal, readState, restoreWarpHandoff, setGoal, _clearStoreCache } from "../src/flow/store.js";
import * as sessionRegistry from "../src/flow/session-registry.js";

async function executeWarp(
  cwd: string,
  sourceSessionId: string,
  newSessionId: string,
  beforeHandoff?: () => void,
  afterHandoff?: () => void,
): Promise<number> {
  const branch: any[] = [];
  const commands = new Map<string, any>();
  let newSessionCalls = 0;
  const pi = {
    registerCommand: (name: string, command: any) => commands.set(name, command),
    sendUserMessage: (content: string) => {
      branch.push({ type: "message", message: { role: "user", content } });
      branch.push({ type: "message", message: { role: "assistant", stopReason: "stop", content: "---\nsummary: handoff" } });
    },
  };
  setupWarp(pi as any);
  await commands.get("flow:warp").handler("continue", {
    cwd,
    model: { provider: "test", id: "test" },
    sessionManager: {
      getSessionId: () => sourceSessionId,
      getSessionFile: () => path.join(cwd, `${sourceSessionId}.jsonl`),
      getBranch: () => branch,
    },
    isIdle: () => true,
    ui: { notify: () => {} },
    newSession: async (options: any) => {
      newSessionCalls += 1;
      beforeHandoff?.();
      await options.withSession({
        sessionManager: { getSessionId: () => newSessionId },
        ui: { notify: () => {} },
        sendUserMessage: async () => {},
      });
      afterHandoff?.();
      return { cancelled: false };
    },
  });
  return newSessionCalls;
}

describe("warp handoff integration", () => {
  it("unlocks the new session before its first turn while blocking the old-session race", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-warp-handoff-"));
    const branch: any[] = [];
    const commands = new Map<string, any>();
    const handlers = new Map<string, (event: any, ctx: any) => void>();
    const continuationMessages: string[] = [];
    let resolveNewSession!: (result: { cancelled: boolean }) => void;
    const newSessionDone = new Promise<{ cancelled: boolean }>((resolve) => { resolveNewSession = resolve; });

    const pi = {
      registerCommand: (name: string, command: any) => commands.set(name, command),
      on: (name: string, handler: any) => handlers.set(name, handler),
      sendMessage: (message: { content: string }) => continuationMessages.push(message.content),
      sendUserMessage: (content: string) => {
        branch.push({ type: "message", message: { role: "user", content } });
        branch.push({ type: "message", message: { role: "assistant", stopReason: "stop", content: "---\nsummary: handoff" } });
      },
    };

    try {
      setupContinuation(pi as any);
      setupWarp(pi as any);
      const sessionStart = handlers.get("session_start")!;
      const turnEnd = handlers.get("turn_end")!;
      sessionStart({}, { cwd, sessionManager: { getSessionId: () => "old-session" } });
      // No maxTokens/maxFlows: this is the historical no-loop race.
      setGoal(cwd, "Continue safely", { sessionId: "old-session" });

      const ctx = {
        cwd,
        model: { provider: "test", id: "test" },
        sessionManager: {
          getSessionId: () => "old-session",
          getSessionFile: () => path.join(cwd, "old.jsonl"),
          getBranch: () => branch,
        },
        isIdle: () => true,
        ui: { notify: () => {} },
        newSession: async (options: any) => {
          // The old session races while distillation/session creation is pending.
          await turnEnd({ message: { role: "user", content: [{ type: "text", text: "old race" }] } });
          expect(continuationMessages).toHaveLength(0);
          sessionStart({}, { cwd, sessionManager: { getSessionId: () => "new-session" } });
          await options.withSession({
            sessionManager: { getSessionId: () => "new-session" },
            ui: { notify: () => {} },
            sendUserMessage: async () => {
              // This fires before newSession() resolves, as Pi may do on the first turn.
              await turnEnd({ message: { role: "user", content: [{ type: "text", text: "new first turn" }] } });
            },
          });
          return newSessionDone;
        },
      };

      const warpPromise = commands.get("flow:warp").handler("continue", ctx);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(readState(cwd).current?.pendingWarpSessionId).toBeUndefined();
      expect(getGoal(cwd)?.sessionId).toBe("new-session");
      expect(continuationMessages).toHaveLength(1);
      expect(continuationMessages[0]).toContain("<flow-continuation>");
      resolveNewSession({ cancelled: false });
      await warpPromise;
    } finally {
      clearGoal(cwd);
      sessionRegistry.unregister(cwd);
      _clearStoreCache();
      shutdownWakeup();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("cleans locks after both pre-handoff failure and post-handoff cancellation", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-warp-cleanup-"));
    try {
      setGoal(cwd, "Continue safely", { sessionId: "old-session" });
      beginWarpHandoff(cwd, "old-session");
      clearWarpHandoff(cwd, "old-session");
      expect(getGoal(cwd)?.pendingWarpSessionId).toBeUndefined();

      beginWarpHandoff(cwd, "old-session");
      completeWarpHandoff(cwd, "old-session", "new-session");
      restoreWarpHandoff(cwd, "old-session", "new-session");
      expect(getGoal(cwd)).toMatchObject({ sessionId: "old-session", status: "active" });
      expect(getGoal(cwd)?.pendingWarpSessionId).toBeUndefined();

      clearGoal(cwd);
      setGoal(cwd, "Legacy unbound goal");
      beginWarpHandoff(cwd, "old-session");
      completeWarpHandoff(cwd, "old-session", "new-session");
      expect(getGoal(cwd)?.sessionId).toBe("new-session");
      expect(getGoal(cwd)?.pendingWarpSessionId).toBeUndefined();
    } finally {
      clearGoal(cwd);
      _clearStoreCache();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("migrates a legacy loop lock to the active goal before continuation reads it", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-warp-migration-"));
    try {
      fs.mkdirSync(path.join(cwd, ".pi"));
      fs.writeFileSync(path.join(cwd, ".pi", "flow.json"), JSON.stringify({
        current: { id: "goal-legacy", objective: "Continue", createdAt: "now", updatedAt: "now", status: "active", completedFlows: [], totalTokens: 0, sessionId: "old-session" },
        history: [],
        loop: { objective: "Continue", status: "active", sessionCount: 1, totalTokensAcrossSessions: 0, totalFlowsAcrossSessions: 0, pendingWarpSessionId: "old-session" },
      }));
      _clearStoreCache();
      const state = readState(cwd);
      expect(state.current?.pendingWarpSessionId).toBe("old-session");
      expect(state.loop?.pendingWarpSessionId).toBeUndefined();
    } finally {
      _clearStoreCache();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not increment a loop owned by another session, but increments after an owner handoff", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-warp-owner-"));
    try {
      setGoal(cwd, "Budgeted goal", { maxFlows: 3, sessionId: "owner" });
      expect(await executeWarp(cwd, "other", "other-new")).toBe(1);
      expect(getGoal(cwd)?.sessionId).toBe("owner");
      expect(readState(cwd).loop?.sessionCount).toBe(1);

      expect(await executeWarp(cwd, "owner", "owner-new")).toBe(1);
      expect(getGoal(cwd)?.sessionId).toBe("owner-new");
      expect(readState(cwd).loop?.sessionCount).toBe(2);
    } finally {
      clearGoal(cwd);
      _clearStoreCache();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not increment loop counters when a previously acquired handoff cannot complete", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-warp-failed-"));
    try {
      setGoal(cwd, "Original goal", { maxFlows: 3, sessionId: "owner" });
      expect(await executeWarp(cwd, "owner", "owner-new", () => {
        setGoal(cwd, "Replacement goal", { maxFlows: 3, sessionId: "replacement" });
      })).toBe(1);
      expect(getGoal(cwd)).toMatchObject({ objective: "Replacement goal", sessionId: "replacement" });
      expect(readState(cwd).current?.pendingWarpSessionId).toBeUndefined();
      expect(readState(cwd).loop?.sessionCount).toBe(1);
    } finally {
      clearGoal(cwd);
      _clearStoreCache();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not increment a replacement loop after its predecessor's handoff completes", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-warp-replacement-"));
    try {
      setGoal(cwd, "Original goal", { maxFlows: 3, sessionId: "owner" });
      expect(await executeWarp(cwd, "owner", "owner-new", undefined, () => {
        // A new goal normally inherits the destination session ID, so the
        // handed-off goal ID is required to distinguish this replacement.
        setGoal(cwd, "Replacement goal", { maxFlows: 3, sessionId: "owner-new" });
      })).toBe(1);

      expect(getGoal(cwd)).toMatchObject({ objective: "Replacement goal", sessionId: "owner-new" });
      expect(readState(cwd).loop?.sessionCount).toBe(1);
    } finally {
      clearGoal(cwd);
      _clearStoreCache();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("still creates a new session for an ordinary warp with no goal", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-warp-no-goal-"));
    try {
      expect(await executeWarp(cwd, "source", "destination")).toBe(1);
      expect(readState(cwd)).toEqual({ history: [] });
    } finally {
      _clearStoreCache();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
