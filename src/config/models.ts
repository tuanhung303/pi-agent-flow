import * as fs from "node:fs";
import * as path from "node:path";
import { logWarn } from "./log.js";
import { getAgentDir, hasAgentDirOverride } from "./paths.js";

export function getModelsJsonPath(): string {
	const agentDir = getAgentDir();
	const defaultPath = path.join(agentDir, "models.json");
	if (!hasAgentDirOverride() && !fs.existsSync(defaultPath)) {
		const rootPath = path.join(path.dirname(agentDir), "models.json");
		if (fs.existsSync(rootPath)) return rootPath;
	}
	return defaultPath;
}

function readSettingsJson(filePath: string): Record<string, unknown> | null {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(content) as Record<string, unknown>;
	} catch (e) {
		logWarn(`[pi-agent-flow] Failed to read settings JSON from ${filePath}: ${e}`);
		return null;
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function resolveModelContextWindow(model: string): number | undefined {
	const parts = model.split("/");
	if (parts.length < 2) return undefined;

	const providerKey = parts[0];
	const modelId = parts.slice(1).join("/");

	const raw = readSettingsJson(getModelsJsonPath());
	if (!isPlainObject(raw)) return undefined;

	const providers = raw.providers;
	if (!isPlainObject(providers)) return undefined;

	const provider = providers[providerKey];
	if (!isPlainObject(provider)) return undefined;

	const models = provider.models;
	if (!Array.isArray(models)) return undefined;

	for (const m of models) {
		if (!isPlainObject(m)) continue;
		if (typeof m.id !== "string") continue;
		if (m.id === modelId && typeof m.contextWindow === "number") {
			return m.contextWindow;
		}
	}

	return undefined;
}

/**
 * Return whether a provider/model entry is known in models.json.
 *
 * `undefined` means the local model registry cannot answer authoritatively
 * (for example, no provider/model form or unreadable models.json).
 */
export function hasConfiguredModel(
	model: string,
	registry?: Record<string, unknown> | null,
): boolean | undefined {
	const parts = model.split("/");
	if (parts.length < 2) return undefined;

	const providerKey = parts[0];
	const modelId = parts.slice(1).join("/");

	const raw = registry === undefined ? readSettingsJson(getModelsJsonPath()) : registry;
	if (!isPlainObject(raw)) return undefined;

	const providers = raw.providers;
	if (!isPlainObject(providers)) return undefined;

	const provider = providers[providerKey];
	if (!isPlainObject(provider)) return undefined;

	const models = provider.models;
	if (!Array.isArray(models)) return undefined;

	return models.some((m) => isPlainObject(m) && m.id === modelId);
}
