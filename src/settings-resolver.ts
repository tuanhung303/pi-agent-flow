/**
 * Settings resolution for session_start handler.
 *
 * Extracted from index.ts for single-responsibility and testability.
 */

import * as os from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type FlowConfig, discoverFlows } from "./agents.js";
import {
	loadFlowModelConfigs,
	loadFlowSettings,
	loadProjectFlowModelConfigName,
	normalizeFlowModeName,
	selectFlowModelStrategy,
	writeGlobalFlowMode,
	formatFlowModelStrategy,
	type LoadedFlowModelConfigs,
} from "./config.js";
import { getInheritedCliArgs } from "./cli-args.js";
import { parseBoolean, FLOW_TOOL_OPTIMIZE_ENV } from "./depth.js";
import {
	DEFAULT_AGENT_SESSION_MODE,
	PI_FLOW_SESSION_MODE_ENV,
	parseAgentSessionMode,
	type AgentSessionMode,
} from "./session-mode.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedSettings {
	toolOptimize: boolean;
	structuredOutput: boolean;
	maxConcurrency: number;
	defaultSessionMode: AgentSessionMode;
	discoveredFlows: FlowConfig[];
	loadedFlowModelConfigs: LoadedFlowModelConfigs;
	activeRuntimeFlowMode: string | undefined;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve all flow settings from env vars, CLI flags, and settings files.
 *
 * Called from the session_start handler. Returns the resolved settings
 * plus discovered flows and model configs.
 */
export function resolveSettings(
	pi: ExtensionAPI,
	cwd: string,
): ResolvedSettings & { projectFlowsDir: string | null } {
	const inheritedCliArgs = getInheritedCliArgs();

	let toolOptimize = true;
	let structuredOutput = true;
	let maxConcurrency = 4;
	let defaultSessionMode: AgentSessionMode = DEFAULT_AGENT_SESSION_MODE;

	const envToolOptimize = process.env[FLOW_TOOL_OPTIMIZE_ENV];
	if (envToolOptimize !== undefined) {
		const parsed = parseBoolean(envToolOptimize);
		if (parsed !== null) toolOptimize = parsed;
	}

	// Auto-discover flows
	const discovery = discoverFlows(cwd, "all");
	const discoveredFlows = discovery.flows;
	let loadedFlowModelConfigs: LoadedFlowModelConfigs = loadFlowModelConfigs(cwd);
	let activeRuntimeFlowMode: string | undefined = undefined;

	// Resolve --flow-mode persistent switch
	const requestedFlowMode = normalizeFlowModeName(pi.getFlag("flow-mode"));
	if (requestedFlowMode !== undefined) {
		if (!Object.prototype.hasOwnProperty.call(loadedFlowModelConfigs.configs, requestedFlowMode)) {
			const availableModes = Object.keys(loadedFlowModelConfigs.configs).sort().join(", ") || "(none)";
			console.warn(
				`[pi-agent-flow] Cannot switch flow mode to "${requestedFlowMode}"; no flowModelConfigs.${requestedFlowMode} strategy was found. Available modes: ${availableModes}.`,
			);
		} else {
			try {
				writeGlobalFlowMode(requestedFlowMode);
				const strategy = loadedFlowModelConfigs.configs[requestedFlowMode] ?? {};
				const strategyDescription = formatFlowModelStrategy(requestedFlowMode, strategy);
				console.warn(strategyDescription);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.warn(`[pi-agent-flow] ${message}`);
			}

			const projectFlowModelConfig = loadProjectFlowModelConfigName(cwd);
			if (projectFlowModelConfig !== undefined && projectFlowModelConfig !== requestedFlowMode) {
				console.warn(
					`[pi-agent-flow] Switched global flow mode to "${requestedFlowMode}"; this project selects "${projectFlowModelConfig}" in .pi/settings.json, so future runs in this project may still use "${projectFlowModelConfig}" unless project settings are changed.`,
				);
			}

			activeRuntimeFlowMode = requestedFlowMode;
			loadedFlowModelConfigs = selectFlowModelStrategy(loadedFlowModelConfigs.configs, requestedFlowMode);
		}
	}

	// Resolve settings from .pi/settings.json
	const flowSettings = loadFlowSettings(cwd);
	if (typeof flowSettings.structuredOutput === "boolean") {
		structuredOutput = flowSettings.structuredOutput;
	}
	if (typeof flowSettings.maxConcurrency === "number") {
		maxConcurrency = flowSettings.maxConcurrency;
	}

	// Resolve toolOptimize: CLI flag > env var > settings.json > default
	const cliFlag = pi.getFlag("tool-optimize");
	if (typeof flowSettings.toolOptimize === "boolean") {
		toolOptimize = flowSettings.toolOptimize;
	}
	if (envToolOptimize !== undefined) {
		const parsed = parseBoolean(envToolOptimize);
		if (parsed !== null) toolOptimize = parsed;
	}
	if (typeof cliFlag === "boolean") {
		toolOptimize = cliFlag;
	} else if (typeof cliFlag === "string") {
		const parsed = parseBoolean(cliFlag);
		if (parsed !== null) toolOptimize = parsed;
	}

	// Resolve sessionMode: CLI flag > env var > settings.json > default
	defaultSessionMode = flowSettings.sessionMode ?? DEFAULT_AGENT_SESSION_MODE;
	const envSessionModeRaw = process.env[PI_FLOW_SESSION_MODE_ENV];
	if (envSessionModeRaw !== undefined) {
		const envSessionMode = parseAgentSessionMode(envSessionModeRaw);
		if (envSessionMode !== undefined) {
			defaultSessionMode = envSessionMode;
		} else {
			console.warn(`[pi-agent-flow] Ignoring invalid ${PI_FLOW_SESSION_MODE_ENV}="${envSessionModeRaw}". Expected fast, default, long, or extreme_long.`);
		}
	}
	const cliSessionModeRaw = pi.getFlag("flow-session-mode");
	if (typeof cliSessionModeRaw === "string") {
		const cliSessionMode = parseAgentSessionMode(cliSessionModeRaw);
		if (cliSessionMode !== undefined) {
			defaultSessionMode = cliSessionMode;
		} else {
			console.warn(`[pi-agent-flow] Ignoring invalid --flow-session-mode value "${cliSessionModeRaw}". Expected fast, default, long, or extreme_long.`);
		}
	} else if (inheritedCliArgs.flowSessionMode !== undefined) {
		defaultSessionMode = inheritedCliArgs.flowSessionMode;
	}

	// Resolve maxConcurrency: CLI flag > env var > settings.json > default
	const cliConcurrency = pi.getFlag("flow-max-concurrency");
	if (typeof cliConcurrency === "string") {
		const parsed = Number(cliConcurrency);
		if (Number.isSafeInteger(parsed) && parsed >= 1) maxConcurrency = parsed;
	} else if (typeof cliConcurrency === "number" && Number.isSafeInteger(cliConcurrency) && cliConcurrency >= 1) {
		maxConcurrency = cliConcurrency;
	}
	const envConcurrency = process.env["PI_FLOW_MAX_CONCURRENCY"];
	if (envConcurrency !== undefined && typeof cliConcurrency === "undefined") {
		const parsed = Number(envConcurrency);
		if (Number.isSafeInteger(parsed) && parsed >= 1) maxConcurrency = parsed;
	}
	// Cap concurrency to the number of available CPUs
	if (typeof os.availableParallelism === "function") {
		const hwConcurrency = os.availableParallelism();
		if (hwConcurrency > 0) maxConcurrency = Math.min(maxConcurrency, hwConcurrency);
	}

	return {
		toolOptimize,
		structuredOutput,
		maxConcurrency,
		defaultSessionMode,
		discoveredFlows,
		loadedFlowModelConfigs,
		activeRuntimeFlowMode,
		projectFlowsDir: discovery.projectFlowsDir,
	};
}
