/**
 * Pi Flow Extension (fork-only)
 *
 * Dives into specialized flow states running as isolated pi processes.
 * Each flow receives a forked snapshot of the current session context.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { setupNotify } from "./notify/notify.js";
import { discoverFlows, getFlowTier } from "./core/agents.js";
import { getInheritedCliArgs } from "./snapshot/cli-args.js";
import { renderFlowCall, renderFlowResult } from "./tui/render.js";
import { terminateAllChildGroups } from "./core/flow.js";
import { executeFlows } from "./core/executor.js";
import { appendStrategicHintOnce, resetStrategicHintTracker, configureStrategicHint } from "./steering/tool-utils.js";
import type { SingleResult, FlowDetails, PiAgentFlowAPI } from "./types/flow.js";
import type { CompressedFlowResult } from "./types/output.js";
import { createBatchTool, createBatchReadTool, BashProcessTracker, createBatchBashPollTool } from "./batch/index.js";
import { createWebTool } from "./tools/web-tool.js";
import { createAskUserTool } from "./tools/ask-user.js";
import { stripSteeringHintText, stripSteeringHintsFromMessages, makeSteeringHintMessage, configureSteering } from "./steering/sliding-prompt.js";
import { registerFlow, getGoalForSession, recordFlowCompletion, addTokens, shutdownWakeup } from "./flow/index.js";
import * as sessionRegistry from "./core/session-registry.js";
import { createTimedBashToolDefinition } from "./tools/timed-bash.js";
import { resolveFlowDepthConfig, type FlowDepthConfig } from "./core/depth.js";
import { buildForkSessionSnapshotJsonl, sanitizeForkSnapshot, compressToolResults, compressFlowToolResults, stripBatchReadToolCalls } from "./snapshot/snapshot.js";
import { resolveSettings, type ResolvedSettings } from "./config/settings-resolver.js";
import { scrambleManager, setAnimationConfig } from "./tui/scramble/index.js";
import { createFlowRunnerFromEnv, type FlowRunner } from "./flow-runner.js";
export { logWarn, logError } from "./config/log.js";
export { type FlowColorConfig } from "./tui/flow-colors.js";

const flowResultCache = new Map<string, CompressedFlowResult[]>();
const inheritedCliArgs = getInheritedCliArgs();

const FlowItem = Type.Object({
  type: Type.String({ description: "Flow type. Matching is case-insensitive. Must correspond to an available flow name such as scout, debug, build, craft, audit, or ideas." }),
  intent: Type.String({ description: "Specific mission for this flow — target concrete files, folders, or code patterns. Be precise in final outcome/expectation and common sense, but avoid over-specifying implementation details or assuming current state that may have shifted." }),
  aim: Type.String({ description: "Extreme short intent — one sentence, 5-7 words, headline-style summary of what this flow does." }),
  acceptance: Type.Optional(Type.String({ description: "Short success criteria — one sentence stating what done looks like." })),
  cwd: Type.Optional(Type.String({ description: "Working directory override for this flow." })),
  sessionMode: Type.Optional(
    Type.Union([
      Type.Literal("fast"),
      Type.Literal("default"),
      Type.Literal("long"),
      Type.Literal("extreme_long"),
    ], { description: "Agent session budget for this flow: fast=300s, default=600s, long=900s, extreme_long=1200s. Use long or extreme_long only when the work genuinely needs the larger budget." }),
  ),
}, { title: "FlowTask", description: "A single flow task — must be a JSON object, NOT a string." });

const FlowParams = Type.Object({
  flow: Type.Array(FlowItem, {
    description: "Array of flow tasks. Each runs in its own forked process. Optional sessionMode selects the child-agent budget: fast=300s, default=600s, long=900s, extreme_long=1200s.",
    examples: [
      { type: "scout", intent: "Map auth module files and trace JWT validation path", aim: "Map auth and trace JWT" },
      { type: "audit", intent: "Audit input validation and SQL injection risks in user routes", aim: "Audit user route security" },
    ],
    minItems: 1,
  }),
  confirmProjectFlows: Type.Optional(Type.Boolean({ description: "Whether to prompt the user before running project-local flows. Default: true.", default: true })),
});

function makeFlowDetailsFactory(projectFlowsDir: string | null) {
  return (results: SingleResult[]): FlowDetails => ({
    mode: "flow",
    flowStyle: "fork",
    projectAgentsDir: projectFlowsDir,
    results,
  });
}

export { compressToolResults, compressFlowToolResults, stripBatchReadToolCalls };

export default function (pi: ExtensionAPI) {
  registerFlow(pi);
  const depthConfig: FlowDepthConfig = resolveFlowDepthConfig(pi);
  const { currentDepth, maxDepth, canDelegate, ancestorFlowStack, preventCycles } = depthConfig;

  let resolved: ResolvedSettings | undefined;
  let _sessionCtx: ExtensionContext | undefined;
  let flowRunner: FlowRunner | undefined;
  let bashTracker: BashProcessTracker | undefined;

  pi.on("session_start", async (_event, ctx) => {
    sessionRegistry.register(ctx.cwd, ctx.sessionManager.getSessionId());
    _sessionCtx = ctx;
    resolved = resolveSettings(pi, ctx.cwd);
    flowRunner = createFlowRunnerFromEnv();

    configureSteering({ enabled: resolved.steeringEnabled, customPrompt: resolved.steeringCustomPrompt });
    configureStrategicHint(resolved.steeringStrategicHint);
    setAnimationConfig({ enabled: resolved.animationEnabled, glitch: resolved.glitchEnabled });
    setupNotify(pi, ctx.cwd);
    bashTracker = new BashProcessTracker();

    const baseTools = [
      createBatchTool(pi, ctx),
      createBatchReadTool(pi, ctx),
      createTimedBashToolDefinition(pi, ctx, bashTracker),
      createBatchBashPollTool(pi, ctx, bashTracker),
      createWebTool(pi, ctx),
      createAskUserTool(pi, ctx),
    ];

    if (currentDepth === 0) {
      pi.setTools(baseTools);
    }
  });

  pi.on("session_end", async () => {
    bashTracker?.abortAll();
    await terminateAllChildGroups();
    shutdownWakeup();
  });

  pi.addTool({
    name: "flow",
    description: "Delegate work to one or more specialized flows.",
    parameters: FlowParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!resolved) {
        return {
          content: [{ type: "text", text: "Error: session not initialized" }],
          details: makeFlowDetailsFactory(null)([]),
          isError: true,
        };
      }

      const discovery = discoverFlows(ctx.cwd, "all");
      const { flows } = discovery;
      const makeDetails = makeFlowDetailsFactory(discovery.projectFlowsDir);

      const { result: forkSessionSnapshotJsonl } = sanitizeForkSnapshot(
        buildForkSessionSnapshotJsonl(ctx.sessionManager),
        flowResultCache,
        {
          forkedFrom: ctx.sessionManager.getSessionId(),
          forkedAt: new Date().toISOString(),
          depth: currentDepth + 1,
          ...(ancestorFlowStack.length > 0 ? { parentFlow: ancestorFlowStack[ancestorFlowStack.length - 1] } : {}),
        },
      );

      const getTierOverride = (tier: "lite" | "flash" | "full"): string | undefined => {
        const flagName = tier === "lite" ? "flow-lite-model" : tier === "flash" ? "flow-flash-model" : "flow-full-model";
        const runtimeValue = pi.getFlag(flagName);
        if (typeof runtimeValue === "string" && runtimeValue.trim()) return runtimeValue.trim();
        const inheritedValue = inheritedCliArgs.tieredModels?.[tier];
        return typeof inheritedValue === "string" && inheritedValue.trim() ? inheritedValue.trim() : undefined;
      };

      // Reset per-turn prompt hint state without overriding parent active tools.
// Child flow tool restrictions are still controlled by the flow runner's --tools args.
pi.on("turn_start", () => { if (currentDepth > 0 || !resolved) return; resetStrategicHintTracker(); });
const goal = getGoalForSession(ctx.cwd, sessionRegistry.getSessionId(ctx.cwd));
      const goalContext = goal ? {
        objective: goal.objective,
        acceptance: goal.acceptance,
        flowCount: goal.completedFlows.length,
        maxFlows: goal.maxFlows,
      } : undefined;

      const result = await executeFlows(
        {
          flows,
          currentDepth,
          maxDepth,
          ancestorFlowStack,
          preventCycles,
          toolOptimize: resolved.toolOptimize,
          structuredOutput: resolved.structuredOutput,
          cwd: ctx.cwd,
          loadedFlowModelConfigs: resolved.loadedFlowModelConfigs,
          maxConcurrency: resolved.maxConcurrency,
          defaultSessionMode: resolved.defaultSessionMode,
          signal,
          onUpdate,
          makeDetails,
          getFlag: (name: string) => name === "flow-mode" ? resolved!.activeRuntimeFlowMode : pi.getFlag(name),
          tierOverrideResolver: getTierOverride,
          fallbackModel: inheritedCliArgs.fallbackModel,
          forkSessionSnapshotJsonl,
          flowResultCache,
          projectFlowsDir: discovery.projectFlowsDir,
          sessionManager: ctx.sessionManager,
          hasUI: ctx.hasUI,
          uiConfirm: (title, body) => ctx.ui.confirm(title, body),
          onFlowMetrics: (metrics) => {
            if (typeof pi.emit === "function") pi.emit("pi-agent-flow:complete", metrics);
          },
          flowRunner,
          confirmProjectFlows: params.confirmProjectFlows,
          goalContext,
          goalContinuationCallback: async (results) => {
            // Reset per-turn prompt hint state without overriding parent active tools.
// Child flow tool restrictions are still controlled by the flow runner's --tools args.
pi.on("turn_start", () => { if (currentDepth > 0 || !resolved) return; resetStrategicHintTracker(); });
const goal = getGoalForSession(ctx.cwd, sessionRegistry.getSessionId(ctx.cwd));
            if (!goal) return;
            for (const r of results) {
              recordFlowCompletion(ctx.cwd, { type: r.type, intent: r.intent, aim: r.aim });
              addTokens(ctx.cwd, r.usage.input + r.usage.output);
            }
          },
        },
        params.flow.map((f: any) => ({
          type: f.type,
          intent: f.intent,
          aim: f.aim,
          acceptance: f.acceptance,
          cwd: f.cwd,
          sessionMode: f.sessionMode,
        })),
        toolCallId,
      );

      const flowToolResult = {
        content: result.content,
        details: result.details,
        isError: result.isError,
        _toolCallId: toolCallId,
      } as any;
      appendStrategicHintOnce(flowToolResult);
      return flowToolResult;
    },
    renderCall: (args, theme) => renderFlowCall(args, theme),
    renderResult: (result, { expanded }, theme, args) => renderFlowResult(result, expanded, theme, args),
  });

  const pluginApi: PiAgentFlowAPI = {
    discoverFlows: (cwd: string) => discoverFlows(cwd, "all"),
    getFlowTier: (name: string) => getFlowTier(name),
    getSettings: () => resolved ? {
      toolOptimize: resolved.toolOptimize,
      structuredOutput: resolved.structuredOutput,
      maxConcurrency: resolved.maxConcurrency,
      defaultSessionMode: resolved.defaultSessionMode,
      steeringEnabled: resolved.steeringEnabled,
      steeringCustomPrompt: resolved.steeringCustomPrompt,
      steeringStrategicHint: resolved.steeringStrategicHint,
      animationEnabled: resolved.animationEnabled,
      glitchEnabled: resolved.glitchEnabled,
      loadedFlowModelConfigs: resolved.loadedFlowModelConfigs,
      activeRuntimeFlowMode: resolved.activeRuntimeFlowMode,
    } : undefined,
    resetStrategicHintTracker,
    stripSteeringHintText,
    stripSteeringHintsFromMessages,
    makeSteeringHintMessage,
    computeActiveTools: (currentDepthArg, toolArg, canDelegateArg = canDelegate) =>
      import("./steering/flow-prompt.js").then((m) => m.computeActiveTools(currentDepthArg, toolArg, canDelegateArg)),
    buildBeforeAgentStartPrompt: (currentDepthArg, promptArg) =>
      import("./steering/flow-prompt.js").then((m) => m.buildBeforeAgentStartPrompt(currentDepthArg, promptArg)),
    scrambleManager,
  };

  if (typeof pi.emit === "function") {
    pi.emit("pi-agent-flow:ready", pluginApi);
  }
}
