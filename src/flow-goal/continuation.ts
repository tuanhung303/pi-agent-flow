import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@mariozechner/pi-coding-agent";
import { getGoal, addTokens, updateGoalStatus } from "./store.js";

let _previousObjective: string | undefined;
let _lastSpawnAt = 0;
const SPAWN_COOLDOWN_MS = 5000;

export function setupContinuation(
  pi: ExtensionAPI,
  getCwd: () => string | undefined,
): void {
  pi.on("turn_end", async (event: TurnEndEvent) => {
    const cwd = getCwd();
    if (!cwd) return;

    const goal = getGoal(cwd);
    if (!goal || goal.status !== "active") return;

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
    if (overTokens || overFlows) {
      updateGoalStatus(cwd, "paused");
      return;
    }

    // Build a flow tool call instruction
    const aim = goal.objective.slice(0, 60);
    const acceptanceClause = goal.acceptance ? ` Acceptance: ${goal.acceptance}.` : '';
    pi.sendUserMessage(
      `You MUST call the flow tool now to advance the active goal.${'\n'}` +
      `Goal: ${goal.objective}${'\n'}` +
      `Call the flow tool with: {"flow": [{"type": "build", "intent": "${goal.objective.replace(/"/g, '\\"')}", "aim": "${aim.replace(/"/g, '\\"')}"${goal.acceptance ? `, "acceptance": "${goal.acceptance.replace(/"/g, '\\"')}"` : ''}}]}`
    );
  });
}
