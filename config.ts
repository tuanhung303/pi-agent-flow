/**
 * Load flow model strategy configuration from Pi settings files.
 *
 * Reads global (~/.pi/agent/settings.json) and project (.pi/settings.json)
 * settings, with project overriding global for flowModelConfigs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type FlowModelTier = "lite" | "flash" | "full";

export interface FlowModelTierConfig {
	primary?: string;
	failover?: string[];
}

export type FlowModelStrategy = Partial<Record<FlowModelTier, FlowModelTierConfig>>;

export type FlowModelConfigs = Record<string, FlowModelStrategy>;

export interface LoadedFlowModelConfigs {
	selectedName: string;
	configs: FlowModelConfigs;
	strategy: FlowModelStrategy;
}

export interface FlowModelConfig {
	lite?: string;
	flash?: string;
	full?: string;
}

export interface FlowSettings {
	toolOptimize?: boolean;
}

const FLOW_MODEL_TIERS: FlowModelTier[] = ["lite", "flash", "full"];
const DEFAULT_FLOW_MODEL_CONFIG_NAME = "default";
const BUILTIN_FLOW_MODEL_CONFIGS: FlowModelConfigs = {
	[DEFAULT_FLOW_MODEL_CONFIG_NAME]: {},
};

function readSettingsJson(filePath: string): Record<string, unknown> | null {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(content) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeConfigName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeModelName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function extractSelectedFlowModelConfig(settings: Record<string, unknown> | null): string | undefined {
	if (!settings) return undefined;
	return normalizeConfigName(settings.flowModelConfig);
}

function validateFlowModelTierConfig(
	value: unknown,
	pathLabel: string,
): FlowModelTierConfig | undefined {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) {
		console.warn(
			`[pi-agent-flow] Ignoring invalid ${pathLabel}. Expected an object with primary/failover fields.`,
		);
		return undefined;
	}

	const result: FlowModelTierConfig = {};
	if (typeof value.primary === "string") {
		const primary = value.primary.trim();
		if (primary.length > 0) {
			result.primary = primary;
		}
	} else if (value.primary !== undefined) {
		console.warn(
			`[pi-agent-flow] Ignoring invalid ${pathLabel}.primary. Expected a string.`,
		);
	}

	if (value.failover !== undefined) {
		if (!Array.isArray(value.failover)) {
			console.warn(
				`[pi-agent-flow] Ignoring invalid ${pathLabel}.failover. Expected an array of strings.`,
			);
		} else {
			const failover = value.failover
				.filter((entry): entry is string => typeof entry === "string")
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0);
			if (failover.length > 0) {
				result.failover = failover;
			}
			if (failover.length !== value.failover.length) {
				console.warn(
					`[pi-agent-flow] Ignoring invalid entries in ${pathLabel}.failover. Expected only non-empty strings.`,
				);
			}
		}
	}

	return result;
}

function extractFlowModelConfigs(settings: Record<string, unknown> | null): FlowModelConfigs {
	if (!settings) return {};
	const raw = settings.flowModelConfigs;
	if (raw === undefined) return {};
	if (!isPlainObject(raw)) {
		console.warn(
			"[pi-agent-flow] Ignoring invalid flowModelConfigs. Expected an object keyed by strategy name.",
		);
		return {};
	}

	const result: FlowModelConfigs = {};
	for (const [rawName, rawStrategy] of Object.entries(raw)) {
		const name = normalizeConfigName(rawName);
		if (!name) {
			console.warn("[pi-agent-flow] Ignoring invalid flow model config name.");
			continue;
		}
		if (!isPlainObject(rawStrategy)) {
			console.warn(
				`[pi-agent-flow] Ignoring invalid flowModelConfigs.${rawName}. Expected an object keyed by flow tier.`,
			);
			continue;
		}

		const strategy: FlowModelStrategy = {};
		for (const tier of FLOW_MODEL_TIERS) {
			if (rawStrategy[tier] !== undefined) {
				const tierConfig = validateFlowModelTierConfig(
					rawStrategy[tier],
					`flowModelConfigs.${rawName}.${tier}`,
				);
				if (tierConfig) strategy[tier] = tierConfig;
			}
		}

		for (const key of Object.keys(rawStrategy)) {
			if (!FLOW_MODEL_TIERS.includes(key as FlowModelTier)) {
				console.warn(
					`[pi-agent-flow] Ignoring unknown tier "${key}" in flowModelConfigs.${rawName}.`,
				);
			}
		}

		result[name] = strategy;
	}

	return result;
}

function mergeFlowModelStrategies(
	base: FlowModelStrategy | undefined,
	override: FlowModelStrategy | undefined,
): FlowModelStrategy {
	const merged: FlowModelStrategy = { ...(base ?? {}) };
	if (!override) return merged;

	for (const tier of FLOW_MODEL_TIERS) {
		const baseTier = merged[tier];
		const overrideTier = override[tier];
		if (!baseTier && !overrideTier) continue;
		if (!baseTier) {
			merged[tier] = { ...overrideTier };
			continue;
		}
		if (!overrideTier) continue;
		merged[tier] = {
			...baseTier,
			...overrideTier,
		};
	}

	return merged;
}

function mergeFlowModelConfigs(
	base: FlowModelConfigs,
	override: FlowModelConfigs,
): FlowModelConfigs {
	const merged: FlowModelConfigs = { ...base };
	for (const [name, strategy] of Object.entries(override)) {
		merged[name] = mergeFlowModelStrategies(merged[name], strategy);
	}
	return merged;
}

function getGlobalSettingsPath(): string {
	const agentDir = process.env["PI_CODING_AGENT_DIR"]?.trim() || path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "settings.json");
}

function getProjectSettingsPath(cwd: string): string {
	return path.join(cwd, ".pi", "settings.json");
}

function selectFlowModelStrategy(
	configs: FlowModelConfigs,
	requestedName: string | undefined,
): { selectedName: string; strategy: FlowModelStrategy } {
	const selectedName = requestedName ?? DEFAULT_FLOW_MODEL_CONFIG_NAME;
	const strategy = configs[selectedName];
	if (strategy) {
		return { selectedName, strategy };
	}
	if (selectedName !== DEFAULT_FLOW_MODEL_CONFIG_NAME) {
		console.warn(
			`[pi-agent-flow] Unknown flow model config "${selectedName}". Falling back to "${DEFAULT_FLOW_MODEL_CONFIG_NAME}".`,
		);
	}
	return {
		selectedName: DEFAULT_FLOW_MODEL_CONFIG_NAME,
		strategy: configs[DEFAULT_FLOW_MODEL_CONFIG_NAME] ?? {},
	};
}

/**
 * Load flowModelConfigs from global and project settings.json.
 * Project overrides global (merge per strategy and per tier).
 */
export function loadFlowModelConfigs(cwd: string): LoadedFlowModelConfigs {
	const globalSettings = readSettingsJson(getGlobalSettingsPath());
	const globalSelected = extractSelectedFlowModelConfig(globalSettings);
	const globalConfigs = extractFlowModelConfigs(globalSettings);

	const projectSettings = readSettingsJson(getProjectSettingsPath(cwd));
	const projectSelected = extractSelectedFlowModelConfig(projectSettings);
	const projectConfigs = extractFlowModelConfigs(projectSettings);

	const configs = mergeFlowModelConfigs(BUILTIN_FLOW_MODEL_CONFIGS, globalConfigs);
	const merged = mergeFlowModelConfigs(configs, projectConfigs);
	const selectedName = projectSelected ?? globalSelected ?? DEFAULT_FLOW_MODEL_CONFIG_NAME;
	const selected = selectFlowModelStrategy(merged, selectedName);

	return {
		selectedName: selected.selectedName,
		configs: merged,
		strategy: selected.strategy,
	};
}

/**
 * Resolve ordered model candidates for a flow tier.
 * Explicit flow or CLI overrides are treated as single-model selections.
 */
export function resolveFlowModelCandidates(opts: {
	tier: FlowModelTier;
	flowModel?: string;
	cliTierOverride?: string;
	strategy: FlowModelStrategy;
	fallbackModel?: string;
}): { primary: string | undefined; candidates: string[] } {
	const explicitFlowModel = normalizeModelName(opts.flowModel);
	if (explicitFlowModel) {
		return { primary: explicitFlowModel, candidates: [explicitFlowModel] };
	}

	const explicitCliModel = normalizeModelName(opts.cliTierOverride);
	if (explicitCliModel) {
		return { primary: explicitCliModel, candidates: [explicitCliModel] };
	}

	const candidates: string[] = [];
	const seen = new Set<string>();
	const pushUnique = (model: string | undefined) => {
		if (!model || seen.has(model)) return;
		seen.add(model);
		candidates.push(model);
	};

	const tierConfig = opts.strategy[opts.tier];
	const primary = normalizeModelName(tierConfig?.primary);
	pushUnique(primary);
	for (const model of tierConfig?.failover ?? []) {
		pushUnique(normalizeModelName(model));
	}
	pushUnique(normalizeModelName(opts.fallbackModel));

	return {
		primary: candidates[0],
		candidates,
	};
}

/**
 * Legacy flat model config loader retained for compatibility.
 * Returns the selected strategy flattened to { lite, flash, full }.
 */
export function loadFlowModels(cwd: string): FlowModelConfig {
	const loaded = loadFlowModelConfigs(cwd);
	const result: FlowModelConfig = {};
	for (const tier of FLOW_MODEL_TIERS) {
		const primary = loaded.strategy[tier]?.primary;
		if (typeof primary === "string" && primary.trim()) {
			result[tier] = primary.trim();
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

function extractFlowSettings(settings: Record<string, unknown> | null): FlowSettings {
	if (!settings) return {};
	const flowSettings = settings.flowSettings;
	if (!flowSettings || typeof flowSettings !== "object" || Array.isArray(flowSettings)) {
		return {};
	}
	const obj = flowSettings as Record<string, unknown>;
	const result: FlowSettings = {};
	if (typeof obj.toolOptimize === "boolean") {
		result.toolOptimize = obj.toolOptimize;
	}
	return result;
}
