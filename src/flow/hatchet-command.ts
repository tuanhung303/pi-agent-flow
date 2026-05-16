/**
 * /flow:hatchet slash command registration.
 *
 * Subcommands: status, reconcile, attach <runId>, cancel <runId>
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { loadHatchetRunRegistry, type HatchetRunRecord } from "../hatchet-run-registry.js";
import { reconcileHatchetRuns, formatReconcileSummary } from "../hatchet-reconcile.js";
import type { HatchetRunAdapter } from "../hatchet-run-adapter.js";

function formatRunLine(r: HatchetRunRecord): string {
  const base = `[${r.status}] ${r.flowType} — ${r.aim} — ${r.id}`;
  if (r.status === "completed") {
    return `${base} — exit ${r.result?.exitCode ?? "?"}`;
  }
  if (r.status === "failed" || r.status === "unknown" || r.status === "cancelled") {
    return `${base} — ${r.errorMessage ?? "no details"}`;
  }
  return base;
}

function findRun(registry: ReturnType<typeof loadHatchetRunRegistry>, runId: string): HatchetRunRecord | undefined {
  return registry.runs.find((r) => r.id === runId || r.hatchetRunId === runId);
}

export interface HatchetCommandDeps {
  /** Adapter used for live reconciliation. When undefined, only shows stored status. */
  getAdapter?: () => HatchetRunAdapter | undefined;
}

export function setupHatchetCommand(pi: ExtensionAPI, deps: HatchetCommandDeps = {}): void {
  pi.registerCommand("flow:hatchet", {
    description:
      "Manage Hatchet-backed flow runs. Subcommands: status, reconcile, attach <runId>, cancel <runId>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      const firstSpace = trimmed.indexOf(" ");
      const sub = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase() || "status";
      const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
      const { cwd } = ctx;

      switch (sub) {
        case "status": {
          const registry = loadHatchetRunRegistry(cwd);
          if (registry.runs.length === 0) {
            ctx.ui.notify?.("No Hatchet runs recorded for this workspace.", "info");
            return;
          }
          const lines = registry.runs.map(formatRunLine);
          ctx.ui.notify?.(lines.join("\n"), "info");
          break;
        }

        case "reconcile": {
          const adapter = deps.getAdapter?.();
          if (!adapter) {
            ctx.ui.notify?.(
              "Reconciliation requires PI_FLOW_RUNNER=hatchet and a configured Hatchet adapter.",
              "error",
            );
            return;
          }
          ctx.ui.notify?.("Reconciling Hatchet runs...", "info");
          try {
            const sessionId = ctx.sessionManager.getSessionId();
            const summary = await reconcileHatchetRuns({
              cwd,
              sessionId,
              adapter,
              includeOtherSessions: true,
            });
            ctx.ui.notify?.(formatReconcileSummary(summary), "info");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.ui.notify?.(`Reconciliation failed: ${msg}`, "error");
          }
          break;
        }

        case "attach": {
          if (!rest) {
            ctx.ui.notify?.("Usage: /flow:hatchet attach <runId>", "error");
            return;
          }
          const registry = loadHatchetRunRegistry(cwd);
          const run = findRun(registry, rest);
          if (!run) {
            ctx.ui.notify?.(`No Hatchet run found with ID: ${rest}`, "error");
            return;
          }
          ctx.ui.notify?.(formatRunLine(run), "info");
          if (run.result) {
            const output = run.result.stderr || "(no output)";
            ctx.ui.notify?.(`Result:\n${output}`, "info");
          }
          break;
        }

        case "cancel": {
          if (!rest) {
            ctx.ui.notify?.("Usage: /flow:hatchet cancel <runId>", "error");
            return;
          }
          const adapter = deps.getAdapter?.();
          if (!adapter) {
            ctx.ui.notify?.(
              "Cancel requires PI_FLOW_RUNNER=hatchet and a configured Hatchet adapter.",
              "error",
            );
            return;
          }
          if (!adapter.cancel) {
            ctx.ui.notify?.(
              "This Hatchet adapter does not support cancellation.",
              "warning",
            );
            return;
          }
          const registry = loadHatchetRunRegistry(cwd);
          const run = findRun(registry, rest);
          if (!run) {
            ctx.ui.notify?.(`No Hatchet run found with ID: ${rest}`, "error");
            return;
          }
          if (!run.hatchetRunId) {
            ctx.ui.notify?.(`Run ${run.id} has no remote handle — cannot cancel.`, "error");
            return;
          }
          try {
            await adapter.cancel({ runId: run.hatchetRunId });
            ctx.ui.notify?.(`Cancellation requested for run ${run.id}.`, "info");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.ui.notify?.(`Cancel failed: ${msg}`, "error");
          }
          break;
        }

        default: {
          ctx.ui.notify?.(
            "Unknown subcommand. Usage: /flow:hatchet {status|reconcile|attach <runId>|cancel <runId>}",
            "error",
          );
        }
      }
    },
  });
}
