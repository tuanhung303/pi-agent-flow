import { describe, it, expect, vi, beforeEach } from "vitest";
import { setupWarpCommand } from "../src/flow/warp-command.js";
import { extractGoalFromPrompt } from "../src/flow/warp-utils.js";

vi.mock("../src/flow/perform-warp.js", () => ({
	distillForWarp: vi.fn(),
	performWarp: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("../src/flow/store.js", () => ({
	getGoalForSession: vi.fn().mockReturnValue(null),
}));

vi.mock("../src/flow/loop.js", () => ({
	getLoop: vi.fn().mockReturnValue(null),
}));

import { distillForWarp, performWarp } from "../src/flow/perform-warp.js";

describe("extractGoalFromPrompt", () => {
	it("extracts end_goal from YAML frontmatter", () => {
		const prompt = `---\ncontext: Refactoring auth layer\nend_goal: All endpoints protected by NestJS guards with zero regressions\ndecisions:\n  - Use JWT\n---\n\n## Task\n\nDo something else.`;
		const result = extractGoalFromPrompt(prompt);
		expect(result).toBe(
			"All endpoints protected by NestJS guards with zero regressions. Context: Refactoring auth layer",
		);
	});

	it("combines end_goal and context when both fit within MAX_GOAL_LEN", () => {
		const prompt = `---\ncontext: Refactoring auth layer\nend_goal: All endpoints protected by NestJS guards with zero regressions\n---\n\n## Task\n\nDo the thing.`;
		const result = extractGoalFromPrompt(prompt);
		expect(result).toBe(
			"All endpoints protected by NestJS guards with zero regressions. Context: Refactoring auth layer",
		);
	});

	it("falls back to end_goal alone when combined string exceeds MAX_GOAL_LEN", () => {
		const longContext = "a".repeat(250);
		const prompt = `---\ncontext: ${longContext}\nend_goal: Short goal here\n---\n\n## Task\n\nDo the thing.`;
		const result = extractGoalFromPrompt(prompt);
		expect(result).toBe("Short goal here");
	});

	it("falls back to ## Task section when no end_goal in frontmatter", () => {
		const prompt = `---\ncontext: Some context\n---\n\n## Task\n\nMigrate tests to vitest and verify all pass\n\n## Other\n\nStuff.`;
		const result = extractGoalFromPrompt(prompt);
		expect(result).toBe("Migrate tests to vitest and verify all pass");
	});

	it("falls back to first body line when no end_goal and no ## Task", () => {
		const prompt = `---\ncontext: Some context\n---\n\nMigrate everything to the new framework now`;
		const result = extractGoalFromPrompt(prompt);
		expect(result).toBe("Migrate everything to the new framework now");
	});

	it("returns generic string when nothing matches", () => {
		const prompt = `---\n---\n\n\n\n`;
		const result = extractGoalFromPrompt(prompt);
		expect(result).toBe("Continue the work from the warped context");
	});

	it("truncates end_goal if it exceeds MAX_GOAL_LEN alone", () => {
		const longGoal = "a".repeat(250);
		const prompt = `---\nend_goal: ${longGoal}\n---\n\n## Task\n\nShort task.`;
		const result = extractGoalFromPrompt(prompt);
		expect(result).toBe(longGoal.slice(0, 200));
	});

	it("handles optional quotes around end_goal and context values", () => {
		const prompt = `---\ncontext: "Quoted context"\nend_goal: 'Quoted goal'\n---\n\n## Task\n\nOther.`;
		const result = extractGoalFromPrompt(prompt);
		expect(result).toBe("Quoted goal. Context: Quoted context");
	});
});

describe("setupWarpCommand", () => {
	const registerCommand = vi.fn();
	const pi = {
		registerCommand,
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		setupWarpCommand(pi as any);
	});

	it("registers the flow:warp command", () => {
		expect(registerCommand).toHaveBeenCalledWith("flow:warp", expect.any(Object));
	});

	it("passes pi to performWarp", async () => {
		(distillForWarp as any).mockResolvedValue("distilled prompt");

		const handler = registerCommand.mock.calls[0][1].handler;

		const ctx = {
			cwd: "/test",
			model: { provider: "test", id: "test" },
			modelRegistry: {
				getAvailable: () => [{ provider: "test", id: "test" }],
				getApiKeyAndHeaders: () => ({ ok: true, apiKey: "key" }),
			},
			sessionManager: {
				getSessionId: () => "s1",
				getBranch: () => [{ type: "message", message: { role: "user", content: "hi" } }],
			},
			ui: {
				custom: vi.fn().mockResolvedValue("distilled prompt"),
				editor: vi.fn().mockResolvedValue("distilled prompt"),
				notify: vi.fn(),
			},
		} as any;

		await handler("My goal", ctx);

		expect(performWarp).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				reviewedPrompt: "distilled prompt",
				goalOverride: "My goal",
				pi,
			}),
		);
	});
});