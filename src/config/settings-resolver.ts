/**
 * Settings resolution for session_start handler.
 *
 * Extracted from index.ts for single-responsibility and testability.
 */

import * as os from "node:os";
import * as fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type FlowConfig, discoverFlows } from "../core/agents.js";
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
import { getInheritedCliArgs } from "../snapshot/cli-args.js";
import { parseBoolean, FLOW_TOOL_OPTIMIZE_ENV } from "../core/depth.js";
import { logWarn } from "./log.js";
import {
	DEFAULT_AGENT_SESSION_MODE,
	PI_FLOW_SESSION_MODE_ENV,
	parseAgentSessionMode,
	type AgentSessionMode,
} from "../core/session-mode.js";

// Environment variables for steering and animation
const PI_FLOW_NO_STEERING_ENV = "PI_FLOW_NO_STEERING";
const PI_FLOW_NO_STRATEGIC_HINT_ENV = "PI_FLOW_NO_STRATEGIC_HINT";
const PI_FLOW_NO_ANIMATION_ENV = "PI_FLOW_NO_ANIMATION";
const PI_FLOW_NO_GLITCH_ENV = "PI_FLOW_NO_GLITCH";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedSettings {
	toolOptimize: boolean;
	structuredOutput: boolean;
	maxConcurrency: number;
	defaultSessionMode: AgentSessionMode;
	steeringEnabled: boolean;
	steeringCustomPrompt: string | undefined;
	steeringStrategicHint: boolean;
	animationEnabled: boolean;
	animationGlitch: boolean;
	askUserEnabled: boolean;
	askUserTimeout: number;
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
	let steeringEnabled = true;
	let steeringCustomPrompt: string | undefined = undefined;
	let steeringStrategicHint = true;
	let animationEnabled = true;
	let animationGlitch = true;
	let askUserEnabled = false;
	let askUserTimeout = 300000; // 5 minutes in ms

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
			logWarn(
				`[pi-agent-flow] Cannot switch flow mode to "${requestedFlowMode}"; no flowModelConfigs.${requestedFlowMode} strategy was found. Available modes: ${availableModes}.`,
			);
		} else {
			try {
				writeGlobalFlowMode(requestedFlowMode);
				const strategy = loadedFlowModelConfigs.configs[requestedFlowMode] ?? {};
				const strategyDescription = formatFlowModelStrategy(requestedFlowMode, strategy);
				logWarn(strategyDescription);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logWarn(`[pi-agent-flow] ${message}`);
			}

			const projectFlowModelConfig = loadProjectFlowModelConfigName(cwd);
			if (projectFlowModelConfig !== undefined && projectFlowModelConfig !== requestedFlowMode) {
				logWarn(
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
	// steering defaults from settings.json
	if (typeof flowSettings.steering?.enabled === "boolean") {
		steeringEnabled = flowSettings.steering.enabled;
	}
	if (typeof flowSettings.steering?.customPrompt === "string") {
		steeringCustomPrompt = flowSettings.steering.customPrompt;
	}
	if (typeof flowSettings.steering?.strategicHint === "boolean") {
		steeringStrategicHint = flowSettings.steering.strategicHint;
	}
	// animation defaults from settings.json
	if (typeof flowSettings.animation?.enabled === "boolean") {
		animationEnabled = flowSettings.animation.enabled;
	}
	if (typeof flowSettings.animation?.glitch === "boolean") {
		animationGlitch = flowSettings.animation.glitch;
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
			logWarn(`[pi-agent-flow] Ignoring invalid ${PI_FLOW_SESSION_MODE_ENV}="${envSessionModeRaw}". Expected fast, default, long, or extreme_long.`);
		}
	}
	const cliSessionModeRaw = pi.getFlag("flow-session-mode");
	if (typeof cliSessionModeRaw === "string") {
		const cliSessionMode = parseAgentSessionMode(cliSessionModeRaw);
		if (cliSessionMode !== undefined) {
			defaultSessionMode = cliSessionMode;
		} else {
			logWarn(`[pi-agent-flow] Ignoring invalid --flow-session-mode value "${cliSessionModeRaw}". Expected fast, default, long, or extreme_long.`);
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

	// Resolve steering: CLI flag > env var > settings.json > default
	const envNoSteering = process.env[PI_FLOW_NO_STEERING_ENV];
	if (envNoSteering !== undefined) {
		const parsed = parseBoolean(envNoSteering);
		if (parsed !== null) steeringEnabled = !parsed; // env is "NO" steering, so invert
	}
	const cliNoSteering = pi.getFlag("no-steering");
	if (typeof cliNoSteering === "boolean") {
		steeringEnabled = !cliNoSteering;
	} else if (typeof cliNoSteering === "string") {
		const parsed = parseBoolean(cliNoSteering);
		if (parsed !== null) steeringEnabled = !parsed;
	}

	// Resolve strategic hint: CLI flag > env var > settings.json > default
	const envNoStrategicHint = process.env[PI_FLOW_NO_STRATEGIC_HINT_ENV];
	if (envNoStrategicHint !== undefined) {
		const parsed = parseBoolean(envNoStrategicHint);
		if (parsed !== null) steeringStrategicHint = !parsed;
	}
	const cliNoStrategicHint = pi.getFlag("no-strategic-hint");
	if (typeof cliNoStrategicHint === "boolean") {
		steeringStrategicHint = !cliNoStrategicHint;
	} else if (typeof cliNoStrategicHint === "string") {
		const parsed = parseBoolean(cliNoStrategicHint);
		if (parsed !== null) steeringStrategicHint = !parsed;
	}

	// Resolve animation: CLI flag > env var > settings.json > default
	const envNoAnimation = process.env[PI_FLOW_NO_ANIMATION_ENV];
	if (envNoAnimation !== undefined) {
		const parsed = parseBoolean(envNoAnimation);
		if (parsed !== null) animationEnabled = !parsed;
	}
	const cliNoAnimation = pi.getFlag("no-animation");
	if (typeof cliNoAnimation === "boolean") {
		animationEnabled = !cliNoAnimation;
	} else if (typeof cliNoAnimation === "string") {
		const parsed = parseBoolean(cliNoAnimation);
		if (parsed !== null) animationEnabled = !parsed;
	}

	// Resolve glitch: CLI flag > env var > settings.json > default
	const envNoGlitch = process.env[PI_FLOW_NO_GLITCH_ENV];
	if (envNoGlitch !== undefined) {
		const parsed = parseBoolean(envNoGlitch);
		if (parsed !== null) animationGlitch = !parsed;
	}
	const cliNoGlitch = pi.getFlag("no-glitch");
	if (typeof cliNoGlitch === "boolean") {
		animationGlitch = !cliNoGlitch;
	} else if (typeof cliNoGlitch === "string") {
		const parsed = parseBoolean(cliNoGlitch);
		if (parsed !== null) animationGlitch = !parsed;
	}

	// Resolve askUser: settings.json > env var > default
	if (typeof flowSettings.askUser?.enabled === "boolean") {
		askUserEnabled = flowSettings.askUser.enabled;
	}
	if (typeof flowSettings.askUser?.timeout === "number") {
		askUserTimeout = flowSettings.askUser.timeout * 1000;
	}
	const envAskUserTimeout = process.env["PI_ASK_USER_TIMEOUT"];
	if (envAskUserTimeout !== undefined) {
		const parsed = Number(envAskUserTimeout);
		if (Number.isSafeInteger(parsed) && parsed >= 1) {
			askUserTimeout = parsed * 1000;
		}
	}

	// Resolve custom steering prompt: CLI flag only (path to file)
	const cliSteeringPrompt = pi.getFlag("steering-prompt");
	if (typeof cliSteeringPrompt === "string" && cliSteeringPrompt.trim()) {
		try {
			steeringCustomPrompt = fs.readFileSync(cliSteeringPrompt.trim(), "utf-8").trim();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logWarn(`[pi-agent-flow] Could not read steering-prompt file: ${msg}`);
		}
	}

	return {
		toolOptimize,
		structuredOutput,
		maxConcurrency,
		defaultSessionMode,
		steeringEnabled,
		steeringCustomPrompt,
		steeringStrategicHint,
		animationEnabled,
		animationGlitch,
		askUserEnabled,
		askUserTimeout,
		discoveredFlows,
		loadedFlowModelConfigs,
		activeRuntimeFlowMode,
		projectFlowsDir: discovery.projectFlowsDir,
	};
}
