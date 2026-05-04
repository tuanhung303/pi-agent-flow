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

/**
 * Unregister a hook by name.
 * Returns true if a hook was removed, false if no hook with that name existed.
 */
export function unregisterHook(name: string): boolean {
	const idx = hooks.findIndex((h) => h.name === name);
	if (idx < 0) return false;
	hooks.splice(idx, 1);
	return true;
}

export interface RunHooksResult {
	/** Advisory messages sorted by priority. */
	advisors: string[];
	/** Auto-transitions collected from hooks. */
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
 *
 * Each hook action is wrapped in try/catch so one bad hook cannot crash
 * the pipeline. Failures are reported as advisory warnings.
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

		try {
			const result = hook.action({ results: matching, params });
			if (result) {
				messages.push({ priority: result.priority ?? 0, content: result.content });
				if (result.autoTransition) {
					transitions.push(result.autoTransition);
				}
			}
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			messages.push({
				priority: 999,
				content: `Hook "${hook.name}" failed: ${errorMessage}`,
			});
		}
	}

	messages.sort((a, b) => a.priority - b.priority);
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

// Built-in hooks removed — transitions are now handled exclusively by
// the declarative DEFAULT_TRANSITIONS matrix in transitions.ts and
// registered via buildTransitionHooks() in index.ts session_start.
// See transitions.ts for the single source of truth.
