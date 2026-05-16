/**
 * Canonical reasoning/thinking stripping for assistant messages.
 *
 * Shared between index.ts (session snapshot sanitization) and
 * runner-events.ts (inbound message cleaning).
 */

/** Message part types that represent reasoning/thinking content. */
const REASONING_PART_TYPES = new Set([
	"thinking",
	"reasoning",
	"reasoning_content",
	"reasoningContent",
]);

/** Top-level fields on assistant messages that carry reasoning data. */
const REASONING_FIELDS = [
	"thinking",
	"thinkingSignature",
	"thinking_signature",
	"reasoning",
	"reasoningContent",
	"reasoning_content",
	"reasoningSignature",
	"reasoning_signature",
];

/**
 * Strip thinking/reasoning content from an assistant message.
 *
 * Removes top-level reasoning fields and filters reasoning parts
 * from the content array. Returns the (possibly new) message and
 * a boolean indicating whether anything was changed.
 *
 * This is the canonical implementation used by both index.ts
 * (for session snapshot sanitization) and runner-events.ts
 * (for inbound message cleaning).
 */
export function stripReasoningFromAssistantMessage(message: any): {
	message: any;
	changed: boolean;
} {
	let next = message;
	let changed = false;

	for (const field of REASONING_FIELDS) {
		if (field in next) {
			if (next === message) next = { ...message };
			delete next[field];
			changed = true;
		}
	}

	if (Array.isArray(message.content)) {
		const filteredContent = message.content.filter(
			(part: any) => !REASONING_PART_TYPES.has(part?.type),
		);
		if (filteredContent.length !== message.content.length) {
			if (next === message) next = { ...message };
			next.content = filteredContent;
			changed = true;
		}
	}

	return { message: next, changed };
}
