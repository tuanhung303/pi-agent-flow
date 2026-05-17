import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { sanitizeBranchForWarp, SYSTEM_PROMPT } from "./warp-utils.js";

export function setupWarpCommand(pi: ExtensionAPI): void {
  pi.registerCommand("flow:warp", {
    description: "Warp to a new session with distilled context. Usage: /flow:warp [goal]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify?.("warp requires interactive mode", "error");
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify?.("No model selected", "error");
        return;
      }

      const goal = args.trim() || "Continue where we left off";

      const branch = ctx.sessionManager.getBranch();
      const messages = branch
        .filter((entry): entry is SessionEntry & { type: "message" } => (entry as SessionEntry).type === "message")
        .map((entry) => (entry as SessionEntry & { type: "message" }).message);

      if (messages.length === 0) {
        ctx.ui.notify?.("No conversation to warp", "error");
        return;
      }

      const { messages: sanitized } = sanitizeBranchForWarp(messages);
      const llmMessages = convertToLlm(sanitized);
      const conversationText = serializeConversation(llmMessages);
      const currentSessionFile = ctx.sessionManager.getSessionFile();

      const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, "Generating warp prompt...");
        loader.onAbort = () => done(null);

        const doGenerate = async () => {
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
          if (!auth.ok || !auth.apiKey) {
            throw new Error(auth.ok ? `No API key for ${ctx.model!.provider}` : (auth.error ?? "Auth error"));
          }

          const response = await complete(
            ctx.model!,
            {
              systemPrompt: SYSTEM_PROMPT,
              messages: [{ role: "user", content: `## Conversation History\n\n${conversationText}\n\n## User's Goal\n\n${goal}` }],
            },
            { apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
          );

          if (response.stopReason === "aborted") return null;

          return response.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n");
        };

        doGenerate()
          .then(done)
          .catch((err) => {
            console.error("Warp generation failed:", err);
            done(null);
          });

        return loader;
      });

      if (result === null || result === undefined) {
        ctx.ui.notify?.("Cancelled", "info");
        return;
      }

      const editedPrompt = await ctx.ui.editor("Edit warp prompt", result);

      if (editedPrompt === undefined) {
        ctx.ui.notify?.("Cancelled", "info");
        return;
      }

      const newSessionResult = await ctx.newSession({
        parentSession: currentSessionFile,
        withSession: async (replacementCtx) => {
          replacementCtx.ui.setEditorText(editedPrompt);
          replacementCtx.ui.notify("Warp ready. Submit when ready.", "info");
        },
      });

      if (newSessionResult.cancelled) {
        ctx.ui.notify?.("New session cancelled", "info");
      }
    },
  });
}
