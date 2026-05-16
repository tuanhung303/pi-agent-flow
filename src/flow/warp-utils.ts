/**
 * Shared warp utilities — sanitization, system prompt, and goal extraction.
 */

import { stripReasoningFromAssistantMessage } from "../snapshot/reasoning-strip.js";
import {
  stripSteeringHintFromContent,
  isJsonEqual,
  contentContainsSteeringHintTag,
} from "../steering/sliding-prompt.js";
import { stripStrategicHintsFromContent } from "../steering/tool-utils.js";
import { logError } from "../config/log.js";

export const MAX_CONVERSATION_CHARS = 15000;

export function sanitizeBranchForWarp(messages: any[]): { messages: any[]; passesApplied: string[] } {
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

export const SYSTEM_PROMPT = `You are a context transfer and execution planning assistant. Given a conversation history and the user's goal, generate a structured warp prompt that serves as a ready-to-execute project brief for a new session.

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
