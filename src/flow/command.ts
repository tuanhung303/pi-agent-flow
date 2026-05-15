/**
 * /flow slash command registration.
 *
 * Subcommands: set, clear, pause, resume, edit, status, show
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  getGoal,
  setGoal,
  clearGoal,
  updateGoalStatus,
  updateGoalObjective,
} from "./store.js";

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

export function setupFlowCommand(pi: ExtensionAPI, getCwd: () => string | undefined): void {
  pi.registerCommand("flow", {
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
            ctx.ui.notify?.("Usage: /flow set <objective> [--acceptance <text>] [--max-tokens <n>] [--max-flows <n>]", "error");
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
            { content: `You have a new active goal. Analyze it and call the flow tool to start executing.\n\nGoal: ${objective}${acceptanceLine}\n\nChoose the appropriate flow type (scout, craft, build, audit, debug, ideas) based on the objective's nature.`, display: false },
            { triggerTurn: true }
          );
          break;
        }
        case "clear": {
          clearGoal(cwd);
          ctx.ui.notify?.("Goal cleared", "info");
          break;
        }
        case "pause": {
          const entry = updateGoalStatus(cwd, "paused");
          if (entry) {
            ctx.ui.notify?.("Goal paused", "info");
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
            ctx.ui.notify?.("Goal is already active", "info");
            break;
          }
          const entry = updateGoalStatus(cwd, "active", sessionId);
          if (entry) {
            ctx.ui.notify?.("Goal resumed", "info");

            const acceptanceLine = entry.acceptance ? `\nAcceptance: ${entry.acceptance}` : '';
            pi.sendMessage(
              { content: `You have a resumed goal. Continue working on it and call the flow tool to proceed.\n\nGoal: ${entry.objective}${acceptanceLine}\n\nChoose the appropriate flow type (scout, craft, build, audit, debug, ideas) based on the objective's nature.`, display: false },
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
            ctx.ui.notify?.("Usage: /flow edit <new-objective> [--acceptance <text>]", "error");
            return;
          }
          const previousGoal = getGoal(cwd);
          const previousObjective = previousGoal?.objective ?? "(none)";
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
          const entry = getGoal(cwd);
          if (entry) {
            ctx.ui.notify?.(formatGoal(entry), "info");
          } else {
            ctx.ui.notify?.("No active goal", "info");
          }
          break;
        }
        case "complete": {
          const entry = updateGoalStatus(cwd, "completed");
          if (entry) {
            ctx.ui.notify?.("Goal marked as completed", "info");
          } else {
            ctx.ui.notify?.("No active goal to complete", "error");
          }
          break;
        }
        default: {
          ctx.ui.notify?.(
            "Unknown subcommand. Usage: /flow {set|clear|pause|resume|complete|edit|status|show}",
            "error",
          );
        }
      }
    },
  });
}
