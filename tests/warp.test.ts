import { describe, it, expect, vi, beforeEach } from "vitest";

import setupWarp from "../src/flow/warp.js";

describe("setupWarp", () => {
	const registerCommand = vi.fn();
	const sendUserMessage = vi.fn();
	const pi = { registerCommand, sendUserMessage };

	beforeEach(() => {
		vi.clearAllMocks();
		setupWarp(pi as any);
	});

	it("registers the flow:warp command", () => {
		expect(registerCommand).toHaveBeenCalledWith(
			"flow:warp",
			expect.objectContaining({
				description: expect.stringContaining("Transfer context to a new focused session"),
			}),
		);
	});

	it("requires a model", async () => {
		const handler = registerCommand.mock.calls[0][1].handler;
		const notify = vi.fn();
		const ctx = { model: null, ui: { notify } } as any;
		await handler("", ctx);
		expect(notify).toHaveBeenCalledWith("No model selected", "error");
	});

	it("uses default goal when args are empty", async () => {
		const handler = registerCommand.mock.calls[0][1].handler;
		const notify = vi.fn();
		const getSessionFile = vi.fn().mockReturnValue("/tmp/session");
		let branch: any[] = [];
		const getBranch = vi.fn().mockImplementation(() => branch);
		const newSession = vi.fn().mockResolvedValue({ cancelled: false });
		const ctx = {
			model: { provider: "test", id: "test" },
			sessionManager: { getBranch, getSessionFile, getSessionId: () => "sid" },
			ui: { notify },
			newSession,
			isIdle: () => true,
		} as any;

		sendUserMessage.mockImplementation((content: string) => {
			branch.push({ type: "message", message: { role: "user", content } });
			branch.push({ type: "message", message: { role: "assistant", stopReason: "stop", content: "generated warp note" } });
		});

		await handler("", ctx);

		expect(sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("Continue where we left off"),
		);
		expect(newSession).toHaveBeenCalled();
	});

	it("times out when no assistant response arrives", async () => {
		const handler = registerCommand.mock.calls[0][1].handler;
		const notify = vi.fn();
		const getSessionFile = vi.fn().mockReturnValue("/tmp/session");
		const getBranch = vi.fn().mockReturnValue([]);
		const newSession = vi.fn();
		const ctx = {
			model: { provider: "test", id: "test" },
			sessionManager: { getBranch, getSessionFile, getSessionId: () => "sid" },
			ui: { notify },
			newSession,
			isIdle: () => true,
		} as any;

		const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(Infinity);

		await handler("my goal", ctx);

		expect(notify).toHaveBeenCalledWith("Timed out waiting for warp note", "error");
		expect(newSession).not.toHaveBeenCalled();

		dateNowSpy.mockRestore();
	});

	it("captures assistant response and creates new session", async () => {
		const handler = registerCommand.mock.calls[0][1].handler;
		const notify = vi.fn();
		const getSessionFile = vi.fn().mockReturnValue("/tmp/session");
		let branch: any[] = [];
		const getBranch = vi.fn().mockImplementation(() => branch);
		const newSession = vi.fn().mockResolvedValue({ cancelled: false });
		const ctx = {
			model: { provider: "test", id: "test" },
			sessionManager: { getBranch, getSessionFile, getSessionId: () => "sid" },
			ui: { notify },
			newSession,
			isIdle: () => true,
		} as any;

		sendUserMessage.mockImplementation((content: string) => {
			branch.push({ type: "message", message: { role: "user", content } });
			branch.push({ type: "message", message: { role: "assistant", stopReason: "stop", content: "generated warp note" } });
		});

		await handler("my goal", ctx);

		expect(notify).toHaveBeenCalledWith("Generating warp note...", "info");
		expect(newSession).toHaveBeenCalledWith(
			expect.objectContaining({
				parentSession: "/tmp/session",
				withSession: expect.any(Function),
			}),
		);

		const withSessionCallback = newSession.mock.calls[0][0].withSession;
		const newCtxSendUserMessage = vi.fn();
		const newCtxNotify = vi.fn();
		await withSessionCallback({
			sendUserMessage: newCtxSendUserMessage,
			ui: { notify: newCtxNotify },
		});

		expect(newCtxSendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("## Task\nmy goal"),
		);
		expect(newCtxNotify).toHaveBeenCalledWith("Warp ready...", "info");
	});

	it("notifies when new session is cancelled", async () => {
		const handler = registerCommand.mock.calls[0][1].handler;
		const notify = vi.fn();
		const getSessionFile = vi.fn().mockReturnValue("/tmp/session");
		let branch: any[] = [];
		const getBranch = vi.fn().mockImplementation(() => branch);
		const newSession = vi.fn().mockResolvedValue({ cancelled: true });
		const ctx = {
			model: { provider: "test", id: "test" },
			sessionManager: { getBranch, getSessionFile, getSessionId: () => "sid" },
			ui: { notify },
			newSession,
			isIdle: () => true,
		} as any;

		sendUserMessage.mockImplementation((content: string) => {
			branch.push({ type: "message", message: { role: "user", content } });
			branch.push({ type: "message", message: { role: "assistant", stopReason: "stop", content: "note" } });
		});

		await handler("my goal", ctx);
		expect(notify).toHaveBeenCalledWith("New session cancelled", "info");
	});

	it("rejects assistant responses with non-stop stopReason", async () => {
		const handler = registerCommand.mock.calls[0][1].handler;
		const notify = vi.fn();
		const getSessionFile = vi.fn().mockReturnValue("/tmp/session");
		let branch: any[] = [];
		const getBranch = vi.fn().mockImplementation(() => branch);
		const newSession = vi.fn();
		const ctx = {
			model: { provider: "test", id: "test" },
			sessionManager: { getBranch, getSessionFile, getSessionId: () => "sid" },
			ui: { notify },
			newSession,
			isIdle: () => true,
		} as any;

		sendUserMessage.mockImplementation((content: string) => {
			branch.push({ type: "message", message: { role: "user", content } });
			branch.push({ type: "message", message: { role: "assistant", stopReason: "error", content: "bad note" } });
		});

		await handler("my goal", ctx);
		expect(notify).toHaveBeenCalledWith("Failed to capture warp note from the assistant response", "error");
		expect(newSession).not.toHaveBeenCalled();
	});
});
