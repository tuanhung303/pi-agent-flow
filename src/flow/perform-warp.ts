/**
 * Auto-warp pipeline for the endless loop.
 *
 * performWarp — distill context, create a new session, seed it.
 * distillForWarp — shared LLM distillation logic.
 */

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { getGoalForSession, getGoal } from "./store.js";
import { getLoop, recordSessionWarp, terminateLoop, setPendingWarpSessionId, clearPendingWarpSessionId } from "./loop.js";
import { sanitizeBranchForWarp, SYSTEM_PROMPT, extractGoalFromPrompt, MAX_CONVERSATION_CHARS } from "./warp-utils.js";
import { logWarn, logError } from "../config/log.js";
import type { GoalEntry, LoopState } from "./types.js";

export interface WarpFlow {
  type: string;
  intent: string;
  aim: string;
}

export interface DistillOptions {
  signal?: AbortSignal;
  userGoalOverride?: string;
}

export async function distillForWarp(
  ctx: ExtensionCommandContext,
  goalEntry: GoalEntry | undefined,
  loop: LoopState | undefined,
  opts?: DistillOptions,
): Promise<string> {
  const model = ctx.model ?? ctx.modelRegistry?.getAvailable()?.[0];
  if (!model) {
    throw new Error("No model selected. Configure a model in Pi settings first.");
  }

  const branch = ctx.sessionManager.getBranch();
  if (!branch || branch.length === 0) {
    throw new Error("Empty conversation — nothing to warp.");
  }

  const agentMessages = branch
    .map((entry: any) => (entry.type === "message" ? entry.message : undefined))
    .filter((m: any) => m != null);
  const { messages: sanitizedMessages, passesApplied } = sanitizeBranchForWarp(agentMessages);
  if (process.env.PI_FLOW_DUMP_SNAPSHOT) {
    logWarn(`[warp-sanitize] passes applied: ${passesApplied.join(", ")}`);
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
  let preWarpContext = "";
  if (goalEntry) {
    preWarpContext = `\nPre-warp active goal: ${goalEntry.objective}${
      goalEntry.acceptance ? ` (Acceptance: ${goalEntry.acceptance})` : ""
    }\n`;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(auth.ok ? `No API key for ${model.provider}` : (auth.error ?? "Auth error"));
  }

  const userContent = opts?.userGoalOverride
    ? `Conversation history:\n${conversation}\n${preWarpContext}\nUser's goal for new thread: ${opts.userGoalOverride}`
    : `Conversation history:\n${conversation}\n${preWarpContext}`;

  const response = await complete(
    model,
    {
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    },
    { apiKey: auth.apiKey, headers: auth.headers, signal: opts?.signal },
  );

  if (response.stopReason === "aborted") {
    throw new Error("Warp aborted.");
  }

  if (response.stopReason === "error" || response.errorMessage) {
    throw new Error(response.errorMessage || "Unknown error");
  }

  return response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

export interface PerformWarpOptions {
  reviewedPrompt?: string;
  signal?: AbortSignal;
  goalOverride?: string;
}

export async function performWarp(
  ctx: ExtensionCommandContext,
  warpFlow: WarpFlow,
  opts?: PerformWarpOptions,
): Promise<{ success: boolean; error?: string }> {
  const cwd = ctx.cwd;
  const loop = getLoop(cwd);
  const goal = getGoalForSession(cwd, ctx.sessionManager.getSessionId()) ?? getGoal(cwd);
  const isLoopActive = loop?.status === "active";

  if (isLoopActive && !goal) {
    return { success: false, error: "No active goal to warp with." };
  }

  const currentSessionId = ctx.sessionManager.getSessionId();

  if (isLoopActive) {
    setPendingWarpSessionId(cwd, currentSessionId);
  }

  try {
    let bridgeArtifact: string;
    if (opts?.reviewedPrompt) {
      bridgeArtifact = opts.reviewedPrompt;
    } else {
      bridgeArtifact = await distillForWarp(ctx, goal, loop, { signal: opts?.signal });
    }

    let warpedPrompt = bridgeArtifact;
    if (isLoopActive) {
      warpedPrompt += `\n\n[Loop: session ${loop.sessionCount}, total tokens ≈ ${loop.totalTokensAcrossSessions}]`;
    }

    const result = await ctx.newSession({
      parentSession: ctx.sessionManager.getSessionFile(),
      withSession: async (newCtx) => {
        if (isLoopActive) {
          recordSessionWarp(cwd);
        }
        newCtx.ui.notify?.("Warped to new session.", "info");
        await newCtx.sendUserMessage(warpedPrompt);
        const effectiveGoal =
          opts?.goalOverride ??
          (isLoopActive
            ? loop.objective
            : (extractGoalFromPrompt(warpedPrompt) || goal?.objective || "Continue the work from the warped context"));
        newCtx.sendUserMessage(`/flow:goal set ${effectiveGoal}`);
      },
    });

    if (result.cancelled) {
      return { success: false, error: "Warp cancelled." };
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Only terminate the loop for auto-warp paths (no reviewedPrompt).
    // Manual warps should not destroy loop state on transient errors.
    if (isLoopActive && !opts?.reviewedPrompt) {
      terminateLoop(cwd, "budget_exhausted");
    }
    return { success: false, error: message };
  } finally {
    if (isLoopActive) {
      clearPendingWarpSessionId(cwd);
    }
  }
}
