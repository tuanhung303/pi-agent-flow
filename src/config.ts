/**
 * Load flow model strategy configuration from Pi settings files.
 *
 * Reads global (~/.pi/agent/settings.json) and project (.pi/settings.json)
 * settings, with project overriding global for flowModelConfigs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type FlowTier = "lite" | "flash" | "full";

export interface FlowModelTierConfig {
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
}

const BUILTIN_FLOW_MODEL_CONFIGS: FlowModelConfigs = {
	default: {},
};

const FLOW_TIERS: FlowTier[] = ["lite", "flash", "full"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readSettingsJson(filePath: string): Record<string, unknown> | null {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(content) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function getGlobalSettingsPath(): string {
	const agentDir = process.env["PI_CODING_AGENT_DIR"]?.trim() || path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "settings.json");
}

function getProjectSettingsPath(cwd: string): string {
	return path.join(cwd, ".pi", "settings.json");
}

function extractSelectedFlowModelConfigName(settings: Record<string, unknown> | null): string | undefined {
	if (!isPlainObject(settings)) return undefined;
	const raw = settings.flowModelConfig;
	if (typeof raw !== "string") return undefined;
	const normalized = raw.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeFailoverList(
	value: unknown,
	sourceLabel: string,
	strategyName: string,
	tier: FlowTier,
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		console.warn(
			`[pi-agent-flow] Ignoring invalid ${sourceLabel}.flowModelConfigs.${strategyName}.${tier}.failover. Expected an array of strings.`,
		);
		return undefined;
	}

	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") {
			console.warn(
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
		console.warn(
			`[pi-agent-flow] Ignoring invalid ${sourceLabel}.flowModelConfigs. Expected an object map of strategy names.`,
		);
		return {};
	}

	const result: FlowModelConfigs = {};
	for (const [rawName, rawStrategy] of Object.entries(rawConfigs)) {
		const name = rawName.trim();
		if (!name) {
			console.warn(
				`[pi-agent-flow] Ignoring empty strategy name in ${sourceLabel}.flowModelConfigs.`,
			);
			continue;
		}
		if (!isPlainObject(rawStrategy)) {
			console.warn(
				`[pi-agent-flow] Ignoring invalid ${sourceLabel}.flowModelConfigs.${name}. Expected an object with lite/flash/full tiers.`,
			);
			continue;
		}

		const strategy: FlowModelStrategy = {};
		for (const tier of FLOW_TIERS) {
			const rawTier = rawStrategy[tier];
			if (rawTier === undefined) continue;
			if (!isPlainObject(rawTier)) {
				console.warn(
					`[pi-agent-flow] Ignoring invalid ${sourceLabel}.flowModelConfigs.${name}.${tier}. Expected { primary?: string, failover?: string[] }.`,
				);
				continue;
			}

			const tierConfig: FlowModelTierConfig = {};
			if (typeof rawTier.primary === "string") {
				const primary = rawTier.primary.trim();
				if (primary) tierConfig.primary = primary;
			} else if (rawTier.primary !== undefined) {
				console.warn(
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

export function selectFlowModelStrategy(
	configs: FlowModelConfigs,
	requestedName?: string,
): LoadedFlowModelConfigs {
	const normalizedRequested = requestedName?.trim() || "default";
	const strategy = configs[normalizedRequested];
	if (strategy) {
		return { selectedName: normalizedRequested, configs, strategy };
	}

	if (normalizedRequested !== "default") {
		console.warn(
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
