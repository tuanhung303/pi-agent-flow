// Auto-generated from src/tui/scramble.ts split
import {
	FastRNG,
	MIN_PHRASE_LENGTH,
	MAX_PHRASE_BUFFER_TIME,
	DEEP_GLITCH,
	MID_GLITCH,
	SHALLOW_GLITCH,
	THIN_BRAILLE_SPARK,
	SCRAMBLE_CHARS,
	DECORATIVE_ICON_RE,
} from './constants.js';
export function makeAnimationSeed(text: string, timestamp: number): number {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return ((h ^ timestamp) >>> 0);
}

const hashNoiseCache = new Map<number, number>();
const MAX_HASH_CACHE_SIZE = 4096;

export function hashNoise(seed: number, charIndex: number, tick: number, depth: number): number {
	const key = (((seed * 31 + charIndex) * 31 + tick) * 7 + depth) >>> 0;
	const cached = hashNoiseCache.get(key);
	if (cached !== undefined) return cached;
	let h = Math.imul(seed ^ charIndex, 0x45d9f3b);
	h = Math.imul(h ^ tick, 0x45d9f3b);
	h = Math.imul(h ^ depth, 0x45d9f3b);
	h ^= h >>> 16;
	const result = (h >>> 0) / 0xFFFFFFFF;
	if (hashNoiseCache.size < MAX_HASH_CACHE_SIZE) {
		hashNoiseCache.set(key, result);
	}
	return result;
}

// ---------------------------------------------------------------------------
// Character sets — depth-based esoteric scramble symbols (illuminate mode)
// ---------------------------------------------------------------------------

/** Deep glitch: fine dots, sparse sparkle, dense braille for inner ripple depths (1–2) */
export function easeOutCubic(t: number): number {
	const et = 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
	return 0.7 * et + 0.3 * Math.min(1, Math.max(0, t));
}

/** Smoothstep interpolation for smooth color band transitions */
export function smoothstep(min: number, max: number, value: number): number {
	const x = Math.max(0, Math.min(1, (value - min) / (max - min)));
	return x * x * (3 - 2 * x);
}

/** Linear interpolation between a and b by factor t (0..1) */
export function lerp(a: number, b: number, t: number): number {
	return Math.round(a + (b - a) * Math.max(0, Math.min(1, t)));
}

/** Ease-in quadratic: gentle start, accelerating into the main wave */
export function easeInQuad(t: number): number {
	return t * t;
}

/** Ease-out quadratic: fast start, gentle deceleration — used for
 *  distributing cascade start frames more evenly across the range. */
export function easeOutQuad(t: number): number {
	return 1 - (1 - t) * (1 - t);
}

// ---------------------------------------------------------------------------
// Mode type
// ---------------------------------------------------------------------------

export function stripDecorativeIcons(text: string): string {
	return text.replace(DECORATIVE_ICON_RE, '');
}

export function findPhraseBoundary(text: string, minLen: number = MIN_PHRASE_LENGTH): number {
	// Sentence boundaries — flush regardless of length
	const sentenceBoundaries = ['. ', '! ', '? ', '\n'];
	for (const b of sentenceBoundaries) {
		const idx = text.lastIndexOf(b);
		if (idx >= 0) return idx + b.length;
	}
	// Other boundaries require min length
	if (text.length < minLen) return -1;
	const otherBoundaries = ['— ', '– '];
	for (const b of otherBoundaries) {
		const idx = text.lastIndexOf(b);
		if (idx >= 0) return idx + b.length;
	}
	// Fallback: word boundary (space)
	const spaceIdx = text.indexOf(' ', minLen);
	if (spaceIdx >= 0) return spaceIdx + 1;
	return -1;
}

export function shouldFlushPhrase(text: string, displayed: string, lastFlushTime: number, now: number): boolean {
	if (text === displayed) return false;
	// If text is completely different (not incremental), check if it's just a slide
	if (!text.startsWith(displayed) && !displayed.startsWith(text)) {
		// Tail-view windows slide: old suffix overlaps new prefix.
		// If overlap is significant (>50%), treat as a slide, not a rewrite.
		const overlap = computeOverlapLen(displayed, text);
		const minLen = Math.min(displayed.length, text.length);
		if (overlap > 0 && overlap >= minLen * 0.5) {
			return now - lastFlushTime > MAX_PHRASE_BUFFER_TIME;
		}
		return true;
	}
	// Check buffer timeout
	if (now - lastFlushTime > MAX_PHRASE_BUFFER_TIME) return true;
	// Find new content added since displayed
	let newContent = '';
	if (text.startsWith(displayed)) {
		newContent = text.slice(displayed.length);
	} else {
		newContent = text;
	}
	const boundaryPos = findPhraseBoundary(newContent);
	if (boundaryPos >= 0) return true;
	// Force flush: if enough new content accumulated, flush regardless of boundary
	const newContentLen = text.startsWith(displayed) ? text.length - displayed.length : text.length;
	if (newContentLen >= 40) return true;
	return false;
}

export function randomizedCenter(length: number, jitterRatio?: number, rng?: FastRNG): number {
	const min = Math.max(0, Math.floor(length * 0.2));
	const max = Math.min(length - 1, Math.floor(length * 0.8));
	if (max <= min) return Math.floor(length / 2);
	const range = max - min + 1;
	const offset = rng ? rng.nextInt(range) : Math.floor(Math.random() * range);
	return min + offset;
}

/**
 * Find sentence-start character positions in text.
 * Returns positions of the first non-space character after sentence
 * delimiters (. ! ? ... \n) plus position 0. If fewer than 2
 * positions are found, falls back to positions at ~30-char intervals.
 */
export function findSentenceStarts(text: string): number[] {
	const starts: number[] = [];
	if (text.length === 0) return starts;
	starts.push(0);

	const delimiters = ['... ', '. ', '! ', '? ', '\n'];
	let i = 0;
	while (i < text.length) {
		let bestD = '';
		let bestLen = 0;
		for (const d of delimiters) {
			if (text.slice(i, i + d.length) === d && d.length > bestLen) {
				bestD = d;
				bestLen = d.length;
			}
		}
		if (bestD) {
			let pos = i + bestD.length;
			while (pos < text.length && text[pos] === ' ') pos++;
			if (pos < text.length && pos !== starts[starts.length - 1]) {
				starts.push(pos);
			}
			i = pos;
		} else {
			i++;
		}
	}

	// Fallback: if too few sentence starts, add positions at ~30-char intervals
	if (starts.length < 2 && text.length > 30) {
		const stride = Math.max(30, Math.floor(text.length / 3));
		let pos = stride;
		while (pos < text.length) {
			while (pos < text.length && text[pos] === ' ') pos++;
			if (pos < text.length && !starts.includes(pos)) {
				starts.push(pos);
			}
			pos += stride;
		}
	}

	return starts;
}

/**
 * Pick a random sentence-start position. Falls back to `randomizedCenter`
 * when the text has no sentence boundaries.
 */
export function randomSentenceStart(text: string, rng?: FastRNG): number {
	const starts = findSentenceStarts(text);
	if (starts.length === 0 || (starts.length === 1 && starts[0] === 0)) {
		return randomizedCenter(text.length, 0.2, rng);
	}
	const idx = rng ? rng.nextInt(starts.length) : Math.floor(Math.random() * starts.length);
	return starts[idx];
}

// ---------------------------------------------------------------------------
// Unified apply function (cascade/ripple/illuminate)
// ---------------------------------------------------------------------------

export function computeOverlapLen(oldStr: string, newStr: string): number {
	const maxOverlap = Math.min(oldStr.length, newStr.length);
	if (maxOverlap === 0) return 0;

	// KMP LPS array for newStr prefix of length maxOverlap
	const lps = new Array(maxOverlap).fill(0);
	let len = 0;
	for (let i = 1; i < maxOverlap; i++) {
		while (len > 0 && newStr[i] !== newStr[len]) {
			len = lps[len - 1];
		}
		if (newStr[i] === newStr[len]) len++;
		lps[i] = len;
	}

	// Match newStr prefix against oldStr suffix
	len = 0;
	const startIdx = Math.max(0, oldStr.length - maxOverlap);
	for (let i = startIdx; i < oldStr.length; i++) {
		while (len > 0 && oldStr[i] !== newStr[len]) {
			len = lps[len - 1];
		}
		if (oldStr[i] === newStr[len]) len++;
	}

	return len;
}

/**
 * For static lines, detect whether a text change is a minor mutation
 * (most characters remain in the same positions). Used to suppress
 * re-flashing when embedded stats (TPS, tokens) change at the end of
 * a header line while the prefix (flow name, model) stays stable.
 */
export function isMinorStaticMutation(oldStr: string, newStr: string): boolean {
	const maxLen = Math.max(oldStr.length, newStr.length);
	if (maxLen === 0) return true;
	let same = 0;
	const minLen = Math.min(oldStr.length, newStr.length);
	for (let i = 0; i < minLen; i++) {
		if (oldStr[i] === newStr[i]) same++;
	}
	return same / maxLen >= 0.5;
}

export function selectScrambleChar(depth: number, dist: number, elapsed: number, seed?: number, textLen?: number): string {
	const tickMs = (textLen !== undefined && textLen < 20) ? 300 : 150;
	const tick = Math.floor(elapsed / tickMs);
	if (seed !== undefined) {
		const n = hashNoise(seed, dist, tick, depth);
		let char: string;
		if (depth < 2.5) {
			// Blend deep→mid across [1.5, 2.5]
			const t = smoothstep(1.5, 2.5, depth);
			const deepIdx = Math.floor(n * DEEP_GLITCH.length);
			const midIdx = Math.floor(n * MID_GLITCH.length);
			char = n < t ? MID_GLITCH[midIdx] : DEEP_GLITCH[deepIdx];
		} else if (depth < 3.5) {
			// Blend mid→shallow across [2.5, 3.5]
			const t = smoothstep(2.5, 3.5, depth);
			const midIdx = Math.floor(n * MID_GLITCH.length);
			const shallowIdx = Math.floor(n * SHALLOW_GLITCH.length);
			char = n < t ? SHALLOW_GLITCH[shallowIdx] : MID_GLITCH[midIdx];
		} else {
			const shallowIdx = Math.floor(n * SHALLOW_GLITCH.length);
			char = SHALLOW_GLITCH[shallowIdx];
		}
		return char;
	}
	// Deterministic fallback (backward compatible)
	const jitter = 0;
	if (depth <= 2) {
		const idx = (3 * dist + tick + jitter) % DEEP_GLITCH.length;
		return DEEP_GLITCH[idx < 0 ? idx + DEEP_GLITCH.length : idx];
	} else if (depth === 3) {
		const idx = (5 * dist + tick + jitter) % MID_GLITCH.length;
		return MID_GLITCH[idx < 0 ? idx + MID_GLITCH.length : idx];
	} else {
		const idx = (7 * dist + tick + jitter) % SHALLOW_GLITCH.length;
		return SHALLOW_GLITCH[idx < 0 ? idx + SHALLOW_GLITCH.length : idx];
	}
}

export function selectSparkChar(seed: number, charIndex: number, tick: number): string {
	const n = hashNoise(seed, charIndex, tick, 88);
	const idx = Math.floor(n * THIN_BRAILLE_SPARK.length);
	return THIN_BRAILLE_SPARK[idx < 0 ? idx + THIN_BRAILLE_SPARK.length : idx];
}

// ---------------------------------------------------------------------------
// ANSI truecolor neon glow constants (illuminate mode)
// ---------------------------------------------------------------------------

