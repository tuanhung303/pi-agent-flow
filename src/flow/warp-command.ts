/**
 * /flow:warp slash command registration.
 *
 * Distills conversation context and spawns a new session with the warped prompt.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { getGoal, getWarpCount, recordWarp } from "./store.js";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained — the new thread should be able to proceed without the old conversation
5. If an active goal is present, include it as background context so the new session understands the broader objective
6. Preserve any unresolved blockers, open questions, or 'not done' items from prior flow results
7. Include a 'Watch Out' section listing edge cases, gotchas, or fragile assumptions from the prior session that the new agent should be aware of (e.g. 'X API returns stale data after 5pm', 'Y config is overridden by env var', 'Z test is flaky on CI but passes locally').
8. Capture the user's END GOAL INTENT — not just the immediate next step, but the larger objective they are working toward. State it explicitly so the new session can recognize opportunities, suggest improvements, and make progress beyond the narrow task.

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like 'Here is the prompt' — just output the prompt itself.`;

const MAX_CONVERSATION_CHARS = 15000;

export function setupWarpCommand(pi: ExtensionAPI, getCwd: () => string | undefined): void {
  pi.registerCommand("flow:warp", {
    description: "Warp to a new session with distilled context. Usage: /flow:warp [goal]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const DEFAULT_WARP_GOAL = "Continue where we left off — summarize what we've done, where we are, and what the natural next step is.";
      const goal = args.trim() || DEFAULT_WARP_GOAL;

      const cwd = getCwd() ?? ctx.cwd;

      // Ensure a model is available
      const model = (ctx as any).model ?? ctx.modelRegistry?.getAvailable()?.[0];
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

      // Convert and serialize
      const messages = convertToLlm(branch);
      let conversation = serializeConversation(messages);

      // Truncate if too large (middle truncation: keep first 20% + last 80% of max)
      if (conversation.length > MAX_CONVERSATION_CHARS) {
        const headChars = Math.floor(MAX_CONVERSATION_CHARS * 0.2);
        const tailChars = Math.floor(MAX_CONVERSATION_CHARS * 0.8);
        conversation =
          conversation.slice(0, headChars) +
          "\n\n[... warp context truncated from the middle ...]\n\n" +
          conversation.slice(conversation.length - tailChars);
      }

      // Inject active goal context
      const activeGoal = getGoal(cwd);
      let preWarpContext = "";
      if (activeGoal) {
        preWarpContext = `\nPre-warp active goal: ${activeGoal.objective}${
          activeGoal.acceptance ? ` (Acceptance: ${activeGoal.acceptance})` : ""
        }\n`;
      }

      // Generate distilled prompt
      const result = await complete({
        model,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Conversation history:\n${conversation}\n${preWarpContext}\nUser's goal for new thread: ${goal}`,
          },
        ],
      });

      const distilledPrompt = result.content.trim();

      // Present for review
      const reviewedPrompt = await ctx.ui.input(
        "Review and edit the distilled warp prompt (or submit as-is):",
        distilledPrompt,
        { defaultValue: distilledPrompt }
      );

      if (reviewedPrompt === null || reviewedPrompt === undefined) {
        ctx.ui.notify?.("Warp cancelled by user.", "info");
        return;
      }

      const warpedPrompt = reviewedPrompt.trim() || distilledPrompt;

      // Warn on deep warp chains
      const warpCount = getWarpCount(cwd);
      if (warpCount >= 3) {
        const proceed = await ctx.ui.confirm(
          "Deep warp chain",
          `You are about to create warp depth ${warpCount + 1} (>3). Continue?`
        );
        if (!proceed) {
          ctx.ui.notify?.("Warp cancelled.", "info");
          return;
        }
      }

      // Spawn new session
      const currentSessionFile = ctx.sessionManager.getSessionDir();
      const { cancelled } = await ctx.newSession({
        parentSession: currentSessionFile,
        withSession: async (newCtx) => {
          await newCtx.sendUserMessage(`/flow:goal set ${goal}`);
          newCtx.ui.setEditorText?.(warpedPrompt);
        },
      });

      if (cancelled) {
        ctx.ui.notify?.("Warp cancelled — no session created.", "info");
        return;
      }

      // Log warp
      recordWarp(cwd, {
        id: `warp-${Date.now()}`,
        parentSession: currentSessionFile,
        goal,
        createdAt: new Date().toISOString(),
        depth: warpCount + 1,
      });

      ctx.ui.notify?.("Warped to new session.", "info");
    },
  });
}
