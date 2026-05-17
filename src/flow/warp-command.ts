/**
 * /flow:warp slash command registration.
 *
 * Distills conversation context and spawns a new session with the warped prompt.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { DynamicScrambleText, scrambleManager } from "../tui/scramble/index.js";
import { getGoalForSession } from "./store.js";
import { getLoop, recordSessionWarp, terminateLoop, setPendingWarpSessionId, clearPendingWarpSessionId } from "./loop.js";
import { extractGoalFromPrompt } from "./warp-utils.js";
import { distillForWarp, performWarp } from "./perform-warp.js";

export function setupWarpCommand(pi: ExtensionAPI): void {
  pi.registerCommand("flow:warp", {
    description: "Warp to a new session with distilled context. Usage: /flow:warp [goal]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
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

      const distilledPrompt = await ctx.ui.custom<string | null>((tui, _theme, _kb, done) => {
        const abortController = new AbortController();
        const id = `warp-${Date.now()}`;
        let completed = false;
        const RESTART_DELAY_MS = 1500;

        class WarpingComponent {
          private scramble: DynamicScrambleText;
          private timer: ReturnType<typeof setTimeout> | undefined;
          onAbort?: () => void;

          constructor() {
            this.scramble = new DynamicScrambleText("warping...", () => {
              const now = Date.now();
              const result = scrambleManager.updateText(id, "warp", "warping...", now, completed);
              return result.content;
            });
            this.onAbort = () => {
              abortController.abort();
              this.cleanup();
              done(null);
            };
            this.scheduleNext();
          }

          private scheduleNext() {
            if (this.timer) clearTimeout(this.timer);
            if (completed) return;
            const now = Date.now();
            const result = scrambleManager.updateText(id, "warp", "warping...", now, completed);
            if (result.isAnimating) {
              this.timer = setTimeout(() => {
                this.timer = undefined;
                tui.requestRender();
                this.scheduleNext();
              }, 100);
            } else {
              this.timer = setTimeout(() => {
                this.timer = undefined;
                if (completed) return;
                // Reset scramble state and restart animation
                scrambleManager.completeFlow(id);
                const restartNow = Date.now();
                scrambleManager.updateText(id, "warp", "warping...", restartNow, false);
                tui.requestRender();
                this.scheduleNext();
              }, RESTART_DELAY_MS);
            }
          }

          render(width: number): string[] {
            const now = Date.now();
            const result = scrambleManager.updateText(id, "warp", "warping...", now, completed);
            if (result.isAnimating && !this.timer && !completed) {
              this.scheduleNext();
            }
            return this.scramble.render(width);
          }

          cleanup() {
            if (this.timer) {
              clearTimeout(this.timer);
              this.timer = undefined;
            }
            this.scramble.invalidate();
            scrambleManager.completeFlow(id);
          }
        }

        const component = new WarpingComponent();

        distillForWarp(ctx, activeGoal, loop, { signal: abortController.signal, userGoalOverride: args.trim() || undefined })
          .then((result) => {
            completed = true;
            component.cleanup();
            done(result);
          })
          .catch((err) => {
            completed = true;
            warpError = err instanceof Error ? err.message : "Unknown error";
            component.cleanup();
            done(null);
          });

        return component;
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

      const result = await performWarp(ctx, { type: "warp", intent: "Manual warp", aim: "Warp to fresh session" }, {
        reviewedPrompt: warpedPrompt,
        goalOverride: args.trim() ? goal : undefined,
      });

      if (!result.success) {
        ctx.ui.notify?.(`Warp failed: ${result.error}`, "error");
      }
    },
  });
}
