/**
 * Flow goal module — barrel export and registration entry point.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { setupFlowCommand } from "./command.js";
import { setupContinuation } from "./continuation.js";
import { recordFlowCompletion, addTokens } from "./store.js";

export type {
  GoalState,
  GoalEntry,
  GoalStatus,
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

export { setupFlowCommand, setupContinuation };

let _currentCwd: string | undefined;

export function registerFlow(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    _currentCwd = ctx.cwd;
  });

  setupFlowCommand(pi, () => _currentCwd);
  setupContinuation(pi, () => _currentCwd);
}
