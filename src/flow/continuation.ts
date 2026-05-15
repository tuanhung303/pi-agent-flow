import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@mariozechner/pi-coding-agent";
import { getGoal, addTokens } from "./store.js";

let _previousObjective: string | undefined;
let _lastSpawnAt = 0;
let _currentSessionId: string | undefined;
const SPAWN_COOLDOWN_MS = 5000;

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

    // Cooldown: don't re-fire within 5 seconds of last spawn
    const now = Date.now();
    if (now - _lastSpawnAt < SPAWN_COOLDOWN_MS) return;
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

    // Build a continuation prompt with goal context and completion audit
    const maxFlowsClause = goal.maxFlows !== undefined ? `/${goal.maxFlows}` : '';
    const tokenInfo = `${goal.totalTokens}${goal.maxTokens !== undefined ? `/${goal.maxTokens}` : ''}`;
    const acceptanceClause = goal.acceptance ? `\nAcceptance: ${goal.acceptance}` : '';
    const budgetTokenInfo = `${goal.totalTokens}${goal.maxTokens !== undefined ? `/${goal.maxTokens}` : ''}`;
    const budgetFlowInfo = `${flowCount}${goal.maxFlows !== undefined ? `/${goal.maxFlows}` : ''}`;
    const budgetWarning = (overTokens || overFlows)
      ? `\n**⚠️ Budget advisory:** The goal has exceeded its budget (${budgetTokenInfo} tokens, ${budgetFlowInfo} flows). Wrap up efficiently — prioritize the most impactful remaining work and aim to complete within the next 1-2 flows.`
      : '';

    const continuationPrompt = `<flow-continuation>\nThe current session has an active flow goal. Continue execution toward the objective.\n\nObjective: ${goal.objective}${acceptanceClause}\nProgress: ${flowCount}${maxFlowsClause} flows completed, ${tokenInfo} tokens used.${budgetWarning}\n\n**Flow routing:** Choose the appropriate flow type based on the objective:\n- \`scout\` — explore, map, discover\n- \`craft\` — conservative design, architecture\n- \`build\` — implement, test, verify, ship\n- \`audit\` — security, quality, correctness review\n- \`debug\` — investigate root cause and fix\n- \`ideas\` — diverge, evaluate, recommend\n\n**Completion audit:** Before considering the goal complete, verify EACH requirement:\n1. Re-read the original objective and acceptance criteria.\n2. For every stated requirement, confirm concrete evidence of completion.\n3. If ANY requirement lacks evidence, continue working rather than declaring victory.\n4. A goal is complete only when ALL acceptance criteria are met with verifiable results.\n\nCall the flow tool with the appropriate flow type to advance the goal.\n</flow-continuation>`;

    pi.sendMessage({ content: continuationPrompt, display: false }, { triggerTurn: true });
  });
}
