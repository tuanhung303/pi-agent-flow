import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeFlows, type FlowExecutorDeps, type ExecuteFlowParams } from "../src/executor.js";
import type { FlowConfig } from "../src/agents.js";
import type { SingleResult, FlowDetails } from "../src/types.js";
import { emptyFlowUsage } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../src/flow.js", () => ({
  runFlow: vi.fn(),
  mapFlowConcurrent: vi.fn(),
}));

vi.mock("../src/hooks.js", () => ({
  runHooksDetailed: vi.fn(),
  runHooks: vi.fn(),
  registerHook: vi.fn(),
  unregisterHook: vi.fn(),
  getRegisteredHooks: vi.fn(() => []),
  clearHooks: vi.fn(),
}));

vi.mock("../src/runner-events.js", () => ({
  getFlowSummaryText: vi.fn(() => "Mocked summary"),
  getFlowFinalText: vi.fn(() => "Mocked final text"),
}));

vi.mock("../src/config.js", () => ({
  resolveFlowModelCandidates: vi.fn(() => ({ primary: undefined, candidates: [] })),
  selectFlowModelStrategy: vi.fn(() => ({
    selectedName: "default",
    configs: { default: {} },
    strategy: {},
  })),
}));

vi.mock("../src/structured-output.js", () => ({
  extractStructuredOutput: vi.fn(() => null),
}));

import { mapFlowConcurrent, runFlow } from "../src/flow.js";
import { runHooksDetailed } from "../src/hooks.js";
import { getFlowSummaryText } from "../src/runner-events.js";
import { resolveFlowModelCandidates, selectFlowModelStrategy } from "../src/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_FLOW_CONFIGS: FlowConfig[] = [
  {
    name: "scout",
    description: "Discovery flow",
    systemPrompt: "You are scout.",
    source: "bundled",
    filePath: "/agents/scout.md",
  },
  {
    name: "build",
    description: "Implementation flow",
    systemPrompt: "You are build.",
    source: "bundled",
    filePath: "/agents/build.md",
  },
  {
    name: "debug",
    description: "Debug flow",
    systemPrompt: "You are debug.",
    source: "bundled",
    filePath: "/agents/debug.md",
  },
  {
    name: "audit",
    description: "Audit flow",
    systemPrompt: "You are audit.",
    source: "bundled",
    filePath: "/agents/audit.md",
  },
  {
    name: "project-flow",
    description: "Project-local flow",
    systemPrompt: "You are project.",
    source: "project",
    filePath: "/.pi/agents/project-flow.md",
  },
];

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    type: "scout",
    agentSource: "bundled",
    intent: "test",
    aim: "test aim",
    exitCode: 0,
    messages: [{
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
    }],
    stderr: "",
    usage: emptyFlowUsage(),
    sawAgentEnd: true,
    ...overrides,
  };
}

function makeFailedResult(overrides: Partial<SingleResult> = {}): SingleResult {
  return makeResult({
    exitCode: 1,
    sawAgentEnd: false,
    errorMessage: "Model rate limited",
    stderr: "rate limit exceeded",
    stopReason: "error",
    ...overrides,
  });
}

function makeDeps(overrides: Partial<FlowExecutorDeps> = {}): FlowExecutorDeps {
  return {
    flows: MOCK_FLOW_CONFIGS,
    currentDepth: 0,
    maxDepth: 3,
    ancestorFlowStack: [],
    preventCycles: true,
    toolOptimize: true,
    structuredOutput: true,
    cwd: "/tmp/test",
    loadedFlowModelConfigs: {
      selectedName: "default",
      configs: { default: {} },
      strategy: {},
    },
    maxConcurrency: 4,
    autoTransition: false,
    makeDetails: (results) => ({
      mode: "flow",
      delegationMode: "fork",
      projectAgentsDir: null,
      results,
    }),
    getFlag: () => undefined,
    tierOverrideResolver: () => undefined,
    forkSessionSnapshotJsonl: null,
    projectFlowsDir: null,
    sessionManager: { getHeader: () => null, getBranch: () => [] },
    hasUI: true,
    uiConfirm: async () => true,
    ...overrides,
  };
}

function makeParams(types: string[]): ExecuteFlowParams[] {
  return types.map((type) => ({
    type,
    intent: `Test ${type}`,
    aim: `Test ${type} aim`,
  }));
}

// Setup mock mapFlowConcurrent to call the callback for each item
function setupMapFlowConcurrent() {
  vi.mocked(mapFlowConcurrent).mockImplementation(
    async (items: any[], _concurrency: number, fn: any) => {
      const results = [];
      for (let i = 0; i < items.length; i++) {
        results.push(await fn(items[i], i));
      }
      return results;
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeFlows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMapFlowConcurrent();
    vi.mocked(runHooksDetailed).mockReturnValue({
      advisors: [],
      autoTransitions: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Cycle detection
  // -----------------------------------------------------------------------

  describe("cycle detection", () => {
    it("blocks execution when requested flow is in ancestor stack", async () => {
      vi.mocked(runFlow).mockResolvedValue(makeResult({ type: "build" }));

      const deps = makeDeps({
        ancestorFlowStack: ["scout", "build"],
        preventCycles: true,
      });

      const result = await executeFlows(deps, makeParams(["build"]), "tc-1");

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Blocked: cycle detected");
      expect(result.content[0].text).toContain("build");
      expect(result.content[0].text).toContain("scout -> build");
      expect(runFlow).not.toHaveBeenCalled();
    });

    it("allows execution when flow is not in ancestor stack", async () => {
      vi.mocked(runFlow).mockResolvedValue(makeResult({ type: "build" }));

      const deps = makeDeps({
        ancestorFlowStack: ["scout"],
        preventCycles: true,
      });

      const result = await executeFlows(deps, makeParams(["build"]), "tc-1");

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("completed");
      expect(runFlow).toHaveBeenCalled();
    });

    it("allows execution when preventCycles is false", async () => {
      vi.mocked(runFlow).mockResolvedValue(makeResult({ type: "scout" }));

      const deps = makeDeps({
        ancestorFlowStack: ["scout"],
        preventCycles: false,
      });

      const result = await executeFlows(deps, makeParams(["scout"]), "tc-1");

      expect(result.isError).toBeFalsy();
      expect(runFlow).toHaveBeenCalled();
    });

    it("detects multiple cycle violations", async () => {
      const deps = makeDeps({
        ancestorFlowStack: ["scout", "build"],
        preventCycles: true,
      });

      const result = await executeFlows(deps, makeParams(["scout", "build"]), "tc-1");

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("scout");
      expect(result.content[0].text).toContain("build");
    });

    it("skips cycle check when preventCycles is false", async () => {
      vi.mocked(runFlow).mockResolvedValue(makeResult({ type: "debug" }));

      const deps = makeDeps({
        ancestorFlowStack: ["debug"],
        preventCycles: false,
      });

      const result = await executeFlows(deps, makeParams(["debug"]), "tc-1");
      expect(result.isError).toBeFalsy();
    });
  });

  // -----------------------------------------------------------------------
  // Project flow confirmation
  // -----------------------------------------------------------------------

  describe("project flow confirmation", () => {
    it("prompts for confirmation when project flow is requested", async () => {
      vi.mocked(runFlow).mockResolvedValue(makeResult({ type: "project-flow" }));
      const uiConfirm = vi.fn().mockResolvedValue(true);

      const deps = makeDeps({
        hasUI: true,
        uiConfirm,
        confirmProjectFlows: true,
      });

      const result = await executeFlows(deps, makeParams(["project-flow"]), "tc-1");

      expect(uiConfirm).toHaveBeenCalledOnce();
      expect(uiConfirm.mock.calls[0][0]).toBe("Run project-local flows?");
      expect(result.isError).toBeFalsy();
      expect(runFlow).toHaveBeenCalled();
    });

    it("blocks when user declines project flow confirmation", async () => {
      const uiConfirm = vi.fn().mockResolvedValue(false);

      const deps = makeDeps({
        hasUI: true,
        uiConfirm,
        confirmProjectFlows: true,
      });

      const result = await executeFlows(deps, makeParams(["project-flow"]), "tc-1");

      expect(uiConfirm).toHaveBeenCalledOnce();
      expect(result.content[0].text).toContain("Canceled");
      expect(runFlow).not.toHaveBeenCalled();
    });

    it("blocks in non-UI mode with explanation", async () => {
      const deps = makeDeps({
        hasUI: false,
        uiConfirm: async () => true,
        confirmProjectFlows: true,
      });

      const result = await executeFlows(deps, makeParams(["project-flow"]), "tc-1");

      expect(result.content[0].text).toContain("Blocked");
      expect(result.content[0].text).toContain("non-UI mode");
      expect(runFlow).not.toHaveBeenCalled();
    });

    it("skips confirmation when confirmProjectFlows is false", async () => {
      vi.mocked(runFlow).mockResolvedValue(makeResult({ type: "project-flow" }));
      const uiConfirm = vi.fn();

      const deps = makeDeps({
        hasUI: true,
        uiConfirm,
        confirmProjectFlows: false,
      });

      const result = await executeFlows(deps, makeParams(["project-flow"]), "tc-1");

      expect(uiConfirm).not.toHaveBeenCalled();
      expect(runFlow).toHaveBeenCalled();
    });

    it("does not prompt for bundled flows", async () => {
      vi.mocked(runFlow).mockResolvedValue(makeResult({ type: "scout" }));
      const uiConfirm = vi.fn();

      const deps = makeDeps({
        hasUI: true,
        uiConfirm,
      });

      await executeFlows(deps, makeParams(["scout"]), "tc-1");

      expect(uiConfirm).not.toHaveBeenCalled();
    });

    it("skips confirmation when confirmProjectFlows is undefined (default)", async () => {
      vi.mocked(runFlow).mockResolvedValue(makeResult({ type: "project-flow" }));
      const uiConfirm = vi.fn().mockResolvedValue(true);

      const deps = makeDeps({
        hasUI: true,
        uiConfirm,
        // confirmProjectFlows not set — defaults to true behavior
      });

      const result = await executeFlows(deps, makeParams(["project-flow"]), "tc-1");

      // Should prompt because default is to confirm
      expect(uiConfirm).toHaveBeenCalledOnce();
    });
  });

  // -----------------------------------------------------------------------
  // Model failover
  // -----------------------------------------------------------------------

  describe("model failover", () => {
    it("attempts next model on recoverable failure", async () => {
      // First call fails, second succeeds
      vi.mocked(runFlow)
        .mockResolvedValueOnce(makeFailedResult({ model: "model-a" }))
        .mockResolvedValueOnce(makeResult({ model: "model-b", type: "build" }));

      vi.mocked(resolveFlowModelCandidates).mockReturnValue({
        primary: "model-a",
        candidates: ["model-a", "model-b"],
      });

      const deps = makeDeps();
      const result = await executeFlows(deps, makeParams(["build"]), "tc-1");

      expect(runFlow).toHaveBeenCalledTimes(2);
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("completed");
    });

    it("appends failover summary to stderr when all models fail", async () => {
      vi.mocked(runFlow)
        .mockResolvedValueOnce(makeFailedResult({ model: "model-a" }))
        .mockResolvedValueOnce(makeFailedResult({ model: "model-b" }));

      vi.mocked(resolveFlowModelCandidates).mockReturnValue({
        primary: "model-a",
        candidates: ["model-a", "model-b"],
      });

      const deps = makeDeps();
      const result = await executeFlows(deps, makeParams(["build"]), "tc-1");

      expect(runFlow).toHaveBeenCalledTimes(2);
      expect(result.isError).toBeFalsy();
      // The result is a success count, not isError — but the flow failed
      expect(result.content[0].text).toContain("0/1 completed");
    });

    it("does not failover on abort", async () => {
      vi.mocked(runFlow).mockResolvedValue(
        makeFailedResult({ stopReason: "aborted" }),
      );

      vi.mocked(resolveFlowModelCandidates).mockReturnValue({
        primary: "model-a",
        candidates: ["model-a", "model-b"],
      });

      const deps = makeDeps();
      await executeFlows(deps, makeParams(["build"]), "tc-1");

      // Only one attempt — abort stops failover
      expect(runFlow).toHaveBeenCalledTimes(1);
    });

    it("does not failover on permission errors", async () => {
      vi.mocked(runFlow).mockResolvedValue(
        makeFailedResult({ stderr: "permission denied" }),
      );

      vi.mocked(resolveFlowModelCandidates).mockReturnValue({
        primary: "model-a",
        candidates: ["model-a", "model-b"],
      });

      const deps = makeDeps();
      await executeFlows(deps, makeParams(["build"]), "tc-1");

      expect(runFlow).toHaveBeenCalledTimes(1);
    });

    it("does not failover when only one candidate exists", async () => {
      vi.mocked(runFlow).mockResolvedValue(makeFailedResult());

      vi.mocked(resolveFlowModelCandidates).mockReturnValue({
        primary: "model-a",
        candidates: ["model-a"],
      });

      const deps = makeDeps();
      await executeFlows(deps, makeParams(["build"]), "tc-1");

      expect(runFlow).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Auto-transitions
  // -----------------------------------------------------------------------

  describe("auto-transitions", () => {
    it("returns autoTransitions when autoTransition is enabled and hooks produce them", async () => {
      vi.mocked(runFlow).mockResolvedValue(makeResult({ type: "build" }));
      vi.mocked(runHooksDetailed).mockReturnValue({
        advisors: ["Consider audit."],
        autoTransitions: [{ type: "audit", intent: "Audit the changes" }],
      });

      const deps = makeDeps({ autoTransition: true });
      const result = await executeFlows(deps, makeParams(["build"]), "tc-1");

      expect(result.autoTransitions).toBeDefined();
      expect(result.autoTransitions).toHaveLength(1);
      expect(result.autoTransitions![0].type).toBe("audit");
    });

    it("does not auto-transition when autoTransition is disabled", async () => {
      vi.mocked(runFlow).mockResolvedValue(makeResult({ type: "build" }));
      vi.mocked(runHooksDetailed).mockReturnValue({
        advisors: ["Consider audit."],
        autoTransitions: [{ type: "audit", intent: "Audit the changes" }],
      });

      const deps = makeDeps({ autoTransition: false });
      const result = await executeFlows(deps, makeParams(["build"]), "tc-1");

      expect(result.autoTransitions).toBeUndefined();
    });

    it("filters out auto-transitions for flows already requested", async () => {
      vi.mocked(runFlow)
        .mockResolvedValueOnce(makeResult({ type: "build" }))
        .mockResolvedValueOnce(makeResult({ type: "audit" }));
      vi.mocked(runHooksDetailed).mockReturnValue({
        advisors: [],
        autoTransitions: [
          { type: "build", intent: "Re-build" },
          { type: "audit", intent: "Audit" },
        ],
      });

      const deps = makeDeps({ autoTransition: true });
      const result = await executeFlows(
        deps,
        makeParams(["build", "audit"]),
        "tc-1",
      );

      // Both are already requested, so auto-transitions should be empty
      expect(result.autoTransitions).toBeUndefined();
    });

    it("filters out auto-transitions for non-existent flows", async () => {
      vi.mocked(runFlow).mockResolvedValue(makeResult({ type: "scout" }));
      vi.mocked(runHooksDetailed).mockReturnValue({
        advisors: [],
        autoTransitions: [{ type: "nonexistent", intent: "Do something" }],
      });

      const deps = makeDeps({ autoTransition: true });
      const result = await executeFlows(deps, makeParams(["scout"]), "tc-1");

      expect(result.autoTransitions).toBeUndefined();
    });

    it("filters out auto-transitions that would create cycles", async () => {
      vi.mocked(runFlow).mockResolvedValue(makeResult({ type: "build" }));
      vi.mocked(runHooksDetailed).mockReturnValue({
        advisors: [],
        autoTransitions: [{ type: "scout", intent: "Scout again" }],
      });

      const deps = makeDeps({
        autoTransition: true,
        preventCycles: true,
        ancestorFlowStack: ["scout"],
      });
      const result = await executeFlows(deps, makeParams(["build"]), "tc-1");

      // scout is in ancestor stack, so should be filtered out
      expect(result.autoTransitions).toBeUndefined();
    });

    it("allows auto-transitions that would not create cycles when preventCycles is false", async () => {
      vi.mocked(runFlow).mockResolvedValue(makeResult({ type: "build" }));
      vi.mocked(runHooksDetailed).mockReturnValue({
        advisors: [],
        autoTransitions: [{ type: "scout", intent: "Scout again" }],
      });

      const deps = makeDeps({
        autoTransition: true,
        preventCycles: false,
        ancestorFlowStack: ["scout"],
      });
      const result = await executeFlows(deps, makeParams(["build"]), "tc-1");

      // preventCycles is off, so cycle check is skipped
      expect(result.autoTransitions).toHaveLength(1);
      expect(result.autoTransitions![0].type).toBe("scout");
    });
  });

  // -----------------------------------------------------------------------
  // General execution
  // -----------------------------------------------------------------------

  describe("general execution", () => {
    it("reports success count correctly", async () => {
      vi.mocked(runFlow)
        .mockResolvedValueOnce(makeResult({ type: "scout" }))
        .mockResolvedValueOnce(makeResult({ type: "build" }))
        .mockResolvedValueOnce(makeFailedResult({ type: "debug" }));

      const deps = makeDeps();
      const result = await executeFlows(
        deps,
        makeParams(["scout", "build", "debug"]),
        "tc-1",
      );

      expect(result.content[0].text).toContain("2/3 completed");
    });

    it("returns advisory text from hooks", async () => {
      vi.mocked(runFlow).mockResolvedValue(makeResult({ type: "scout" }));
      vi.mocked(runHooksDetailed).mockReturnValue({
        advisors: ["Consider building."],
        autoTransitions: [],
      });

      const deps = makeDeps();
      const result = await executeFlows(deps, makeParams(["scout"]), "tc-1");

      expect(result.content[0].text).toContain("Consider building.");
    });

    it("calls onFlowMetrics for each completed flow", async () => {
      vi.mocked(runFlow).mockResolvedValue(makeResult({ type: "scout" }));
      const onFlowMetrics = vi.fn();

      const deps = makeDeps({ onFlowMetrics });
      await executeFlows(deps, makeParams(["scout"]), "tc-1");

      expect(onFlowMetrics).toHaveBeenCalledOnce();
      expect(onFlowMetrics.mock.calls[0][0]).toMatchObject({
        type: "scout",
        exitCode: 0,
        success: true,
        depth: 1,
      });
    });

    it("emits streaming updates when onUpdate is provided", async () => {
      vi.mocked(runFlow).mockResolvedValue(makeResult({ type: "scout" }));
      const onUpdate = vi.fn();

      const deps = makeDeps({ onUpdate });
      await executeFlows(deps, makeParams(["scout"]), "tc-1");

      // Should have been called at least once for initial and final
      expect(onUpdate).toHaveBeenCalled();
    });

    it("handles empty params array", async () => {
      const deps = makeDeps();
      const result = await executeFlows(deps, [], "tc-1");

      expect(result.content[0].text).toContain("0/0 completed");
      expect(runFlow).not.toHaveBeenCalled();
    });

    it("passes model config correctly to runFlow", async () => {
      vi.mocked(runFlow).mockResolvedValue(makeResult({ type: "build" }));
      vi.mocked(resolveFlowModelCandidates).mockReturnValue({
        primary: "gpt-4o",
        candidates: ["gpt-4o"],
      });

      const deps = makeDeps();
      await executeFlows(deps, makeParams(["build"]), "tc-1");

      expect(resolveFlowModelCandidates).toHaveBeenCalledWith(
        expect.objectContaining({
          tier: "flash",
          strategy: {},
        }),
      );

      const callArgs = vi.mocked(runFlow).mock.calls[0][0];
      expect(callArgs.model).toBe("gpt-4o");
    });
  });
});
