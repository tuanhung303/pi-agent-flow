/**
 * /flow:warp slash command registration.
 *
 * Distills conversation context and spawns a new session with the warped prompt.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import { getGoalForSession } from "./store.js";
import { getLoop } from "./loop.js";
import { distillForWarp, performWarp } from "./perform-warp.js";

export function setupWarpCommand(pi: ExtensionAPI): void {
  pi.registerCommand("flow:warp", {
    description: "Warp to a new session with distilled context. Usage: /flow:warp [goal]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.ui) {
        return;
      }
      const DEFAULT_WARP_GOAL = "Continue where we left off — summarize what we've done, where we are, and what the natural next step is.";
      const goal = args.trim() || DEFAULT_WARP_GOAL;

      const cwd = ctx.cwd;

      // Ensure a model is available
      const model = ctx.model ?? ctx.modelRegistry?.getAvailable()?.[0];
      if (!model) {
        ctx.ui.notify?.("No model selected. Configure a model in Pi settings first.", "error");
        return;
      }

      // Gather conversation
      const branch = ctx.sessionManager.getBranch();
      if (!branch || branch.length === 0) {
        ctx.ui.notify?.("Empty conversation — nothing to warp.", "error");
        return;
      }

      const activeGoal = getGoalForSession(cwd, ctx.sessionManager.getSessionId());
      const loop = getLoop(cwd);

      let warpError: string | undefined;

      const distilledPrompt = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, "Generating warp prompt...");
        loader.onAbort = () => done(null);
        distillForWarp(ctx, activeGoal, loop, { signal: loader.signal, userGoalOverride: args.trim() || undefined })
          .then((r) => done(r))
          .catch((err) => { warpError = err instanceof Error ? err.message : "Unknown error"; done(null); });
        return loader;
      });

      if (distilledPrompt === null || distilledPrompt === undefined) {
        if (warpError) {
          ctx.ui.notify?.(`Warp generation failed: ${warpError}`, "error");
        } else {
          ctx.ui.notify?.("Warp cancelled.", "info");
        }
        return;
      }

      let reviewedPrompt: string | undefined;
      if (loop?.status !== "active") {
        // Present for review
        reviewedPrompt = await ctx.ui.editor("Edit warp prompt", distilledPrompt);
        if (reviewedPrompt === undefined) {
          ctx.ui.notify?.("Warp cancelled by user.", "info");
          return;
        }
        reviewedPrompt = (reviewedPrompt ?? distilledPrompt).trim();
      }

      const warpedPrompt = reviewedPrompt ?? distilledPrompt.trim();

      const result = await performWarp(ctx, {
        reviewedPrompt: warpedPrompt,
        goalOverride: args.trim() ? goal : undefined,
        pi,
      });

      if (!result.success) {
        ctx.ui.notify?.(`Warp failed: ${result.error}`, "error");
      } else {
        ctx.ui.notify?.("Warped to new session.", "info");
      }
    },
  });
}
