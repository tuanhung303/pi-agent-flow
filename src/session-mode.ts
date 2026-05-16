const AGENT_SESSION_MODES = ["fast", "default", "long", "extreme_long"] as const;

export type AgentSessionMode = typeof AGENT_SESSION_MODES[number];

export const DEFAULT_AGENT_SESSION_MODE: AgentSessionMode = "default";
export const MAX_AGENT_SESSION_TIMEOUT_MS = 1_200_000;
export const PI_FLOW_SESSION_MODE_ENV = "PI_FLOW_SESSION_MODE";

export const AGENT_SESSION_TIMEOUTS_MS: Record<AgentSessionMode, number> = {
	fast: 300_000,
	default: 600_000,
	long: 900_000,
	extreme_long: MAX_AGENT_SESSION_TIMEOUT_MS,
};

export function parseAgentSessionMode(value: unknown): AgentSessionMode | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return (AGENT_SESSION_MODES as readonly string[]).includes(normalized)
		? normalized as AgentSessionMode
		: undefined;
}

export function resolveAgentSessionMode(
	value: unknown,
	fallback: AgentSessionMode = DEFAULT_AGENT_SESSION_MODE,
): AgentSessionMode {
	return parseAgentSessionMode(value) ?? fallback;
}

export function getAgentSessionTimeoutMs(mode: AgentSessionMode): number {
	return AGENT_SESSION_TIMEOUTS_MS[mode];
}
