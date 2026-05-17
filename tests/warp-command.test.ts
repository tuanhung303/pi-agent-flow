import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@mariozechner/pi-ai", () => ({
  complete: vi.fn(),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  BorderedLoader: class {
    signal = new AbortController().signal;
    onAbort?: () => void;
    constructor(_tui: any, _theme: any, _text: string) {}
    invalidate() {}
    render(_width: number): string[] { return []; }
    handleInput?(_data: string): void {}
  },
  convertToLlm: vi.fn((msgs: any[]) => msgs),
  serializeConversation: vi.fn((msgs: any[]) => msgs.map((m: any) => m.content).join("\n")),
}));

import { complete } from "@mariozechner/pi-ai";
import { BorderedLoader, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import setupWarpCommand from "../src/flow/warp-command.js";

describe("setupWarpCommand", () => {
  const registerCommand = vi.fn();
  const pi = { registerCommand };

  beforeEach(() => {
    vi.clearAllMocks();
    setupWarpCommand(pi as any);
  });

  it("registers the flow:warp command", () => {
    expect(registerCommand).toHaveBeenCalledWith(
      "flow:warp",
      expect.objectContaining({
        description: expect.stringContaining("Transfer context to a new focused session"),
      }),
    );
  });

  it("requires interactive mode", async () => {
    const handler = registerCommand.mock.calls[0][1].handler;
    const notify = vi.fn();
    const ctx = { hasUI: false, ui: { notify } } as any;
    await handler("", ctx);
    expect(notify).toHaveBeenCalledWith("warp requires interactive mode", "error");
  });

  it("requires a model", async () => {
    const handler = registerCommand.mock.calls[0][1].handler;
    const notify = vi.fn();
    const ctx = { hasUI: true, model: null, ui: { notify } } as any;
    await handler("", ctx);
    expect(notify).toHaveBeenCalledWith("No model selected", "error");
  });

  it("requires a non-empty goal", async () => {
    const handler = registerCommand.mock.calls[0][1].handler;
    const notify = vi.fn();
    const ctx = {
      hasUI: true,
      model: { provider: "test", id: "test" },
      ui: { notify },
    } as any;
    await handler("", ctx);
    expect(notify).toHaveBeenCalledWith("Usage: /warp <goal for new thread>", "error");
  });

  it("requires non-empty conversation", async () => {
    const handler = registerCommand.mock.calls[0][1].handler;
    const notify = vi.fn();
    const ctx = {
      hasUI: true,
      model: { provider: "test", id: "test" },
      sessionManager: { getBranch: () => [] },
      ui: { notify },
    } as any;
    await handler("my goal", ctx);
    expect(notify).toHaveBeenCalledWith("No conversation to hand off", "error");
  });

  it("generates warp prompt and creates new session", async () => {
    const handler = registerCommand.mock.calls[0][1].handler;
    const notify = vi.fn();
    const editor = vi.fn().mockResolvedValue("edited prompt");
    const setEditorText = vi.fn();
    const newSession = vi.fn().mockResolvedValue({ cancelled: false });
    const getApiKeyAndHeaders = vi.fn().mockResolvedValue({ ok: true, apiKey: "key", headers: {} });

    (complete as any).mockResolvedValue({
      stopReason: "end",
      content: [{ type: "text", text: "generated prompt" }],
    });

    const branch = [{ type: "message", message: { role: "user", content: "hi" } }];
    const ctx = {
      hasUI: true,
      model: { provider: "test", id: "test" },
      modelRegistry: { getApiKeyAndHeaders },
      sessionManager: {
        getBranch: () => branch,
        getSessionFile: () => "/tmp/session",
      },
      ui: {
        notify,
        editor,
        setEditorText,
        custom: vi.fn().mockImplementation((factory) => {
          return new Promise((resolve) => {
            const done = (val: any) => resolve(val);
            factory({}, {}, {}, done);
          });
        }),
      },
      newSession,
    } as any;

    await handler("my goal", ctx);

    expect(convertToLlm).toHaveBeenCalledWith([{ role: "user", content: "hi" }]);
    expect(serializeConversation).toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        systemPrompt: expect.stringContaining("context transfer assistant"),
        messages: [
          expect.objectContaining({
            role: "user",
            content: [
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("my goal"),
              }),
            ],
          }),
        ],
      }),
      expect.anything(),
    );
    expect(editor).toHaveBeenCalledWith("Edit warp prompt", "generated prompt");
    expect(newSession).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSession: "/tmp/session",
        withSession: expect.any(Function),
      }),
    );
  });

  it("cancels when custom returns null", async () => {
    const handler = registerCommand.mock.calls[0][1].handler;
    const notify = vi.fn();
    const ctx = {
      hasUI: true,
      model: { provider: "test", id: "test" },
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "key", headers: {} }),
      },
      sessionManager: {
        getBranch: () => [{ type: "message", message: { role: "user", content: "hi" } }],
        getSessionFile: () => "/tmp/session",
      },
      ui: {
        notify,
        custom: vi.fn().mockResolvedValue(null),
      },
    } as any;

    await handler("my goal", ctx);
    expect(notify).toHaveBeenCalledWith("Cancelled", "info");
  });

  it("cancels when editor returns undefined", async () => {
    const handler = registerCommand.mock.calls[0][1].handler;
    const notify = vi.fn();
    const editor = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      hasUI: true,
      model: { provider: "test", id: "test" },
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "key", headers: {} }),
      },
      sessionManager: {
        getBranch: () => [{ type: "message", message: { role: "user", content: "hi" } }],
        getSessionFile: () => "/tmp/session",
      },
      ui: {
        notify,
        editor,
        custom: vi.fn().mockResolvedValue("generated prompt"),
      },
    } as any;

    await handler("my goal", ctx);
    expect(notify).toHaveBeenCalledWith("Cancelled", "info");
  });

  it("notifies when new session is cancelled", async () => {
    const handler = registerCommand.mock.calls[0][1].handler;
    const notify = vi.fn();
    const editor = vi.fn().mockResolvedValue("edited prompt");
    const newSession = vi.fn().mockResolvedValue({ cancelled: true });
    const ctx = {
      hasUI: true,
      model: { provider: "test", id: "test" },
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "key", headers: {} }),
      },
      sessionManager: {
        getBranch: () => [{ type: "message", message: { role: "user", content: "hi" } }],
        getSessionFile: () => "/tmp/session",
      },
      ui: {
        notify,
        editor,
        custom: vi.fn().mockResolvedValue("generated prompt"),
      },
      newSession,
    } as any;

    await handler("my goal", ctx);
    expect(notify).toHaveBeenCalledWith("New session cancelled", "info");
  });
});
