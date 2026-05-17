/**
 * Auto-warp orchestration for endless loops.
 *
 * When a loop is active and the goal budget is exceeded, instead of pausing
 * we send a hidden message that triggers the root state to call /flow:warp.
 * The warp frontmatter receives loop context so the new session can resume
 * seamlessly.
 */

import type { GoalEntry, LoopState } from "./types.js";
import { getLoop } from "./loop.js";
import { autoWarpTriggerTemplate } from "./loop-templates.js";

export function shouldAutoWarp(cwd: string, goal: GoalEntry): boolean {
  const loop = getLoop(cwd);
  if (!loop || loop.status !== "active") return false;
  const overTokens = goal.maxTokens !== undefined && goal.totalTokens >= goal.maxTokens;
  const overFlows = goal.maxFlows !== undefined && goal.completedFlows.length >= goal.maxFlows;
  return overTokens || overFlows;
}

export function buildAutoWarpPrompt(goal: GoalEntry, loop: LoopState): string {
  const acceptanceClause = goal.acceptance ? `\nAcceptance: ${goal.acceptance}` : "";
  return autoWarpTriggerTemplate
    .replace("{{objective}}", goal.objective)
    .replace("{{acceptanceClause}}", acceptanceClause)
    .replace("{{sessionCount}}", String(loop.sessionCount))
    .replace("{{totalTokensAcrossSessions}}", String(loop.totalTokensAcrossSessions))
    .replace("{{maxTokens}}", String(goal.maxTokens ?? "unlimited"))
    .replace("{{totalFlowsAcrossSessions}}", String(loop.totalFlowsAcrossSessions));
}
