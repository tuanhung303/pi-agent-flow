/**
 * Flow goal module — barrel export and registration entry point.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SpawnContinuation } from "./types.js";
import { setupFlowGoalCommand } from "./command.js";
import { setupContinuation } from "./continuation.js";

export type {
  FlowGoalState,
  FlowGoalEntry,
  FlowGoalStatus,
  GoalContext,
  SpawnContinuation,
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
  spawnContinuation?: SpawnContinuation,
): void {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    _currentCwd = ctx.cwd;
  });

  setupFlowGoalCommand(pi, () => _currentCwd);

  const defaultSpawn: SpawnContinuation = async (flows) => {
    const lines = flows.map((f) => `- ${f.type}: ${f.aim} — ${f.intent}`).join("\n");
    pi.sendMessage(
      { content: `Autonomous continuation required:\n${lines}\n\nExecute these flows to advance the current goal.`, display: true },
      { triggerTurn: true },
    );
  };

  setupContinuation(pi, () => _currentCwd, spawnContinuation ?? defaultSpawn);
}
