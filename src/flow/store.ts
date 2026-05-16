/**
 * Flow goal state persistence.
 *
 * Stores state in `.pi/flow.json` with atomic rename writes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { logWarn } from "../config/log.js";
import type { GoalEntry, GoalState, GoalStatus } from "./types.js";

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getStorePath(cwd: string): string {
  return path.join(cwd, ".pi", "flow.json");
}

function atomicWriteJson(targetPath: string, data: unknown): void {
  const dir = path.dirname(targetPath);
  ensureDir(dir);
  const tmpPath = path.join(dir, `.tmp-${path.basename(targetPath)}.${Date.now()}`);
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmpPath, targetPath);
}

export function readState(cwd: string): GoalState {
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

export function writeState(cwd: string, state: GoalState): void {
  atomicWriteJson(getStorePath(cwd), state);
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


