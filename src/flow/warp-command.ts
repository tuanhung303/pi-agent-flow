/**
 * /flow:warp slash command registration.
 *
 * Distills conversation context and spawns a new session with the warped prompt.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { DynamicScrambleText, scrambleManager, runScrambleTimer } from "../tui/scramble.js";
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
  uncertain_areas — Areas of the codebase or design that need re-assessment before proceeding (list)
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
9. Flag any uncertain areas — parts of the codebase, design decisions, or assumptions that may have shifted since the conversation and need re-assessment via a scout or audit flow before committing to a plan.
10. OUTPUT TEXT ONLY. Do not make tool calls, do not attempt to run code, do not try to read or write files. Your only job is to produce the structured warp prompt as text. The conversation history is provided for context only — do not continue it.
11. Your entire response must be the warp prompt starting with '---' (YAML frontmatter opening). No preamble, no explanations, no tool calls.

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here is the prompt" — just output the prompt itself.

IMPORTANT: You are a text generation assistant, not an agent. Do NOT attempt tool calls, file operations, code execution, or any actions. Output ONLY the structured prompt text.`;

const MAX_CONVERSATION_CHARS = 15000;

function extractGoalFromPrompt(prompt: string): string {
  // Try to find ## Task section
  const taskMatch = prompt.match(/##\s*Task\s*\n([\s\S]*?)(?=\n##|$)/i);
  if (taskMatch?.[1]?.trim()) return taskMatch[1].trim();
  // Fallback: first non-empty, non-header line after ---
  const bodyStart = prompt.indexOf('---', 3);
  if (bodyStart !== -1) {
    const body = prompt.slice(bodyStart + 3);
    const lines = body.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'));
    if (lines[0]) return lines[0].trim();
  }
  return 'Continue the work from the warped context';
}

export function setupWarpCommand(pi: ExtensionAPI, getCwd: () => string | undefined): void {
  pi.registerCommand("flow:warp", {
    description: "Warp to a new session with distilled context. Usage: /flow:warp [goal]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const DEFAULT_WARP_GOAL = "Continue where we left off — summarize what we've done, where we are, and what the natural next step is.";
      const goal = args.trim() || DEFAULT_WARP_GOAL;

      const cwd = getCwd() ?? ctx.cwd;

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

      // Convert and serialize
      // getBranch() returns wrapped session entries; convertToLlm expects AgentMessage objects.
      const agentMessages = branch
        .map((entry: any) => (entry.type === "message" ? entry.message : undefined))
        .filter((m: any) => m != null);
      const messages = convertToLlm(agentMessages);
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
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) {
        ctx.ui.notify?.(auth.ok ? `No API key for ${model.provider}` : (auth.error ?? "Auth error"), "error");
        return;
      }

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

        const doGenerate = async () => {
          const response = await complete(
            model,
            {
              systemPrompt: SYSTEM_PROMPT,
              messages: [
                {
                  role: "user",
                  content: args.trim()
                    ? `Conversation history:\n${conversation}\n${preWarpContext}\nUser's goal for new thread: ${goal}`
                    : `Conversation history:\n${conversation}\n${preWarpContext}`,
                },
              ],
            },
            { apiKey: auth.apiKey, headers: auth.headers, signal: abortController.signal },
          );

          if (response.stopReason === "aborted") {
            return null;
          }

          if (response.stopReason === "error" || response.errorMessage) {
            throw new Error(response.errorMessage || "Unknown error");
          }

          return response.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n")
            .trim();
        };

        doGenerate()
          .then((result) => {
            completed = true;
            component.cleanup();
            done(result);
          })
          .catch((err) => {
            completed = true;
            component.cleanup();
            warpError = err.message || "Unknown error";
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

      // Present for review
      const reviewedPrompt = await ctx.ui.editor("Edit warp prompt", distilledPrompt);

      if (reviewedPrompt === undefined) {
        ctx.ui.notify?.("Warp cancelled by user.", "info");
        return;
      }

      const warpedPrompt = (reviewedPrompt ?? distilledPrompt).trim();

      // Warn on deep warp chains
      const warpCount = getWarpCount(cwd);
      if (warpCount >= 3) {
        ctx.ui.notify?.(`Warning: Deep warp chain (depth ${warpCount + 1}). Proceed with caution.`, "warning");
      }

      // Spawn new session
      const currentSessionFile = ctx.sessionManager.getSessionFile();
      const { cancelled } = await ctx.newSession({
        parentSession: currentSessionFile,
        withSession: async (newCtx) => {
          const effectiveGoal = args.trim() ? goal : extractGoalFromPrompt(warpedPrompt);
          newCtx.ui.setEditorText?.(`/flow:goal set ${effectiveGoal}\n\n${warpedPrompt}`);

          // Log warp (cwd captured in closure, no ctx needed)
          recordWarp(cwd, {
            id: `warp-${Date.now()}`,
            parentSession: currentSessionFile,
            goal,
            createdAt: new Date().toISOString(),
            depth: warpCount + 1,
          });

          newCtx.ui.notify?.("Warped to new session.", "info");
        },
      });

      if (cancelled) {
        // Can't use ctx.ui.notify here — ctx is stale after newSession.
        // The cancelled case means withSession never ran, so we return silently.
        return;
      }
    },
  });
}
