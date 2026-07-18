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

function getModelsStorePath(): string {
	return path.join(getAgentDir(), "models-store.json");
}

const _modelsJsonCache = new Map<string, Record<string, unknown> | null>();
const _modelsStoreCache = new Map<string, Record<string, unknown> | null>();

export function readModelsJson(): Record<string, unknown> | null {
	const filePath = getModelsJsonPath();
	if (_modelsJsonCache.has(filePath)) return _modelsJsonCache.get(filePath)!;
	const parsed = readSettingsJson(filePath);
	_modelsJsonCache.set(filePath, parsed);
	return parsed;
}

function readModelsStore(): Record<string, unknown> | null {
	const filePath = getModelsStorePath();
	if (_modelsStoreCache.has(filePath)) return _modelsStoreCache.get(filePath)!;
	const parsed = readSettingsJson(filePath, { missingIsQuiet: true });
	_modelsStoreCache.set(filePath, parsed);
	return parsed;
}

/** Clear the parsed models.json cache. Exposed for tests and future hot-reload boundaries. */
export function invalidateModelsJsonCache(): void {
	_modelsJsonCache.clear();
	_modelsStoreCache.clear();
}

function readSettingsJson(
	filePath: string,
	options: { missingIsQuiet?: boolean } = {},
): Record<string, unknown> | null {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(content) as Record<string, unknown>;
	} catch (e) {
		if (options.missingIsQuiet && isMissingFileError(e)) return null;
		logWarn(`[pi-agent-flow] Failed to read settings JSON from ${filePath}: ${e}`);
		return null;
	}
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getRegistryProviders(registry: Record<string, unknown>): Record<string, unknown> {
	return isPlainObject(registry.providers) ? registry.providers : registry;
}

function findRegisteredModel(
	registry: Record<string, unknown> | null,
	providerKey: string,
	modelId: string,
): Record<string, unknown> | undefined {
	if (!isPlainObject(registry)) return undefined;
	const provider = getRegistryProviders(registry)[providerKey];
	if (!isPlainObject(provider) || !Array.isArray(provider.models)) return undefined;
	return provider.models.find((candidate): candidate is Record<string, unknown> =>
		isPlainObject(candidate) && candidate.id === modelId,
	);
}

export function resolveModelContextWindow(model: string): number | undefined {
	const parts = model.split("/");
	if (parts.length < 2) return undefined;

	const providerKey = parts[0];
	const modelId = parts.slice(1).join("/");

	const registered =
		findRegisteredModel(readModelsJson(), providerKey, modelId) ??
		findRegisteredModel(readModelsStore(), providerKey, modelId);
	return typeof registered?.contextWindow === "number" ? registered.contextWindow : undefined;
}

/**
 * Return whether a provider/model entry is known in the local model registries.
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

	const customRegistry = registry === undefined ? readModelsJson() : registry;
	if (findRegisteredModel(customRegistry, providerKey, modelId)) return true;
	if (findRegisteredModel(readModelsStore(), providerKey, modelId)) return true;

	const store = readModelsStore();
	const registryHasProvider = isPlainObject(customRegistry) && providerKey in getRegistryProviders(customRegistry);
	const storeHasProvider = isPlainObject(store) && providerKey in getRegistryProviders(store);
	return registryHasProvider || storeHasProvider ? false : undefined;
}
