/**
 * Shared warp utilities — sanitization and system prompt.
 */

import { stripReasoningFromAssistantMessage } from "../snapshot/reasoning-strip.js";
import {
  stripSteeringHintFromContent,
  isJsonEqual,
  contentContainsSteeringHintTag,
} from "../steering/sliding-prompt.js";
import { stripStrategicHintsFromContent } from "../steering/tool-utils.js";

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

      // Strip strategic hints from all message content
      const afterHints = stripStrategicHintsFromContent(modifiedContent);
      if (!isJsonEqual(afterHints, modifiedContent)) {
        modifiedContent = afterHints;
        changed = true;
        passesApplied.add("stripStrategicHints");
      }

      if (changed) {
        sanitizedMessage = { ...sanitizedMessage, content: modifiedContent };
      }
    }

    sanitized.push(sanitizedMessage);
  }

  return { messages: sanitized, passesApplied: Array.from(passesApplied) };
}

export const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;
