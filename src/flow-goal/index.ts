/**
 * Flow goal module — barrel export and registration entry point.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SpawnContinuation, ExecuteFlowsFn } from "./types.js";
import { setupFlowGoalCommand } from "./command.js";
import { setupContinuation } from "./continuation.js";
import { recordFlowCompletion, addTokens } from "./store.js";

export type {
  FlowGoalState,
  FlowGoalEntry,
  FlowGoalStatus,
  GoalContext,
  SpawnContinuation,
  ExecuteFlowsFn,
} from "./types.js";

export {
  getGoal,
  setGoal,
  clearGoal,
  updateGoalStatus,
  updateGoalObjective,
  recordFlowCompletion,
  addTokens,
} from "./store.js";

export { setupFlowGoalCommand, setupContinuation };

let _currentCwd: string | undefined;

export function registerFlowGoal(
  pi: ExtensionAPI,
  opts?: { spawnContinuation?: SpawnContinuation; executeFlows?: ExecuteFlowsFn },
): void {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    _currentCwd = ctx.cwd;
  });

  setupFlowGoalCommand(pi, () => _currentCwd);

  const spawnFn: SpawnContinuation = opts?.spawnContinuation ?? (async (flows) => {
    if (opts?.executeFlows) {
      const results = await opts.executeFlows(flows);
      for (const r of results) {
        recordFlowCompletion(_currentCwd!, { type: r.type, intent: r.intent, aim: r.aim });
        addTokens(_currentCwd!, r.usage.input + r.usage.output);
      }
    } else {
      const flowJson = JSON.stringify({ flow: flows.map(f => ({ type: f.type, intent: f.intent, aim: f.aim, ...(f.acceptance ? { acceptance: f.acceptance } : {}) })) });
      pi.sendUserMessage(flowJson);
    }
  });

  setupContinuation(pi, () => _currentCwd, spawnFn);
}
