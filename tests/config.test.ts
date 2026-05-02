import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	loadFlowModelConfigs,
	loadFlowSettings,
	resolveFlowModelCandidates,
} from "../src/config.js";

describe("loadFlowModelConfigs", () => {
	let tmpDir: string;
	let originalHome: string | undefined;
	let originalAgentDir: string | undefined;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-config-test-"));
		originalHome = process.env.HOME;
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.HOME = tmpDir;
		delete process.env.PI_CODING_AGENT_DIR;
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		process.env.HOME = originalHome;
		if (originalAgentDir !== undefined) {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		} else {
			delete process.env.PI_CODING_AGENT_DIR;
		}
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeGlobalSettings(content: Record<string, unknown>) {
		const dir = path.join(tmpDir, ".pi", "agent");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(content, null, 2), "utf-8");
	}

	function writeProjectSettings(cwd: string, content: Record<string, unknown>) {
		const dir = path.join(cwd, ".pi");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(content, null, 2), "utf-8");
	}

	it("returns built-in default config when no settings files exist", () => {
		const result = loadFlowModelConfigs(tmpDir);
		expect(result).toEqual({
			selectedName: "default",
			configs: { default: {} },
			strategy: {},
		});
	});

	it("reads global selected config and strategies", () => {
		writeGlobalSettings({
			flowModelConfig: "balanced",
			flowModelConfigs: {
				balanced: {
					lite: { primary: "gemini-mini" },
					flash: { primary: "claude-sonnet", failover: ["gpt-4o-mini"] },
					full: { primary: "claude-opus" },
				},
			},
		});

		const result = loadFlowModelConfigs(tmpDir);
		expect(result.selectedName).toBe("balanced");
		expect(result.strategy).toEqual({
			lite: { primary: "gemini-mini" },
			flash: { primary: "claude-sonnet", failover: ["gpt-4o-mini"] },
			full: { primary: "claude-opus" },
		});
	});

	it("project overrides global selected config and merges strategies", () => {
		writeGlobalSettings({
			flowModelConfig: "balanced",
			flowModelConfigs: {
				balanced: {
					lite: { primary: "global-lite" },
					flash: { primary: "global-flash", failover: ["global-flash-fallback"] },
				},
			},
		});
		writeProjectSettings(tmpDir, {
			flowModelConfig: "quality",
			flowModelConfigs: {
				balanced: {
					flash: { primary: "project-flash" },
					full: { primary: "project-full" },
				},
				quality: {
					lite: { primary: "quality-lite" },
				},
			},
		});

		const result = loadFlowModelConfigs(tmpDir);
		expect(result.selectedName).toBe("quality");
		expect(result.strategy).toEqual({
			lite: { primary: "quality-lite" },
		});
		expect(result.configs.balanced).toEqual({
			lite: { primary: "global-lite" },
			flash: { primary: "project-flash", failover: ["global-flash-fallback"] },
			full: { primary: "project-full" },
		});
	});

	it("falls back to built-in default when selected config is missing", () => {
		writeGlobalSettings({
			flowModelConfig: "missing",
			flowModelConfigs: {
				balanced: {
					lite: { primary: "gemini-mini" },
				},
			},
		});

		const result = loadFlowModelConfigs(tmpDir);
		expect(result.selectedName).toBe("default");
		expect(result.strategy).toEqual({});
		expect(warnSpy).toHaveBeenCalled();
	});

	it("ignores invalid structures and warns", () => {
		writeGlobalSettings({
			flowModelConfig: "balanced",
			flowModelConfigs: {
				balanced: {
					lite: "bad",
					flash: { primary: 123, failover: ["ok", 99, ""] },
					full: ["bad"],
				},
			},
		});

		const result = loadFlowModelConfigs(tmpDir);
		expect(result.strategy).toEqual({
			flash: { failover: ["ok"] },
		});
		expect(warnSpy).toHaveBeenCalled();
	});

	it("uses PI_CODING_AGENT_DIR for global settings location", () => {
		const customDir = path.join(tmpDir, "custom-agent");
		fs.mkdirSync(customDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = customDir;
		fs.writeFileSync(
			path.join(customDir, "settings.json"),
			JSON.stringify({
				flowModelConfigs: {
					default: { lite: { primary: "custom-model" } },
				},
			}),
			"utf-8",
		);
		const result = loadFlowModelConfigs(tmpDir);
		expect(result.strategy).toEqual({
			lite: { primary: "custom-model" },
		});
	});
});

describe("resolveFlowModelCandidates", () => {
	it("returns explicit flow model only", () => {
		const result = resolveFlowModelCandidates({
			tier: "flash",
			flowModel: "explicit-model",
			strategy: {
				flash: { primary: "strategy-model", failover: ["fallback-a"] },
			},
			fallbackModel: "parent-model",
		});

		expect(result).toEqual({
			primary: "explicit-model",
			candidates: ["explicit-model"],
		});
	});

	it("builds ordered candidates from strategy and fallback", () => {
		const result = resolveFlowModelCandidates({
			tier: "full",
			strategy: {
				full: { primary: "primary-a", failover: ["primary-b", "primary-a"] },
			},
			fallbackModel: "parent-model",
		});

		expect(result).toEqual({
			primary: "primary-a",
			candidates: ["primary-a", "primary-b", "parent-model"],
		});
	});

	it("uses cli tier override before strategy", () => {
		const result = resolveFlowModelCandidates({
			tier: "lite",
			cliTierOverride: "cli-model",
			strategy: {
				lite: { primary: "strategy-model", failover: ["fallback-a"] },
			},
		});

		expect(result).toEqual({
			primary: "cli-model",
			candidates: ["cli-model"],
		});
	});
});

describe("loadFlowSettings", () => {
	let tmpDir: string;
	let originalHome: string | undefined;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-config-test-"));
		originalHome = process.env.HOME;
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.HOME = tmpDir;
		delete process.env.PI_CODING_AGENT_DIR;
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		if (originalAgentDir !== undefined) {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		} else {
			delete process.env.PI_CODING_AGENT_DIR;
		}
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeGlobalSettings(content: Record<string, unknown>) {
		const dir = path.join(tmpDir, ".pi", "agent");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(content, null, 2), "utf-8");
	}

	function writeProjectSettings(cwd: string, content: Record<string, unknown>) {
		const dir = path.join(cwd, ".pi");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(content, null, 2), "utf-8");
	}

	it("returns empty object when no settings files exist", () => {
		const result = loadFlowSettings(tmpDir);
		expect(result).toEqual({});
	});

	it("reads global toolOptimize setting", () => {
		writeGlobalSettings({
			flowSettings: {
				toolOptimize: true,
			},
		});
		const result = loadFlowSettings(tmpDir);
		expect(result).toEqual({ toolOptimize: true });
	});

	it("reads project toolOptimize setting", () => {
		writeProjectSettings(tmpDir, {
			flowSettings: {
				toolOptimize: false,
			},
		});
		const result = loadFlowSettings(tmpDir);
		expect(result).toEqual({ toolOptimize: false });
	});

	it("project overrides global toolOptimize", () => {
		writeGlobalSettings({
			flowSettings: {
				toolOptimize: true,
			},
		});
		writeProjectSettings(tmpDir, {
			flowSettings: {
				toolOptimize: false,
			},
		});
		const result = loadFlowSettings(tmpDir);
		expect(result).toEqual({ toolOptimize: false });
	});

	it("ignores non-boolean toolOptimize", () => {
		writeGlobalSettings({
			flowSettings: {
				toolOptimize: "yes",
			},
		});
		const result = loadFlowSettings(tmpDir);
		expect(result).toEqual({});
	});

	it("gracefully handles invalid JSON", () => {
		const dir = path.join(tmpDir, ".pi", "agent");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "settings.json"), "not json", "utf-8");
		const result = loadFlowSettings(tmpDir);
		expect(result).toEqual({});
	});

	it("gracefully handles missing flowSettings key", () => {
		writeGlobalSettings({
			defaultModel: "claude-sonnet-4",
		});
		const result = loadFlowSettings(tmpDir);
		expect(result).toEqual({});
	});
});
