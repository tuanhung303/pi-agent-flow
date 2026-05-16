import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@mariozechner/pi-coding-agent";
import { getGoal, addTokens, updateGoalStatus } from "./store.js";
import { budgetLimitTemplate, goalCompletedTemplate } from "./template-strings.js";

let _previousObjective: string | undefined;
let _lastSpawnAt = 0;
let _currentSessionId: string | undefined;
const SPAWN_COOLDOWN_MS = 5000;

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
let _lastFlowCompleteAt = 0;

/**
 * Mark that a flow just completed. Called by the executor after each flow
 * finishes. The continuation system uses this to enforce the post-completion
 * hold, giving the user time to read the result before the next flow spawns.
 */
export function markFlowCompleted(): void {
  _lastFlowCompleteAt = Date.now();
}

export function setupContinuation(
  pi: ExtensionAPI,
  getCwd: () => string | undefined,
): void {
  pi.on("session_start", (_event, ctx) => {
    _currentSessionId = ctx.sessionManager.getSessionId();
  });

  pi.on("turn_end", async (event: TurnEndEvent) => {
    const cwd = getCwd();
    if (!cwd) return;

    const goal = getGoal(cwd);
    if (!goal || goal.status !== "active") return;
    if (goal.sessionId && goal.sessionId !== _currentSessionId) return;

    // Detect agent-driven completion: parse assistant message for flow tool call with type='complete'
    const contentParts =
      typeof event.message.content === "string"
        ? [{ type: "text", text: event.message.content }]
        : event.message.content;

    for (const part of contentParts as any[]) {
      if (part.type === "toolCall" && part.name === "flow") {
        const args = part.arguments;
        if (args && Array.isArray(args.flow)) {
          const hasComplete = args.flow.some(
            (f: any) =>
              f && typeof f.type === "string" && f.type.toLowerCase() === "complete",
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

    // Cooldown: don't re-fire within 5 seconds of last spawn
    const now = Date.now();
    if (now - _lastSpawnAt < SPAWN_COOLDOWN_MS) return;

    // Post-completion hold: give the user time to read the flow result
    // before triggering the next flow. This prevents the completed result
    // from scrolling off-screen too fast.
    if (_lastFlowCompleteAt > 0 && now - _lastFlowCompleteAt < FLOW_COMPLETE_HOLD_MS) return;

    _lastSpawnAt = now;

    // Track token usage from turn
    const messageText =
      typeof event.message.content === "string"
        ? event.message.content
        : event.message.content
            .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
            .map((p) => p.text)
            .join("");
    addTokens(cwd, Math.ceil(messageText.length / 4));
    _previousObjective = goal.objective;

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

    const continuationPrompt = `<flow-continuation>\nThe current session has an active flow goal. Continue execution toward the objective.\n\nObjective: ${goal.objective}${acceptanceClause}\nProgress: ${flowCount}${maxFlowsClause} flows completed, ${tokenInfo} tokens used.\n\n**Flow routing:** Choose the appropriate flow type based on the objective:\n- \`scout\` — explore, map, discover\n- \`craft\` — conservative design, architecture\n- \`build\` — implement, test, verify, ship\n- \`audit\` — security, quality, correctness review\n- \`debug\` — investigate root cause and fix\n- \`ideas\` — diverge, evaluate, recommend\n\n**Completion audit:** Before considering the goal complete, verify EACH requirement:\n1. Re-read the original objective and acceptance criteria.\n2. For every stated requirement, confirm concrete evidence of completion.\n3. If ANY requirement lacks evidence, continue working rather than declaring victory.\n4. A goal is complete only when ALL acceptance criteria are met with verifiable results.\n\nCall the flow tool with the appropriate flow type to advance the goal.\n</flow-continuation>`;

    pi.sendMessage({ content: continuationPrompt, display: false }, { triggerTurn: true });
  });
}
