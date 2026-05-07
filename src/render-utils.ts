/**
 * Pure utility functions for rendering - extracted for testability.
 */

import type { UsageStats } from "./types.js";

/**
 * Format a token count to exactly 5 characters with leading spaces.
 * Shifts from k to M when value would exceed 5 chars.
 * Examples: 500 → "  500", 1300 → " 1.3k", 32000 → "32.0k", 950500 → "0.95M"
 */
export function formatFixedTokens(count: number): string {
	if (count < 1000) {
		return count.toString().padStart(5);
	}

	const k = count / 1000;
	if (k < 100) {
		return (k.toFixed(1) + "k").padStart(5);
	} else if (k < 1000) {
		const m = count / 1000000;
		return (m.toFixed(2) + "M").padStart(5);
	} else {
		const m = count / 1000000;
		return (m.toFixed(2) + "M").padStart(5);
	}
}

/**
 * Format flow type name to fixed width (5 chars) in lowercase with space padding.
 * Examples: "debug" → "debug", "scout" → "scout", "build" → "build"
 */
export function formatFlowTypeName(type: string): string {
	const lower = type.toLowerCase();
	const targetWidth = 5;
	if (lower.length >= targetWidth) return lower.slice(0, targetWidth);
	return lower.padEnd(targetWidth, " ");
}

/** Format tokens-per-second to a 5-char display (e.g., " 42.3", "    -"). */
function formatTps(value: number | undefined): string {
	if (!value || value <= 0) return "    -";
	return value.toFixed(1).padStart(5);
}

export function formatCompactTokenPair(usage: Partial<UsageStats>): string {
	return `↑ ${formatFixedTokens(usage.input || 0)} · ↓ ${formatFixedTokens(usage.output || 0)}`;
}

export function formatCompactStats(
	usage: Partial<UsageStats>,
	model?: string,
	maxWidth?: number,
	options: { skipTokens?: boolean } = {},
): string {
	const tokenParts = [`↑ ${formatFixedTokens(usage.input || 0)}`, `↓ ${formatFixedTokens(usage.output || 0)}`];
	const runtimeParts = [`tps: ${formatTps(usage.smoothedTps)}`, `ctx: ${formatFixedTokens(usage.contextTokens || 0)}`];
	const parts = options.skipTokens ? runtimeParts : [...tokenParts, ...runtimeParts];

	const displayModel = model ? model.replace(/^[^/]+\//, "") : undefined;
	let result = parts.join(" · ") + (displayModel ? ` · ${displayModel}` : "");
	if (maxWidth && visibleLength(result) > maxWidth) {
		// Drop model first.
		let narrow = parts.join(" · ");
		if (visibleLength(narrow) <= maxWidth) return narrow;

		// Drop context tokens next.
		const withoutContext = parts.filter((part) => !part.startsWith("ctx:"));
		narrow = withoutContext.join(" · ");
		if (visibleLength(narrow) <= maxWidth) return narrow;

		// Bare minimum: token pair for normal stats, tps for token-free headers.
		narrow = options.skipTokens ? runtimeParts[0] : tokenParts.join(" · ");
		if (visibleLength(narrow) <= maxWidth) return narrow;

		return truncateChars(result, maxWidth);
	}

	return result;
}

export function formatCountdown(ms: number): string {
	const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Regex matching ANSI escape sequences. */
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Return the visible (ANSI-stripped) character count. */
export function visibleLength(text: string): number {
	return text.replace(ANSI_RE, "").length;
}

/**
 * Compute the remaining visible-character budget for a line,
 * given the length of its prefix (indent + label + space).
 * Respects `process.stdout.columns` with a floor of 40 and default of 80.
 */
export function getTruncationBudget(prefixLength: number): number {
	const cols = process.stdout.columns ?? 80;
	const width = Math.max(cols, 40);
	return Math.max(width - prefixLength, 1);
}

/** Fixed content budget for collapsed-line text (dir/act/log). */
export const CONTENT_MAX = 60;

/**
 * Compute how many visible chars of content fit after a prefix,
 * using the fixed CONTENT_MAX budget. Floor of 8 to keep things readable.
 */
export function contentBudget(prefixVisibleLen: number): number {
	return Math.max(CONTENT_MAX - prefixVisibleLen, 8);
}

/**
 * Truncate an ANSI-colored string to at most `max` visible characters,
 * preserving ANSI codes in the kept portions. Does not inject reset codes
 * — the caller is responsible for closing any open styles.
 * 
 * Refactored to perform head-truncation (start + ...) instead of middle-truncation.
 */
function truncateAnsi(text: string, max: number): string {
	if (visibleLength(text) <= max) return text;

	// Walk through the string, collecting raw chars until we've consumed
	// `count` visible characters. ANSI sequences are copied through without
	// counting toward the limit.
	function takeVisible(src: string, count: number): { raw: string; consumed: number } {
		let raw = "";
		let visible = 0;
		let i = 0;
		while (i < src.length && visible < count) {
			// Check for ANSI escape sequence at current position
			if (src[i] === "\x1b" && src[i + 1] === "[") {
				const end = src.indexOf("m", i + 2);
				if (end !== -1) {
					const seq = src.slice(i, end + 1);
					if (/^\x1b\[[0-9;]*m$/.test(seq)) {
						raw += seq;
						i = end + 1;
						continue;
					}
				}
			}
			raw += src[i];
			visible++;
			i++;
		}
		return { raw, consumed: visible };
	}

	if (max < 3) {
		// Not enough room for '...' — just truncate without ellipsis
		const { raw } = takeVisible(text, max);
		return raw;
	}

	const keep = max - 3; // 3 = '...'.length
	const ellipsis = "...";

// Take head from the start
	const headResult = takeVisible(text, keep);

	return headResult.raw + ellipsis;
}

export function truncateChars(text: string, max: number): string {
	text = text.replace(/[\n\r\t]+/g, " ").replace(/ +/g, " ").trim();
	if (visibleLength(text) <= max) return text;
	return truncateAnsi(text, max);
}

export function tailText(text: string, max: number): string {
	const flat = text.replace(/[\n\r\t]+/g, " ").replace(/ +/g, " ").trim();
	if (visibleLength(flat) <= max) return flat;

	// Take last `max` visible characters from the end
	let visible = 0;
	let i = flat.length - 1;
	while (i >= 0 && visible < max) {
		if (flat[i] === "m") {
			const escStart = flat.lastIndexOf("\x1b[", i);
			if (escStart !== -1 && escStart < i) {
				const seq = flat.slice(escStart, i + 1);
				if (/^\x1b\[[0-9;]*m$/.test(seq)) {
					i = escStart - 1;
					continue;
				}
			}
		}
		visible++;
		i--;
	}
	return flat.slice(i + 1);
}
