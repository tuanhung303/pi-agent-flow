import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	formatFlowModelStrategy,
	getGlobalSettingsPath,
	loadFlowModelConfigs,
	loadFlowSettings,
	resolveFlowModelCandidates,
	writeGlobalFlowMode,
} from "../src/config/config.js";
import { resolveModelContextWindow } from "../src/config/models.js";

describe("loadFlowModelConfigs", () => {
	let tmpDir: string;
	let originalHome: string | undefined;
	let originalAgentDir: string | undefined;
	let originalIsTTY: boolean | undefined;
	let originalFlowDepth: string | undefined;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-config-test-"));
		originalHome = process.env.HOME;
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		originalIsTTY = process.stdout.isTTY;
		originalFlowDepth = process.env.PI_FLOW_DEPTH;
		process.env.HOME = tmpDir;
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_FLOW_DEPTH;
		// @ts-ignore
		process.stdout.isTTY = false;
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		// @ts-ignore
		process.stdout.isTTY = originalIsTTY;
		if (originalFlowDepth !== undefined) {
			process.env.PI_FLOW_DEPTH = originalFlowDepth;
		} else {
			delete process.env.PI_FLOW_DEPTH;
		}
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

describe("writeGlobalFlowMode", () => {
	let tmpDir: string;
	let originalHome: string | undefined;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-mode-test-"));
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

	it("creates global settings when missing", () => {
		const result = writeGlobalFlowMode("mimo");

		expect(result.path).toBe(path.join(tmpDir, ".pi", "agent", "settings.json"));
		expect(JSON.parse(fs.readFileSync(result.path, "utf-8"))).toEqual({
			flowModelConfig: "mimo",
		});
	});

	it("preserves existing settings while updating only flowModelConfig", () => {
		const dir = path.join(tmpDir, ".pi", "agent");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "settings.json"),
			JSON.stringify({
				flowModelConfig: "balance",
				flowSettings: { maxConcurrency: 2 },
				flowModelConfigs: { balance: {}, mimo: {} },
			}, null, 2),
			"utf-8",
		);

		const result = writeGlobalFlowMode("mimo");

		expect(result.previous).toBe("balance");
		expect(JSON.parse(fs.readFileSync(result.path, "utf-8"))).toEqual({
			flowModelConfig: "mimo",
			flowSettings: { maxConcurrency: 2 },
			flowModelConfigs: { balance: {}, mimo: {} },
		});
	});

	it("respects PI_CODING_AGENT_DIR", () => {
		const customDir = path.join(tmpDir, "custom-agent");
		process.env.PI_CODING_AGENT_DIR = customDir;

		writeGlobalFlowMode("quality");

		expect(getGlobalSettingsPath()).toBe(path.join(customDir, "settings.json"));
		expect(JSON.parse(fs.readFileSync(path.join(customDir, "settings.json"), "utf-8"))).toEqual({
			flowModelConfig: "quality",
		});
	});

	it("refuses to overwrite invalid JSON", () => {
		const dir = path.join(tmpDir, ".pi", "agent");
		fs.mkdirSync(dir, { recursive: true });
		const settingsPath = path.join(dir, "settings.json");
		fs.writeFileSync(settingsPath, "not json", "utf-8");

		expect(() => writeGlobalFlowMode("mimo")).toThrow(/invalid JSON/);
		expect(fs.readFileSync(settingsPath, "utf-8")).toBe("not json");
	});

	it("rejects empty mode names", () => {
		expect(() => writeGlobalFlowMode("   ")).toThrow(/non-empty mode name/);
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

	it("reads and merges sessionMode settings", () => {
		writeGlobalSettings({
			flowSettings: {
				sessionMode: "fast",
			},
		});
		writeProjectSettings(tmpDir, {
			flowSettings: {
				sessionMode: "long",
			},
		});
		const result = loadFlowSettings(tmpDir);
		expect(result).toEqual({ sessionMode: "long" });
	});

	it("ignores invalid sessionMode settings", () => {
		writeGlobalSettings({
			flowSettings: {
				sessionMode: "extra-long",
			},
		});
		const result = loadFlowSettings(tmpDir);
		expect(result).toEqual({});
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

describe("resolveModelContextWindow", () => {
	let tmpDir: string;
	let originalHome: string | undefined;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-models-test-"));
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

	function writeModelsJson(content: Record<string, unknown>) {
		const dir = path.join(tmpDir, ".pi", "agent");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify(content, null, 2), "utf-8");
	}

	it("returns undefined when models.json does not exist", () => {
		expect(resolveModelContextWindow("openai/gpt-4o")).toBeUndefined();
	});

	it("returns undefined for invalid model string format", () => {
		writeModelsJson({
			providers: {
				openai: {
					models: [{ id: "gpt-4o", contextWindow: 128000 }],
				},
			},
		});
		expect(resolveModelContextWindow("gpt-4o")).toBeUndefined();
	});

	it("resolves contextWindow for a simple provider/modelId", () => {
		writeModelsJson({
			providers: {
				openai: {
					models: [{ id: "gpt-4o", contextWindow: 128000 }],
				},
			},
		});
		expect(resolveModelContextWindow("openai/gpt-4o")).toBe(128000);
	});

	it("resolves contextWindow for a nested modelId with slashes", () => {
		writeModelsJson({
			providers: {
				firework: {
					models: [
						{
							id: "accounts/fireworks/routers/kimi-k2p6-turbo",
							contextWindow: 196608,
						},
					],
				},
			},
		});
		expect(
			resolveModelContextWindow("firework/accounts/fireworks/routers/kimi-k2p6-turbo"),
		).toBe(196608);
	});

	it("returns undefined when provider is not found", () => {
		writeModelsJson({
			providers: {
				openai: {
					models: [{ id: "gpt-4o", contextWindow: 128000 }],
				},
			},
		});
		expect(resolveModelContextWindow("anthropic/claude-3-5-sonnet")).toBeUndefined();
	});

	it("returns undefined when model id is not found", () => {
		writeModelsJson({
			providers: {
				openai: {
					models: [{ id: "gpt-4o", contextWindow: 128000 }],
				},
			},
		});
		expect(resolveModelContextWindow("openai/gpt-4o-mini")).toBeUndefined();
	});

	it("ignores malformed model entries and continues searching", () => {
		writeModelsJson({
			providers: {
				openai: {
					models: [
						{ id: "gpt-4", contextWindow: "invalid" },
						"not-an-object",
						{ id: "gpt-4o", contextWindow: 128000 },
					],
				},
			},
		});
		expect(resolveModelContextWindow("openai/gpt-4o")).toBe(128000);
	});

	it("respects PI_CODING_AGENT_DIR for models.json location", () => {
		const customDir = path.join(tmpDir, "custom-agent");
		fs.mkdirSync(customDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = customDir;
		fs.writeFileSync(
			path.join(customDir, "models.json"),
			JSON.stringify({
				providers: {
					custom: {
						models: [{ id: "custom-model", contextWindow: 32000 }],
					},
				},
			}),
			"utf-8",
		);
		expect(resolveModelContextWindow("custom/custom-model")).toBe(32000);
	});
});

describe("formatFlowModelStrategy", () => {
	it("returns concise default message when strategy is empty", () => {
		expect(formatFlowModelStrategy("default", {})).toBe("mode: default | lite: (default) - flash: (default) - full: (default)");
	});

	it("shows primary and failover when both present", () => {
		const result = formatFlowModelStrategy("mimo", {
			lite: { primary: "mimo-lite", failover: ["fallback-lite"] },
			flash: { primary: "mimo-flash" },
		});
		expect(result).toBe("mode: mimo | lite: mimo-lite - flash: mimo-flash - full: (default)");
	});

	it("shows failover-only tier without primary", () => {
		const result = formatFlowModelStrategy("mimo", {
			lite: { failover: ["failover-a", "failover-b"] },
			flash: { primary: "mimo-flash" },
		});
		expect(result).toBe("mode: mimo | lite: failover: failover-a, failover-b - flash: mimo-flash - full: (default)");
	});
});
