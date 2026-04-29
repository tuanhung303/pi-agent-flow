/**
 * Post-flow hook registry.
 *
 * Hooks inject advisory messages into flow tool results after execution.
 * Built-in hooks fire automatically; user hooks can be registered via `registerHook()`.
 */

import {
	type PostFlowHook,
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
 * Run all registered hooks against the given flow results.
 * Returns an array of advisory strings sorted by priority.
 */
export function runHooks(
	params: Array<{ type: string; intent: string }>,
	results: SingleResult[],
): string[] {
	const messages: Array<{ priority: number; content: string }> = [];

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
		}
	}

	messages.sort((a, b) => a.priority - b.priority);
	return messages.map((m) => m.content);
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

/** Suggest review flow after a successful code flow. */
registerHook({
	name: "pi-agent-flow/code-to-review",
	trigger: { flowTypes: ["code"], onlyOnSuccess: true },
	action: (ctx) => {
		const reviewWasRequested = ctx.params.some(
			(p) => p.type.toLowerCase() === "review",
		);
		if (reviewWasRequested) return null;

		return {
			content:
				"Consider running a [review] flow to audit the changes for security, correctness, and code quality.",
			priority: 10,
		};
	},
});

/** Suggest code flow after a successful debug flow. */
registerHook({
	name: "pi-agent-flow/debug-to-code",
	trigger: { flowTypes: ["debug"], onlyOnSuccess: true },
	action: (ctx) => {
		const codeWasRequested = ctx.params.some(
			(p) => p.type.toLowerCase() === "code",
		);
		if (codeWasRequested) return null;

		return {
			content:
				"The root cause has been identified. Consider running a [code] flow to implement the fix.",
			priority: 10,
		};
	},
});
