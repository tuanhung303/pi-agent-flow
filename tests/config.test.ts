import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	formatFlowModelStrategy,
	getGlobalSettingsPath,
	loadFlowModelConfigs,
	loadFlowSettings,
	resolveFlowModelCandidates,
	writeFlowModelConfig,
	writeGlobalFlowMode,
	writeFlowSetting,
	_clearSettingsCache,
	onSettingsChange,
	_clearSettingsChangeListeners,
} from "../src/config/config.js";
import {
	hasConfiguredModel,
	invalidateModelsJsonCache,
	readModelsJson,
	resolveModelContextWindow,
} from "../src/config/models.js";
import { _resetLoggingForTests } from "../src/config/log.js";

describe("loadFlowModelConfigs", () => {
	let tmpDir: string;
	let originalHome: string | undefined;
	let originalAgentDir: string | undefined;
	let originalIsTTY: boolean | undefined;
	let originalFlowDepth: string | undefined;
	let originalTuiMode: string | undefined;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-config-test-"));
		originalHome = process.env.HOME;
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		originalIsTTY = process.stdout.isTTY;
		originalFlowDepth = process.env.PI_FLOW_DEPTH;
		originalTuiMode = process.env.PI_TUI_MODE;
		process.env.HOME = tmpDir;
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_FLOW_DEPTH;
		delete process.env.PI_TUI_MODE;
		// @ts-ignore
		process.stdout.isTTY = false;
		_resetLoggingForTests();
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		_clearSettingsCache();
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
		if (originalTuiMode !== undefined) process.env.PI_TUI_MODE = originalTuiMode;
		else delete process.env.PI_TUI_MODE;
		_resetLoggingForTests();
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
		_clearSettingsCache();
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
		_clearSettingsCache();

		expect(() => writeGlobalFlowMode("mimo")).toThrow(/invalid JSON/);
		expect(fs.readFileSync(settingsPath, "utf-8")).toBe("not json");
	});

	it("rejects empty mode names", () => {
		expect(() => writeGlobalFlowMode("   ")).toThrow(/non-empty mode name/);
	});
});

describe("resolveFlowModelCandidates", () => {
	let tmpDir: string;
	let originalHome: string | undefined;
	let originalAgentDir: string | undefined;
	let originalFlowDepth: string | undefined;
	let originalTuiMode: string | undefined;
	let originalIsTTY: boolean | undefined;
	let warnSpy: MockInstance<(...args: unknown[]) => void>;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-candidates-test-"));
		originalHome = process.env.HOME;
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		originalFlowDepth = process.env.PI_FLOW_DEPTH;
		originalTuiMode = process.env.PI_TUI_MODE;
		originalIsTTY = process.stdout.isTTY;
		process.env.HOME = tmpDir;
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_FLOW_DEPTH;
		delete process.env.PI_TUI_MODE;
		// @ts-ignore
		process.stdout.isTTY = false;
		_resetLoggingForTests();
		_clearSettingsCache();
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		// @ts-ignore
		process.stdout.isTTY = originalIsTTY;
		if (originalFlowDepth !== undefined) process.env.PI_FLOW_DEPTH = originalFlowDepth;
		else delete process.env.PI_FLOW_DEPTH;
		if (originalTuiMode !== undefined) process.env.PI_TUI_MODE = originalTuiMode;
		else delete process.env.PI_TUI_MODE;
		_resetLoggingForTests();
		process.env.HOME = originalHome;
		if (originalAgentDir !== undefined) {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		} else {
			delete process.env.PI_CODING_AGENT_DIR;
		}
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

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
			invalidCandidates: [],
			effectivePrimary: "explicit-model",
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
			invalidCandidates: [],
			effectivePrimary: "primary-a",
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
			invalidCandidates: [],
			effectivePrimary: "cli-model",
		});
	});

	it("returns empty candidates when no model source is configured", () => {
		const result = resolveFlowModelCandidates({
			tier: "lite",
			strategy: {},
		});

		expect(result).toEqual({
			primary: undefined,
			candidates: [],
			invalidCandidates: [],
			effectivePrimary: undefined,
		});
	});

	it("warns but still tries models known to be missing from models.json", () => {
		const agentDir = path.join(tmpDir, ".pi", "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					kimi: {
						models: [{ id: "kimi-k2.7-code", contextWindow: 262144 }],
					},
				},
			}),
			"utf-8",
		);

		const result = resolveFlowModelCandidates({
			tier: "flash",
			strategy: {
				flash: {
					primary: "kimi/kimi-for-coding",
					failover: ["kimi/kimi-k2.7-code"],
				},
			},
		});

		expect(result).toEqual({
			primary: "kimi/kimi-for-coding",
			candidates: ["kimi/kimi-for-coding", "kimi/kimi-k2.7-code"],
			invalidCandidates: ["kimi/kimi-for-coding"],
			effectivePrimary: "kimi/kimi-k2.7-code",
		});
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("not present in models.json"));
	});

	it("reports invalid candidates when every configured model is missing", () => {
		const agentDir = path.join(tmpDir, ".pi", "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					kimi: {
						models: [{ id: "kimi-k2.7-code", contextWindow: 262144 }],
					},
				},
			}),
			"utf-8",
		);

		const result = resolveFlowModelCandidates({
			tier: "full",
			strategy: {
				full: {
					primary: "kimi/kimi-for-coding",
					failover: ["kimi/kimi-old"],
				},
			},
		});

		expect(result).toEqual({
			primary: "kimi/kimi-for-coding",
			candidates: ["kimi/kimi-for-coding", "kimi/kimi-old"],
			invalidCandidates: ["kimi/kimi-for-coding", "kimi/kimi-old"],
			effectivePrimary: undefined,
		});
	});

	it("does not read models.json (and emits no warn) when the strategy is fully empty", () => {
		// Lazy-load: if no candidates are added at all, the registry is never
		// consulted. In a fresh tmpDir HOME without models.json, this means
		// the spurious "Failed to read settings JSON" warn must not appear.
		const warnBefore = warnSpy.mock.calls.length;
		const result = resolveFlowModelCandidates({
			tier: "flash",
			strategy: {}, // no flowModel, no cliTierOverride, no tier primary/failover, no fallbackModel
		});

		expect(result).toEqual({
			primary: undefined,
			candidates: [],
			invalidCandidates: [],
			effectivePrimary: undefined,
		});

		const newWarns = warnSpy.mock.calls
			.slice(warnBefore)
			.map((c) => String(c[0] ?? ""))
			.filter((m) => m.includes("Failed to read settings JSON"));
		expect(newWarns).toHaveLength(0);
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
		_clearSettingsCache();
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

	it("reads and merges complexity settings", () => {
		writeGlobalSettings({
			flowSettings: {
				complexity: "simple",
			},
		});
		writeProjectSettings(tmpDir, {
			flowSettings: {
				complexity: "complex",
			},
		});
		const result = loadFlowSettings(tmpDir);
		expect(result).toEqual({ complexity: "complex" });
	});

	it("ignores invalid complexity settings", () => {
		writeGlobalSettings({
			flowSettings: {
				complexity: "invalid",
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

	it("reads tools.trace setting", () => {
		writeProjectSettings(tmpDir, {
			flowSettings: {
				tools: { trace: false },
			},
		});
		const result = loadFlowSettings(tmpDir);
		expect(result).toEqual({ tools: { trace: false } });
	});

	it("reads tools.batchRead setting", () => {
		writeProjectSettings(tmpDir, {
			flowSettings: {
				tools: { batchRead: true },
			},
		});
		const result = loadFlowSettings(tmpDir);
		expect(result).toEqual({ tools: { batchRead: true } });
	});

	it("ignores invalid tools settings", () => {
		writeProjectSettings(tmpDir, {
			flowSettings: {
				tools: { trace: "off", batchRead: 1, extra: true },
			},
		});
		const result = loadFlowSettings(tmpDir);
		expect(result).toEqual({ tools: {} });
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

	it("reports whether a provider/model is configured", () => {
		writeModelsJson({
			providers: {
				openai: {
					models: [{ id: "gpt-4o", contextWindow: 128000 }],
				},
			},
		});

		expect(hasConfiguredModel("openai/gpt-4o")).toBe(true);
		expect(hasConfiguredModel("openai/gpt-4o-mini")).toBe(false);
		expect(hasConfiguredModel("anthropic/claude-3-5-sonnet")).toBeUndefined();
		expect(hasConfiguredModel("gpt-4o")).toBeUndefined();
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

describe("optional models-store registry", () => {
	let tmpDir: string;
	let originalAgentDir: string | undefined;
	let originalFlowDepth: string | undefined;
	let originalTuiMode: string | undefined;
	let originalIsTTY: boolean | undefined;
	let warnSpy: MockInstance<(...args: unknown[]) => void>;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-models-store-test-"));
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		originalFlowDepth = process.env.PI_FLOW_DEPTH;
		originalTuiMode = process.env.PI_TUI_MODE;
		originalIsTTY = process.stdout.isTTY;
		process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, "agent");
		delete process.env.PI_FLOW_DEPTH;
		delete process.env.PI_TUI_MODE;
		// @ts-ignore
		process.stdout.isTTY = false;
		_resetLoggingForTests();
		invalidateModelsJsonCache();
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		warnSpy.mockRestore();
		// @ts-ignore
		process.stdout.isTTY = originalIsTTY;
		if (originalAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		else delete process.env.PI_CODING_AGENT_DIR;
		if (originalFlowDepth !== undefined) process.env.PI_FLOW_DEPTH = originalFlowDepth;
		else delete process.env.PI_FLOW_DEPTH;
		if (originalTuiMode !== undefined) process.env.PI_TUI_MODE = originalTuiMode;
		else delete process.env.PI_TUI_MODE;
		_resetLoggingForTests();
		invalidateModelsJsonCache();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
	function writeRegistry(fileName: string, content: string): void {
		const agentDir = process.env.PI_CODING_AGENT_DIR!;
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, fileName), content, "utf-8");
	}
	it("does not warn when the optional models-store.json fallback is absent", () => {
		writeRegistry("models.json", JSON.stringify({ providers: {} }));
		expect(hasConfiguredModel("openai/gpt-4o")).toBeUndefined();
		expect(resolveModelContextWindow("openai/gpt-4o")).toBeUndefined();
		expect(warnSpy).not.toHaveBeenCalled();
	});
	it("uses a registered model from models-store.json when models.json lacks it", () => {
		writeRegistry("models.json", JSON.stringify({ providers: {} }));
		writeRegistry("models-store.json", JSON.stringify({ providers: { openai: { models: [{ id: "gpt-4o", contextWindow: 128000 }] } } }));
		expect(hasConfiguredModel("openai/gpt-4o")).toBe(true);
		expect(hasConfiguredModel("openai/gpt-4o-mini")).toBe(false);
		expect(resolveModelContextWindow("openai/gpt-4o")).toBe(128000);
		expect(warnSpy).not.toHaveBeenCalled();
	});
	it("warns when an existing models-store.json is malformed", () => {
		writeRegistry("models.json", JSON.stringify({ providers: {} }));
		writeRegistry("models-store.json", "not json");
		expect(hasConfiguredModel("openai/gpt-4o")).toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("models-store.json"));
	});
	it("warns when an existing models-store.json cannot be read", () => {
		writeRegistry("models.json", JSON.stringify({ providers: {} }));
		fs.mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR!, "models-store.json"));
		expect(hasConfiguredModel("openai/gpt-4o")).toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("models-store.json"));
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

describe("onSettingsChange", () => {
	let tmpDir: string;
	let originalHome: string | undefined;
	let originalAgentDir: string | undefined;
	let projectCwd: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-settings-emit-test-"));
		projectCwd = path.join(tmpDir, "project");
		fs.mkdirSync(projectCwd, { recursive: true });
		originalHome = process.env.HOME;
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.HOME = tmpDir;
		delete process.env.PI_CODING_AGENT_DIR;
		_clearSettingsCache();
		_clearSettingsChangeListeners();
	});

	afterEach(() => {
		_clearSettingsChangeListeners();
		process.env.HOME = originalHome;
		if (originalAgentDir !== undefined) {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		} else {
			delete process.env.PI_CODING_AGENT_DIR;
		}
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("fires after writeFlowSetting with fresh cache", () => {
		const calls: Array<{ keyPath: string; value: unknown; toolOptimizeAtCallTime: boolean | undefined }> = [];
		onSettingsChange((keyPath, value) => {
			const freshSettings = loadFlowSettings(projectCwd);
			calls.push({ keyPath, value, toolOptimizeAtCallTime: freshSettings.toolOptimize });
		});

		writeFlowSetting(projectCwd, "toolOptimize", false);

		expect(calls).toHaveLength(1);
		expect(calls[0].keyPath).toBe("toolOptimize");
		expect(calls[0].value).toBe(false);
		expect(calls[0].toolOptimizeAtCallTime).toBe(false);
	});

	it("fires for nested keyPath", () => {
		const calls: Array<{ keyPath: string; value: unknown }> = [];
		onSettingsChange((keyPath, value) => {
			calls.push({ keyPath, value });
		});

		writeFlowSetting(projectCwd, "steering.enabled", false);

		expect(calls).toHaveLength(1);
		expect(calls[0].keyPath).toBe("steering.enabled");
		expect(calls[0].value).toBe(false);
	});

	it("unsubscribe stops further notifications", () => {
		const calls: string[] = [];
		const unsub = onSettingsChange((keyPath) => {
			calls.push(keyPath);
		});

		writeFlowSetting(projectCwd, "toolOptimize", false);
		expect(calls).toEqual(["toolOptimize"]);

		unsub();

		writeFlowSetting(projectCwd, "toolOptimize", true);
		expect(calls).toEqual(["toolOptimize"]);
	});

	it("supports multiple listeners", () => {
		const callsA: string[] = [];
		const callsB: string[] = [];
		onSettingsChange((keyPath) => callsA.push(keyPath));
		onSettingsChange((keyPath) => callsB.push(keyPath));

		writeFlowSetting(projectCwd, "complexity", "simple");

		expect(callsA).toEqual(["complexity"]);
		expect(callsB).toEqual(["complexity"]);
	});

	it("handler error does not prevent other listeners from firing", () => {
		const calls: string[] = [];
		onSettingsChange(() => {
			throw new Error("boom");
		});
		onSettingsChange((keyPath) => calls.push(keyPath));

		// Should not throw
		writeFlowSetting(projectCwd, "trace", true);
		expect(calls).toEqual(["trace"]);
	});

	it("_clearSettingsChangeListeners removes all listeners", () => {
		const calls: string[] = [];
		onSettingsChange((keyPath) => calls.push(keyPath));

		_clearSettingsChangeListeners();

		writeFlowSetting(projectCwd, "toolOptimize", false);
		expect(calls).toEqual([]);
	});
});

describe("cache invalidation boundaries", () => {
	let tmpDir: string;
	let originalHome: string | undefined;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-cache-invalidation-test-"));
		originalHome = process.env.HOME;
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.HOME = tmpDir;
		process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, ".pi", "agent");
		_clearSettingsCache();
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
		const dir = process.env.PI_CODING_AGENT_DIR!;
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify(content, null, 2), "utf-8");
	}

	it("writeFlowSetting does NOT invalidate the models.json cache (settings don't touch models.json)", () => {
		writeModelsJson({ providers: { openai: { models: [{ id: "gpt-4o", contextWindow: 128000 }] } } });
		// Warm the cache.
		expect(readModelsJson()).not.toBeNull();

		// Touch a settings.json-only field.
		writeFlowSetting(tmpDir, "toolOptimize", false);

		// Prove the cache was not invalidated: edit models.json on disk to a
		// different registry, then read — if the cache had been invalidated,
		// the new registry would be returned. With the fix, the warm value
		// persists (settings writes don't touch models.json).
		const modelsPath = path.join(process.env.PI_CODING_AGENT_DIR!, "models.json");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({ providers: { openai: { models: [{ id: "totally-different-model" }] } } }, null, 2),
			"utf-8",
		);
		expect(hasConfiguredModel("openai/gpt-4o", readModelsJson())).toBe(true);
		expect(hasConfiguredModel("openai/totally-different-model", readModelsJson())).toBe(false);
	});

	it("writeGlobalFlowMode does NOT invalidate the models.json cache", () => {
		writeModelsJson({ providers: { openai: { models: [{ id: "gpt-4o", contextWindow: 128000 }] } } });
		expect(readModelsJson()).not.toBeNull();

		// Touch global flow mode — a settings.json-only writer.
		writeGlobalFlowMode("balance");

		// The cache must still serve the warm value.
		expect(hasConfiguredModel("openai/gpt-4o", readModelsJson())).toBe(true);
	});

	it("writeFlowModelConfig DOES invalidate the models.json cache", () => {
		writeModelsJson({ providers: { openai: { models: [{ id: "gpt-4o", contextWindow: 128000 }] } } });
		expect(readModelsJson()).not.toBeNull();

		// Snapshot the cached object identity.
		const beforeRef = readModelsJson();

		// writeFlowModelConfig changes which models are configured — cache must drop.
		writeFlowModelConfig(tmpDir, "custom", "flash", { primary: "openai/gpt-4o" });

		// After invalidation, readModelsJson re-reads from disk and returns a
		// different object reference (deep clone from JSON.parse).
		expect(readModelsJson()).not.toBe(beforeRef);
	});

	it("writeFlowModelConfig sees updated models.json registry on the very next readModelsJson call", () => {
		writeModelsJson({ providers: { openai: { models: [{ id: "gpt-4o", contextWindow: 128000 }] } } });
		expect(readModelsJson()).not.toBeNull();

		// Edit models.json on disk to add a new model.
		const modelsPath = path.join(process.env.PI_CODING_AGENT_DIR!, "models.json");
		const updated = { providers: { openai: { models: [{ id: "gpt-4o-mini", contextWindow: 128000 }] } } };
		fs.writeFileSync(modelsPath, JSON.stringify(updated, null, 2), "utf-8");

		// Without invalidation, the cache would still report only "gpt-4o".
		writeFlowModelConfig(tmpDir, "custom", "flash", { primary: "openai/gpt-4o-mini" });

		// The next read sees the new model.
		expect(hasConfiguredModel("openai/gpt-4o-mini", readModelsJson())).toBe(true);
	});

	it("invalidateModelsJsonCache drops the cached models.json reference", () => {
		writeModelsJson({ providers: { openai: { models: [{ id: "gpt-4o", contextWindow: 128000 }] } } });
		const beforeRef = readModelsJson();
		expect(beforeRef).not.toBeNull();

		invalidateModelsJsonCache();

		const afterRef = readModelsJson();
		expect(afterRef).not.toBe(beforeRef);
	});
});
