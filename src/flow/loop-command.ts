/**
 * /flow:loop slash command registration.
 *
 * Subcommands: enable, disable, status, stop, reset
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getGoal } from "./store.js";
import {
  getLoop,
  enableLoop,
  disableLoop,
  resetLoop,
  terminateLoop,
} from "./loop.js";

function requireActiveGoalOwner(
  cwd: string,
  sessionId: string,
  action: "enable" | "disable" | "stop" | "reset",
  notify: (message: string, level: "error") => void,
): ReturnType<typeof getGoal> {
  const goal = getGoal(cwd);
  if (!goal) {
    notify(
      action === "enable"
        ? "Cannot enable loop: no active goal. Set a goal first with /flow:goal set."
        : `Cannot ${action} loop: no active goal.`,
      "error",
    );
    return undefined;
  }
  if (goal.status !== "active") {
    notify(`Cannot ${action} loop: goal is not active.`, "error");
    return undefined;
  }
  // Unbound legacy goals follow the same ownership convention as
  // getGoalForSession(): they are available to the current session.
  if (goal.sessionId && goal.sessionId !== sessionId) {
    notify(`Cannot ${action} loop: active goal belongs to another session.`, "error");
    return undefined;
  }
  return goal;
}

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
      "Manage endless loop. enable follows the active goal; disable pauses auto-warp; stop terminates loop mode. Subcommands: enable, disable, status, stop, reset",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.ui) {
        return;
      }
      const trimmed = args.trim();
      const firstSpace = trimmed.indexOf(" ");
      const sub = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
      const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
      const cwd = ctx.cwd;

      switch (sub) {
        case "enable": {
          if (rest) {
            ctx.ui.notify?.("Usage: /flow:loop enable", "error");
            return;
          }
          const sessionId = ctx.sessionManager.getSessionId();
          const goal = requireActiveGoalOwner(cwd, sessionId, "enable", (message, level) => ctx.ui!.notify?.(message, level));
          if (!goal) {
            return;
          }
          try {
            const loop = enableLoop(cwd, goal.objective);
            ctx.ui.notify?.(`Loop enabled: ${loop.objective}`, "info");
          } catch (err) {
            ctx.ui.notify?.(err instanceof Error ? err.message : "Failed to enable loop", "error");
          }
          break;
        }
        case "disable": {
          if (!requireActiveGoalOwner(cwd, ctx.sessionManager.getSessionId(), "disable", (message, level) => ctx.ui!.notify?.(message, level))) {
            return;
          }
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
          if (!requireActiveGoalOwner(cwd, ctx.sessionManager.getSessionId(), "stop", (message, level) => ctx.ui!.notify?.(message, level))) {
            return;
          }
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
          if (!requireActiveGoalOwner(cwd, ctx.sessionManager.getSessionId(), "reset", (message, level) => ctx.ui!.notify?.(message, level))) {
            return;
          }
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
