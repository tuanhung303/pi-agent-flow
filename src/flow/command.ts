/**
 * /flow:goal slash command registration.
 *
 * Subcommands: set, clear, pause, resume, edit, status, show
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  getGoal,
  getGoalForSession,
  setGoal,
  clearGoal,
  updateGoalStatus,
  updateGoalObjective,
} from "./store.js";
import { getLoop, terminateLoop } from "./loop.js";
import { cleanupContinuationState } from "./continuation.js";

function formatGoal(entry: NonNullable<ReturnType<typeof getGoal>>): string {
  const lines = [
    `**ID:** ${entry.id}`,
    `**Objective:** ${entry.objective}`,
    `**Status:** ${entry.status}`,
    `**Created:** ${entry.createdAt}`,
    `**Updated:** ${entry.updatedAt}`,
  ];
  if (entry.acceptance) lines.push(`**Acceptance:** ${entry.acceptance}`);
  if (entry.maxTokens !== undefined) lines.push(`**Token budget:** ${entry.totalTokens}/${entry.maxTokens}`);
  if (entry.maxFlows !== undefined) lines.push(`**Flow budget:** ${entry.completedFlows.length}/${entry.maxFlows}`);
  if (entry.completedFlows.length > 0) {
    lines.push(`**Completed flows:**`);
    for (const f of entry.completedFlows) {
      lines.push(`  - [${f.type}] ${f.aim}`);
    }
  }
  return lines.join("\n");
}

export function setupFlowCommand(pi: ExtensionAPI): void {
  pi.registerCommand("flow:goal", {
    description:
      "Manage an active flow goal. Subcommands: set <objective> [--acceptance <text>] [--max-tokens <n>] [--max-flows <n>], clear, pause, resume, complete, edit <new-objective> [--acceptance <text>], status, show",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      const firstSpace = trimmed.indexOf(" ");
      const sub = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
      const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
      const cwd = ctx.cwd;

      switch (sub) {
        case "set": {
          const acceptanceMatch = rest.match(/--acceptance\s+(.+?)(?=\s+--|$)/);
          const maxTokensMatch = rest.match(/--max-tokens\s+(\d+)/);
          const maxFlowsMatch = rest.match(/--max-flows\s+(\d+)/);
          let objective = rest;
          if (acceptanceMatch) objective = objective.replace(acceptanceMatch[0], "").trim();
          if (maxTokensMatch) objective = objective.replace(maxTokensMatch[0], "").trim();
          if (maxFlowsMatch) objective = objective.replace(maxFlowsMatch[0], "").trim();
          if (!objective) {
            ctx.ui.notify?.("Usage: /flow:goal set <objective> [--acceptance <text>] [--max-tokens <n>] [--max-flows <n>]", "error");
            return;
          }
          const sessionId = ctx.sessionManager.getSessionId();
          const entry = setGoal(cwd, objective, {
            acceptance: acceptanceMatch?.[1],
            maxTokens: maxTokensMatch ? parseInt(maxTokensMatch[1], 10) : undefined,
            maxFlows: maxFlowsMatch ? parseInt(maxFlowsMatch[1], 10) : undefined,
            sessionId,
          });
          ctx.ui.notify?.(`Goal set: ${entry.objective}`, "info");

          const acceptanceLine = entry.acceptance ? `\nAcceptance: ${entry.acceptance}` : '';
          pi.sendMessage(
            { content: `New goal active. Objective: ${entry.objective}. Call the flow tool with an appropriate type (scout, craft, build, audit, debug, ideas) to start executing.${acceptanceLine}`, display: false },
            { triggerTurn: true }
          );
          break;
        }
        case "clear": {
          const goalToClear = getGoal(cwd);
          if (goalToClear?.sessionId) {
            cleanupContinuationState(goalToClear.sessionId); // Fix L3: Prevent unbounded Map growth by cleaning up session tracking state
          }
          clearGoal(cwd);
          ctx.ui.notify?.("Goal cleared", "info");
          break;
        }
        case "pause": {
          const currentSessionId = ctx.sessionManager.getSessionId();
          const goal = getGoalForSession(cwd, currentSessionId);
          if (goal) {
            const entry = updateGoalStatus(cwd, "paused");
            if (entry) {
              ctx.ui.notify?.("Goal paused", "info");
            }
          } else if (getGoal(cwd)) {
            ctx.ui.notify?.("No active goal in this session to pause", "error");
          } else {
            ctx.ui.notify?.("No active goal to pause", "error");
          }
          break;
        }
        case "resume": {
          const sessionId = ctx.sessionManager.getSessionId();
          const current = getGoal(cwd);
          if (!current) {
            ctx.ui.notify?.("No goal to resume", "error");
            break;
          }
          if (current.status === "active") {
            if (current.sessionId && current.sessionId !== sessionId) {
              ctx.ui.notify?.("Goal is already active in another session", "info");
            } else {
              ctx.ui.notify?.("Goal is already active", "info");
            }
            break;
          }
          if (current.sessionId && current.sessionId !== sessionId) {
            ctx.ui.notify?.("Resuming goal from another session — it will be rebound to this session.", "warning");
          }
          const entry = updateGoalStatus(cwd, "active", sessionId);
          if (entry) {
            ctx.ui.notify?.("Goal resumed", "info");

            const acceptanceLine = entry.acceptance ? `\nAcceptance: ${entry.acceptance}` : '';
            pi.sendMessage(
              { content: `Goal resumed. Objective: ${entry.objective}. Continue execution by calling the flow tool with an appropriate type (scout, craft, build, audit, debug, ideas).${acceptanceLine}`, display: false },
              { triggerTurn: true }
            );
          }
          break;
        }
        case "edit": {
          const acceptanceMatch = rest.match(/--acceptance\s+(.+?)(?=\s+--|$)/);
          let objective = rest;
          if (acceptanceMatch) objective = objective.replace(acceptanceMatch[0], "").trim();
          if (!objective) {
            ctx.ui.notify?.("Usage: /flow:goal edit <new-objective> [--acceptance <text>]", "error");
            return;
          }
          const currentSessionId = ctx.sessionManager.getSessionId();
          const previousGoal = getGoalForSession(cwd, currentSessionId);
          if (!previousGoal) {
            if (getGoal(cwd)) {
              ctx.ui.notify?.("No active goal in this session to edit", "error");
            } else {
              ctx.ui.notify?.("No active goal to edit", "error");
            }
            return;
          }
          const previousObjective = previousGoal.objective;
          const entry = updateGoalObjective(cwd, objective, acceptanceMatch?.[1]);
          if (entry) {
            ctx.ui.notify?.(`Goal updated: ${entry.objective}`, "info");
            const acceptanceLine = entry.acceptance ? `\nAcceptance: ${entry.acceptance}` : '';
            pi.sendMessage(
              { content: `<flow-update>\nThe flow goal objective has been updated.\n\nPrevious: ${previousObjective}\nCurrent: ${entry.objective}${acceptanceLine}\n\nAdjust your plan accordingly. Continue with the revised objective. Choose the appropriate flow type.\n</flow-update>`, display: false },
              { triggerTurn: true }
            );
          } else {
            ctx.ui.notify?.("No active goal to edit", "error");
          }
          break;
        }
        case "status":
        case "show": {
          const currentSessionId = ctx.sessionManager.getSessionId();
          const entry = getGoalForSession(cwd, currentSessionId);
          if (entry) {
            ctx.ui.notify?.(formatGoal(entry), "info");
          } else {
            const anyGoal = getGoal(cwd);
            if (anyGoal) {
              ctx.ui.notify?.(formatGoal(anyGoal) + "\n\n(belongs to another session)", "info");
            } else {
              ctx.ui.notify?.("No active goal", "info");
            }
          }
          break;
        }
        case "complete": {
          const currentSessionId = ctx.sessionManager.getSessionId();
          const goal = getGoalForSession(cwd, currentSessionId);
          if (goal) {
            const entry = updateGoalStatus(cwd, "completed");
            if (entry) {
              ctx.ui.notify?.("Goal marked as completed", "info");
              cleanupContinuationState(currentSessionId); // Fix L3: Prevent unbounded Map growth by cleaning up session tracking state
              const loop = getLoop(cwd);
              if (loop && loop.status !== "terminated") {
                terminateLoop(cwd, "goal_completed");
              }
            }
          } else if (getGoal(cwd)) {
            ctx.ui.notify?.("No active goal in this session to complete", "error");
          } else {
            ctx.ui.notify?.("No active goal to complete", "error");
          }
          break;
        }
        default: {
          ctx.ui.notify?.(
            "Unknown subcommand. Usage: /flow:goal {set|clear|pause|resume|complete|edit|status|show}",
            "error",
          );
        }
      }
    },
  });
}
