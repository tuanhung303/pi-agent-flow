import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setupFlowCommand } from "../src/flow/command.js";
import { setGoal, clearGoal, flushAllStoreCaches, _clearStoreCache } from "../src/flow/store.js";
import { clearLoop } from "../src/flow/loop.js";

describe("setupFlowCommand", () => {
  let tmpDir: string;
  let registered: Record<string, { description: string; handler: Function }>;
  let notifyCalls: Array<{ msg: string; type: string }>;
  let sendMessages: Array<{ content: string; display: boolean; opts: any }>;
  let mockPi: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-flow-command-test-"));
    registered = {};
    notifyCalls = [];
    sendMessages = [];
    mockPi = {
      registerCommand: vi.fn((name: string, def: any) => {
        registered[name] = def;
      }),
      sendMessage: vi.fn((msg: any, opts: any) => {
        sendMessages.push({ content: msg.content, display: msg.display, opts });
      }),
    };
    setupFlowCommand(mockPi);
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

  it("registers flow:goal command", () => {
    expect(mockPi.registerCommand).toHaveBeenCalledWith("flow:goal", expect.any(Object));
    expect(registered["flow:goal"]).toBeDefined();
  });

  it("set with objective creates goal and sends hidden message", async () => {
    const handler = registered["flow:goal"].handler;
    await handler("set refactor auth layer", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Goal set: refactor auth layer", type: "info" });
    expect(sendMessages.length).toBe(1);
    expect(sendMessages[0].content).toContain("Objective: refactor auth layer");
    expect(sendMessages[0].display).toBe(false);
    expect(sendMessages[0].opts.triggerTurn).toBe(true);
  });

  it("set parses --acceptance flag", async () => {
    const handler = registered["flow:goal"].handler;
    await handler("set build auth --acceptance All tests pass", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Goal set: build auth", type: "info" });
    expect(sendMessages[0].content).toContain("Acceptance: All tests pass");
  });

  it("set parses --max-tokens flag", async () => {
    const handler = registered["flow:goal"].handler;
    await handler("set optimize --max-tokens 5000", makeCtx());
    await flushAllStoreCaches();
    const goal = JSON.parse(fs.readFileSync(path.join(tmpDir, ".pi", "flow.json"), "utf-8")).current;
    expect(goal.maxTokens).toBe(5000);
  });

  it("set parses --max-flows flag", async () => {
    const handler = registered["flow:goal"].handler;
    await handler("set optimize --max-flows 5", makeCtx());
    await flushAllStoreCaches();
    const goal = JSON.parse(fs.readFileSync(path.join(tmpDir, ".pi", "flow.json"), "utf-8")).current;
    expect(goal.maxFlows).toBe(5);
  });

  it("set errors when objective is empty", async () => {
    const handler = registered["flow:goal"].handler;
    await handler("set ", makeCtx());
    expect(notifyCalls).toContainEqual({
      msg: "Usage: /flow:goal set <objective> [--acceptance <text>] [--max-tokens <n>] [--max-flows <n>]",
      type: "error",
    });
  });

  it("clear removes active goal", async () => {
    setGoal(tmpDir, "test", { sessionId: "session-test" });
    const handler = registered["flow:goal"].handler;
    await handler("clear", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Goal cleared", type: "info" });
    await flushAllStoreCaches();
    const state = JSON.parse(fs.readFileSync(path.join(tmpDir, ".pi", "flow.json"), "utf-8"));
    expect(state.current).toBeUndefined();
  });

  it("pause pauses active goal", async () => {
    setGoal(tmpDir, "test", { sessionId: "session-test" });
    const handler = registered["flow:goal"].handler;
    await handler("pause", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Goal paused", type: "info" });
    await flushAllStoreCaches();
    const state = JSON.parse(fs.readFileSync(path.join(tmpDir, ".pi", "flow.json"), "utf-8"));
    expect(state.current.status).toBe("paused");
  });

  it("pause errors when no goal in session", async () => {
    setGoal(tmpDir, "test", { sessionId: "other-session" });
    const handler = registered["flow:goal"].handler;
    await handler("pause", makeCtx("session-test"));
    expect(notifyCalls).toContainEqual({ msg: "No active goal in this session to pause", type: "error" });
  });

  it("pause errors when no goal at all", async () => {
    const handler = registered["flow:goal"].handler;
    await handler("pause", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "No active goal to pause", type: "error" });
  });

  it("resume resumes paused goal", async () => {
    setGoal(tmpDir, "test", { sessionId: "session-test" });
    const handler = registered["flow:goal"].handler;
    await handler("pause", makeCtx());
    notifyCalls.length = 0;
    sendMessages.length = 0;
    await handler("resume", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Goal resumed", type: "info" });
    expect(sendMessages[0].content).toContain("Goal resumed");
    await flushAllStoreCaches();
    const state = JSON.parse(fs.readFileSync(path.join(tmpDir, ".pi", "flow.json"), "utf-8"));
    expect(state.current.status).toBe("active");
  });

  it("resume warns when goal is already active", async () => {
    setGoal(tmpDir, "test", { sessionId: "session-test" });
    const handler = registered["flow:goal"].handler;
    await handler("resume", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Goal is already active", type: "info" });
  });

  it("resume info when goal belongs to another session and already active", async () => {
    setGoal(tmpDir, "test", { sessionId: "other-session" });
    const handler = registered["flow:goal"].handler;
    await handler("resume", makeCtx("session-test"));
    expect(notifyCalls).toContainEqual({
      msg: "Goal is already active in another session",
      type: "info",
    });
  });

  it("resume errors when no goal exists", async () => {
    const handler = registered["flow:goal"].handler;
    await handler("resume", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "No goal to resume", type: "error" });
  });

  it("edit updates objective", async () => {
    setGoal(tmpDir, "old objective", { sessionId: "session-test" });
    const handler = registered["flow:goal"].handler;
    await handler("edit new objective", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Goal updated: new objective", type: "info" });
    await flushAllStoreCaches();
    const state = JSON.parse(fs.readFileSync(path.join(tmpDir, ".pi", "flow.json"), "utf-8"));
    expect(state.current.objective).toBe("new objective");
    expect(sendMessages[0].content).toContain("Previous: old objective");
  });

  it("edit parses --acceptance flag", async () => {
    setGoal(tmpDir, "old", { sessionId: "session-test" });
    const handler = registered["flow:goal"].handler;
    await handler("edit new --acceptance All pass", makeCtx());
    await flushAllStoreCaches();
    const state = JSON.parse(fs.readFileSync(path.join(tmpDir, ".pi", "flow.json"), "utf-8"));
    expect(state.current.acceptance).toBe("All pass");
  });

  it("edit errors when no goal in session", async () => {
    setGoal(tmpDir, "test", { sessionId: "other" });
    const handler = registered["flow:goal"].handler;
    await handler("edit new", makeCtx("session-test"));
    expect(notifyCalls).toContainEqual({ msg: "No active goal in this session to edit", type: "error" });
  });

  it("edit errors when no goal at all", async () => {
    const handler = registered["flow:goal"].handler;
    await handler("edit new", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "No active goal to edit", type: "error" });
  });

  it("status shows goal info", async () => {
    setGoal(tmpDir, "test status", { sessionId: "session-test", acceptance: "Done" });
    const handler = registered["flow:goal"].handler;
    notifyCalls.length = 0;
    await handler("status", makeCtx());
    const statusCall = notifyCalls.find((n) => n.type === "info");
    expect(statusCall).toBeDefined();
    expect(statusCall!.msg).toContain("test status");
    expect(statusCall!.msg).toContain("Done");
  });

  it("show falls back to any goal with session note", async () => {
    setGoal(tmpDir, "other session goal", { sessionId: "other" });
    const handler = registered["flow:goal"].handler;
    notifyCalls.length = 0;
    await handler("show", makeCtx("session-test"));
    const statusCall = notifyCalls.find((n) => n.type === "info");
    expect(statusCall).toBeDefined();
    expect(statusCall!.msg).toContain("other session goal");
    expect(statusCall!.msg).toContain("belongs to another session");
  });

  it("status shows no goal when none exists", async () => {
    const handler = registered["flow:goal"].handler;
    await handler("status", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "No active goal", type: "info" });
  });

  it("complete marks goal completed", async () => {
    setGoal(tmpDir, "test", { sessionId: "session-test" });
    const handler = registered["flow:goal"].handler;
    await handler("complete", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "Goal marked as completed", type: "info" });
    await flushAllStoreCaches();
    const state = JSON.parse(fs.readFileSync(path.join(tmpDir, ".pi", "flow.json"), "utf-8"));
    expect(state.current.status).toBe("completed");
  });

  it("complete errors when no goal in session", async () => {
    setGoal(tmpDir, "test", { sessionId: "other" });
    const handler = registered["flow:goal"].handler;
    await handler("complete", makeCtx("session-test"));
    expect(notifyCalls).toContainEqual({ msg: "No active goal in this session to complete", type: "error" });
  });

  it("complete errors when no goal at all", async () => {
    const handler = registered["flow:goal"].handler;
    await handler("complete", makeCtx());
    expect(notifyCalls).toContainEqual({ msg: "No active goal to complete", type: "error" });
  });

  it("unknown subcommand shows error", async () => {
    const handler = registered["flow:goal"].handler;
    await handler("unknown", makeCtx());
    expect(notifyCalls).toContainEqual({
      msg: "Unknown subcommand. Usage: /flow:goal {set|clear|pause|resume|complete|edit|status|show}",
      type: "error",
    });
  });
});
