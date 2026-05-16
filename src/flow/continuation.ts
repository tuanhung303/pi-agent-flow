import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@mariozechner/pi-coding-agent";
import { getGoal, addTokens, updateGoalStatus } from "./store.js";
import { budgetLimitTemplate, goalCompletedTemplate } from "./template-strings.js";
import { logWarn } from '../config/log.js';
import * as sessionRegistry from '../core/session-registry.js';

const SPAWN_COOLDOWN_MS = 5000;
const _lastSpawnAt = new Map<string, number>();

/**
 * Post-flow completion hold — gives the user time to read the result before
 * the continuation system triggers the next flow.
 *
 * When a flow finishes, the TUI renders the completed result. If the
 * continuation system immediately spawns the next flow, the completed
 * result scrolls off-screen before the user can read it.
 *
 * This delay is measured from the last flow completion time (tracked via
 * _lastFlowCompleteAt) rather than from _lastSpawnAt, so the hold applies
 * even when the cooldown has already elapsed.
 */
const FLOW_COMPLETE_HOLD_MS = 3000;
const _lastFlowCompleteAt = new Map<string, number>();

/**
 * Mark that a flow just completed. Called by the executor after each flow
 * finishes. The continuation system uses this to enforce the post-completion
 * hold, giving the user time to read the result before the next flow spawns.
 *
 * Per-session tracking prevents one session's flow completion from delaying
 * another session's continuation.
 */
export function markFlowCompleted(sessionId?: string): void {
  if (sessionId) {
    _lastFlowCompleteAt.set(sessionId, Date.now());
  }
}

export function setupContinuation(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    sessionRegistry.register(ctx.cwd, ctx.sessionManager.getSessionId());
  });

  pi.on("turn_end", async (event: TurnEndEvent) => {
    const cwd = sessionRegistry.getCwd();
    if (!cwd) return;

    const goal = getGoal(cwd);
    if (!goal || goal.status !== "active") return;
    // Session guard: only continue goals bound to the current session.
    if (goal.sessionId && goal.sessionId !== sessionRegistry.getSessionId(cwd)) {
      logWarn(`[pi-agent-flow] Continuation skipped: goal session ${goal.sessionId} ≠ active session ${sessionRegistry.getSessionId(cwd) ?? '(none)'}`);
      return;
    }

    // Detect agent-driven completion: parse assistant message for flow tool call with type='complete'
    const contentParts =
      typeof event.message.content === "string"
        ? [{ type: "text", text: event.message.content }]
        : event.message.content;

    for (const part of contentParts) {
      if (part && typeof part === "object" && "type" in part && part.type === "toolCall" && "name" in part && part.name === "flow") {
        const args = (part as { arguments?: Record<string, unknown> }).arguments;
        if (args && Array.isArray(args.flow)) {
          const hasComplete = args.flow.some(
            (f: unknown) => {
              if (!f || typeof f !== "object") return false;
              const ft = (f as Record<string, unknown>).type;
              return typeof ft === "string" && ft.toLowerCase() === "complete";
            },
          );
          if (hasComplete) {
            updateGoalStatus(cwd, "completed");
            pi.sendMessage(
              {
                content: goalCompletedTemplate.replace("{{objective}}", goal.objective),
                display: false,
              },
              { triggerTurn: true },
            );
            return;
          }
        }
      }
    }

    // Cooldown: don't re-fire within 5 seconds of last spawn for THIS goal's session
    const now = Date.now();
    const goalSessionId = goal.sessionId ?? "none";
    if (now - (_lastSpawnAt.get(goalSessionId) ?? 0) < SPAWN_COOLDOWN_MS) return;

    // Post-completion hold: give the user time to read the flow result
    // before triggering the next flow. This prevents the completed result
    // from scrolling off-screen too fast.
    const lastFlowComplete = _lastFlowCompleteAt.get(goalSessionId);
    if (lastFlowComplete !== undefined && now - lastFlowComplete < FLOW_COMPLETE_HOLD_MS) return;

    _lastSpawnAt.set(goalSessionId, now);

    // Track token usage from turn
    const messageText =
      typeof event.message.content === "string"
        ? event.message.content
        : event.message.content
            .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
            .map((p) => p.text)
            .join("");
    addTokens(cwd, Math.ceil(messageText.length / 4));

    // Budget guards — silent
    const flowCount = goal.completedFlows.length;
    const overTokens = goal.maxTokens !== undefined && goal.totalTokens >= goal.maxTokens;
    const overFlows = goal.maxFlows !== undefined && flowCount >= goal.maxFlows;

    // Budget guards — actually pause when exceeded
    if (overTokens || overFlows) {
      updateGoalStatus(cwd, "paused");
      const pausedPrompt = budgetLimitTemplate
        .replace("{{objective}}", goal.objective)
        .replace("{{totalTokens}}", String(goal.totalTokens))
        .replace("{{maxTokens}}", String(goal.maxTokens ?? "unlimited"))
        .replace("{{flowCount}}", String(flowCount))
        .replace("{{maxFlows}}", String(goal.maxFlows ?? "unlimited"));
      pi.sendMessage({ content: pausedPrompt, display: false }, { triggerTurn: true });
      return;
    }

    // Build a continuation prompt with goal context and completion audit
    const maxFlowsClause = goal.maxFlows !== undefined ? `/${goal.maxFlows}` : '';
    const tokenInfo = `${goal.totalTokens}${goal.maxTokens !== undefined ? `/${goal.maxTokens}` : ''}`;
    const acceptanceClause = goal.acceptance ? `\nAcceptance: ${goal.acceptance}` : '';

    const continuationPrompt = `<flow-continuation>\nContinue execution toward the active goal.\n\nObjective: ${goal.objective}${acceptanceClause}\nProgress: ${flowCount}${maxFlowsClause} flows, ${tokenInfo} tokens.\n\nCall the flow tool with an appropriate type (scout, craft, build, audit, debug, ideas) to advance. Verify all acceptance criteria are met before marking complete.\n</flow-continuation>`;

    pi.sendMessage({ content: continuationPrompt, display: false }, { triggerTurn: true });
  });
}
