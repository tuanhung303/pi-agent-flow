import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performWarp } from "../src/flow/perform-warp.js";
import { setGoal, clearGoal } from "../src/flow/store.js";
import { setLoop, clearLoop } from "../src/flow/loop.js";

describe("performWarp", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-perform-warp-test-"));
  });

  afterEach(() => {
    clearGoal(tmpDir);
    clearLoop(tmpDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns error when no active goal and loop is active", async () => {
    setLoop(tmpDir, {
      objective: "test",
      status: "active",
      sessionCount: 1,
      totalTokensAcrossSessions: 0,
      totalFlowsAcrossSessions: 0,
    });
    const ctx = {
      cwd: tmpDir,
      sessionManager: { getSessionId: () => "session-1" },
    } as any;
    const result = await performWarp(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("No active goal");
  });

  it("returns success when newSession succeeds (non-loop manual warp)", async () => {
    setGoal(tmpDir, "Test goal");
    const ctx = {
      cwd: tmpDir,
      sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/session-1" },
      newSession: vi.fn().mockResolvedValue({ cancelled: false }),
    } as any;
    const result = await performWarp(ctx, {
      reviewedPrompt: "---\ncontext: test\n---\nTask: do it",
    });
    expect(result.success).toBe(true);
    expect(ctx.newSession).toHaveBeenCalled();
  });

  it("returns error when newSession is cancelled", async () => {
    setGoal(tmpDir, "Test goal");
    const ctx = {
      cwd: tmpDir,
      sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/session-1" },
      newSession: vi.fn().mockResolvedValue({ cancelled: true }),
    } as any;
    const result = await performWarp(ctx, {
      reviewedPrompt: "test",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("cancelled");
  });

  it("terminates loop on auto-warp failure when loop is active", async () => {
    setGoal(tmpDir, "Test goal");
    setLoop(tmpDir, {
      objective: "Test goal",
      status: "active",
      sessionCount: 1,
      totalTokensAcrossSessions: 0,
      totalFlowsAcrossSessions: 0,
    });
    const ctx = {
      cwd: tmpDir,
      sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/session-1" },
      newSession: vi.fn().mockRejectedValue(new Error("session error")),
    } as any;
    const result = await performWarp(ctx);
    expect(result.success).toBe(false);
    const { getLoop } = await import("../src/flow/loop.js");
    const loop = getLoop(tmpDir);
    expect(loop?.status).toBe("terminated");
    expect(loop?.terminationReason).toBe("budget_exhausted");
  });

  it("does NOT terminate loop on manual warp failure when loop is active", async () => {
    setGoal(tmpDir, "Test goal");
    setLoop(tmpDir, {
      objective: "Test goal",
      status: "active",
      sessionCount: 1,
      totalTokensAcrossSessions: 0,
      totalFlowsAcrossSessions: 0,
    });
    const ctx = {
      cwd: tmpDir,
      sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/session-1" },
      newSession: vi.fn().mockRejectedValue(new Error("session error")),
    } as any;
    const result = await performWarp(ctx, {
      reviewedPrompt: "test",
    });
    expect(result.success).toBe(false);
    const { getLoop } = await import("../src/flow/loop.js");
    const loop = getLoop(tmpDir);
    expect(loop?.status).toBe("active");
    expect(loop?.terminationReason).toBeUndefined();
  });

  it("writes source session markers when pi is provided", async () => {
    setGoal(tmpDir, "Test goal");
    const sendMessage = vi.fn();
    const appendEntry = vi.fn();
    const sendUserMessage = vi.fn();
    const pi = { sendMessage, appendEntry, sendUserMessage };
    const ctx = {
      cwd: tmpDir,
      sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/session-1" },
      newSession: vi.fn().mockResolvedValue({ cancelled: false }),
    } as any;
    const result = await performWarp(ctx, {
      reviewedPrompt: "---\ncontext: test\n---\nTask: do it",
      pi,
    });
    expect(result.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      customType: "pi-agent-flow:warp-summary",
      content: expect.stringContaining("Session context warped to a new session"),
    }));
    expect(appendEntry).toHaveBeenCalledWith("pi-agent-flow:warp", expect.objectContaining({
      sourceSessionId: "session-1",
      goal: expect.any(String),
    }));
  });

  it("seeds new session via setup callback", async () => {
    setGoal(tmpDir, "Test goal");
    const appendMessage = vi.fn();
    const appendSessionInfo = vi.fn();
    const appendCustomEntry = vi.fn();
    const sessionManager = { appendMessage, appendSessionInfo, appendCustomEntry };
    const ctx = {
      cwd: tmpDir,
      sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/session-1" },
      newSession: vi.fn().mockImplementation(({ setup }: any) => {
        return Promise.resolve().then(() => setup(sessionManager)).then(() => ({ cancelled: false }));
      }),
    } as any;
    const result = await performWarp(ctx, {
      reviewedPrompt: "---\ncontext: test\n---\nTask: do it",
    });
    expect(result.success).toBe(true);
    expect(appendMessage).toHaveBeenCalledWith({ role: "user", content: "---\ncontext: test\n---\nTask: do it" });
    expect(appendSessionInfo).toHaveBeenCalledWith("Warp: Task: do it");
    expect(appendCustomEntry).toHaveBeenCalledWith("pi-agent-flow:warp", expect.objectContaining({
      sourceSessionId: "session-1",
      warpCount: 1,
      totalTokens: 0,
    }));
  });

  it("sets correct warpCount and totalTokens when loop is active via setup", async () => {
    setGoal(tmpDir, "Test goal");
    setLoop(tmpDir, {
      objective: "Test goal",
      status: "active",
      sessionCount: 3,
      totalTokensAcrossSessions: 5000,
      totalFlowsAcrossSessions: 0,
    });
    const appendMessage = vi.fn();
    const appendSessionInfo = vi.fn();
    const appendCustomEntry = vi.fn();
    const sessionManager = { appendMessage, appendSessionInfo, appendCustomEntry };
    const ctx = {
      cwd: tmpDir,
      sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/session-1" },
      newSession: vi.fn().mockImplementation(({ setup }: any) => {
        return Promise.resolve().then(() => setup(sessionManager)).then(() => ({ cancelled: false }));
      }),
    } as any;
    const result = await performWarp(ctx, {
      reviewedPrompt: "test prompt",
    });
    expect(result.success).toBe(true);
    expect(appendMessage).toHaveBeenCalledWith({ role: "user", content: "test prompt\n\n[Loop: session 3, total tokens ≈ 5000]" });
    expect(appendSessionInfo).toHaveBeenCalledWith("Warp: Test goal");
    expect(appendCustomEntry).toHaveBeenCalledWith("pi-agent-flow:warp", expect.objectContaining({
      sourceSessionId: "session-1",
      warpCount: 3,
      totalTokens: 5000,
    }));
  });

  it("triggers agent processing via sendUserMessage when pi is provided and not cancelled", async () => {
    setGoal(tmpDir, "Test goal");
    const sendUserMessage = vi.fn();
    const sendMessage = vi.fn();
    const appendEntry = vi.fn();
    const pi = { sendUserMessage, sendMessage, appendEntry };
    const ctx = {
      cwd: tmpDir,
      sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/session-1" },
      newSession: vi.fn().mockResolvedValue({ cancelled: false }),
    } as any;
    const result = await performWarp(ctx, {
      reviewedPrompt: "test prompt",
      pi,
    });
    expect(result.success).toBe(true);
    expect(sendUserMessage).toHaveBeenCalledWith("test prompt");
  });

  it("does not trigger sendUserMessage when warp is cancelled", async () => {
    setGoal(tmpDir, "Test goal");
    const sendUserMessage = vi.fn();
    const sendMessage = vi.fn();
    const appendEntry = vi.fn();
    const pi = { sendUserMessage, sendMessage, appendEntry };
    const ctx = {
      cwd: tmpDir,
      sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/session-1" },
      newSession: vi.fn().mockResolvedValue({ cancelled: true }),
    } as any;
    const result = await performWarp(ctx, {
      reviewedPrompt: "test prompt",
      pi,
    });
    expect(result.success).toBe(false);
    expect(sendUserMessage).not.toHaveBeenCalled();
  });
});
