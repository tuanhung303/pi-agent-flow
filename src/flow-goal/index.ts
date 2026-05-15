/**
 * Flow goal module — barrel export and registration entry point.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { setupFlowGoalCommand } from "./command.js";
import { setupContinuation } from "./continuation.js";
import { recordFlowCompletion, addTokens } from "./store.js";

export type {
  FlowGoalState,
  FlowGoalEntry,
  FlowGoalStatus,
  GoalContext,
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

export function registerFlowGoal(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    _currentCwd = ctx.cwd;
  });

  setupFlowGoalCommand(pi, () => _currentCwd);
  setupContinuation(pi, () => _currentCwd);
}
