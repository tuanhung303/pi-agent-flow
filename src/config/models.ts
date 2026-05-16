import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function getModelsJsonPath(): string {
	const agentDir = process.env["PI_CODING_AGENT_DIR"]?.trim() || path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "models.json");
}

function readSettingsJson(filePath: string): Record<string, unknown> | null {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(content) as Record<string, unknown>;
	} catch {
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
