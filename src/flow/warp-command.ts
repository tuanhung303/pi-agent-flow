/**
 * /flow:warp slash command registration.
 *
 * Distills conversation context and spawns a new session with the warped prompt.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { getGoal, getWarpCount, recordWarp } from "./store.js";

const SYSTEM_PROMPT = `You are a context transfer and execution planning assistant. Given a conversation history and the user's goal, generate a structured warp prompt that serves as a ready-to-execute project brief for a new session.

Your output MUST use this exact format:

FRONTMATTER (YAML between --- delimiters):
  context       — 1-2 sentence orientation summary
  end_goal      — The finish line, not the next step
  decisions     — Key choices already made (list)
  files         — Files touched with what changed (list)
  open_items    — Unresolved work or questions (list)
  watch_out     — Edge cases, gotchas, fragile assumptions (list)
  context_gathering:
    aim         — What the initial scout/discovery should accomplish
    scope       — Specific things to explore or map (list)
  execution_plan:
    - phase     — Phase name
      parallel  — true/false, can this run alongside other phases?
      group     — If parallel, which execution group (A, B, C...)
      flow      — Which flow type to use (scout, build, audit, craft...)
      flows     — OR multiple flows if parallel within the phase
      task      — Clear, actionable task for this phase
      depends_on — Phase(s) that must complete first
      produces  — What "done" means for this phase
  success_criteria — How to know the overall work is complete (list)

BODY (after the closing ---):
  A concise Task section restating the immediate next action.

RULES:
1. Always start with a context_gathering phase — the new session has no context yet, so discovery comes first.
2. Mark phases parallel:true when they have no data dependencies on each other. Use group labels (A, B, C) to cluster parallel work.
3. Each phase should produce a concrete artifact or state — not "make progress on X".
4. Keep the total plan to 3-5 phases. If it's more, consolidate.
5. Use flow types from: scout, build, audit, craft, debug, ideas.
6. Success criteria should be testable — something an audit flow could verify.
7. If an active goal from the prior session exists, include it in the frontmatter context.
8. Preserve unresolved blockers, open questions, or "not done" items from prior flow results in open_items.

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here is the prompt" — just output the prompt itself.`;

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
