import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HatchetRunAdapter, HatchetRemoteRunStatus } from "../src/hatchet-run-adapter.js";
import {
  appendHatchetRunRecord,
  createHatchetRunRecord,
  loadHatchetRunRegistry,
  markHatchetRunSubmitted,
  updateHatchetRunResult,
} from "../src/hatchet-run-registry.js";
import { setupHatchetCommand } from "../src/flow/hatchet-command.js";
import { emptyFlowUsage } from "../src/types/flow.js";

// Minimal mock for ExtensionAPI and ExtensionCommandContext

function makeMockPi() {
  const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
  return {
    registerCommand: (name: string, def: any) => {
      commands[name] = def;
    },
    _commands: commands,
  };
}

function makeMockCtx(cwd: string, sessionId = "session-test") {
  const notifications: Array<{ msg: string; type: string }> = [];
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify: (msg: string, type: string) => notifications.push({ msg, type }),
    },
    _notifications: notifications,
  };
}

async function invokeCommand(pi: ReturnType<typeof makeMockPi>, args: string, ctx: ReturnType<typeof makeMockCtx>) {
  const def = pi._commands["flow:hatchet"];
  if (!def) throw new Error("Command not registered");
  await def.handler(args, ctx);
}

describe("/flow:hatchet command", () => {
  it("shows 'no runs' when workspace has no runs", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-cmd-"));
    const pi = makeMockPi();
    const ctx = makeMockCtx(cwd);
    setupHatchetCommand(pi as any);

    await invokeCommand(pi, "status", ctx);
    expect(ctx._notifications[0].msg).toContain("No Hatchet runs recorded");
  });

  it("shows active and completed Hatchet runs for current session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-cmd-"));
    const r1 = createHatchetRunRecord({ cwd, sessionId: "s1", flowType: "build", intent: "i", aim: "Build feature", paramIndex: 0, attemptIndex: 0, payloadHash: "h" });
    appendHatchetRunRecord(cwd, r1);
    markHatchetRunSubmitted(cwd, r1.id, { hatchetRunId: "remote-1", status: "running" });

    const r2 = createHatchetRunRecord({ cwd, sessionId: "s1", flowType: "scout", intent: "i", aim: "Map codebase", paramIndex: 1, attemptIndex: 0, payloadHash: "h2" });
    appendHatchetRunRecord(cwd, r2);
    updateHatchetRunResult(cwd, r2.id, { type: "scout", agentSource: "project", intent: "i", aim: "Map codebase", exitCode: 0, messages: [], stderr: "done", usage: emptyFlowUsage() });

    const pi = makeMockPi();
    const ctx = makeMockCtx(cwd, "s1");
    setupHatchetCommand(pi as any);

    await invokeCommand(pi, "status", ctx);
    const msg = ctx._notifications[0].msg;
    expect(msg).toContain("[running]");
    expect(msg).toContain("[completed]");
    expect(msg).toContain("Build feature");
    expect(msg).toContain("Map codebase");
  });

  it("reconciles runs on /flow:hatchet reconcile", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-cmd-"));
    const record = createHatchetRunRecord({ cwd, flowType: "build", intent: "i", aim: "Build", paramIndex: 0, attemptIndex: 0, payloadHash: "h" });
    appendHatchetRunRecord(cwd, record);
    markHatchetRunSubmitted(cwd, record.id, { hatchetRunId: "remote-r", status: "running" });

    const adapter: HatchetRunAdapter = {
      submit: vi.fn(async () => ({ runId: "never" })),
      getResult: vi.fn(async () => ({
        status: "completed" as const,
        result: { type: "build", agentSource: "project" as const, intent: "i", aim: "Build", exitCode: 0, messages: [], stderr: "done", usage: emptyFlowUsage() },
      })),
    };

    const pi = makeMockPi();
    const ctx = makeMockCtx(cwd);
    setupHatchetCommand(pi as any, { getAdapter: () => adapter });

    await invokeCommand(pi, "reconcile", ctx);
    const reg = loadHatchetRunRegistry(cwd);
    expect(reg.runs[0].status).toBe("completed");
    // Should notify with reconcile summary
    expect(ctx._notifications.some((n) => n.msg.toLowerCase().includes("reconcile") || n.msg.includes("1"))).toBe(true);
  });

  it("attaches to a completed run by id and renders summary", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-cmd-"));
    const record = createHatchetRunRecord({ cwd, flowType: "build", intent: "i", aim: "Attach test", paramIndex: 0, attemptIndex: 0, payloadHash: "h" });
    appendHatchetRunRecord(cwd, record);
    updateHatchetRunResult(cwd, record.id, { type: "build", agentSource: "project", intent: "i", aim: "Attach test", exitCode: 0, messages: [], stderr: "build output", usage: emptyFlowUsage() });

    const pi = makeMockPi();
    const ctx = makeMockCtx(cwd);
    setupHatchetCommand(pi as any);

    await invokeCommand(pi, `attach ${record.id}`, ctx);
    const msgs = ctx._notifications.map((n) => n.msg).join(" ");
    expect(msgs).toContain("[completed]");
    expect(msgs).toContain("build output");
  });

  it("warns clearly when cancel is unsupported", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-cmd-"));
    const record = createHatchetRunRecord({ cwd, flowType: "build", intent: "i", aim: "Cancel test", paramIndex: 0, attemptIndex: 0, payloadHash: "h" });
    appendHatchetRunRecord(cwd, record);
    markHatchetRunSubmitted(cwd, record.id, { hatchetRunId: "remote-c", status: "running" });

    const adapter: HatchetRunAdapter = {
      submit: vi.fn(async () => ({ runId: "never" })),
      getResult: vi.fn(async () => ({ status: "running" as const })),
      // No cancel method
    };

    const pi = makeMockPi();
    const ctx = makeMockCtx(cwd);
    setupHatchetCommand(pi as any, { getAdapter: () => adapter });

    await invokeCommand(pi, `cancel ${record.id}`, ctx);
    expect(ctx._notifications.some((n) => n.msg.includes("not support"))).toBe(true);
  });

  it("cancels a running run when adapter supports cancel", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-cmd-"));
    const record = createHatchetRunRecord({ cwd, flowType: "build", intent: "i", aim: "Cancel me", paramIndex: 0, attemptIndex: 0, payloadHash: "h" });
    appendHatchetRunRecord(cwd, record);
    markHatchetRunSubmitted(cwd, record.id, { hatchetRunId: "remote-cancel", status: "running" });

    const cancelFn = vi.fn(async () => {});
    const adapter: HatchetRunAdapter = {
      submit: vi.fn(async () => ({ runId: "never" })),
      getResult: vi.fn(async () => ({ status: "running" as const })),
      cancel: cancelFn,
    };

    const pi = makeMockPi();
    const ctx = makeMockCtx(cwd);
    setupHatchetCommand(pi as any, { getAdapter: () => adapter });

    await invokeCommand(pi, `cancel ${record.id}`, ctx);
    expect(cancelFn).toHaveBeenCalledWith({ runId: "remote-cancel" });
    expect(ctx._notifications.some((n) => n.msg.includes("Cancellation"))).toBe(true);
  });

  it("shows error when no adapter is configured for reconcile", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-cmd-"));
    const pi = makeMockPi();
    const ctx = makeMockCtx(cwd);
    setupHatchetCommand(pi as any); // no adapter

    await invokeCommand(pi, "reconcile", ctx);
    expect(ctx._notifications[0].type).toBe("error");
    expect(ctx._notifications[0].msg).toContain("PI_FLOW_RUNNER=hatchet");
  });

  it("shows error for unknown subcommand", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hatchet-cmd-"));
    const pi = makeMockPi();
    const ctx = makeMockCtx(cwd);
    setupHatchetCommand(pi as any);

    await invokeCommand(pi, "foobar", ctx);
    expect(ctx._notifications[0].type).toBe("error");
    expect(ctx._notifications[0].msg).toContain("Unknown subcommand");
  });
});
