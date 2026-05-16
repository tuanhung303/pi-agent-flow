/**
 * Endless loop state management.
 *
 * A loop spans multiple sessions toward a persistent objective.
 */

import { readState, writeState } from "./store.js";
import type { LoopState, LoopTerminationReason } from "./types.js";

export function getLoop(cwd: string): LoopState | undefined {
  const state = readState(cwd);
  return state.loop;
}

export function enableLoop(cwd: string, objective: string): LoopState {
  const state = readState(cwd);
  if (!state.current) {
    throw new Error("Cannot enable loop: no active goal.");
  }
  const loop: LoopState = {
    objective,
    status: "active",
    sessionCount: 1,
    totalTokensAcrossSessions: 0,
    totalFlowsAcrossSessions: 0,
  };
  state.loop = loop;
  writeState(cwd, state);
  return loop;
}

export function disableLoop(cwd: string): LoopState | undefined {
  const state = readState(cwd);
  if (!state.loop) return undefined;
  state.loop.status = "paused";
  writeState(cwd, state);
  return state.loop;
}

export function resetLoop(cwd: string): LoopState | undefined {
  const state = readState(cwd);
  if (!state.loop) return undefined;
  state.loop.status = "active";
  state.loop.sessionCount = 0;
  state.loop.totalTokensAcrossSessions = 0;
  state.loop.totalFlowsAcrossSessions = 0;
  delete state.loop.terminatedAt;
  delete state.loop.terminationReason;
  writeState(cwd, state);
  return state.loop;
}

export function terminateLoop(
  cwd: string,
  reason: LoopTerminationReason,
): LoopState | undefined {
  const state = readState(cwd);
  if (!state.loop) return undefined;
  state.loop.status = "terminated";
  state.loop.terminationReason = reason;
  state.loop.terminatedAt = new Date().toISOString();
  writeState(cwd, state);
  return state.loop;
}

export function recordSessionWarp(cwd: string): LoopState | undefined {
  const state = readState(cwd);
  if (!state.loop || state.loop.status !== "active") return undefined;
  state.loop.sessionCount += 1;
  writeState(cwd, state);
  return state.loop;
}

export function setPendingWarpSessionId(cwd: string, sessionId: string): LoopState | undefined {
  const state = readState(cwd);
  if (!state.loop) return undefined;
  state.loop.pendingWarpSessionId = sessionId;
  state.loop.status = "active";
  writeState(cwd, state);
  return state.loop;
}

export function clearPendingWarpSessionId(cwd: string): LoopState | undefined {
  const state = readState(cwd);
  if (!state.loop) return undefined;
  delete state.loop.pendingWarpSessionId;
  writeState(cwd, state);
  return state.loop;
}

/** Directly set loop state (test helper). */
export function setLoop(cwd: string, loop: LoopState): void {
  const state = readState(cwd);
  state.loop = loop;
  writeState(cwd, state);
}

/** Remove loop state (test helper). */
export function clearLoop(cwd: string): void {
  const state = readState(cwd);
  delete state.loop;
  writeState(cwd, state);
}
