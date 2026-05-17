import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverFlows, getFlowTier, type FlowDiscoveryResult } from "../src/core/agents.js";

describe("discoverFlows", () => {
	let tmpDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-test-"));
		originalCwd = process.cwd();
		process.chdir(tmpDir);
	});

	afterEach(() => {
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

	it("deduplicates project-scoped flows with mixed-case filenames", () => {
		const agentsDir = path.join(tmpDir, ".pi", "agents");
		writeFlow(
			agentsDir,
			"Code.md",
			`---\nname: Code\ndescription: Uppercase code\n---\nPrompt.`,
		);
		writeFlow(
			agentsDir,
			"code.md",
			`---\nname: code\ndescription: Lowercase code\n---\nPrompt.`,
		);

		const result = discoverFlows(tmpDir, "project");
		const codeFlows = result.flows.filter((f) => f.name === "code");
		expect(codeFlows).toHaveLength(1);
	});

	it("bundled build and debug prompts require relevant docs updates", () => {
		const result = discoverFlows(tmpDir, "bundled");
		const flowsByName = new Map(result.flows.map((flow) => [flow.name, flow]));

		expect(flowsByName.get("build")?.systemPrompt).toContain("Update relevant docs");
		expect(flowsByName.get("build")?.systemPrompt).toContain("if none changed, state why");
		expect(flowsByName.get("debug")?.systemPrompt).toContain("update relevant docs, runbooks, or troubleshooting notes");
		expect(flowsByName.get("debug")?.systemPrompt).toContain("after finishing");
		expect(flowsByName.get("debug")?.systemPrompt).toContain("Documentation-only updates are required after finishing the work");
	});

	it("parses space-separated tools from frontmatter correctly", () => {
		const agentsDir = path.join(tmpDir, ".pi", "agents");
		writeFlow(
			agentsDir,
			"scout.md",
			`---\nname: scout\ndescription: Discovery\ntools: batch bash find grep ls web\n---\nScout prompt.`,
		);

		const result = discoverFlows(tmpDir, "project");
		const scout = result.flows.find((f) => f.name === "scout");
		expect(scout?.tools).toEqual(["batch", "bash", "find", "grep", "ls", "web"]);
	});

	it("parses comma-separated tools from frontmatter correctly", () => {
		const agentsDir = path.join(tmpDir, ".pi", "agents");
		writeFlow(
			agentsDir,
			"audit.md",
			`---\nname: audit\ndescription: Audit\ntools: batch, bash, find, grep, ls, web\n---\nAudit prompt.`,
		);

		const result = discoverFlows(tmpDir, "project");
		const audit = result.flows.find((f) => f.name === "audit");
		expect(audit?.tools).toEqual(["batch", "bash", "find", "grep", "ls", "web"]);
	});

	it("parses mixed comma-and-space separated tools from frontmatter correctly", () => {
		const agentsDir = path.join(tmpDir, ".pi", "agents");
		writeFlow(
			agentsDir,
			"build.md",
			`---\nname: build\ndescription: Build\ntools: batch, bash find, grep ls, web\n---\nBuild prompt.`,
		);

		const result = discoverFlows(tmpDir, "project");
		const build = result.flows.find((f) => f.name === "build");
		expect(build?.tools).toEqual(["batch", "bash", "find", "grep", "ls", "web"]);
	});

	it("parses bundled build flow tools without duplication", () => {
		const result = discoverFlows(tmpDir, "bundled");
		const build = result.flows.find((f) => f.name === "build");
		expect(build).toBeDefined();
		expect(build?.tools).toEqual(["batch", "bash", "find", "grep", "ls", "web"]);
	});
});

describe("getFlowTier", () => {
	it("maps scout to lite", () => {
		expect(getFlowTier("scout")).toBe("lite");
	});

	it("maps debug to lite", () => {
		expect(getFlowTier("debug")).toBe("lite");
	});

	it("maps build to flash", () => {
		expect(getFlowTier("build")).toBe("flash");
	});

	it("maps audit to flash", () => {
		expect(getFlowTier("audit")).toBe("flash");
	});

	it("maps ideas to full", () => {
		expect(getFlowTier("ideas")).toBe("full");
	});

	it("maps craft to full", () => {
		expect(getFlowTier("craft")).toBe("full");
	});

	it("is case-insensitive", () => {
		expect(getFlowTier("SCOUT")).toBe("lite");
		expect(getFlowTier("Build")).toBe("flash");
		expect(getFlowTier("IDEAS")).toBe("full");
	});

	it("defaults unknown flows to flash", () => {
		expect(getFlowTier("custom")).toBe("flash");
		expect(getFlowTier("")).toBe("flash");
	});
});

describe("mergeFlows case-insensitivity", () => {
	it("handles duplicate names with different casing", () => {
		const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-test2-"));
		const originalCwd2 = process.cwd();
		process.chdir(tmpDir2);

		try {
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
			const codeFlows = result.flows.filter((f) => f.name === "code");
			expect(codeFlows).toHaveLength(1);
		} finally {
			process.chdir(originalCwd2);
			fs.rmSync(tmpDir2, { recursive: true, force: true });
		}
	});
});
