/**
 * Flow goal state persistence.
 *
 * Stores state in `.pi/flow-goal.json` with atomic rename writes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { FlowGoalEntry, FlowGoalState, FlowGoalStatus } from "./types.js";

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getStorePath(cwd: string): string {
  return path.join(cwd, ".pi", "flow-goal.json");
}

function atomicWriteJson(targetPath: string, data: unknown): void {
  const dir = path.dirname(targetPath);
  ensureDir(dir);
  const tmpPath = path.join(dir, `.tmp-${path.basename(targetPath)}.${Date.now()}`);
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmpPath, targetPath);
}

function readState(cwd: string): FlowGoalState {
  const filePath = getStorePath(cwd);
  if (!fs.existsSync(filePath)) {
    return { history: [] };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as FlowGoalState;
    if (!parsed || typeof parsed !== "object") return { history: [] };
    if (!Array.isArray(parsed.history)) parsed.history = [];
    return parsed;
  } catch {
    return { history: [] };
  }
}

function writeState(cwd: string, state: FlowGoalState): void {
  atomicWriteJson(getStorePath(cwd), state);
}

export function getGoal(cwd: string): FlowGoalEntry | undefined {
  return readState(cwd).current;
}

export function setGoal(
  cwd: string,
  objective: string,
  opts?: { acceptance?: string; maxTokens?: number; maxFlows?: number },
): FlowGoalEntry {
  const state = readState(cwd);
  const now = new Date().toISOString();
  const entry: FlowGoalEntry = {
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
  };
  if (state.current) {
    state.history.push(state.current);
  }
  state.current = entry;
  writeState(cwd, state);
  return entry;
}

export function clearGoal(cwd: string): void {
  const state = readState(cwd);
  if (state.current) {
    state.current.status = "abandoned";
    state.current.updatedAt = new Date().toISOString();
    state.history.push(state.current);
    state.current = undefined;
  }
  writeState(cwd, state);
}

export function updateGoalStatus(cwd: string, status: FlowGoalStatus): FlowGoalEntry | undefined {
  const state = readState(cwd);
  if (!state.current) return undefined;
  state.current.status = status;
  state.current.updatedAt = new Date().toISOString();
  writeState(cwd, state);
  return state.current;
}

export function updateGoalObjective(
  cwd: string,
  objective: string,
  acceptance?: string,
): FlowGoalEntry | undefined {
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
): FlowGoalEntry | undefined {
  const state = readState(cwd);
  if (!state.current) return undefined;
  state.current.completedFlows.push({
    type: flow.type,
    intent: flow.intent,
    aim: flow.aim,
    completedAt: new Date().toISOString(),
  });
  state.current.updatedAt = new Date().toISOString();
  writeState(cwd, state);
  return state.current;
}

export function addTokens(cwd: string, tokens: number): FlowGoalEntry | undefined {
  const state = readState(cwd);
  if (!state.current) return undefined;
  state.current.totalTokens += tokens;
  state.current.updatedAt = new Date().toISOString();
  writeState(cwd, state);
  return state.current;
}
