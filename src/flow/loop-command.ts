/**
 * /flow:loop slash command registration.
 *
 * Subcommands: enable, disable, status, stop, reset
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { getGoal } from "./store.js";
import {
  getLoop,
  enableLoop,
  disableLoop,
  resetLoop,
  terminateLoop,
} from "./loop.js";

function formatLoop(loop: NonNullable<ReturnType<typeof getLoop>>): string {
  const lines = [
    `**Status:** ${loop.status}`,
    `**Objective:** ${loop.objective}`,
    `**Sessions:** ${loop.sessionCount}`,
    `**Tokens across sessions:** ${loop.totalTokensAcrossSessions}`,
    `**Flows across sessions:** ${loop.totalFlowsAcrossSessions}`,
  ];
  if (loop.terminatedAt) lines.push(`**Terminated at:** ${loop.terminatedAt}`);
  if (loop.terminationReason) lines.push(`**Termination reason:** ${loop.terminationReason}`);
  return lines.join("\n");
}

export function setupLoopCommand(pi: ExtensionAPI): void {
  pi.registerCommand("flow:loop", {
    description:
      "Manage endless loop. Subcommands: enable, disable, status, stop, reset",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      const firstSpace = trimmed.indexOf(" ");
      const sub = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
      const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
      const cwd = ctx.cwd;

      switch (sub) {
        case "enable": {
          const goal = getGoal(cwd);
          if (!goal) {
            ctx.ui.notify?.("Cannot enable loop: no active goal. Set a goal first with /flow:goal set.", "error");
            return;
          }
          const objective = rest || goal.objective;
          try {
            const loop = enableLoop(cwd, objective);
            ctx.ui.notify?.(`Loop enabled: ${loop.objective}`, "info");
          } catch (err) {
            ctx.ui.notify?.(err instanceof Error ? err.message : "Failed to enable loop", "error");
          }
          break;
        }
        case "disable": {
          const loop = disableLoop(cwd);
          if (loop) {
            ctx.ui.notify?.("Loop disabled", "info");
          } else {
            ctx.ui.notify?.("No active loop to disable", "error");
          }
          break;
        }
        case "status": {
          const loop = getLoop(cwd);
          if (loop) {
            ctx.ui.notify?.(formatLoop(loop), "info");
          } else {
            ctx.ui.notify?.("No loop active", "info");
          }
          break;
        }
        case "stop": {
          const loop = getLoop(cwd);
          if (!loop) {
            ctx.ui.notify?.("No loop active", "error");
            return;
          }
          if (loop.status === "terminated") {
            ctx.ui.notify?.("Loop already terminated", "info");
            return;
          }
          terminateLoop(cwd, "user_disabled");
          ctx.ui.notify?.("Loop stopped", "info");
          break;
        }
        case "reset": {
          const loop = resetLoop(cwd);
          if (loop) {
            ctx.ui.notify?.("Loop reset", "info");
          } else {
            ctx.ui.notify?.("No loop to reset", "error");
          }
          break;
        }
        default: {
          ctx.ui.notify?.(
            "Unknown subcommand. Usage: /flow:loop {enable|disable|status|stop|reset}",
            "error",
          );
        }
      }
    },
  });
}
