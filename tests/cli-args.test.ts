import { describe, it, expect } from "vitest";
import { parseFlowCliArgs } from "../src/snapshot/cli-args.js";

function parse(args: string[]) {
	return parseFlowCliArgs(["node", "script", ...args]);
}

describe("parseFlowCliArgs", () => {
	it("skips a parent --session-id in both spaced and equals forms", () => {
		const result = parse([
			"--session-id",
			"my-session",
			"--session-id=other-session",
			"--model",
			"claude",
			"--provider",
			"anthropic",
		]);

		expect(result.alwaysProxy).not.toContain("--session-id");
		expect(result.alwaysProxy).not.toContain("my-session");
		expect(result.alwaysProxy).not.toContain("other-session");
		expect(result.alwaysProxy).toEqual(["--provider", "anthropic"]);
		expect(result.fallbackModel).toBe("claude");
	});

	it("still forwards other flags such as --model and --provider", () => {
		const result = parse([
			"--model",
			"gpt-4",
			"--provider",
			"openai",
			"--verbose",
		]);

		expect(result.alwaysProxy).toContain("--provider");
		expect(result.alwaysProxy).toContain("openai");
		expect(result.alwaysProxy).toContain("--verbose");
		expect(result.fallbackModel).toBe("gpt-4");
	});
});
