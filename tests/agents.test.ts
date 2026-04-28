import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverFlows, type FlowDiscoveryResult } from "../agents.js";

describe("discoverFlows", () => {
	let tmpDir: string;
	let originalCwd: string;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-test-"));
		originalCwd = process.cwd();
		process.chdir(tmpDir);
	});

	afterAll(() => {
		process.chdir(originalCwd);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeFlow(dir: string, fileName: string, content: string) {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, fileName), content, "utf-8");
	}

	it("normalizes flow names to lowercase during discovery", () => {
		const agentsDir = path.join(tmpDir, ".pi", "agents");
		writeFlow(
			agentsDir,
			"EXPLORE.md",
			`---\nname: EXPLORE\ndescription: Discover things\n---\nExplore prompt.`,
		);
		writeFlow(
			agentsDir,
			"Debug.md",
			`---\nname: Debug\ndescription: Fix things\n---\nDebug prompt.`,
		);

		const result = discoverFlows(tmpDir, "project");
		const names = result.flows.map((f) => f.name);
		expect(names).toContain("explore");
		expect(names).toContain("debug");
		expect(names).not.toContain("EXPLORE");
		expect(names).not.toContain("Debug");
	});

	it("merges flows case-insensitively with project overriding bundled", () => {
		const agentsDir = path.join(tmpDir, ".pi", "agents");
		writeFlow(
			agentsDir,
			"explore.md",
			`---\nname: explore\ndescription: Project explore\n---\nProject explore prompt.`,
		);

		const result = discoverFlows(tmpDir, "all");
		const exploreFlows = result.flows.filter((f) => f.name === "explore");
		expect(exploreFlows).toHaveLength(1);
		expect(exploreFlows[0].description).toBe("Project explore");
		expect(exploreFlows[0].source).toBe("project");
	});
});

describe("mergeFlows case-insensitivity", () => {
	it("handles duplicate names with different casing", () => {
		const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-test2-"));
		const originalCwd2 = process.cwd();
		process.chdir(tmpDir2);

		const agentsDir = path.join(tmpDir2, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentsDir, "Code.md"),
			`---\nname: Code\ndescription: Uppercase code\n---\nPrompt.`,
		);
		fs.writeFileSync(
			path.join(agentsDir, "code.md"),
			`---\nname: code\ndescription: Lowercase code\n---\nPrompt.`,
		);

		const result = discoverFlows(tmpDir2, "project");
		process.chdir(originalCwd2);
		fs.rmSync(tmpDir2, { recursive: true, force: true });

		const codeFlows = result.flows.filter((f) => f.name === "code");
		expect(codeFlows).toHaveLength(1);
	});
});
