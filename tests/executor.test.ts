import { describe, expect, it, vi } from "vitest";
import { executeFlows, type FlowExecutorDeps } from "../src/core/executor.js";
import { emptyFlowUsage, type FlowDetails, type SingleResult } from "../src/types/flow.js";

vi.mock("../src/core/flow.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/flow.js")>();
  return {
    ...actual,
    runFlow: vi.fn(async (opts: any) => ({
      type: opts.flowName,
      agentSource: "project",
      intent: opts.intent,
      aim: opts.aim,
      exitCode: 0,
      messages: [],
      stderr: "direct LocalFlowRunner path should not be used when a runner is injected",
      usage: emptyFlowUsage(),
    })),
  };
});

function result(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    type: "build",
    agentSource: "project",
    intent: "Fix bug",
    aim: "Fix bug",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyFlowUsage(),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<FlowExecutorDeps> = {}): FlowExecutorDeps {
  return {
    flows: [
      {
        name: "build",
        description: "Code",
        systemPrompt: "Prompt.",
        source: "project",
        filePath: "/tmp/build.md",
      },
    ],
    currentDepth: 0,
    maxDepth: 3,
    ancestorFlowStack: [],
    preventCycles: true,
    toolOptimize: true,
    structuredOutput: true,
    cwd: "/repo",
    loadedFlowModelConfigs: { selectedName: "default", configs: { default: {} }, strategy: {} },
    maxConcurrency: 2,
    defaultSessionMode: "default",
    makeDetails: (results): FlowDetails => ({ mode: "flow", flowStyle: "fork", projectAgentsDir: null, results }),
    getFlag: () => undefined,
    tierOverrideResolver: () => undefined,
    forkSessionSnapshotJsonl: null,
    flowResultCache: new Map(),
    projectFlowsDir: "/repo/.pi/agents",
    sessionManager: { getHeader: () => ({}), getBranch: () => [], getSessionId: () => "test-session-id" },
    hasUI: false,
    uiConfirm: async () => true,
    confirmProjectFlows: false,
    goalContinuationCallback: undefined,
    goalContext: undefined,
    ...overrides,
  };
}

describe("executeFlows runner abstraction", () => {
  it("uses an injected flow runner while preserving resolved runFlow options", async () => {
    const run = vi.fn(async (opts: any) => {
      expect(opts.flowName).toBe("build");
      expect(opts.parentDepth).toBe(0);
      expect(opts.maxDepth).toBe(3);
      expect(opts.sessionMode).toBe("default");
      return result({ stderr: "from injected runner" });
    });

    const output = await executeFlows(
      makeDeps({ flowRunner: { run } } as Partial<FlowExecutorDeps>),
      [{ type: "build", intent: "Fix bug", aim: "Fix bug" }],
      "call-1",
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(output.details.results[0].stderr).toBe("from injected runner");
  });
});
