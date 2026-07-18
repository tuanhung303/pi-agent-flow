import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setupLoopCommand } from "../src/flow/loop-command.js";
import { setGoal, getGoal, clearGoal, getGoalForSession, updateGoalStatus, _clearStoreCache } from "../src/flow/store.js";
import { clearLoop, getLoop } from "../src/flow/loop.js";

describe("setupLoopCommand", () => {
  let tmpDir: string;
  let registered: Record<string, { description: string; handler: Function }>;
  let notifyCalls: Array<{ msg: string; type: string }>;
  let mockPi: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-command-test-"));
    registered = {};
    notifyCalls = [];
    mockPi = {
      registerCommand: vi.fn((name: string, def: any) => {
        registered[name] = def;
      }),
    };
    setupLoopCommand(mockPi);
  });

  afterEach(() => {
    clearGoal(tmpDir);
    clearLoop(tmpDir);
    _clearStoreCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(sessionId = "session-test"): any {
    return {
      cwd: tmpDir,
      ui: {
        notify: (msg: string, type: string) => notifyCalls.push({ msg, type }),
      },
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };
  }

  it("registers flow:loop command", () => {
    expect(mockPi.registerCommand).toHaveBeenCalledWith("flow:loop", expect.any(Object));
  });

  it("enable requires active goal", async () => {
    const handler = registered["flow:loop"].handler;
    await handler("enable", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Cannot enable loop: no active goal. Set a goal first with /flow:goal set.", type: "error" });
  });

  it("enable succeeds with an active goal owned by this session", async () => {
    setGoal(tmpDir, "test objective", { sessionId: "session-test" });
    const handler = registered["flow:loop"].handler;
    await handler("enable", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Loop enabled: test objective", type: "info" });
  });

  it("enable allows an unbound legacy goal using the established ownership convention", async () => {
    setGoal(tmpDir, "legacy objective");
    expect(getGoalForSession(tmpDir, "session-test")?.objective).toBe("legacy objective");
    const handler = registered["flow:loop"].handler;
    await handler("enable", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Loop enabled: legacy objective", type: "info" });
  });

  it("enable rejects another session's goal without resetting loop counters", async () => {
    setGoal(tmpDir, "other objective", { maxFlows: 3, sessionId: "other-session" });
    const before = getLoop(tmpDir);
    const handler = registered["flow:loop"].handler;
    await handler("enable", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Cannot enable loop: active goal belongs to another session.", type: "error" });
    expect(getLoop(tmpDir)).toEqual(before);
  });

  it.each(["paused", "completed"] as const)("enable rejects a %s goal without resetting loop counters", async (status) => {
    setGoal(tmpDir, "inactive objective", { maxFlows: 3, sessionId: "session-test" });
    updateGoalStatus(tmpDir, status);
    const before = getLoop(tmpDir);
    const handler = registered["flow:loop"].handler;
    await handler("enable", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Cannot enable loop: goal is not active.", type: "error" });
    expect(getLoop(tmpDir)).toEqual(before);
  });

  it("enable rejects a cosmetic custom objective", async () => {
    setGoal(tmpDir, "test objective");
    const handler = registered["flow:loop"].handler;
    await handler("enable custom obj", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Usage: /flow:loop enable", type: "error" });
  });

  it.each(["disable", "stop", "reset"] as const)("%s rejects a foreign goal without changing loop state", async (subcommand) => {
    setGoal(tmpDir, "other objective", { maxFlows: 3, sessionId: "other-session" });
    const before = getLoop(tmpDir);

    await registered["flow:loop"].handler(subcommand, makeCtx());

    expect(notifyCalls).toContainEqual({
      msg: `Cannot ${subcommand} loop: active goal belongs to another session.`,
      type: "error",
    });
    expect(getLoop(tmpDir)).toEqual(before);
  });

  it.each(["disable", "stop", "reset"] as const)("%s rejects an inactive goal without changing loop state", async (subcommand) => {
    setGoal(tmpDir, "inactive objective", { maxFlows: 3, sessionId: "session-test" });
    updateGoalStatus(tmpDir, "paused");
    const before = getLoop(tmpDir);

    await registered["flow:loop"].handler(subcommand, makeCtx());

    expect(notifyCalls).toContainEqual({
      msg: `Cannot ${subcommand} loop: goal is not active.`,
      type: "error",
    });
    expect(getLoop(tmpDir)).toEqual(before);
  });

  it.each([
    ["disable", "paused"],
    ["stop", "terminated"],
    ["reset", "active"],
  ] as const)("%s permits an active goal owner to mutate its loop", async (subcommand, expectedStatus) => {
    setGoal(tmpDir, "owned objective", { maxFlows: 3, sessionId: "session-test" });

    await registered["flow:loop"].handler(subcommand, makeCtx());

    expect(getLoop(tmpDir)?.status).toBe(expectedStatus);
  });

  it("disable disables active loop", async () => {
    setGoal(tmpDir, "test objective");
    const handler = registered["flow:loop"].handler;
    await handler("enable", makeCtx());
    notifyCalls.length = 0;
    await handler("disable", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Loop disabled", type: "info" });
  });

  it("disable errors when no loop", async () => {
    const handler = registered["flow:loop"].handler;
    await handler("disable", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Cannot disable loop: no active goal.", type: "error" });
  });

  it("status shows loop state", async () => {
    setGoal(tmpDir, "test objective");
    const handler = registered["flow:loop"].handler;
    await handler("enable", makeCtx());
    notifyCalls.length = 0;
    await handler("status", makeCtx());
    const statusCall = notifyCalls.find((n) => n.type === "info" && n.msg.includes("Status:"));
    expect(statusCall).toBeDefined();
    expect(statusCall!.msg).toContain("test objective");
    expect(statusCall!.msg).toContain("active");
  });

  it("status shows no loop when none exists", async () => {
    const handler = registered["flow:loop"].handler;
    await handler("status", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "No loop active", type: "info" });
  });

  it("stop terminates loop", async () => {
    setGoal(tmpDir, "test objective");
    const handler = registered["flow:loop"].handler;
    await handler("enable", makeCtx());
    notifyCalls.length = 0;
    await handler("stop", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Loop stopped", type: "info" });
    expect(getGoal(tmpDir)?.status).toBe("active");
  });

  it("stop errors when no loop", async () => {
    const handler = registered["flow:loop"].handler;
    await handler("stop", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Cannot stop loop: no active goal.", type: "error" });
  });

  it("stop info when already terminated", async () => {
    setGoal(tmpDir, "test objective");
    const handler = registered["flow:loop"].handler;
    await handler("enable", makeCtx());
    await handler("stop", makeCtx());
    notifyCalls.length = 0;
    await handler("stop", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Loop already terminated", type: "info" });
  });

  it("reset resets loop", async () => {
    setGoal(tmpDir, "test objective");
    const handler = registered["flow:loop"].handler;
    await handler("enable", makeCtx());
    await handler("disable", makeCtx());
    notifyCalls.length = 0;
    await handler("reset", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Loop reset", type: "info" });
  });

  it("reset errors when no loop", async () => {
    const handler = registered["flow:loop"].handler;
    await handler("reset", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Cannot reset loop: no active goal.", type: "error" });
  });

  it("unknown subcommand shows usage error", async () => {
    const handler = registered["flow:loop"].handler;
    await handler("unknown", makeCtx());
    expect(notifyCalls).toContainEqual({
      msg: "Unknown subcommand. Usage: /flow:loop {enable|disable|status|stop|reset}",
      type: "error",
    });
  });
});
