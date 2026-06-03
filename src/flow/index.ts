/**
 * Flow goal module — barrel export and registration entry point.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { setupFlowCommand } from "./command.js";
import { setupSettingsCommand } from "./settings-command.js";
import setupWarp from "./warp.js";
import { setupLoopCommand } from "./loop-command.js";
import { setupContinuation } from "./continuation.js";
import { recordFlowCompletion, addTokens } from "./store.js";
import * as sessionRegistry from "./session-registry.js";

export type {
  GoalState,
  GoalEntry,
  GoalStatus,
  GoalContext,
} from "./types.js";

export type { LoopState, LoopStatus, LoopTerminationReason } from "./types.js";

export {
  getGoal,
  getGoalForSession,
  setGoal,
  clearGoal,
  updateGoalStatus,
  updateGoalObjective,
  recordFlowCompletion,
  addTokens,
  flushAllStoreCachesSync,
  _clearStoreCache,
} from "./store.js";

export {
  getLoop,
  enableLoop,
  disableLoop,
  resetLoop,
  terminateLoop,
  recordSessionWarp,
  setPendingWarpSessionId,
  clearPendingWarpSessionId,
} from "./loop.js";

export { setupFlowCommand, setupContinuation, setupWarp, setupLoopCommand };
export { markFlowCompleted, shutdownWakeup, cleanupContinuationState, clearAllContinuationState } from "./continuation.js";
export { sessionRegistry };

export function registerFlow(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    sessionRegistry.register(ctx.cwd, ctx.sessionManager.getSessionId());
  });

  setupFlowCommand(pi);
  setupSettingsCommand(pi);
  setupWarp(pi);
  setupLoopCommand(pi);
  setupContinuation(pi);
}
