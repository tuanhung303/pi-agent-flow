import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setupLoopCommand } from "../src/flow/loop-command.js";
import { setGoal, clearGoal, _clearStoreCache } from "../src/flow/store.js";
import { clearLoop } from "../src/flow/loop.js";

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

  it("registers flow:loop command", () => {
    expect(mockPi.registerCommand).toHaveBeenCalledWith("flow:loop", expect.any(Object));
  });

  it("enable requires active goal", async () => {
    const handler = registered["flow:loop"].handler;
    await handler("enable", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Cannot enable loop: no active goal. Set a goal first with /flow:goal set.", type: "error" });
  });

  it("enable succeeds with active goal", async () => {
    setGoal(tmpDir, "test objective");
    const handler = registered["flow:loop"].handler;
    await handler("enable", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Loop enabled: test objective", type: "info" });
  });

  it("enable uses custom objective when provided", async () => {
    setGoal(tmpDir, "test objective");
    const handler = registered["flow:loop"].handler;
    await handler("enable custom obj", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Loop enabled: custom obj", type: "info" });
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
    expect(notifyCalls).toContainEqual({ msg: "No active loop to disable", type: "error" });
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
  });

  it("stop errors when no loop", async () => {
    const handler = registered["flow:loop"].handler;
    await handler("stop", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "No loop active", type: "error" });
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
    expect(notifyCalls).toContainEqual({ msg: "No loop to reset", type: "error" });
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
