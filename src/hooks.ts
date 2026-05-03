/**
 * Post-flow hook registry.
 *
 * Hooks inject advisory messages into flow tool results after execution.
 * Built-in hooks fire automatically; user hooks can be registered via `registerHook()`.
 */

import {
	type PostFlowHook,
	type AutoTransition,
	type SingleResult,
	isFlowSuccess,
} from "./types.js";

// ---------------------------------------------------------------------------
// Module-scoped hook registry
// ---------------------------------------------------------------------------

const hooks: PostFlowHook[] = [];

/**
 * Register or replace a hook by name.
 * If a hook with the same name already exists, it is replaced.
 */
export function registerHook(hook: PostFlowHook): void {
	const idx = hooks.findIndex((h) => h.name === hook.name);
	if (idx >= 0) hooks[idx] = hook;
	else hooks.push(hook);
}

export interface RunHooksResult {
	/** Advisory messages sorted by priority. */
	advisors: string[];
	/** Auto-transitions collected from hooks, sorted by confidence descending. */
	autoTransitions: AutoTransition[];
}

/**
 * Run all registered hooks against the given flow results.
 * Returns advisory strings sorted by priority and auto-transitions.
 */
export function runHooks(
	params: Array<{ type: string; intent: string }>,
	results: SingleResult[],
): string[] {
	const raw = runHooksDetailed(params, results);
	return raw.advisors;
}

/**
 * Run all hooks and return both advisors and auto-transitions.
 */
export function runHooksDetailed(
	params: Array<{ type: string; intent: string }>,
	results: SingleResult[],
): RunHooksResult {
	const messages: Array<{ priority: number; content: string }> = [];
	const transitions: AutoTransition[] = [];

	for (const hook of hooks) {
		const triggerTypes = new Set(
			hook.trigger.flowTypes.map((t) => t.toLowerCase()),
		);
		const onlyOnSuccess = hook.trigger.onlyOnSuccess !== false;

		const matching = results.filter((r) => triggerTypes.has(r.type));
		if (matching.length === 0) continue;
		if (onlyOnSuccess && !matching.every((r) => isFlowSuccess(r))) continue;

		const result = hook.action({ results: matching, params });
		if (result) {
			messages.push({ priority: result.priority ?? 0, content: result.content });
			if (result.autoTransition) {
				transitions.push(result.autoTransition);
			}
		}
	}

	messages.sort((a, b) => a.priority - b.priority);
	transitions.sort((a, b) => b.confidence - a.confidence);
	return {
		advisors: messages.map((m) => m.content),
		autoTransitions: transitions,
	};
}

/**
 * Get a snapshot of all registered hooks. For introspection and plugin API.
 */
export function getRegisteredHooks(): PostFlowHook[] {
	return [...hooks];
}

/**
 * Clear all registered hooks. For testing only.
 */
export function clearHooks(): void {
	hooks.length = 0;
}

// ---------------------------------------------------------------------------
// Built-in hooks
// ---------------------------------------------------------------------------

/** Suggest audit flow after a successful build flow. */
registerHook({
	name: "pi-agent-flow/build-to-audit",
	trigger: { flowTypes: ["build"], onlyOnSuccess: true },
	action: (ctx) => {
		const auditWasRequested = ctx.params.some(
			(p) => p.type.toLowerCase() === "audit",
		);
		if (auditWasRequested) return null;

		return {
			content:
				"Consider running a [audit] flow to audit the changes for security, correctness, and code quality.",
			priority: 10,
		};
	},
});

/** Suggest build flow after a successful debug flow. */
registerHook({
	name: "pi-agent-flow/debug-to-build",
	trigger: { flowTypes: ["debug"], onlyOnSuccess: true },
	action: (ctx) => {
		const buildWasRequested = ctx.params.some(
			(p) => p.type.toLowerCase() === "build",
		);
		if (buildWasRequested) return null;

		return {
			content:
				"The root cause has been identified. Consider running a [build] flow to implement the fix.",
			priority: 10,
		};
	},
});

/** Suggest scout flow after a successful audit flow. */
registerHook({
	name: "pi-agent-flow/audit-to-scout",
	trigger: { flowTypes: ["audit"], onlyOnSuccess: true },
	action: (ctx) => {
		const scoutWasRequested = ctx.params.some(
			(p) => p.type.toLowerCase() === "scout",
		);
		if (scoutWasRequested) return null;

		return {
			content:
				"Audit complete. Consider running a [scout] flow to trace the audit findings across the codebase.",
			priority: 15,
		};
	},
});

// ---------------------------------------------------------------------------
// Extended transition hooks
// ---------------------------------------------------------------------------

/** Suggest build or debug flow after a successful scout flow. */
registerHook({
	name: "pi-agent-flow/scout-to-build",
	trigger: { flowTypes: ["scout"], onlyOnSuccess: true },
	action: (ctx) => {
		const alreadyRequested = ctx.params.some(
			(p) => ["build", "debug"].includes(p.type.toLowerCase()),
		);
		if (alreadyRequested) return null;

		return {
			content:
				"Context mapped. Consider running a [build] flow to implement changes, or [debug] if investigating an issue.",
			priority: 20,
		};
	},
});

/** Suggest build flow after a successful craft flow. */
registerHook({
	name: "pi-agent-flow/craft-to-build",
	trigger: { flowTypes: ["craft"], onlyOnSuccess: true },
	action: (ctx) => {
		const buildWasRequested = ctx.params.some(
			(p) => p.type.toLowerCase() === "build",
		);
		if (buildWasRequested) return null;

		return {
			content:
				"Plan ready. Consider running a [build] flow to implement the design.",
			priority: 10,
		};
	},
});

/** Suggest craft or build flow after a successful ideas flow. */
registerHook({
	name: "pi-agent-flow/ideas-to-craft",
	trigger: { flowTypes: ["ideas"], onlyOnSuccess: true },
	action: (ctx) => {
		const alreadyRequested = ctx.params.some(
			(p) => ["craft", "build"].includes(p.type.toLowerCase()),
		);
		if (alreadyRequested) return null;

		return {
			content:
				"Ideas explored. Consider running a [craft] flow to design the approach, or [build] to implement directly.",
			priority: 15,
		};
	},
});

/** Suggest audit flow after a successful debug flow. */
registerHook({
	name: "pi-agent-flow/debug-to-audit",
	trigger: { flowTypes: ["debug"], onlyOnSuccess: true },
	action: (ctx) => {
		const auditWasRequested = ctx.params.some(
			(p) => p.type.toLowerCase() === "audit",
		);
		if (auditWasRequested) return null;

		return {
			content:
				"Root cause identified. Consider running an [audit] flow to verify the fix area for related issues.",
			priority: 20,
		};
	},
});
