/**
 * Continuation engine for flow goals.
 *
 * Hooks into `turn_end`, checks guards, and spawns continuation flows
 * via the provided callback to avoid circular dependencies with the executor.
 */

import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@mariozechner/pi-coding-agent";
import type { SpawnContinuation } from "./types.js";
import { getGoal, addTokens, updateGoalStatus, recordFlowCompletion } from "./store.js";
import {
  continuationTemplate,
  budgetLimitTemplate,
  objectiveUpdatedTemplate,
} from "./template-strings.js";

function renderTemplate(
  template: string,
  vars: Record<string, string | number | undefined>,
): string {
  let text = template;
  for (const [key, value] of Object.entries(vars)) {
    text = text.replace(new RegExp(`{{${key}}}`, "g"), String(value ?? ""));
  }
  return text;
}

let _previousObjective: string | undefined;

export function setupContinuation(
  pi: ExtensionAPI,
  getCwd: () => string | undefined,
  spawnContinuation: SpawnContinuation,
): void {
  pi.on("turn_end", async (event: TurnEndEvent) => {
    const cwd = getCwd();
    if (!cwd) return;

    const goal = getGoal(cwd);
    if (!goal || goal.status !== "active") return;

    const messageText =
      typeof event.message.content === "string"
        ? event.message.content
        : event.message.content
            .filter(
              (p): p is { type: "text"; text: string } =>
                p.type === "text" && typeof p.text === "string",
            )
            .map((p) => p.text)
            .join("");

    // Rough token estimate from message length
    const turnTokens = Math.ceil(messageText.length / 4);
    addTokens(cwd, turnTokens);

    // Detect objective change
    if (_previousObjective && _previousObjective !== goal.objective) {
      const text = renderTemplate(objectiveUpdatedTemplate, {
        previousObjective: _previousObjective,
        objective: goal.objective,
        acceptance: goal.acceptance,
      });
      pi.sendMessage({ content: text, display: true }, { triggerTurn: true });
    }
    _previousObjective = goal.objective;

    // Budget guards
    const flowCount = goal.completedFlows.length;
    const overTokens = goal.maxTokens !== undefined && goal.totalTokens >= goal.maxTokens;
    const overFlows = goal.maxFlows !== undefined && flowCount >= goal.maxFlows;

    if (overTokens || overFlows) {
      updateGoalStatus(cwd, "paused");
      const text = renderTemplate(budgetLimitTemplate, {
        objective: goal.objective,
        totalTokens: goal.totalTokens,
        maxTokens: goal.maxTokens,
        flowCount,
        maxFlows: goal.maxFlows,
      });
      pi.sendMessage({ content: text, display: true }, { triggerTurn: false });
      return;
    }

    // Spawn continuation
    const beforeCount = goal.completedFlows.length;
    await spawnContinuation([
      {
        type: "build",
        intent: goal.objective,
        aim: goal.objective.slice(0, 60),
        acceptance: goal.acceptance,
      },
    ]);
    const afterGoal = getGoal(cwd);
    if (afterGoal && afterGoal.completedFlows.length === beforeCount) {
      recordFlowCompletion(cwd, { type: "build", intent: goal.objective, aim: goal.objective.slice(0, 60) });
      addTokens(cwd, turnTokens);
    }
  });
}
