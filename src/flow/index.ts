/**
 * Flow goal module — barrel export and registration entry point.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { setupFlowCommand } from "./command.js";
import { setupSettingsCommand } from "./settings-command.js";
import { setupWarpCommand } from "./warp-command.js";
import { setupContinuation } from "./continuation.js";
import { recordFlowCompletion, addTokens } from "./store.js";
import * as sessionRegistry from "../core/session-registry.js";

export type {
  GoalState,
  GoalEntry,
  GoalStatus,
  GoalContext,
} from "./types.js";

export {
  getGoal,
  getGoalForSession,
  setGoal,
  clearGoal,
  updateGoalStatus,
  updateGoalObjective,
  recordFlowCompletion,
  addTokens,
} from "./store.js";

export { setupFlowCommand, setupContinuation, setupWarpCommand };
export { markFlowCompleted, shutdownWakeup } from "./continuation.js";
export { sessionRegistry };

export function registerFlow(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    sessionRegistry.register(ctx.cwd, ctx.sessionManager.getSessionId());
  });

  setupFlowCommand(pi);
  setupSettingsCommand(pi);
  setupWarpCommand(pi);
  setupContinuation(pi);
}
