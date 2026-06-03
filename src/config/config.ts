/**
 * Load flow model strategy configuration from Pi settings files.
 *
 * Reads global (~/.pi/agent/settings.json) and project (.pi/settings.json)
 * settings, with project overriding global for flowModelConfigs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseComplexity, type Complexity } from "../flow/complexity.js";
import { type FlowTier } from "../flow/agents.js";
import { logWarn } from "./log.js";
import { resolveModelContextWindow as resolveModelContextWindowFromModels } from "./models.js";
import { getAgentDir, hasAgentDirOverride } from "./paths.js";
import { atomicWriteFileSync, atomicWriteJsonAsync } from "../io/atomic-write.js";


interface FlowModelTierConfig {
	primary?: string;
	failover?: string[];
}

export type FlowModelStrategy = Partial<Record<FlowTier, FlowModelTierConfig>>;
export type FlowModelConfigs = Record<string, FlowModelStrategy>;

export interface LoadedFlowModelConfigs {
	selectedName: string;
	configs: FlowModelConfigs;
	strategy: FlowModelStrategy;
}

export interface FlowSettings {
	toolOptimize?: boolean;
	/** Whether to inject structured JSON output instructions into flow prompts. Default: true. */
	structuredOutput?: boolean;
	/** Maximum number of flows to execute concurrently. Default: 4. */
	maxConcurrency?: number;
	/** Whether to write the full child flow activation prompt to a temp file on every spawn. Default: false. */
	debugMode?: boolean;

	tools?: {
		/** Enable the trace tool. Default: true. */
		trace?: boolean;
		/** Enable the batch_read tool. Default: follows toolOptimize. */
		batchRead?: boolean;
	};

	/** Default child-flow complexity. Default: "moderate" (600s, 1x audit). */
	complexity?: Complexity;

	/** Context compression mode for forked child agents. Default: "auto". */
	contextCompression?: "auto" | "light" | "medium" | "aggressive";

	steering?: {
		/** Skip entire steering system message when false. Default: true. */
		enabled?: boolean;
		/** Replace built-in STEERING_HINT body. Default: undefined. */
		customPrompt?: string;

	};

	animation?: {
		/** Master switch — false = instant render. Default: true. */
		enabled?: boolean;
		/** false = disable glitch/scramble effect. Default: true. */
		glitch?: boolean;
	};

	askUser?: {
		/** Enable visual countdown timer and auto-dismiss. Default: false. */
		enabled?: boolean;
		/** Auto-dismiss timeout in seconds. Default: 300 (5 min). */
		timeout?: number;
	};

	bodyVerbosity?: "lite" | "full";

	loop?: {
		/** Enable endless loop behavior. Default: false. */
		enabled?: boolean;
	};
}

const BUILTIN_FLOW_MODEL_CONFIGS: FlowModelConfigs = {
	default: {},
};

const FLOW_TIERS: FlowTier[] = ["lite", "flash", "full"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Fix P17: Cache settings in memory with async flush
const _settingsCache = new Map<string, Record<string, unknown>>();
const _settingsFlushScheduled = new Set<string>();

function readSettingsJson(filePath: string): Record<string, unknown> | null {
	const cached = _settingsCache.get(filePath);
	if (cached) return cached;
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(content) as Record<string, unknown>;
		_settingsCache.set(filePath, parsed);
		return parsed;
	} catch (e) {
		logWarn(`[pi-agent-flow] Failed to read settings JSON from ${filePath}: ${e}`);
		return null;
	}
}

function scheduleSettingsFlush(filePath: string): void {
	if (!_settingsFlushScheduled.has(filePath)) {
		_settingsFlushScheduled.add(filePath);
		setImmediate(() => flushSettings(filePath));
	}
}

async function flushSettings(filePath: string): Promise<void> {
	_settingsFlushScheduled.delete(filePath);
	const settings = _settingsCache.get(filePath);
	if (!settings) return;
	try {
		await atomicWriteJsonAsync(filePath, settings);
	} catch (err) {
		logWarn(`[pi-agent-flow] Async flush failed for settings ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Synchronous flush of all cached settings entries. For tests or graceful shutdown. */
export function flushAllSettingsCachesSync(): void {
	for (const filePath of Array.from(_settingsCache.keys())) {
		const settings = _settingsCache.get(filePath);
		if (!settings) continue;
		try {
			atomicWriteFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`);
		} catch (err) {
			logWarn(`[pi-agent-flow] Sync flush failed for settings ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

/** Invalidate settings cache. For session_start or tests. */
export function invalidateSettingsCache(filePath?: string): void {
	if (filePath) {
		_settingsCache.delete(filePath);
		_settingsFlushScheduled.delete(filePath);
	} else {
		_settingsCache.clear();
		_settingsFlushScheduled.clear();
	}
}

/** Clear the in-memory settings cache. For tests. */
export function _clearSettingsCache(): void {
	invalidateSettingsCache();
}

export function getGlobalSettingsPath(): string {
	const agentDir = getAgentDir();
	const defaultPath = path.join(agentDir, "settings.json");
	if (!hasAgentDirOverride() && !fs.existsSync(defaultPath)) {
		const rootPath = path.join(os.homedir(), ".pi", "settings.json");
		if (fs.existsSync(rootPath)) return rootPath;
	}
	return defaultPath;
}

function getProjectSettingsPath(cwd: string): string {
	return path.join(cwd, ".pi", "settings.json");
}

export function normalizeFlowModeName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function extractSelectedFlowModelConfigName(settings: Record<string, unknown> | null): string | undefined {
	if (!isPlainObject(settings)) return undefined;
	return normalizeFlowModeName(settings.flowModelConfig);
}

export function loadProjectFlowModelConfigName(cwd: string): string | undefined {
	return extractSelectedFlowModelConfigName(readSettingsJson(getProjectSettingsPath(cwd)));
}

export function writeGlobalFlowMode(mode: string): { path: string; previous?: string } {
	const normalized = normalizeFlowModeName(mode);
	if (!normalized) {
		throw new Error("Cannot update flow mode. Expected a non-empty mode name.");
	}

	const filePath = getGlobalSettingsPath();
	let settings: Record<string, unknown> = {};

	if (fs.existsSync(filePath)) {
		const parsed = readSettingsJson(filePath);
		if (!parsed) {
			throw new Error(`Cannot update flow mode because ${filePath} contains invalid JSON.`);
		}
		if (!isPlainObject(parsed)) {
			throw new Error(`Cannot update flow mode because ${filePath} must contain a JSON object.`);
		}
		settings = { ...parsed };
	}

	const previous = extractSelectedFlowModelConfigName(settings);
	settings.flowModelConfig = normalized;

	_settingsCache.set(filePath, settings);
	scheduleSettingsFlush(filePath);

	return {
		path: filePath,
		...(previous !== undefined ? { previous } : {}),
	};
}

function normalizeFailoverList(
	value: unknown,
	sourceLabel: string,
	strategyName: string,
	tier: FlowTier,
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		logWarn(
			`[pi-agent-flow] Ignoring invalid ${sourceLabel}.flowModelConfigs.${strategyName}.${tier}.failover. Expected an array of strings.`,
		);
		return undefined;
	}

	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") {
			logWarn(
				`[pi-agent-flow] Ignoring invalid failover entry in ${sourceLabel}.flowModelConfigs.${strategyName}.${tier}. Expected a string.`,
			);
			continue;
		}
		const normalized = item.trim();
		if (!normalized) continue;
		result.push(normalized);
	}
	return result;
}

function extractFlowModelConfigs(settings: Record<string, unknown> | null, sourceLabel: string): FlowModelConfigs {
	if (!isPlainObject(settings)) return {};
	const rawConfigs = settings.flowModelConfigs;
	if (rawConfigs === undefined) return {};
	if (!isPlainObject(rawConfigs)) {
		logWarn(
			`[pi-agent-flow] Ignoring invalid ${sourceLabel}.flowModelConfigs. Expected an object map of strategy names.`,
		);
		return {};
	}

	const result: FlowModelConfigs = {};
	for (const [rawName, rawStrategy] of Object.entries(rawConfigs)) {
		const name = rawName.trim();
		if (!name) {
			logWarn(
				`[pi-agent-flow] Ignoring empty strategy name in ${sourceLabel}.flowModelConfigs.`,
			);
			continue;
		}
		if (!isPlainObject(rawStrategy)) {
			logWarn(
				`[pi-agent-flow] Ignoring invalid ${sourceLabel}.flowModelConfigs.${name}. Expected an object with lite/flash/full tiers.`,
			);
			continue;
		}

		const strategy: FlowModelStrategy = {};
		for (const tier of FLOW_TIERS) {
			const rawTier = rawStrategy[tier];
			if (rawTier === undefined) continue;
			if (!isPlainObject(rawTier)) {
				logWarn(
					`[pi-agent-flow] Ignoring invalid ${sourceLabel}.flowModelConfigs.${name}.${tier}. Expected { primary?: string, failover?: string[] }.`,
				);
				continue;
			}

			const tierConfig: FlowModelTierConfig = {};
			if (typeof rawTier.primary === "string") {
				const primary = rawTier.primary.trim();
				if (primary) tierConfig.primary = primary;
			} else if (rawTier.primary !== undefined) {
				logWarn(
					`[pi-agent-flow] Ignoring invalid ${sourceLabel}.flowModelConfigs.${name}.${tier}.primary. Expected a string.`,
				);
			}

			const failover = normalizeFailoverList(rawTier.failover, sourceLabel, name, tier);
			if (failover !== undefined) {
				tierConfig.failover = failover;
			}

			if (tierConfig.primary !== undefined || tierConfig.failover !== undefined) {
				strategy[tier] = tierConfig;
			}
		}

		result[name] = strategy;
	}

	return result;
}

function extractFlowSettings(settings: Record<string, unknown> | null): FlowSettings {
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
		return {};
	}
	const flowSettings = settings.flowSettings;
	if (!flowSettings || typeof flowSettings !== "object" || Array.isArray(flowSettings)) {
		return {};
	}
	const obj = flowSettings as Record<string, unknown>;
	const result: FlowSettings = {};
	if (typeof obj.toolOptimize === "boolean") {
		result.toolOptimize = obj.toolOptimize;
	}
	if (typeof obj.structuredOutput === "boolean") {
		result.structuredOutput = obj.structuredOutput;
	}
	if (typeof obj.maxConcurrency === "number" && Number.isSafeInteger(obj.maxConcurrency) && obj.maxConcurrency >= 1) {
		result.maxConcurrency = obj.maxConcurrency;
	}

	const complexity = parseComplexity(obj.complexity);
	if (complexity !== undefined) {
		result.complexity = complexity;
	}

	// Parse nested steering settings
	if (isPlainObject(obj.steering)) {
		const steering: FlowSettings["steering"] = {};
		if (typeof obj.steering.enabled === "boolean") {
			steering.enabled = obj.steering.enabled;
		}
		if (typeof obj.steering.customPrompt === "string") {
			steering.customPrompt = obj.steering.customPrompt;
		}
		result.steering = steering;
	}

	// Parse nested animation settings
	if (isPlainObject(obj.animation)) {
		const animation: FlowSettings["animation"] = {};
		if (typeof obj.animation.enabled === "boolean") {
			animation.enabled = obj.animation.enabled;
		}
		if (typeof obj.animation.glitch === "boolean") {
			animation.glitch = obj.animation.glitch;
		}
		result.animation = animation;
	}

	// Parse nested askUser settings
	if (isPlainObject(obj.askUser)) {
		const askUser: FlowSettings["askUser"] = {};
		if (typeof obj.askUser.enabled === "boolean") {
			askUser.enabled = obj.askUser.enabled;
		}
		if (typeof obj.askUser.timeout === "number" && Number.isSafeInteger(obj.askUser.timeout) && obj.askUser.timeout >= 1) {
			askUser.timeout = obj.askUser.timeout;
		}
		result.askUser = askUser;
	}

	// Parse body verbosity setting
	if (typeof obj.bodyVerbosity === "string" && (obj.bodyVerbosity === "lite" || obj.bodyVerbosity === "full")) {
		result.bodyVerbosity = obj.bodyVerbosity;
	}

	// Parse nested loop settings
	if (isPlainObject(obj.loop)) {
		const loop: FlowSettings["loop"] = {};
		if (typeof obj.loop.enabled === "boolean") {
			loop.enabled = obj.loop.enabled;
		}
		result.loop = loop;
	}

	// Parse debug mode setting
	if (typeof obj.debugMode === "boolean") {
		result.debugMode = obj.debugMode;
	}

	// Parse nested tools settings
	if (isPlainObject(obj.tools)) {
		const tools: FlowSettings["tools"] = {};
		if (typeof obj.tools.trace === "boolean") {
			tools.trace = obj.tools.trace;
		}
		if (typeof obj.tools.batchRead === "boolean") {
			tools.batchRead = obj.tools.batchRead;
		}
		result.tools = tools;
	}

	// Parse context compression setting
	if (
		typeof obj.contextCompression === "string" &&
		(obj.contextCompression === "auto" || obj.contextCompression === "light" || obj.contextCompression === "medium" || obj.contextCompression === "aggressive")
	) {
		result.contextCompression = obj.contextCompression;
	}

	return result;
}

function mergeFlowModelTierConfigs(
	base: FlowModelTierConfig | undefined,
	override: FlowModelTierConfig | undefined,
): FlowModelTierConfig | undefined {
	if (!base && !override) return undefined;
	return {
		...(base?.primary !== undefined ? { primary: base.primary } : {}),
		...(base?.failover !== undefined ? { failover: base.failover } : {}),
		...(override?.primary !== undefined ? { primary: override.primary } : {}),
		...(override?.failover !== undefined ? { failover: override.failover } : {}),
	};
}

function mergeFlowModelStrategies(
	base: FlowModelStrategy | undefined,
	override: FlowModelStrategy | undefined,
): FlowModelStrategy {
	const result: FlowModelStrategy = {};
	for (const tier of FLOW_TIERS) {
		const merged = mergeFlowModelTierConfigs(base?.[tier], override?.[tier]);
		if (merged) result[tier] = merged;
	}
	return result;
}

function mergeFlowModelConfigs(...configs: FlowModelConfigs[]): FlowModelConfigs {
	const result: FlowModelConfigs = {};
	for (const configSet of configs) {
		for (const [name, strategy] of Object.entries(configSet)) {
			result[name] = mergeFlowModelStrategies(result[name], strategy);
		}
	}
	return result;
}

/**
 * Load flowSettings from global and project settings.json.
 * Project overrides global (shallow merge per key).
 */
export function loadFlowSettings(cwd: string): FlowSettings {
	const globalSettings = readSettingsJson(getGlobalSettingsPath());
	const globalFlowSettings = extractFlowSettings(globalSettings);

	const projectSettings = readSettingsJson(getProjectSettingsPath(cwd));
	const projectFlowSettings = extractFlowSettings(projectSettings);

	return {
		...globalFlowSettings,
		...projectFlowSettings,
	};
}

/**
 * Atomically write a single flow setting to the project .pi/settings.json.
 * Supports dot-notation keyPath like "steering.enabled" or "animation.glitch".
 */
export function writeFlowSetting(cwd: string, keyPath: string, value: unknown): { path: string; previous: unknown } {
	const filePath = getProjectSettingsPath(cwd);
	let settings: Record<string, unknown> = {};

	if (fs.existsSync(filePath)) {
		const parsed = readSettingsJson(filePath);
		if (!parsed) {
			throw new Error(`Cannot update flow setting because ${filePath} contains invalid JSON.`);
		}
		if (!isPlainObject(parsed)) {
			throw new Error(`Cannot update flow setting because ${filePath} must contain a JSON object.`);
		}
		settings = { ...parsed };
	}

	if (!settings.flowSettings || !isPlainObject(settings.flowSettings)) {
		settings.flowSettings = {};
	}
	const flowSettings = settings.flowSettings as Record<string, unknown>;

	if (!keyPath) {
		// Reset the entire flowSettings object when keyPath is empty
		const previous = { ...flowSettings };
		settings.flowSettings = value;
		_settingsCache.set(filePath, settings);
		scheduleSettingsFlush(filePath);
		return { path: filePath, previous };
	}

	const keys = keyPath.split(".");
	let target: Record<string, unknown> = flowSettings;
	for (let i = 0; i < keys.length - 1; i++) {
		const k = keys[i];
		if (!target[k] || !isPlainObject(target[k])) {
			target[k] = {};
		}
		target = target[k] as Record<string, unknown>;
	}
	const leafKey = keys[keys.length - 1];
	const previous = target[leafKey];
	target[leafKey] = value;

	_settingsCache.set(filePath, settings);
	scheduleSettingsFlush(filePath);

	return { path: filePath, previous };
}

export function selectFlowModelStrategy(
	configs: FlowModelConfigs,
	requestedName?: string,
): LoadedFlowModelConfigs {
	const normalizedRequested = normalizeFlowModeName(requestedName) ?? "default";
	const strategy = configs[normalizedRequested];
	if (strategy) {
		return { selectedName: normalizedRequested, configs, strategy };
	}

	if (normalizedRequested !== "default") {
		logWarn(
			`[pi-agent-flow] Flow model config "${normalizedRequested}" not found. Falling back to "default".`,
		);
	}
	return {
		selectedName: "default",
		configs,
		strategy: configs.default ?? {},
	};
}

/**
 * Load flow model configs from global and project settings.json.
 * Project overrides global (shallow merge per strategy/tier).
 */
export function loadFlowModelConfigs(cwd: string): LoadedFlowModelConfigs {
	const globalSettings = readSettingsJson(getGlobalSettingsPath());
	const globalConfigs = extractFlowModelConfigs(globalSettings, "global");

	const projectSettings = readSettingsJson(getProjectSettingsPath(cwd));
	const projectConfigs = extractFlowModelConfigs(projectSettings, "project");

	const configs = mergeFlowModelConfigs(BUILTIN_FLOW_MODEL_CONFIGS, globalConfigs, projectConfigs);
	const requestedName =
		extractSelectedFlowModelConfigName(projectSettings) ??
		extractSelectedFlowModelConfigName(globalSettings) ??
		"default";

	return selectFlowModelStrategy(configs, requestedName);
}

export function resolveFlowModelCandidates(opts: {
	tier: FlowTier;
	flowModel?: string;
	cliTierOverride?: string;
	strategy: FlowModelStrategy;
	fallbackModel?: string;
}): { primary: string | undefined; candidates: string[] } {
	const unique = new Set<string>();
	const candidates: string[] = [];

	const add = (value: string | undefined) => {
		if (!value) return;
		const normalized = value.trim();
		if (!normalized || unique.has(normalized)) return;
		unique.add(normalized);
		candidates.push(normalized);
	};

	if (opts.flowModel) {
		add(opts.flowModel);
		return { primary: candidates[0], candidates };
	}

	if (opts.cliTierOverride) {
		add(opts.cliTierOverride);
		return { primary: candidates[0], candidates };
	}

	const tierConfig = opts.strategy[opts.tier];
	add(tierConfig?.primary);
	for (const model of tierConfig?.failover ?? []) add(model);
	add(opts.fallbackModel);

	return { primary: candidates[0], candidates };
}

export function formatFlowModelStrategy(modeName: string, strategy: FlowModelStrategy): string {
	const tiers: FlowTier[] = ["lite", "flash", "full"];
	const parts: string[] = [];
	for (const tier of tiers) {
		const config = strategy[tier];
		const hasPrimary = Boolean(config?.primary);
		const hasFailover = config?.failover && config.failover.length > 0;
		let value: string;
		if (hasPrimary) {
			value = config!.primary!;
		} else if (hasFailover) {
			value = `failover: ${config!.failover!.join(", ")}`;
		} else {
			value = "(default)";
		}
		parts.push(`${tier}: ${value}`);
	}
	return `mode: ${modeName} | ${parts.join(" - ")}`;
}

export function resolveModelContextWindow(model?: string): number | undefined {
	if (!model) return undefined;
	// Prefer live models.json lookup (supports any provider/modelId format).
	const fromModels = resolveModelContextWindowFromModels(model);
	if (fromModels !== undefined) return fromModels;
	// Fallback to hardcoded heuristics for bare model names without a provider prefix.
	const m = model.toLowerCase();
	// Claude
	if (m.includes("claude-3.7-sonnet")) return 200_000;
	if (m.includes("claude-3.5-sonnet")) return 200_000;
	if (m.includes("claude-3-opus")) return 200_000;
	if (m.includes("claude-3-sonnet")) return 200_000;
	if (m.includes("claude-3-haiku")) return 200_000;
	if (m.includes("claude")) return 200_000;
	// OpenAI
	if (m.includes("gpt-4o")) return 128_000;
	if (m.includes("gpt-4-turbo")) return 128_000;
	if (m.includes("gpt-4")) return m.includes("32k") ? 32_000 : 128_000;
	if (m.includes("gpt-3.5-turbo")) return 16_000;
	if (m.includes("o1") || m.includes("o3")) return 200_000;
	// Gemini
	if (m.includes("gemini-1.5-pro")) return 2_000_000;
	if (m.includes("gemini-1.5-flash")) return 1_000_000;
	if (m.includes("gemini-1.0-pro")) return 32_000;
	if (m.includes("gemini")) return 1_000_000;
	// DeepSeek
	if (m.includes("deepseek")) return 64_000;
	// Llama
	if (m.includes("llama-3.1") || m.includes("llama3.1")) return 128_000;
	if (m.includes("llama-3.2") || m.includes("llama3.2")) return 128_000;
	if (m.includes("llama")) return 8_000;
	return undefined;
}

export function writeFlowModelConfig(
	cwd: string,
	strategyName: string,
	tier: FlowTier,
	updates: { primary?: string | null; failover?: string[] | null },
): void {
	const filePath = getProjectSettingsPath(cwd);
	let settings: Record<string, unknown> = {};

	if (fs.existsSync(filePath)) {
		const parsed = readSettingsJson(filePath);
		if (!parsed) {
			throw new Error(`Cannot update flow model config because ${filePath} contains invalid JSON.`);
		}
		if (!isPlainObject(parsed)) {
			throw new Error(`Cannot update flow model config because ${filePath} must contain a JSON object.`);
		}
		settings = { ...parsed };
	}

	if (!settings.flowModelConfigs || !isPlainObject(settings.flowModelConfigs)) {
		settings.flowModelConfigs = {};
	}
	const configs = settings.flowModelConfigs as Record<string, unknown>;

	if (!configs[strategyName] || !isPlainObject(configs[strategyName])) {
		configs[strategyName] = {};
	}
	const strategy = configs[strategyName] as Record<string, unknown>;

	if (!strategy[tier] || !isPlainObject(strategy[tier])) {
		strategy[tier] = {};
	}
	const tierConfig = strategy[tier] as Record<string, unknown>;

	if (updates.primary !== undefined) {
		if (updates.primary === null) {
			delete tierConfig.primary;
		} else {
			tierConfig.primary = updates.primary;
		}
	}

	if (updates.failover !== undefined) {
		if (updates.failover === null) {
			delete tierConfig.failover;
		} else {
			tierConfig.failover = updates.failover;
		}
	}

	if (Object.keys(tierConfig).length === 0) {
		delete strategy[tier];
	}
	if (Object.keys(strategy).length === 0) {
		delete configs[strategyName];
	}

	_settingsCache.set(filePath, settings);
	scheduleSettingsFlush(filePath);
}
