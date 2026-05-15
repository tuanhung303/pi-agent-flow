/**
 * /flow-goal slash command registration.
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

export function setupFlowGoalCommand(pi: ExtensionAPI, getCwd: () => string | undefined): void {
  pi.registerCommand("flow-goal", {
    description:
      "Manage an active flow goal. Subcommands: set <objective> [--acceptance <text>] [--max-tokens <n>] [--max-flows <n>], clear, pause, resume, edit <new-objective> [--acceptance <text>], status, show",
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
            ctx.ui.notify?.("Usage: /flow-goal set <objective> [--acceptance <text>] [--max-tokens <n>] [--max-flows <n>]", "error");
            return;
          }
          const entry = setGoal(cwd, objective, {
            acceptance: acceptanceMatch?.[1],
            maxTokens: maxTokensMatch ? parseInt(maxTokensMatch[1], 10) : undefined,
            maxFlows: maxFlowsMatch ? parseInt(maxFlowsMatch[1], 10) : undefined,
          });
          ctx.ui.notify?.(`Goal set: ${entry.objective}`, "info");
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
          const entry = updateGoalStatus(cwd, "active");
          if (entry) {
            ctx.ui.notify?.("Goal resumed", "info");
          } else {
            ctx.ui.notify?.("No active goal to resume", "error");
          }
          break;
        }
        case "edit": {
          const acceptanceMatch = rest.match(/--acceptance\s+(.+?)(?=\s+--|$)/);
          let objective = rest;
          if (acceptanceMatch) objective = objective.replace(acceptanceMatch[0], "").trim();
          if (!objective) {
            ctx.ui.notify?.("Usage: /flow-goal edit <new-objective> [--acceptance <text>]", "error");
            return;
          }
          const entry = updateGoalObjective(cwd, objective, acceptanceMatch?.[1]);
          if (entry) {
            ctx.ui.notify?.(`Goal updated: ${entry.objective}`, "info");
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
        default: {
          ctx.ui.notify?.(
            "Unknown subcommand. Usage: /flow-goal {set|clear|pause|resume|edit|status|show}",
            "error",
          );
        }
      }
    },
  });
}
