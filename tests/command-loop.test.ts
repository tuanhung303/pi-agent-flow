import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setupFlowCommand } from "../src/flow/command.js";
import { setupLoopCommand } from "../src/flow/loop-command.js";
import { setGoal, clearGoal } from "../src/flow/store.js";
import { getLoop, clearLoop } from "../src/flow/loop.js";

describe("goal complete hook terminates loop", () => {
  let tmpDir: string;
  let registered: Record<string, { description: string; handler: Function }>;
  let notifyCalls: Array<{ msg: string; type: string }>;
  let mockPi: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-command-loop-test-"));
    registered = {};
    notifyCalls = [];
    mockPi = {
      registerCommand: vi.fn((name: string, def: any) => {
        registered[name] = def;
      }),
      sendMessage: vi.fn(() => {}),
    };
    setupFlowCommand(mockPi);
    setupLoopCommand(mockPi);
  });

  afterEach(() => {
    clearGoal(tmpDir);
    clearLoop(tmpDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(): any {
    return {
      cwd: tmpDir,
      ui: {
        notify: (msg: string, type: string) => notifyCalls.push({ msg, type }),
      },
      sessionManager: {
        getSessionId: () => "session-test",
      },
    };
  }

  it("complete terminates non-terminated loop", async () => {
    setGoal(tmpDir, "test objective", { sessionId: "session-test" });
    await registered["flow:loop"].handler("enable", makeCtx());

    notifyCalls.length = 0;
    await registered["flow:goal"].handler("complete", makeCtx());

    expect(notifyCalls).toContainEqual({ msg: "Goal marked as completed", type: "info" });
    const loop = getLoop(tmpDir);
    expect(loop?.status).toBe("terminated");
    expect(loop?.terminationReason).toBe("goal_completed");
  });

  it("complete does not re-terminate already terminated loop", async () => {
    setGoal(tmpDir, "test objective", { sessionId: "session-test" });
    await registered["flow:loop"].handler("enable", makeCtx());
    await registered["flow:loop"].handler("stop", makeCtx());

    notifyCalls.length = 0;
    await registered["flow:goal"].handler("complete", makeCtx());

    expect(notifyCalls).toContainEqual({ msg: "Goal marked as completed", type: "info" });
    const loop = getLoop(tmpDir);
    expect(loop?.status).toBe("terminated");
    expect(loop?.terminationReason).toBe("user_disabled");
  });

  it("complete works when no loop exists", async () => {
    setGoal(tmpDir, "test objective", { sessionId: "session-test" });
    await registered["flow:goal"].handler("complete", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Goal marked as completed", type: "info" });
  });

  it("set sends hidden message containing objective", async () => {
    await registered["flow:goal"].handler("set refactor auth layer", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Goal set: refactor auth layer", type: "info" });
    expect(mockPi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Objective: refactor auth layer"),
        display: false,
      }),
      expect.objectContaining({ triggerTurn: true })
    );
  });

  it("set sends hidden message containing acceptance when provided", async () => {
    await registered["flow:goal"].handler("set refactor auth layer --acceptance All tests pass", makeCtx());
    expect(mockPi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Acceptance: All tests pass"),
        display: false,
      }),
      expect.objectContaining({ triggerTurn: true })
    );
  });

  it("resume sends hidden message containing objective", async () => {
    setGoal(tmpDir, "migrate to vitest", { sessionId: "session-test" });
    await registered["flow:goal"].handler("pause", makeCtx());
    notifyCalls.length = 0;
    mockPi.sendMessage.mockClear();

    await registered["flow:goal"].handler("resume", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Goal resumed", type: "info" });
    expect(mockPi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Objective: migrate to vitest"),
        display: false,
      }),
      expect.objectContaining({ triggerTurn: true })
    );
  });

  it("resume sends hidden message containing acceptance when provided", async () => {
    setGoal(tmpDir, "migrate to vitest", { sessionId: "session-test", acceptance: "Zero regressions" });
    await registered["flow:goal"].handler("pause", makeCtx());
    mockPi.sendMessage.mockClear();

    await registered["flow:goal"].handler("resume", makeCtx());
    expect(mockPi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Acceptance: Zero regressions"),
        display: false,
      }),
      expect.objectContaining({ triggerTurn: true })
    );
  });
});
