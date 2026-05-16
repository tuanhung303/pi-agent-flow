/**
 * Flow depth configuration, env/CLI flag parsing, and cycle detection.
 *
 * Extracted from index.ts for single-responsibility and testability.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { logWarn } from "../config/log.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_DELEGATION_DEPTH = 3;
export const DEFAULT_PREVENT_CYCLE_DELEGATION = true;
export const FLOW_DEPTH_ENV = "PI_FLOW_DEPTH";
export const FLOW_MAX_DEPTH_ENV = "PI_FLOW_MAX_DEPTH";
export const FLOW_STACK_ENV = "PI_FLOW_STACK";
export const FLOW_PREVENT_CYCLES_ENV = "PI_FLOW_PREVENT_CYCLES";
export const FLOW_TOOL_OPTIMIZE_ENV = "PI_FLOW_TOOL_OPTIMIZE";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FlowDepthConfig {
	currentDepth: number;
	maxDepth: number;
	canDelegate: boolean;
	ancestorFlowStack: string[];
	preventCycles: boolean;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

export function parseNonNegativeInt(raw: unknown): number | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const parsed = Number(trimmed);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseBoolean(raw: unknown): boolean | null {
	if (typeof raw === "boolean") return raw;
	if (typeof raw !== "string") return null;
	const normalized = raw.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return null;
}

export function parseFlowStack(raw: unknown): string[] | null {
	if (raw === undefined) return [];
	if (typeof raw !== "string") return null;
	if (!raw.trim()) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	if (!Array.isArray(parsed)) return null;
	if (!parsed.every((value) => typeof value === "string")) return null;
	return parsed
		.map((value) => value.trim().toLowerCase())
		.filter((value) => value.length > 0);
}

function getMaxDepthFlagFromArgv(argv: string[]): string | null {
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--flow-max-depth") {
			return argv[i + 1] ?? "";
		}
		if (arg.startsWith("--flow-max-depth=")) {
			return arg.slice("--flow-max-depth=".length);
		}
	}
	return null;
}

function getPreventCyclesFlagFromArgv(
	argv: string[],
): string | boolean | null {
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--flow-prevent-cycles") {
			const maybeValue = argv[i + 1];
			if (maybeValue !== undefined && !maybeValue.startsWith("--")) {
				return maybeValue;
			}
			return true;
		}
		if (arg === "--no-flow-prevent-cycles") return false;
		if (arg.startsWith("--flow-prevent-cycles=")) {
			return arg.slice("--flow-prevent-cycles=".length);
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Depth resolution
// ---------------------------------------------------------------------------

export function resolveFlowDepthConfig(pi: ExtensionAPI): FlowDepthConfig {
	const depthRaw = process.env[FLOW_DEPTH_ENV];
	const parsedDepth = parseNonNegativeInt(depthRaw);
	if (depthRaw !== undefined && parsedDepth === null) {
		logWarn(
			`[pi-agent-flow] Ignoring invalid ${FLOW_DEPTH_ENV}="${depthRaw}". Expected a non-negative integer.`,
		);
	}
	const currentDepth = parsedDepth ?? 0;

	const stackRaw = process.env[FLOW_STACK_ENV];
	const ancestorFlowStack = parseFlowStack(stackRaw);
	if (stackRaw !== undefined && ancestorFlowStack === null) {
		logWarn(
			`[pi-agent-flow] Ignoring invalid ${FLOW_STACK_ENV} value. Expected a JSON array of flow names.`,
		);
	}

	const envMaxDepthRaw = process.env[FLOW_MAX_DEPTH_ENV];
	const envMaxDepth = parseNonNegativeInt(envMaxDepthRaw);
	if (envMaxDepthRaw !== undefined && envMaxDepth === null) {
		logWarn(
			`[pi-agent-flow] Ignoring invalid ${FLOW_MAX_DEPTH_ENV}="${envMaxDepthRaw}". Expected a non-negative integer.`,
		);
	}

	const argvFlagRaw = getMaxDepthFlagFromArgv(process.argv);
	const argvFlagMaxDepth =
		argvFlagRaw !== null ? parseNonNegativeInt(argvFlagRaw) : null;
	if (argvFlagRaw !== null && argvFlagMaxDepth === null) {
		logWarn(
			`[pi-agent-flow] Ignoring invalid --flow-max-depth value "${argvFlagRaw}". Expected a non-negative integer.`,
		);
	}

	const runtimeFlagValue = pi.getFlag("flow-max-depth");
	const runtimeFlagMaxDepth =
		typeof runtimeFlagValue === "string"
			? parseNonNegativeInt(runtimeFlagValue)
			: null;
	if (
		argvFlagRaw === null &&
		typeof runtimeFlagValue === "string" &&
		runtimeFlagMaxDepth === null
	) {
		logWarn(
			`[pi-agent-flow] Ignoring invalid --flow-max-depth value "${runtimeFlagValue}". Expected a non-negative integer.`,
		);
	}

	const envPreventCyclesRaw = process.env[FLOW_PREVENT_CYCLES_ENV];
	const envPreventCycles = parseBoolean(envPreventCyclesRaw);
	if (envPreventCyclesRaw !== undefined && envPreventCycles === null) {
		logWarn(
			`[pi-agent-flow] Ignoring invalid ${FLOW_PREVENT_CYCLES_ENV}="${envPreventCyclesRaw}". Expected true/false.`,
		);
	}

	const argvPreventCyclesRaw = getPreventCyclesFlagFromArgv(process.argv);
	const argvPreventCycles =
		typeof argvPreventCyclesRaw === "boolean"
			? argvPreventCyclesRaw
			: parseBoolean(argvPreventCyclesRaw);
	if (
		typeof argvPreventCyclesRaw === "string" &&
		argvPreventCycles === null
	) {
		logWarn(
			`[pi-agent-flow] Ignoring invalid --flow-prevent-cycles value "${argvPreventCyclesRaw}". Expected true/false.`,
		);
	}

	const runtimePreventCyclesRaw = pi.getFlag("flow-prevent-cycles");
	const runtimePreventCycles = parseBoolean(runtimePreventCyclesRaw);
	if (
		argvPreventCyclesRaw === null &&
		runtimePreventCyclesRaw !== undefined &&
		runtimePreventCycles === null
	) {
		logWarn(
			`[pi-agent-flow] Ignoring invalid --flow-prevent-cycles value "${String(runtimePreventCyclesRaw)}". Expected true/false.`,
		);
	}

	const flagMaxDepth = argvFlagMaxDepth ?? runtimeFlagMaxDepth;
	const maxDepth = flagMaxDepth ?? envMaxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH;
	const preventCycles =
		argvPreventCycles ??
		runtimePreventCycles ??
		envPreventCycles ??
		DEFAULT_PREVENT_CYCLE_DELEGATION;

	return {
		currentDepth,
		maxDepth,
		canDelegate: currentDepth < maxDepth,
		ancestorFlowStack: ancestorFlowStack ?? [],
		preventCycles,
	};
}
