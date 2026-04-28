/**
 * Pure utility functions for rendering — extracted for testability.
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
 * Format flow type name to fixed width (10 chars) in lowercase with dot padding.
 * Examples: "debug" → "debug.....", "architect" → "architect.", "brainstorm" → "brainstorm"
 */
export function formatFlowTypeName(type: string): string {
	const lower = type.toLowerCase();
	const targetWidth = 10;
	if (lower.length >= targetWidth) return lower.slice(0, targetWidth);
	return lower + ".".repeat(targetWidth - lower.length);
}

export function formatCompactStats(usage: Partial<UsageStats>, model?: string, maxWidth?: number): string {
	const parts: string[] = [];
	parts.push(`${formatFixedTokens(usage.input || 0)}↑`);
	parts.push(`${formatFixedTokens(usage.output || 0)}↓`);
	if (usage.cacheRead) parts.push(`cr:${formatFixedTokens(usage.cacheRead)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatFixedTokens(usage.contextTokens)}`);

	let result = `[ ${parts.join(" ")} ]${model ? ` ─ ${model}` : ""}`;

	if (maxWidth && visibleLength(result) > maxWidth) {
		// Drop model first
		let narrow = `[ ${parts.join(" ")} ]`;
		if (visibleLength(narrow) <= maxWidth) return narrow;

		// Drop context tokens
		const narrowParts = parts.slice();
		const ctxIndex = narrowParts.findIndex((p) => p.startsWith("ctx:"));
		if (ctxIndex !== -1) narrowParts.splice(ctxIndex, 1);
		narrow = `[ ${narrowParts.join(" ")} ]`;
		if (visibleLength(narrow) <= maxWidth) return narrow;

		// Bare minimum (just input/output)
		narrow = `[ ${parts[0]} ${parts[1]} ]`;
		if (visibleLength(narrow) <= maxWidth) return narrow;

		return truncateChars(result, maxWidth);
	}

	return result;
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

/**
 * Truncate an ANSI-colored string to at most `max` visible characters,
 * preserving ANSI codes in the kept portions. Does not inject reset codes
 * — the caller is responsible for closing any open styles.
 */
function truncateAnsi(text: string, max: number): string {
	if (visibleLength(text) <= max) return text;

	if (max < 6) {
		// Not enough room for " ... " — just truncate without ellipsis
		const { raw } = takeVisible(text, max);
		return raw;
	}

	const head = Math.ceil(max * 0.6);
	const tail = max - head - 5; // 5 = " ... ".length

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

	// Take head from the start
	const headResult = takeVisible(text, head);

	// Take tail from the end (walk backwards)
	function takeVisibleFromEnd(src: string, count: number): string {
		let visible = 0;
		let i = src.length - 1;
		while (i >= 0 && visible < count) {
			// Check if current char is end of an ANSI sequence
			if (src[i] === "m") {
				const escStart = src.lastIndexOf("\x1b[", i);
				if (escStart !== -1 && escStart < i) {
					const seq = src.slice(escStart, i + 1);
					if (/^\x1b\[[0-9;]*m$/.test(seq)) {
						// This is an ANSI sequence — don't count, skip past it
						i = escStart - 1;
						continue;
					}
				}
			}
			visible++;
			i--;
		}
		// Extract the raw substring from (i+1) to end, including any trailing ANSI
		return src.slice(i + 1);
	}

	const tailRaw = takeVisibleFromEnd(text, tail);

	return headResult.raw + " ... " + tailRaw;
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
