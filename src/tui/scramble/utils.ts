// Auto-generated from src/tui/scramble.ts split
import {
	FastRNG,
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
// Character sets — depth-based esoteric scramble symbols
// ---------------------------------------------------------------------------

/** Smoothstep interpolation for smooth color band transitions */
export function smoothstep(min: number, max: number, value: number): number {
	const x = Math.max(0, Math.min(1, (value - min) / (max - min)));
	return x * x * (3 - 2 * x);
}

// ---------------------------------------------------------------------------
// Mode type
// ---------------------------------------------------------------------------

export function stripDecorativeIcons(text: string): string {
	return text.replace(DECORATIVE_ICON_RE, '');
}

export function randomizedCenter(length: number, jitterRatio?: number, rng?: FastRNG): number {
	const min = Math.max(0, Math.floor(length * 0.2));
	const max = Math.min(length - 1, Math.floor(length * 0.8));
	if (max <= min) return Math.floor(length / 2);
	const range = max - min + 1;
	const offset = rng ? rng.nextInt(range) : Math.floor(Math.random() * range);
	return min + offset;
}

// ---------------------------------------------------------------------------
// Unified apply function (glitch)
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
	return same / maxLen >= 0.75;
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
