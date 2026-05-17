/**
 * Warp extension — transfer context to a new focused session
 *
 * Instead of compacting (which is lossy), warp extracts what matters
 * for your next task and creates a new session with a generated prompt.
 *
 * Usage:
 *   /flow:warp now implement this for teams as well
 *   /flow:warp execute phase one of the plan
 *   /flow:warp check other places that need this fix
 *   /flow:warp                              (no args = default continuation goal)
 */

import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@mariozechner/pi-coding-agent";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

type RoleMessage = {
	role: "user" | "assistant";
	content: unknown;
};

type AssistantRoleMessage = RoleMessage & {
	role: "assistant";
	stopReason?: unknown;
};

const WARP_TIMEOUT_MS = 5 * 60 * 1000;
const WARP_POLL_INTERVAL_MS = 25;

const WARP_INSTRUCTIONS = `You are writing a warp note for another AI agent with NO access to this chat.

Extract only task-relevant context from this conversation.

Rules:
- Be tight and token-efficient.
- Use only concrete facts from this conversation.
- Prefer specifics: file paths, symbols, commands, errors, outputs, decisions.
- Include constraints/invariants only when explicit, non-negotiable, and task-relevant.
- Include line numbers only if known from this conversation.
- Omit irrelevant history and broad retrospectives.
- Do not invent missing details.
- If a critical detail is unknown, say so briefly and include the smallest verification step.
- Do not write a plan unless one already exists in this conversation.
- Do not call tools.

Your output MUST use this exact format:

FRONTMATTER (YAML between --- delimiters):
  context       — 1-2 sentence orientation summary
  end_goal      — The finish line, not the next step
  decisions     — Key choices already made (list)
  files         — Files touched with what changed (list)
  open_items    — Unresolved work or questions (list)
  watch_out     — Edge cases, gotchas, fragile assumptions (list)
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
  ## Context
  A concise summary of the conversation context.

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
10. No tool calls; all attempts that you need to discover, note them to the watch_out list or execution_plan.
11. Your entire response must be the warp prompt starting with '---' (YAML frontmatter opening). No preamble, no explanations, no tool calls.

IMPORTANT: You are a text generation assistant, not an agent. Do NOT attempt tool calls, file operations, code execution, or any actions. Output ONLY the structured prompt text.`;

function getRoleMessage(entry: SessionEntry, role: "user" | "assistant"): RoleMessage | null {
	if (entry.type !== "message" || !isRecord(entry.message)) {
		return null;
	}
	const message = entry.message;
	if (message.role !== role || !("content" in message)) {
		return null;
	}
	return message as RoleMessage;
}

function getAssistantMessage(entry: SessionEntry): AssistantRoleMessage | null {
	const message = getRoleMessage(entry, "assistant");
	if (!message || !isRecord(message)) {
		return null;
	}
	return message as AssistantRoleMessage;
}

function getMessageText(entry: SessionEntry): string {
	if (entry.type !== "message" || !isRecord(entry.message) || !("content" in entry.message)) {
		return "";
	}
	const content = entry.message.content;
	if (typeof content === "string") {
		return content.trim();
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((block): block is { type: "text"; text: string } => isRecord(block) && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function findUserMessageIndex(entries: SessionEntry[], fromIndex: number, text: string): number {
	for (let i = entries.length - 1; i >= fromIndex; i--) {
		const entry = entries[i];
		if (!getRoleMessage(entry, "user")) {
			continue;
		}
		if (getMessageText(entry) === text) {
			return i;
		}
	}
	return -1;
}

function hasAssistantAfterIndex(entries: SessionEntry[], fromIndex: number): boolean {
	for (let i = entries.length - 1; i > fromIndex; i--) {
		const entry = entries[i];
		if (getRoleMessage(entry, "assistant")) {
			return true;
		}
	}
	return false;
}

type WarpTurn = {
	branch: SessionEntry[];
	warpUserIndex: number;
};

async function waitForWarpTurn(
	ctx: ExtensionCommandContext,
	startIndex: number,
	warpRequest: string,
	timeoutMs = WARP_TIMEOUT_MS,
): Promise<WarpTurn | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const branch = ctx.sessionManager.getBranch() as SessionEntry[];
		const warpUserIndex = findUserMessageIndex(branch, startIndex, warpRequest);
		if (warpUserIndex !== -1 && hasAssistantAfterIndex(branch, warpUserIndex) && ctx.isIdle()) {
			return { branch, warpUserIndex };
		}
		await new Promise<void>((resolve) => setTimeout(resolve, WARP_POLL_INTERVAL_MS));
	}
	return null;
}

function getAssistantText(entries: SessionEntry[], fromIndex: number): string | null {
	for (let i = entries.length - 1; i >= fromIndex; i--) {
		const entry = entries[i];
		const message = getAssistantMessage(entry);
		if (!message) {
			continue;
		}
		if (message.stopReason !== "stop") {
			return null;
		}
		const text = getMessageText(entry);
		if (text.length > 0) {
			return text;
		}
	}
	return null;
}

const DEFAULT_GOAL = "Continue where we left off — summarize what we have done, where we are, and what the natural next step is.";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("flow:warp", {
		description: "Transfer context to a new focused session",
		handler: async (args, ctx) => {
			const notify = (message: string, level: "info" | "warning" | "error") => {
				ctx.ui?.notify?.(message, level);
			};

			if (!ctx.model) {
				notify("No model selected", "error");
				return;
			}

			const task = args.trim() || DEFAULT_GOAL;

			const currentSessionFile = ctx.sessionManager.getSessionFile();
			const startIndex = ctx.sessionManager.getBranch().length;

			const warpRequest = `${WARP_INSTRUCTIONS}\n\nTask for the next agent:\n${task}`;

			if (ctx.isIdle()) {
				pi.sendUserMessage(warpRequest);
			} else {
				pi.sendUserMessage(warpRequest, { deliverAs: "followUp" });
			}

			notify("Generating warp note...", "info");
			const warpTurn = await waitForWarpTurn(ctx, startIndex, warpRequest);

			if (!warpTurn) {
				notify("Timed out waiting for warp note", "error");
				return;
			}

			const warpNote = getAssistantText(warpTurn.branch, warpTurn.warpUserIndex + 1);

			if (!warpNote) {
				notify("Failed to capture warp note from the assistant response", "error");
				return;
			}

			const promptForNewSession = `${warpNote}\n\n---\n\n## Task\n${task}`;

			const newSessionResult = await ctx.newSession({
				parentSession: currentSessionFile,
				withSession: async (newCtx) => {
					await newCtx.sendUserMessage(promptForNewSession);
					newCtx.ui?.notify?.("Warp ready...", "info");
				},
			});

			if (newSessionResult.cancelled) {
				notify("New session cancelled", "info");
				return;
			}
		},
	});
}
