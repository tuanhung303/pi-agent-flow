/**
 * Load flow tier model configuration from Pi settings files.
 *
 * Reads global (~/.pi/agent/settings.json) and project (.pi/settings.json)
 * settings, with project overriding global for flowModels.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface FlowModelConfig {
	lite?: string;
	flash?: string;
	full?: string;
}

export interface FlowSettings {
	toolOptimize?: boolean;
}

function readSettingsJson(filePath: string): Record<string, unknown> | null {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(content) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function extractFlowModels(settings: Record<string, unknown> | null): FlowModelConfig {
	if (!settings) return {};
	const flowModels = settings.flowModels;
	if (!flowModels || typeof flowModels !== "object" || Array.isArray(flowModels)) {
		return {};
	}
	const obj = flowModels as Record<string, unknown>;
	const result: FlowModelConfig = {};
	for (const key of ["lite", "flash", "full"] as const) {
		if (typeof obj[key] === "string") {
			result[key] = obj[key] as string;
		}
	}
	return result;
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

function getGlobalSettingsPath(): string {
	const agentDir = process.env["PI_CODING_AGENT_DIR"]?.trim() || path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "settings.json");
}

function getProjectSettingsPath(cwd: string): string {
	return path.join(cwd, ".pi", "settings.json");
}

/**
 * Load flowModels from global and project settings.json.
 * Project overrides global (shallow merge per key).
 */
export function loadFlowModels(cwd: string): FlowModelConfig {
	const globalSettings = readSettingsJson(getGlobalSettingsPath());
	const globalModels = extractFlowModels(globalSettings);

	const projectSettings = readSettingsJson(getProjectSettingsPath(cwd));
	const projectModels = extractFlowModels(projectSettings);

	return {
		...globalModels,
		...projectModels,
	};
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
