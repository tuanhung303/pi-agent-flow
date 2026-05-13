import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ReplacedSessionContext, TurnEndEvent } from "@mariozechner/pi-coding-agent";
import { isSpecModeActive, setSpecModeActive } from "./steering-hint.js";

let _pendingSpecDeactivation = false;
let _pendingNewSession: ExtensionCommandContext["newSession"] | null = null;

/** Reset the pending-deactivation flag (used by tests for isolation). */
export function resetSpecDeactivation(): void {
	_pendingSpecDeactivation = false;
	_pendingNewSession = null;
}

function extractTextFromContent(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * Setup the /spec command as a persistent toggle between spec mode
 * (investigate → discuss → plan → delegate) and implement mode
 * (lean orchestrator, investigate first then delegate).
 *
 * The steering hint in index.ts reads the active flag and injects
 * the appropriate prompt content each turn.
 */
export function setupSpecMode(pi: ExtensionAPI): void {
	pi.on("session_start", (event, _ctx: ExtensionContext) => {
		if (event.reason === "new" || event.reason === "fork" || event.reason === "startup") {
			setSpecModeActive(true);
			resetSpecDeactivation();
		}
	});

	pi.on("turn_end", (event: TurnEndEvent, ctx: ExtensionContext) => {
		if (!_pendingSpecDeactivation || event.message?.role !== "assistant") return;
		const text = extractTextFromContent(event.message.content);
		setSpecModeActive(false);
		const capturedNewSession = _pendingNewSession;
		_pendingNewSession = null;
		_pendingSpecDeactivation = false;
		if (capturedNewSession) {
			setImmediate(() => {
				void capturedNewSession({
					withSession: async (newCtx: ReplacedSessionContext) => {
						if (text.trim()) {
							newCtx.ui.setEditorText?.(text);
						}
						newCtx.ui.notify?.("Spec mode deactivated — plan ready in editor", "info");
					},
				});
			});
		}
	});

	pi.registerCommand("spec", {
		description: "Toggle spec-driven planning mode on/off, or pass a prompt to activate and start immediately.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();
			if (trimmed) {
				_pendingSpecDeactivation = false;
				_pendingNewSession = null;
				setSpecModeActive(true);
				pi.sendUserMessage(trimmed);
				ctx.ui.notify?.("Spec mode activated", "info");
			} else {
				const next = !isSpecModeActive();
				if (!next && !_pendingSpecDeactivation) {
					// Deactivate: craft plan in current session, then switch
					_pendingSpecDeactivation = true;
					_pendingNewSession = ctx.newSession.bind(ctx);
					pi.sendUserMessage("Synthesize a full implementation plan from the conversation history. Output ONLY the complete markdown spec (no tool calls after you start writing). After you finish, the plan will be placed in the editor for review.");
				} else {
					// Activate (or cancel a pending deactivation)
					_pendingSpecDeactivation = false;
					_pendingNewSession = null;
					const result = await ctx.newSession({
						withSession: async (newCtx: ReplacedSessionContext) => {
							setSpecModeActive(true);
							newCtx.ui.notify?.("Spec mode activated", "info");
						},
					});
					if (result.cancelled) {
						return;
					}
				}
			}
		},
	});
}
