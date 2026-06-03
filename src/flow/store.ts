/**
 * Flow goal state persistence.
 *
 * Stores state in `.pi/flow.json` with atomic rename writes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { logWarn } from "../config/log.js";
import { atomicWriteJsonSync, atomicWriteJsonAsync } from "../io/atomic-write.js";
import type { GoalEntry, GoalState, GoalStatus } from "./types.js";

/*
 * NOTE: No manual ensureDir is needed here. atomicWriteFile{Sync,Async}
 * already creates the target directory via recursive mkdir.
 */

function getStorePath(cwd: string): string {
  return path.join(cwd, ".pi", "flow.json");
}

// Fix P9: Use in-memory cache with async flush to avoid blocking the event loop on goal state I/O
const _cache = new Map<string, GoalState>();
const _flushScheduled = new Set<string>();
const _inFlightFlushes = new Map<string, Promise<void>>();
const _flushHandles = new Map<string, NodeJS.Immediate>();
const _flushResolvers = new Map<string, () => void>();
const _syncFlushGeneration = new Map<string, number>(); // Generation counter for sync/async flush coordination

function readFromDisk(cwd: string): GoalState {
  const filePath = getStorePath(cwd);
  if (!fs.existsSync(filePath)) {
    return { history: [] };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as GoalState;
    if (!parsed || typeof parsed !== "object") return { history: [] };
    if (!Array.isArray(parsed.history)) parsed.history = [];
    return parsed;
  } catch (err) {
    logWarn(`[pi-agent-flow] Goal state file corrupted or unreadable at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return { history: [] };
  }
}

function deepCopy<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

export function readState(cwd: string): GoalState {
  const cached = _cache.get(cwd);
  if (cached) return deepCopy(cached);
  const state = readFromDisk(cwd);
  _cache.set(cwd, state);
  return deepCopy(state);
}

const MAX_HISTORY_ENTRIES = 5;
const MAX_INTENT_LENGTH = 200;

function pruneHistory(state: GoalState): void {
  if (state.history.length > MAX_HISTORY_ENTRIES) {
    state.history = state.history.slice(-MAX_HISTORY_ENTRIES);
  }
}

function truncateIntent(intent: string): string {
  return intent.length > MAX_INTENT_LENGTH ? intent.slice(0, MAX_INTENT_LENGTH) : intent;
}

function _scheduleFlush(cwd: string): void {
  if (_inFlightFlushes.has(cwd)) return;
  const promise = new Promise<void>((resolve) => {
    _flushResolvers.set(cwd, resolve);
    const handle = setImmediate(() => {
      _flushHandles.delete(cwd);
      flushState(cwd).finally(() => {
        _flushResolvers.delete(cwd);
        resolve();
      });
    });
    _flushHandles.set(cwd, handle);
  });
  _inFlightFlushes.set(cwd, promise);
  promise.finally(() => _inFlightFlushes.delete(cwd));
}

export function writeState(cwd: string, state: GoalState): void {
  _cache.set(cwd, deepCopy(state));
  _flushScheduled.add(cwd);
  // Capture generation at scheduling time. If a sync flush increments the
  // counter before this async flush runs, the flush will detect the mismatch
  // and abort its rename to avoid overwriting fresher data.
  _scheduleFlush(cwd);
}

async function flushState(cwd: string): Promise<void> {
  while (_flushScheduled.has(cwd)) {
    _flushScheduled.delete(cwd);
    const state = _cache.get(cwd);
    if (!state) return;

    // Capture generation at entry. If a sync flush increments this counter
    // while our async write is in-flight, our data becomes stale.
    const capturedGeneration = _syncFlushGeneration.get(cwd) ?? 0;

    try {
      await atomicWriteJsonAsync(getStorePath(cwd), state, {
        // If a sync flush incremented the generation during our async write,
        // the sync flush already persisted the latest state. Abort our rename
        // to avoid overwriting it with stale data.
        shouldAbort: () => (_syncFlushGeneration.get(cwd) ?? 0) !== capturedGeneration,
      });
    } catch (err) {
      logWarn(`[pi-agent-flow] Async flush failed for ${cwd}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // If a sync flush happened while we were writing, the sync flush already
    // persisted the latest state. Continue to process any newly scheduled writes.
    if ((_syncFlushGeneration.get(cwd) ?? 0) !== capturedGeneration) {
      continue;
    }

    // Loop if more writes were scheduled during the async write
  }
}

/** Flush all pending writes. For tests or graceful shutdown. */
export function flushAllStoreCaches(): Promise<void> {
  // Ensure every scheduled cwd has an in-flight flush
  for (const cwd of Array.from(_flushScheduled)) {
    _scheduleFlush(cwd);
  }
  // Wait for all in-flight flushes (deduplicated per cwd)
  return Promise.all(Array.from(_inFlightFlushes.values())).then(() => {});
}

/**
 * Synchronous flush of all cached store entries.
 *
 * This is the **shutdown-path fallback** only. The normal async flush
 * (`flushAllStoreCaches`) is preferred during normal operation because it
 * yields to the event loop. `process.on('exit')` handlers cannot await,
 * so this sync variant guarantees data is persisted before the process
 * terminates.
 */
export function flushAllStoreCachesSync(): void {
  for (const cwd of Array.from(_cache.keys())) {
    const state = _cache.get(cwd);
    if (!state) continue;

    // Cancel any pending setImmediate flush and resolve its promise
    const handle = _flushHandles.get(cwd);
    if (handle) {
      clearImmediate(handle);
      _flushHandles.delete(cwd);
      const resolver = _flushResolvers.get(cwd);
      if (resolver) {
        resolver();
        _flushResolvers.delete(cwd);
      }
    }
    _flushScheduled.delete(cwd);

    // Increment generation BEFORE writing. This ensures any in-flight async
    // flush will see the generation change and abort its rename.
    const currentGen = _syncFlushGeneration.get(cwd) ?? 0;
    _syncFlushGeneration.set(cwd, currentGen + 1);
    try {
      atomicWriteJsonSync(getStorePath(cwd), state);
    } catch (err) {
      logWarn(
        `[pi-agent-flow] Sync flush failed for ${cwd}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Clear the in-memory cache. For tests. */
export function _clearStoreCache(): void {
  for (const handle of _flushHandles.values()) {
    clearImmediate(handle);
  }
  for (const resolver of _flushResolvers.values()) {
    resolver();
  }
  _flushHandles.clear();
  _flushResolvers.clear();
  _cache.clear();
  _flushScheduled.clear();
  _inFlightFlushes.clear();
  _syncFlushGeneration.clear();
}

export function getGoal(cwd: string): GoalEntry | undefined {
  return readState(cwd).current;
}

export function getGoalForSession(cwd: string, sessionId: string | undefined): GoalEntry | undefined {
  const goal = getGoal(cwd);
  if (!goal) return undefined;
  if (!goal.sessionId || goal.sessionId === sessionId) return goal;
  return undefined;
}

export function setGoal(
  cwd: string,
  objective: string,
  opts?: { acceptance?: string; maxTokens?: number; maxFlows?: number; sessionId?: string },
): GoalEntry {
  const state = readState(cwd);
  const now = new Date().toISOString();
  const entry: GoalEntry = {
    id: `goal-${Date.now()}`,
    objective,
    acceptance: opts?.acceptance,
    createdAt: now,
    updatedAt: now,
    status: "active",
    completedFlows: [],
    totalTokens: 0,
    maxTokens: opts?.maxTokens,
    maxFlows: opts?.maxFlows,
    sessionId: opts?.sessionId,
  };
  if (state.current) {
    const loopActive = state.loop?.status === "active";
    state.current.status = loopActive ? "warped" : "abandoned";
    state.current.updatedAt = now;
    state.history.push(state.current);
    pruneHistory(state);
  }
  state.current = entry;
  if (opts?.maxTokens || opts?.maxFlows) {
    state.loop = {
      objective,
      status: "active",
      sessionCount: 1,
      totalTokensAcrossSessions: 0,
      totalFlowsAcrossSessions: 0,
    };
  }
  writeState(cwd, state);
  return entry;
}

export function clearGoal(cwd: string): void {
  const state = readState(cwd);
  if (state.current) {
    const loopActive = state.loop?.status === "active";
    state.current.status = loopActive ? "warped" : "abandoned";
    state.current.updatedAt = new Date().toISOString();
    state.history.push(state.current);
    pruneHistory(state);
    state.current = undefined;
  }
  writeState(cwd, state);
}

export function updateGoalStatus(cwd: string, status: GoalStatus, sessionId?: string): GoalEntry | undefined {
  const state = readState(cwd);
  if (!state.current) return undefined;
  state.current.status = status;
  if (sessionId !== undefined) state.current.sessionId = sessionId;
  state.current.updatedAt = new Date().toISOString();
  writeState(cwd, state);
  return state.current;
}

export function updateGoalObjective(
  cwd: string,
  objective: string,
  acceptance?: string,
): GoalEntry | undefined {
  const state = readState(cwd);
  if (!state.current) return undefined;
  state.current.objective = objective;
  if (acceptance !== undefined) state.current.acceptance = acceptance;
  state.current.updatedAt = new Date().toISOString();
  writeState(cwd, state);
  return state.current;
}

export function recordFlowCompletion(
  cwd: string,
  flow: { type: string; intent: string; aim: string },
): GoalEntry | undefined {
  const state = readState(cwd);
  if (!state.current) return undefined;
  state.current.completedFlows.push({
    type: flow.type,
    intent: truncateIntent(flow.intent),
    aim: flow.aim,
    completedAt: new Date().toISOString(),
  });
  state.current.updatedAt = new Date().toISOString();
  if (state.loop?.status === "active") {
    state.loop.totalFlowsAcrossSessions += 1;
  }
  writeState(cwd, state);
  return state.current;
}

export function addTokens(cwd: string, tokens: number): GoalEntry | undefined {
  const state = readState(cwd);
  if (!state.current) return undefined;
  state.current.totalTokens += tokens;
  state.current.updatedAt = new Date().toISOString();
  if (state.loop?.status === "active") {
    state.loop.totalTokensAcrossSessions += tokens;
  }
  writeState(cwd, state);
  return state.current;
}
