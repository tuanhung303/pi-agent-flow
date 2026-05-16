/**
 * /flow:warp slash command registration.
 *
 * Distills conversation context and spawns a new session with the warped prompt.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { DynamicScrambleText, scrambleManager, runScrambleTimer } from "../tui/scramble/index.js";
import { getGoalForSession, getWarpCount, recordWarp } from "./store.js";
import { stripReasoningFromAssistantMessage } from "../snapshot/reasoning-strip.js";
import {
  stripSteeringHintFromContent,
  isJsonEqual,
  contentContainsSteeringHintTag,
} from "../steering/sliding-prompt.js";
import { stripStrategicHintsFromContent } from "../steering/tool-utils.js";
import { logError } from "../config/log.js";

function sanitizeBranchForWarp(messages: any[]): { messages: any[]; passesApplied: string[] } {
  const passesApplied = new Set<string>();
  const sanitized: any[] = [];

  for (const message of messages) {
    if (!message) continue;

    // Drop messages with role: 'custom' (hidden orchestrator messages that convertToLlm would promote to user)
    if (message.role === "custom") {
      passesApplied.add("dropCustomMessages");
      continue;
    }

    // Drop messages with role: 'system' that contain steering hint tags
    if (message.role === "system" && contentContainsSteeringHintTag(message.content)) {
      passesApplied.add("dropSlidingSystemPrompts");
      continue;
    }

    let changed = false;
    let sanitizedMessage = message;

    // Strip reasoning/thinking from assistant messages
    if (message.role === "assistant" || message.role === "system" || message.role === "tool") {
      const stripped = stripReasoningFromAssistantMessage(message);
      if (stripped.changed) {
        sanitizedMessage = stripped.message;
        changed = true;
        passesApplied.add("stripReasoning");
      }
    }

    // Strip timestamp from message objects
    if ("timestamp" in sanitizedMessage) {
      const { timestamp, ...rest } = sanitizedMessage;
      sanitizedMessage = rest;
      changed = true;
      passesApplied.add("stripTimestamps");
    }

    // Strip API metadata from assistant messages (keep usage but strip cost)
    if (sanitizedMessage.role === "assistant") {
      const { api, provider, model, stopReason, responseId, responseModel, usage, ...rest } = sanitizedMessage;
      let stripped = false;
      if (api !== undefined || provider !== undefined || model !== undefined ||
          stopReason !== undefined || responseId !== undefined || responseModel !== undefined) {
        stripped = true;
      }
      let cleanedUsage = usage;
      if (usage && typeof usage === "object" && "cost" in usage) {
        const { cost, ...usageWithoutCost } = usage as any;
        cleanedUsage = usageWithoutCost;
        stripped = true;
      }
      if (stripped) {
        sanitizedMessage = { ...rest, ...(cleanedUsage !== undefined ? { usage: cleanedUsage } : {}) };
        changed = true;
        passesApplied.add("stripApiMetadata");
      }
    }

    // Strip 'details' from tool/toolResult messages
    if (sanitizedMessage.role === "tool" || sanitizedMessage.role === "toolResult") {
      if ("details" in sanitizedMessage) {
        const { details, ...rest } = sanitizedMessage;
        sanitizedMessage = rest;
        changed = true;
        passesApplied.add("stripDetails");
      }
    }

    if ("content" in sanitizedMessage) {
      let modifiedContent = sanitizedMessage.content;

      // Strip steering hints from message content
      const afterSliding = stripSteeringHintFromContent(modifiedContent);
      if (!isJsonEqual(afterSliding, modifiedContent)) {
        modifiedContent = afterSliding;
        changed = true;
        passesApplied.add("stripSteeringHints");
      }

      // Strip strategic hints from tool result content
      if (sanitizedMessage.role === "tool" || sanitizedMessage.role === "toolResult") {
        const afterHints = stripStrategicHintsFromContent(modifiedContent);
        if (!isJsonEqual(afterHints, modifiedContent)) {
          modifiedContent = afterHints;
          changed = true;
          passesApplied.add("stripStrategicHints");
        }
      }

      if (changed) {
        sanitizedMessage = { ...sanitizedMessage, content: modifiedContent };
      }
    }

    sanitized.push(sanitizedMessage);
  }

  return { messages: sanitized, passesApplied: Array.from(passesApplied) };
}

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
3. Each phase should produce a concrete artifact, evidence of completion before moving on to the next.
4. Respect the given plan scaffold.
5. Use flow types from: scout, build, audit, craft, debug, ideas.
6. Success criteria should be the final state, i.e. integration test pass, code coverage with verified output, etc.
7. If an active goal from the prior session exists, include it in the frontmatter context.
8. Preserve unresolved blockers, open questions, or "not done" items from prior flow results in open_items.
9. Flag any uncertain areas — parts of the codebase, design decisions, or assumptions that may have shifted since the conversation and need re-assessment via a scout or audit flow before committing to a plan.
10. No tool calls, all attemps that you need to discover, note it to the watch_out list or uncertain_areas list.
11. Your entire response must be the warp prompt starting with '---' (YAML frontmatter opening). No preamble, no explanations, no tool calls.

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here is the prompt" — just output the prompt itself.

IMPORTANT: You are a text generation assistant, not an agent. Do NOT attempt tool calls, file operations, code execution, or any actions. Output ONLY the structured prompt text.`;

const MAX_CONVERSATION_CHARS = 15000;

export function extractGoalFromPrompt(prompt: string): string {
  const MAX_GOAL_LEN = 200;
  // Helper: find first meaningful line and strip bullet/numbered prefixes
  const pickFirstLine = (text: string): string | undefined => {
    const lines = text.split('\n');
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const cleaned = trimmed.replace(/^[-*•]\s+|^\d+\.\s+/, '');
      if (cleaned) return cleaned.length > MAX_GOAL_LEN ? cleaned.slice(0, MAX_GOAL_LEN).trimEnd() : cleaned;
    }
    return undefined;
  };

  // Strategy 1: Parse end_goal from YAML frontmatter
  const endGoalMatch = prompt.match(/^end_goal:\s*["']?(.+?)["']?\s*$/m);
  if (endGoalMatch?.[1]) {
    const endGoal = endGoalMatch[1].trim();
    const contextMatch = prompt.match(/^context:\s*["']?(.+?)["']?\s*$/m);
    if (contextMatch?.[1]) {
      const context = contextMatch[1].trim();
      const combined = `${endGoal}. Context: ${context}`;
      if (combined.length <= MAX_GOAL_LEN) return combined;
    }
    return endGoal.length > MAX_GOAL_LEN ? endGoal.slice(0, MAX_GOAL_LEN).trimEnd() : endGoal;
  }

  // Try to find ## Task section
  const taskMatch = prompt.match(/##\s*Task\s*\n([\s\S]*?)(?=\n##|$)/i);
  if (taskMatch?.[1]) {
    const picked = pickFirstLine(taskMatch[1]);
    if (picked) return picked;
  }
  // Fallback: first non-empty, non-header, non-bullet line after ---
  const bodyStart = prompt.indexOf('---', 3);
  if (bodyStart !== -1) {
    const body = prompt.slice(bodyStart + 3);
    const picked = pickFirstLine(body);
    if (picked) return picked;
  }
  return 'Continue the work from the warped context';
}

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

      // Convert and serialize
      // getBranch() returns wrapped session entries; convertToLlm expects AgentMessage objects.
      const agentMessages = branch
        .map((entry: any) => (entry.type === "message" ? entry.message : undefined))
        .filter((m: any) => m != null);
      const { messages: sanitizedMessages, passesApplied } = sanitizeBranchForWarp(agentMessages);
      if (process.env.PI_FLOW_DUMP_SNAPSHOT) {
        logError(`[warp-sanitize] passes applied: ${passesApplied.join(", ")}`);
      }
      const messages = convertToLlm(sanitizedMessages);
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

      // Inject active goal context (session-guarded)
      const activeGoal = getGoalForSession(cwd, ctx.sessionManager.getSessionId());
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

          // Log warp (cwd captured in closure, no ctx needed)
          recordWarp(cwd, {
            id: `warp-${Date.now()}`,
            parentSession: currentSessionFile,
            goal,
            createdAt: new Date().toISOString(),
            depth: warpCount + 1,
          });

          newCtx.ui.notify?.("Warped to new session.", "info");

          // Execute /flow:goal set as a real user message in the new session.
          // This triggers the command handler which calls setGoal() with
          // ctx.sessionManager.getSessionId() — guaranteed to be the new
          // session's ID. The handler then triggers the LLM to start working.
          // sendUserMessage is called last because it may trigger a turn.
          await newCtx.sendUserMessage(warpedPrompt);
          newCtx.sendUserMessage(`/flow:goal set ${effectiveGoal}`);
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
