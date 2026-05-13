import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ReplacedSessionContext, TurnEndEvent } from "@mariozechner/pi-coding-agent";

interface SessionStartEvent {
	type: "session_start";
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	previousSessionFile?: string;
}
import { registeredCommands } from "../tests/__mocks__/pi-coding-agent.js";
import { setupSpecMode, resetSpecDeactivation } from "../src/spec-mode.js";
import {
	isSpecModeActive,
	setSpecModeActive,
	makeSteeringHintMessage,
	STEERING_HINT,
	IMPLEMENT_PROMPT,
} from "../src/sliding-prompt.js";

function createMockPi(): ExtensionAPI & { emitTurnEnd(event: TurnEndEvent, ctx: ExtensionContext): void; emitSessionStart(event: SessionStartEvent, ctx: ExtensionContext): void } {
	const handlers: Record<string, Function[]> = {};
	return {
		registerFlag: vi.fn(),
		on: vi.fn((event: string, handler: Function) => {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
		}),
		emit: vi.fn(),
		emitTurnEnd: (event: TurnEndEvent, ctx: ExtensionContext) => {
			for (const h of handlers["turn_end"] ?? []) {
				h(event, ctx);
			}
		},
		emitSessionStart: (event: SessionStartEvent, ctx: ExtensionContext) => {
			for (const h of handlers["session_start"] ?? []) {
				h(event, ctx);
			}
		},
		registerTool: vi.fn(),
		setActiveTools: vi.fn(),
		getActiveTools: vi.fn(() => []),
		getFlag: vi.fn(),
		registerCommand: vi.fn((name: string, config: any) => {
			registeredCommands.set(name, config);
		}),
		sendUserMessage: vi.fn(),
	} as unknown as ExtensionAPI & { emitTurnEnd(event: TurnEndEvent, ctx: ExtensionContext): void; emitSessionStart(event: SessionStartEvent, ctx: ExtensionContext): void };
}

function createMockCtx(options?: { newSessionCancelled?: boolean }) {
	const notifyCalls: { msg: string; type: string }[] = [];
	const editorTexts: string[] = [];
	const newSessionId = "new-session-456";
	const newCtx = {
		cwd: "/tmp/test",
		hasUI: true,
		ui: {
			confirm: vi.fn(async () => false),
			notify: vi.fn((msg: string, type: string) => {
				notifyCalls.push({ msg, type });
			}),
			select: vi.fn(async () => null),
			input: vi.fn(async () => null),
			custom: vi.fn(async () => undefined),
			setEditorText: vi.fn((text: string) => {
				editorTexts.push(text);
			}),
		},
		sessionManager: { getSessionDir: () => "/tmp", getHeader: () => ({}), getBranch: () => [], getSessionId: () => newSessionId },
		sendUserMessage: vi.fn(async (msg: string) => {}),
	} as unknown as ReplacedSessionContext;
	const ctx = {
		cwd: "/tmp/test",
		hasUI: true,
		ui: {
			confirm: vi.fn(async () => false),
			notify: vi.fn((msg: string, type: string) => {
				notifyCalls.push({ msg, type });
			}),
			select: vi.fn(async () => null),
			input: vi.fn(async () => null),
			custom: vi.fn(async () => undefined),
			setEditorText: vi.fn((text: string) => {
				editorTexts.push(text);
			}),
		},
		sessionManager: { getSessionDir: () => "/tmp", getHeader: () => ({}), getBranch: () => [], getSessionId: () => "old-session-123" },
		newSession: vi.fn(async (opts?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> }) => {
			const cancelled = options?.newSessionCancelled ?? false;
			if (!cancelled && opts?.withSession) {
				await opts.withSession(newCtx);
			}
			return { cancelled };
		}),
		navigateTree: vi.fn(async () => ({ cancelled: false })),
		waitForIdle: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
	} as unknown as ExtensionCommandContext;
	return { ctx, notifyCalls, editorTexts, newCtx };
}

/** Strip a command context down to ExtensionContext (no newSession etc.) */
function toExtensionContext(cmdCtx: ExtensionCommandContext): ExtensionContext {
	const { newSession: _ns, navigateTree: _nt, waitForIdle: _wi, reload: _re, ...extCtx } = cmdCtx as any;
	return extCtx as ExtensionContext;
}

describe("setupSpecMode", () => {
	beforeEach(() => {
		registeredCommands.clear();
		setSpecModeActive(true); // reset to default
		resetSpecDeactivation();
		vi.stubGlobal("setImmediate", (fn: () => void) => fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("registers the spec command and turn_end listener", () => {
		const pi = createMockPi();
		setupSpecMode(pi);

		expect(registeredCommands.has("spec")).toBe(true);
		expect(registeredCommands.get("spec")!.description).toContain("Toggle");
		expect(pi.on).toHaveBeenCalledWith("turn_end", expect.any(Function));
	});

	it("toggles spec mode off, captures assistant plan, and calls captured newSession in turn_end", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);
		const command = registeredCommands.get("spec")!;
		const { ctx, notifyCalls, editorTexts } = createMockCtx();

		expect(isSpecModeActive()).toBe(true);
		await command.handler("", ctx);
		// Spec mode stays active while the plan is being crafted in the current session
		expect(isSpecModeActive()).toBe(true);
		// newSession should NOT be called yet (only captured for later)
		expect(ctx.newSession).not.toHaveBeenCalled();
		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			"Synthesize a full implementation plan from the conversation history. Output ONLY the complete markdown spec (no tool calls after you start writing). After you finish, the plan will be placed in the editor for review."
		);

		// Simulate assistant responding with the plan in the CURRENT session.
		// Pass a stripped ExtensionContext (no newSession) to match real runtime.
		const extCtx = toExtensionContext(ctx);
		pi.emitTurnEnd(
			{ message: { role: "assistant", content: [{ type: "text", text: "# Plan\n\nImplement caching." }] } },
			extCtx,
		);
		expect(isSpecModeActive()).toBe(false);
		expect(editorTexts).toContain("# Plan\n\nImplement caching.");
		expect(notifyCalls.some((n) => n.msg === "Spec mode deactivated — plan ready in editor")).toBe(true);
		// The captured newSession WAS called during turn_end
		expect(ctx.newSession).toHaveBeenCalled();
	});

	it("does not capture non-assistant turns", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);
		const command = registeredCommands.get("spec")!;
		const { ctx, editorTexts } = createMockCtx();

		await command.handler("", ctx);

		// Simulate a user turn in the current session — should be ignored
		const extCtx = toExtensionContext(ctx);
		pi.emitTurnEnd(
			{ message: { role: "user", content: "some user text" } },
			extCtx,
		);
		expect(editorTexts).toHaveLength(0);
		expect(ctx.newSession).not.toHaveBeenCalled();
	});

	it("captures only the first assistant turn then stops listening", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);
		const command = registeredCommands.get("spec")!;
		const { ctx, editorTexts } = createMockCtx();

		await command.handler("", ctx);

		const extCtx = toExtensionContext(ctx);
		pi.emitTurnEnd(
			{ message: { role: "assistant", content: [{ type: "text", text: "First plan" }] } },
			extCtx,
		);
		expect(editorTexts).toContain("First plan");
		expect(ctx.newSession).toHaveBeenCalledTimes(1);

		// Second assistant turn in the current session should be ignored
		pi.emitTurnEnd(
			{ message: { role: "assistant", content: [{ type: "text", text: "Second plan" }] } },
			extCtx,
		);
		expect(editorTexts).toHaveLength(1);
		expect(editorTexts).not.toContain("Second plan");
		expect(ctx.newSession).toHaveBeenCalledTimes(1);
	});

	it("sets spec mode inactive and captures plan via newSession after assistant reply", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);
		const command = registeredCommands.get("spec")!;
		const { ctx, notifyCalls, editorTexts } = createMockCtx();

		expect(isSpecModeActive()).toBe(true);
		await command.handler("", ctx);
		// Still active while waiting for the plan
		expect(isSpecModeActive()).toBe(true);
		expect(ctx.newSession).not.toHaveBeenCalled();
		expect(pi.sendUserMessage).toHaveBeenCalled();

		// Simulate assistant responding with the plan
		const extCtx = toExtensionContext(ctx);
		pi.emitTurnEnd(
			{ message: { role: "assistant", content: [{ type: "text", text: "# Plan\n\nImplement caching." }] } },
			extCtx,
		);
		expect(isSpecModeActive()).toBe(false);
		expect(editorTexts).toContain("# Plan\n\nImplement caching.");
		expect(notifyCalls.some((n) => n.msg === "Spec mode deactivated — plan ready in editor")).toBe(true);
		expect(ctx.newSession).toHaveBeenCalled();
	});

	it("toggles spec mode on", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);
		const command = registeredCommands.get("spec")!;
		const { ctx, notifyCalls } = createMockCtx();

		setSpecModeActive(false);
		expect(isSpecModeActive()).toBe(false);
		await command.handler("", ctx);
		expect(isSpecModeActive()).toBe(true);
		expect(ctx.newSession).toHaveBeenCalled();
		expect(notifyCalls.some((n) => n.msg === "Spec mode activated")).toBe(true);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("forwards a prompt and activates spec mode", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);
		const command = registeredCommands.get("spec")!;
		const { ctx, notifyCalls } = createMockCtx();

		setSpecModeActive(false);
		expect(isSpecModeActive()).toBe(false);
		await command.handler("design a caching layer", ctx);
		expect(isSpecModeActive()).toBe(true);
		expect(pi.sendUserMessage).toHaveBeenCalledWith("design a caching layer");
		expect(notifyCalls.some((n) => n.msg === "Spec mode activated")).toBe(true);
	});

	it("trims whitespace from the forwarded prompt", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);
		const command = registeredCommands.get("spec")!;
		const { ctx } = createMockCtx();

		setSpecModeActive(false);
		await command.handler("  build auth flow  ", ctx);
		expect(pi.sendUserMessage).toHaveBeenCalledWith("build auth flow");
	});

	it("stays out of spec mode when newSession is cancelled on toggle on", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);
		const command = registeredCommands.get("spec")!;
		const { ctx, notifyCalls, editorTexts } = createMockCtx({ newSessionCancelled: true });

		setSpecModeActive(false);
		expect(isSpecModeActive()).toBe(false);
		await command.handler("", ctx);
		expect(isSpecModeActive()).toBe(false);
		expect(ctx.newSession).toHaveBeenCalled();
		expect(notifyCalls.some((n) => n.msg === "Spec mode activated")).toBe(false);
		expect(editorTexts).toHaveLength(0);
	});

	it("does not capture old assistant reply after toggling on again", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);
		const command = registeredCommands.get("spec")!;
		const { ctx, editorTexts } = createMockCtx();

		// Toggle OFF (sets _pendingSpecDeactivation + captures newSession)
		await command.handler("", ctx);
		expect(isSpecModeActive()).toBe(true);

		// Toggle ON (clears pending flag and creates new session)
		await command.handler("", ctx);
		expect(isSpecModeActive()).toBe(true);

		// Old session assistant reply should NOT be captured
		const extCtx = toExtensionContext(ctx);
		pi.emitTurnEnd(
			{ message: { role: "assistant", content: [{ type: "text", text: "Old plan" }] } },
			extCtx,
		);
		expect(editorTexts).toHaveLength(0);
	});

	it("clears stale waiting flag when activating with a prompt", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);
		const command = registeredCommands.get("spec")!;
		const { ctx, editorTexts } = createMockCtx();

		// Toggle OFF to set _pendingSpecDeactivation
		await command.handler("", ctx);
		expect(isSpecModeActive()).toBe(true);

		// Activate with prompt — should clear pending flag
		await command.handler("design a caching layer", ctx);
		expect(isSpecModeActive()).toBe(true);

		// Old session assistant reply should NOT be captured
		const extCtx = toExtensionContext(ctx);
		pi.emitTurnEnd(
			{ message: { role: "assistant", content: [{ type: "text", text: "Old plan" }] } },
			extCtx,
		);
		expect(editorTexts).toHaveLength(0);
	});

	it("resets spec mode to default on session_start reason 'new'", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);

		setSpecModeActive(false);
		expect(isSpecModeActive()).toBe(false);

		const extCtx = toExtensionContext(createMockCtx().ctx);
		pi.emitSessionStart({ type: "session_start", reason: "new" }, extCtx);
		expect(isSpecModeActive()).toBe(true);
	});

	it("resets spec mode to default on session_start reason 'fork'", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);

		setSpecModeActive(false);
		expect(isSpecModeActive()).toBe(false);

		const extCtx = toExtensionContext(createMockCtx().ctx);
		pi.emitSessionStart({ type: "session_start", reason: "fork" }, extCtx);
		expect(isSpecModeActive()).toBe(true);
	});

	it("does NOT reset spec mode on session_start reason 'resume'", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);

		setSpecModeActive(false);
		expect(isSpecModeActive()).toBe(false);

		const extCtx = toExtensionContext(createMockCtx().ctx);
		pi.emitSessionStart({ type: "session_start", reason: "resume" }, extCtx);
		expect(isSpecModeActive()).toBe(false);
	});

	it("clears pending deactivation state on session_start reason 'new'", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);
		const command = registeredCommands.get("spec")!;
		const { ctx, editorTexts } = createMockCtx();

		// Toggle OFF to set _pendingSpecDeactivation
		await command.handler("", ctx);
		expect(isSpecModeActive()).toBe(true);

		// Simulate /new — should clear pending state
		const extCtx = toExtensionContext(ctx);
		pi.emitSessionStart({ type: "session_start", reason: "new" }, extCtx);

		// Old session assistant reply should NOT be captured because pending was cleared
		pi.emitTurnEnd(
			{ message: { role: "assistant", content: [{ type: "text", text: "Old plan" }] } },
			extCtx,
		);
		expect(editorTexts).toHaveLength(0);
	});
});

describe("makeSteeringHintMessage mode switching", () => {
	beforeEach(() => {
		setSpecModeActive(true);
	});

	it("returns spec prompt when spec mode is active", () => {
		setSpecModeActive(true);
		const msg = makeSteeringHintMessage();
		expect(msg.content).toBe(STEERING_HINT);
	});

	it("returns implement prompt when spec mode is inactive", () => {
		setSpecModeActive(false);
		const msg = makeSteeringHintMessage();
		expect(msg.content).toBe(IMPLEMENT_PROMPT);
	});
});
