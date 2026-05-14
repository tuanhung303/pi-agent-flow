/**
 * Quad-mode text scramble effect for terminal TUI.
 *
 * Mode 1 — STREAM: Typewriter-style progressive reveal.
 *   Buffer the full text, reveal character-by-character with a scramble
 *   cursor at the writing position. Works naturally with streaming text —
 *   the cursor follows the stream, creating a "typing" effect.
 *
 * Mode 2 — CASCADE: Classic TextScramble algorithm (Justin Windle).
 *   Per-character queue with staggered start/end frames. Characters decode
 *   one-by-one in a left-to-right cascade. Self-terminating after ~640ms.
 *
 * Mode 3 — RIPPLE: Hermes radial wave propagation.
 *   Wave expands from a center point. Characters resolve behind the wavefront.
 *
 * Mode 4 — ILLUMINATE: Neon glow ripple with depth-based esoteric char sets,
 *   ANSI truecolor, phrase-chunked msg streaming, and TPS hysteresis.
 *   Per-target color configs (sky aim, warm act, peach TPS, etc.).
 *
 * Line behavior (all modes):
 *   aim: — content stays still, no animation ever
 *   act: — stream/cascade/ripple/illuminate on text change
 *   msg: — stream/cascade/ripple/illuminate on text change
 *   tps: — flash on value change (cascade/ripple/illuminate only)
 */

import type { UsageStats } from './types.js';
import { stripAnsi, tailText, truncateChars } from './render-utils.js';

// ---------------------------------------------------------------------------
// Fast RNG (xorshift32) + hash-based noise
// ---------------------------------------------------------------------------

export class FastRNG {
	private s: number;
	constructor(seed: number) { this.s = seed >>> 0; }
	next(): number {
		let s = this.s;
		s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
		this.s = s >>> 0;
		return (s >>> 0) / 0xFFFFFFFF;
	}
	nextInt(max: number): number {
		return Math.floor(this.next() * max);
	}
}

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
const DEEP_GLITCH = '·∘∙*˚｡⠁⠂⠃⠄⠅⠆⠇⠈⠉⠊⠋⠌⠍⠎⠏⠐⠑⠒⠓';
/** Mid glitch: dots, light sparkles, medium braille for depth (3) */
const MID_GLITCH = '·∘∙~⋆˚｡₊⊹⟡✩˖⠁⠂⠃⠄⠅⠆⠇⠈⠉⠊⠋';
/** Shallow glitch: heavy sparkles + light braille for outer depths (4+) — the wavefront crest */
const SHALLOW_GLITCH = '·∘∙~✦°⭒✶𖦹✮✩⠌⠡⠜';
/** Classic scramble set for stream/cascade/ripple fallback — balanced braille + sparkle mix */
const SCRAMBLE_CHARS = '·∘∙~⋆˚｡₊⊹⟡✩✦°⠌⠡⠜⠣⠪⠹⠸⠷⠮⠯⠿⠾';
/** Sparkle and thin braille mix for afterglow "pop" */
const SPARK_CHARS = '·∘∙⋆˚｡⠂⠄⠈⠐⠠⡀⢀⠃⠆⠉⠘⠰⡁⢂';
/** Backward-compat alias */
const THIN_BRAILLE_SPARK = SPARK_CHARS;

function selectScrambleChar(depth: number, dist: number, elapsed: number, seed?: number, textLen?: number): string {
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

function selectSparkChar(seed: number, charIndex: number, tick: number): string {
	const n = hashNoise(seed, charIndex, tick, 88);
	const idx = Math.floor(n * THIN_BRAILLE_SPARK.length);
	return THIN_BRAILLE_SPARK[idx < 0 ? idx + THIN_BRAILLE_SPARK.length : idx];
}

// ---------------------------------------------------------------------------
// ANSI truecolor neon glow constants (illuminate mode)
// ---------------------------------------------------------------------------

const CYAN_GLOW = '\x1b[38;2;0;255;204m';
const WARM_GLOW = '\x1b[38;2;255;140;120m';
const PEACH_GLOW = '\x1b[38;2;255;160;140m';
const ORANGE_GLOW = '\x1b[38;2;255;190;130m';
const SKY_GLOW = '\x1b[38;2;80;170;255m';
const WHITE_GLOW = '\x1b[38;2;255;255;255m';
const RESET_COLOR = '\x1b[39m';
const BOLD_ON = '\x1b[1m';
const BOLD_OFF = '\x1b[22m';

const DIM_ON = '\x1b[2m';
const DIM_OFF = '\x1b[22m';

/** Illuminate close: turns off bold (SGR 22 also kills dim), then re-applies
 *  dim (SGR 2) so enclosing dim context survives scramble transitions. */
const ILLUMINATE_CLOSE = '\x1b[22m\x1b[39m\x1b[49m';

// ---------------------------------------------------------------------------
// Illuminate per-target effect configs
// ---------------------------------------------------------------------------

interface IlluminateConfig {
	color: string;
	duration: number;
	spread: number;
	glowIntensity: 'high' | 'medium' | 'low' | 'variable';
	initialTimeOffset?: number;
	crestOnly?: boolean;
	spark?: boolean;
	scramble?: boolean; // default true; when false, keep original text during ripple (no garble)
}

const ILLUMINATE_CONFIGS: Record<string, IlluminateConfig> = {
	aimLabel: { color: SKY_GLOW, duration: 360, spread: 1.0, glowIntensity: 'high', crestOnly: false, spark: false },
	actLabel: { color: WARM_GLOW, duration: 360, spread: 1.0, glowIntensity: 'high', crestOnly: false, spark: false },
	msgLabel: { color: PEACH_GLOW, duration: 360, spread: 1.0, glowIntensity: 'high', crestOnly: false, spark: false },

	msgContent: { color: 'dynamic', duration: 600, spread: 1.0, glowIntensity: 'variable', initialTimeOffset: 30, scramble: false },
	flowMeta: { color: WARM_GLOW, duration: 380, spread: 0.8, glowIntensity: 'medium', crestOnly: false, spark: false },

	tps: { color: WARM_GLOW, duration: 84, spread: 0.5, glowIntensity: 'medium', crestOnly: true, spark: false },

};

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

const RIPPLE_DUR_DEFAULT = 520;
const RIPPLE_SPREAD_DEFAULT = 1;
const MIN_RIPPLE_INTERVAL = 300;
const DEPTH_BAND_MAX = 7;
const TPS_FLASH_DUR = 105;
const TPS_FLASH_SPREAD = 0.5;
const AFTERGLOW_MS = 420;
const ECHO_AFTERGLOW_MS = 650;
const FLASH_AFTERGLOW_MS = 137; // shorter afterglow for TPS/KPI value flashes
const PULSE_WINDOW_MS = 600;
const PULSE_CYCLE_MS = 998;
const CASCADE_FRAME_MS = 11;
const CASCADE_MAX_START = 28;
const CASCADE_MAX_LENGTH = 28;
const CASCADE_FLASH_MAX_START = 4;
const CASCADE_FLASH_MAX_LENGTH = 6;

// Illuminate phrase buffering
const MAX_PHRASE_BUFFER_TIME = 560;
const MIN_PHRASE_LENGTH = 60;

// Drain timeout: partial chunk ripples when text stops changing for this long.
// Tokens arrive ~200ms apart at 196 TPS; 350ms is long enough to avoid firing
// during active streaming but short enough to feel responsive when tool calls pause.
const MSG_CHUNK_DRAIN_MS = 120;

// Resume gap: after a long pause (e.g. tool call), treat resumed chunks as a
// fresh stream and force a ripple effect.
const STREAMING_RESUME_GAP_MS = 2000;

// TPS hysteresis
const SECONDARY_RIPPLE_DELAY_MS = 84;
const SECONDARY_RIPPLE_STRENGTH = 0.75;

// TPS hysteresis
const TPS_HYSTERESIS_PCT = 0.15;
const TPS_HYSTERESIS_MS = 2000;
const TPS_FLASH_COOLDOWN_MS = 3000;

// Stream mode constants
const STREAM_SPEED_MSG = 35;       // ms per char for msg: (~29 chars/sec)
const STREAM_SPEED_ACT = 25;       // ms per char for act: (~40 chars/sec)
const STREAM_SCRAMBLE_WIDTH = 5;   // scramble chars at cursor position
const STREAM_RERANDOMIZE_RATE = 0.28; // 28% chance to re-randomize (CodePen style)

// ---------------------------------------------------------------------------
// Easing and interpolation helpers
// ---------------------------------------------------------------------------

/** Ease-out cubic: organic deceleration for ripple expansion.
 *  Blended 70% ease-out + 30% linear for a snappier wavefront. */
function easeOutCubic(t: number): number {
	const et = 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
	return 0.7 * et + 0.3 * Math.min(1, Math.max(0, t));
}

/** Smoothstep interpolation for smooth color band transitions */
function smoothstep(min: number, max: number, value: number): number {
	const x = Math.max(0, Math.min(1, (value - min) / (max - min)));
	return x * x * (3 - 2 * x);
}

/** Linear interpolation between a and b by factor t (0..1) */
function lerp(a: number, b: number, t: number): number {
	return Math.round(a + (b - a) * Math.max(0, Math.min(1, t)));
}

/** Ease-in quadratic: gentle start, accelerating into the main wave */
function easeInQuad(t: number): number {
	return t * t;
}

/** Ease-out quadratic: fast start, gentle deceleration — used for
 *  distributing cascade start frames more evenly across the range. */
function easeOutQuad(t: number): number {
	return 1 - (1 - t) * (1 - t);
}

// ---------------------------------------------------------------------------
// Mode type
// ---------------------------------------------------------------------------

export type ScrambleMode = 'stream' | 'cascade' | 'ripple' | 'illuminate';

export { selectScrambleChar };
export { selectSparkChar };
export { THIN_BRAILLE_SPARK };
export { ILLUMINATE_CONFIGS };
export type { IlluminateConfig };
export { CYAN_GLOW, WARM_GLOW, PEACH_GLOW, ORANGE_GLOW, SKY_GLOW, WHITE_GLOW, BOLD_ON, BOLD_OFF, RESET_COLOR };

export const DEFAULT_MODE: ScrambleMode = 'illuminate';

// ---------------------------------------------------------------------------
// Types — shared
// ---------------------------------------------------------------------------

interface Ripple {
	pos: number;
	time: number;
	dur: number;
	spread: number;
	seed?: number;
	contentChange?: boolean;
}

interface QueueItem {
	from: string;
	to: string;
	start: number;
	end: number;
	char?: string;
}

interface LineState {
	lastText: string;
	queue: QueueItem[];
	queueMaxEnd: number;
	startTime: number;
	ripples: Ripple[];
	lastAnimTime: number;
	initialized: boolean;
	completed: boolean;
	// Illuminate phrase buffering (msg: only)
	phraseBuffer: string;
	displayedText: string;
	pendingText: string;
	lastFlushTime: number;
	// Ripple reveal target (msg: only)
	targetText: string;
	resolvedMask: Set<number>;
	// Age tracking for cache eviction
	lastAccessTime: number;
	// Drain timing: when text last changed (for partial chunk drain)
	lastTextChangeTime: number;
	// Ambient pulse: when last ripple expired
	lastRippleEndTime: number;
	// Accumulated chars since last flush (forces periodic ripples during dense streaming)
	charsSinceLastFlush: number;
}

/** Phrase boundary detection for illuminate msg: streaming */
function findPhraseBoundary(text: string, minLen: number = MIN_PHRASE_LENGTH): number {
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

function shouldFlushPhrase(text: string, displayed: string, lastFlushTime: number, now: number): boolean {
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

type LineKey = 'aim' | 'act' | 'msg';

export interface ScrambleResult {
	label: string;
	content: string;
	isAnimating: boolean;
}

interface ValueFlashState {
	prev: string;
	ripples: Ripple[];
	queue: QueueItem[];
	queueMaxEnd: number;
	startTime: number;
	lastValueChangeTime: number;
	lastFlashTime: number;
	completed: boolean;
	// Ambient pulse: when last ripple expired
	lastRippleEndTime: number;
}

// ---------------------------------------------------------------------------
// Types — stream mode
// ---------------------------------------------------------------------------

interface TypewriterState {
	/** Complete buffered text. */
	fullText: string;
	/** Number of chars fully resolved (shown normally). */
	revealedCount: number;
	/** Date.now() of last cursor advance. */
	lastRevealTime: number;
	/** ms per character reveal speed. */
	speed: number;
	/** Number of scramble chars at cursor position. */
	scrambleWidth: number;
	/** Flow has completed — no further animation. */
	completed: boolean;
	/** Cached scramble chars for cursor zone (28% re-randomize). */
	cursorChars: string[];
	/** Last rendered visible text (tail view only, for overlap tracking). */
	lastVisibleText?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function randomChar(): string {
	return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
}

// ---------------------------------------------------------------------------
// Fast random char pool — pre-filled to reduce Math.random() calls ~80%
// ---------------------------------------------------------------------------

const RANDOM_POOL_SIZE = 2048;
const POOL_REFILL_THRESHOLD = 512; // refill when 25% remaining

let randomPool: string[] = [];
let randomPoolIndex = 0;

function fillRandomPool(rng?: FastRNG): void {
	randomPool = new Array(RANDOM_POOL_SIZE);
	for (let i = 0; i < RANDOM_POOL_SIZE; i++) {
		if (rng) {
			randomPool[i] = SCRAMBLE_CHARS[rng.nextInt(SCRAMBLE_CHARS.length)];
		} else {
			randomPool[i] = SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
		}
	}
	randomPoolIndex = 0;
}

function poolRandomChar(): string {
	if (randomPoolIndex >= randomPool.length - POOL_REFILL_THRESHOLD) {
		fillRandomPool();
	}
	return randomPool[randomPoolIndex++];
}

// ---------------------------------------------------------------------------
// Pre-allocated segment buffer — reused across frames to reduce GC pressure
// ---------------------------------------------------------------------------

let segmentBuffer: string[] = [];

function getSegmentBuffer(minSize: number): string[] {
	if (segmentBuffer.length < minSize) {
		segmentBuffer = new Array(Math.max(minSize, 512));
	}
	return segmentBuffer;
}

// ---------------------------------------------------------------------------
// Pure algorithm: STREAM (typewriter progressive reveal)
// ---------------------------------------------------------------------------

/**
 * Render visible text with typewriter stream effect.
 *
 * - Characters before `visibleRevealed` are shown normally (resolved).
 * - Characters in the cursor zone (visibleRevealed to visibleRevealed+scrambleWidth)
 *   show scramble chars with 28% re-randomize rate (CodePen feel).
 * - Characters beyond the cursor show pure noise scramble chars.
 * - Spaces are always preserved.
 */
export function renderStreamText(
	visibleText: string,
	visibleRevealed: number,
	scrambleWidth: number,
	cursorChars: string[],
	rng?: () => string,
): string {
	if (visibleRevealed >= visibleText.length) return visibleText;

	let result = '';
	let inDim = false;

	for (let i = 0; i < visibleText.length; i++) {
		const isResolved = i < visibleRevealed;
		const isCursorZone = !isResolved && i < visibleRevealed + scrambleWidth;
		const ch = visibleText[i];

		if (isResolved || ch === ' ') {
			if (inDim) {
				result += DIM_OFF;
				inDim = false;
			}
			result += ch;
		} else if (isCursorZone) {
			if (!inDim) {
				result += DIM_ON;
				inDim = true;
			}
			const cursorIdx = i - visibleRevealed;
			const getChar = rng ?? poolRandomChar;
			while (cursorChars.length <= cursorIdx) cursorChars.push(getChar());
			if (Math.random() < STREAM_RERANDOMIZE_RATE || !cursorChars[cursorIdx]) {
				cursorChars[cursorIdx] = getChar();
			}
			result += cursorChars[cursorIdx];
		} else {
			// Beyond cursor — live scramble (keeps fuzzing each frame)
			if (!inDim) {
				result += DIM_ON;
				inDim = true;
			}
			result += (rng ?? poolRandomChar)();
		}
	}
	if (inDim) {
		result += DIM_OFF;
	}

	// Trim cursor chars array to actual size used
	cursorChars.length = Math.min(scrambleWidth, Math.max(0, visibleText.length - visibleRevealed));
	return result;
}

// ---------------------------------------------------------------------------
// Pure algorithm: CASCADE (TextScramble by Justin Windle, terminal port)
// ---------------------------------------------------------------------------

export function buildQueue(
	oldText: string,
	newText: string,
	maxStart: number = CASCADE_MAX_START,
	maxLength: number = CASCADE_MAX_LENGTH,
	rng?: FastRNG,
): QueueItem[] {
	const queue: QueueItem[] = [];
	const length = Math.max(oldText.length, newText.length);
	const useRng = rng ?? new FastRNG(makeAnimationSeed(newText, Date.now()));
	for (let i = 0; i < length; i++) {
		const from = oldText[i] || '';
		const to = newText[i] || '';
		const t = length <= 1 ? 0 : i / (length - 1);
		const baseStart = easeOutQuad(t) * maxStart * 0.55;
		const jitter = useRng.next() * maxStart * 0.45;
		const start = Math.floor(baseStart + jitter);
		// Asymmetric end: late chars resolve more slowly using easeOutCubic
		const endEase = easeOutCubic(1 - t);
		const end = start + Math.floor((0.5 + 0.5 * endEase) * useRng.next() * maxLength);
		queue.push({ from, to, start, end });
	}
	return queue;
}

export function computeCascadeFrame(queue: QueueItem[], frame: number, rng?: () => string): string {
	const clampedFrame = Math.max(0, frame);
	let result = '';
	let inDim = false;
	const getChar = rng ?? poolRandomChar;
	for (const item of queue) {
		if (item.to === ' ') {
			if (inDim) { result += DIM_OFF; inDim = false; }
			result += ' ';
			continue;
		}
		if (clampedFrame >= item.end) {
			if (inDim) { result += DIM_OFF; inDim = false; }
			result += item.to;
		} else if (clampedFrame >= item.start) {
			if (!inDim) { result += DIM_ON; inDim = true; }
			result += getChar();
		} else {
			if (item.from === ' ') {
				if (inDim) { result += DIM_OFF; inDim = false; }
				result += ' ';
			} else {
				if (!inDim) { result += DIM_ON; inDim = true; }
				result += getChar();
			}
		}
	}
	if (inDim) result += DIM_OFF;
	return result;
}

function isCascadeComplete(queue: QueueItem[], frame: number, maxEnd?: number): boolean {
	const clampedFrame = Math.max(0, frame);
	if (maxEnd !== undefined) return clampedFrame >= maxEnd;
	for (const item of queue) {
		if (clampedFrame < item.end) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Pure algorithm: RIPPLE (Hermes radial wave)
// ---------------------------------------------------------------------------

/** Build the ANSI prefix for a scramble char based on illuminate config */
function illuminatePrefix(depth: number, elapsed: number, dur: number, config: IlluminateConfig, combinedDepth?: number): string {
	if (config.color === 'dynamic') {
		const progress = Math.min(1, Math.max(0, elapsed / dur));
		// heat = how deep in the ripple (0..1), life = how early in animation (1..0)
		const heat = Math.min(1, depth / DEPTH_BAND_MAX);
		const life = 1 - progress;
		const intensity = heat * life * (1 - 0.25 * heat);

		// 5-zone continuous truecolor gradient: deep sky → bright sky → sky-peach bridge → vivid peach → rich salmon → warm white peak
		let r: number, g: number, b: number;
		if (intensity < 0.20) {
			const t = smoothstep(0, 0.20, intensity);
			r = lerp(0, 80, t);
			g = lerp(80, 170, t);
			b = lerp(255, 255, t);
		} else if (intensity < 0.40) {
			const t = smoothstep(0.20, 0.40, intensity);
			r = lerp(80, 180, t);
			g = lerp(170, 170, t);
			b = lerp(255, 210, t);
		} else if (intensity < 0.60) {
			const t = smoothstep(0.40, 0.60, intensity);
			r = lerp(180, 255, t);
			g = lerp(170, 140, t);
			b = lerp(210, 120, t);
		} else if (intensity < 0.80) {
			const t = smoothstep(0.60, 0.80, intensity);
			r = lerp(255, 255, t);
			g = lerp(140, 90, t);
			b = lerp(120, 70, t);
		} else {
			const t = smoothstep(0.80, 1.0, intensity);
			r = lerp(255, 255, t);
			g = lerp(90, 240, t);
			b = lerp(70, 230, t);
		}

		// Interference boost: overlapping ripples warm-white flash
		const effectiveCombined = combinedDepth ?? depth;
		const interferenceBoost = Math.max(0, (effectiveCombined - DEPTH_BAND_MAX * 0.6) / DEPTH_BAND_MAX);
		if (interferenceBoost > 0) {
			const targetR = 255, targetG = 245, targetB = 240;
			r = Math.min(255, Math.max(0, Math.round(r + interferenceBoost * (targetR - r))));
			g = Math.min(255, Math.max(0, Math.round(g + interferenceBoost * (targetG - g))));
			b = Math.min(255, Math.max(0, Math.round(b + interferenceBoost * (targetB - b))));
		}

		return `\x1b[38;2;${r};${g};${b}m`;
	}
	return BOLD_ON + config.color;
}

export function applyRipples(
	text: string,
	ripples: Ripple[],
	now: number,
	config?: IlluminateConfig,
	targetText?: string,
	resolvedMask?: Set<number>,
	pulseIntensity?: number,
): string {
	if (!ripples.length && !targetText) return text;
	const len = Math.max(text.length, targetText?.length || 0);
	if (len === 0) return text;

	// Active ripples + recently-expired ripples for afterglow
	const activeRipples = ripples.filter(r => r.time <= now && now - r.time < r.dur);
	const afterglowRipples = ripples.filter(r => r.time <= now && now - r.time >= r.dur && now - r.time < r.dur + (r.contentChange ? ECHO_AFTERGLOW_MS : AFTERGLOW_MS));
	const activeCount = activeRipples.length;
	const afterglowCount = afterglowRipples.length;
	if (!activeCount && !afterglowCount && !targetText) return text;

	// Pre-compute radius per active ripple
	const radii = new Float64Array(activeCount);
	const leftBounds = new Int32Array(activeCount);
	const rightBounds = new Int32Array(activeCount);
	for (let i = 0; i < activeCount; i++) {
		const r = activeRipples[i];
		const elapsed = Math.min(1, (now - r.time) / r.dur);
		const maxDist = Math.max(r.pos, len - r.pos - 1);
		radii[i] = easeOutCubic(elapsed) * maxDist * r.spread;
		leftBounds[i] = Math.max(0, Math.floor(r.pos - radii[i]));
		rightBounds[i] = Math.min(len - 1, Math.ceil(r.pos + radii[i]));
	}

	// Pre-compute afterglow reach per expired ripple
	const afterglowData = afterglowCount > 0 ? afterglowRipples.map(r => ({
		pos: r.pos,
		maxReach: Math.max(r.pos, len - r.pos - 1) * r.spread,
		timeSinceExpiry: now - r.time - r.dur,
	})) : [];

	let segments: string[] = getSegmentBuffer(len * 3);
	let segCount = 0;
	let inColor = false;
	let currentPrefix = '';

	for (let idx = 0; idx < len; idx++) {
		const origChar = text[idx];
		if (origChar === ' ') {
			if (inColor) {
				segments[segCount++] = config ? ILLUMINATE_CLOSE : RESET_COLOR + DIM_OFF;
				inColor = false;
				currentPrefix = '';
			}
			segments[segCount++] = origChar;
			continue;
		}

		let maxDepth = 0;
		let combinedDepth = 0; // Additive depth for wave interference
		let afterglowIntensity = 0;
		let bestAgIdx = -1;
		let bestElapsed = 0;
		let bestDist = 0;
		let bestDur = activeRipples[0]?.dur ?? 0;
		let bestIdx = 0;

		for (let i = 0; i < activeCount; i++) {
			if (idx < leftBounds[i] || idx > rightBounds[i]) continue;
			const dist = Math.abs(idx - activeRipples[i].pos);
			const depth = radii[i] - dist;
			if (depth > 0) {
				const fade = 1 - smoothstep(DEPTH_BAND_MAX - 0.5, DEPTH_BAND_MAX + 0.5, depth);
				if (fade > 0) {
					const cappedDepth = Math.min(depth, DEPTH_BAND_MAX);
					combinedDepth += cappedDepth * fade; // Additive for interference
					if (cappedDepth > maxDepth || (cappedDepth === maxDepth && activeRipples[i].time > activeRipples[bestIdx]?.time)) {
						maxDepth = cappedDepth;
						bestElapsed = now - activeRipples[i].time;
						bestDist = dist;
						bestDur = activeRipples[i].dur;
						bestIdx = i;
					}
				}
			}
		}

		// Cap combined depth to avoid overflow in color computation
		combinedDepth = Math.min(combinedDepth, DEPTH_BAND_MAX * 2);

		// Check recently-expired ripples for trailing afterglow (primary + secondary layers)
		if (maxDepth === 0) {
			for (let i = 0; i < afterglowCount; i++) {
				const dist = Math.abs(idx - afterglowData[i].pos);
				if (dist < afterglowData[i].maxReach) {
					const primaryAg = 1 - Math.min(1, afterglowData[i].timeSinceExpiry / 350);
					const secondaryAg = 0.4 * (1 - Math.min(1, afterglowData[i].timeSinceExpiry / AFTERGLOW_MS));
					if (primaryAg > afterglowIntensity || secondaryAg > afterglowIntensity) {
						bestAgIdx = i;
					}
					afterglowIntensity = Math.max(afterglowIntensity, primaryAg, secondaryAg);
				}
			}
		}

		if (maxDepth > 0) {
			const seed = activeRipples[bestIdx].seed ?? 0;
			const jitterTick = Math.floor(now / 42);
			const depthJitter = (hashNoise(seed, bestDist, jitterTick, 99) * 2 - 1) * 0.15;
			const jitteredDepth = Math.max(0.1, maxDepth + depthJitter);
			const char = (config?.scramble === false) ? origChar : selectScrambleChar(jitteredDepth, bestDist, bestElapsed, seed, text.length);
			if (config) {
				const crestDepth = radii[bestIdx] - bestDist;
				const isCrest = !config.crestOnly || (crestDepth > 0 && crestDepth < 2.0);
				let prefix = '';
				if (isCrest) {
					prefix = illuminatePrefix(maxDepth, bestElapsed, bestDur, config, combinedDepth);
					if (config.color === 'dynamic' && crestDepth > 0 && crestDepth < 1.5) {
						// Gradient peak: vivid salmon → warm white, with complementary bg halo
						const t = Math.min(1, crestDepth / 1.5);
						const cr = Math.round(lerp(255, 255, t));
						const cg = Math.round(lerp(90, 240, t));
						const cb = Math.round(lerp(70, 230, t));
						const bgr = Math.round(lerp(20, 60, t));
						const bgg = Math.round(lerp(30, 20, t));
						const bgb = Math.round(lerp(60, 30, t));
						prefix = `\x1b[1m\x1b[48;2;${bgr};${bgg};${bgb}m\x1b[38;2;${cr};${cg};${cb}m`;
					}
				}
				if (prefix) {
					if (!inColor || currentPrefix !== prefix) {
						if (inColor) segments[segCount++] = ILLUMINATE_CLOSE;
						segments[segCount++] = prefix;
						inColor = true;
						currentPrefix = prefix;
					}
				} else if (inColor) {
					segments[segCount++] = ILLUMINATE_CLOSE;
					inColor = false;
					currentPrefix = '';
				}
				segments[segCount++] = char;
			} else {
				if (inColor) {
					segments[segCount++] = ILLUMINATE_CLOSE;
					inColor = false;
					currentPrefix = '';
				}
				segments[segCount++] = char;
			}
		} else if (afterglowIntensity > 0) {
			const agRipple = afterglowRipples[bestAgIdx];
			const timeSinceExpiry = now - agRipple.time - agRipple.dur;
			// Discrete post-ripple glitch pops: 3 brief bursts after ripple expires
			const popWidth = 40;
			const popGap = 60;
			const inInitialPopWindow = (timeSinceExpiry >= 0 && timeSinceExpiry < popWidth)
			    || (timeSinceExpiry >= popWidth + popGap && timeSinceExpiry < 2 * popWidth + popGap)
			    || (timeSinceExpiry >= 2 * (popWidth + popGap) && timeSinceExpiry < 2 * (popWidth + popGap) + popWidth);
			const agTick = Math.floor(now / 40);
			const glitchRoll = bestAgIdx >= 0 ? hashNoise(agRipple.seed ?? 0, idx, agTick, 77) : 1;
			const popTarget = Math.min(0.045, 4 / Math.max(1, text.length));
			const shouldScramble = inInitialPopWindow && bestAgIdx >= 0 && afterglowRipples[bestAgIdx].dur >= 210 && glitchRoll < popTarget;
			if (shouldScramble && config?.scramble !== false) {
				if (config) {
					let agPrefix: string;
					if (config.color === 'dynamic') {
						// Cooling ember: warm at start, fading to dim cool
						// Echo pops get minimum intensity so chars stay visible long after ripple
						const effectiveIntensity = afterglowIntensity;
						const emberR = Math.round(200 + 55 * effectiveIntensity);
						const emberG = Math.round(130 + 80 * effectiveIntensity);
						const emberB = Math.round(140 + 70 * effectiveIntensity);
						agPrefix = `\x1b[38;2;${emberR};${emberG};${emberB}m`;
					} else {
						agPrefix = config.color;
					}
					if (!inColor || currentPrefix !== agPrefix) {
						if (inColor) segments[segCount++] = ILLUMINATE_CLOSE;
						segments[segCount++] = agPrefix;
						inColor = true;
						currentPrefix = agPrefix;
					}
				}
				const agDepth = afterglowIntensity * 4.5;
				const agElapsed = now - agRipple.time - agRipple.dur;
				const useSpark = config?.spark !== false;
				const char = useSpark
					? selectSparkChar(agRipple.seed ?? 0, idx, agTick)
					: selectScrambleChar(agDepth, 0, agElapsed, agRipple.seed, text.length);
				segments[segCount++] = char;
			} else {
				// Plain afterglow — close any open styling and render origChar
				if (inColor) {
					segments[segCount++] = ILLUMINATE_CLOSE;
					inColor = false;
					currentPrefix = '';
				}
				segments[segCount++] = origChar;
			}
		} else {
			if (inColor) {
				segments[segCount++] = ILLUMINATE_CLOSE;
				inColor = false;
				currentPrefix = '';
			}
			if (pulseIntensity !== undefined) {
				const settleTick = Math.floor(now / 175);
				const settleRoll = hashNoise(42, idx, settleTick, 33);
				if (settleRoll < 0.05) {
					const settlePrefix = (hashNoise(42, idx, settleTick, 55) < 0.5)
						? '\x1b[38;2;80;170;255m'   // sky
						: '\x1b[38;2;255;140;120m';  // warm
					if (!inColor || currentPrefix !== settlePrefix) {
						if (inColor) segments[segCount++] = ILLUMINATE_CLOSE;
						segments[segCount++] = settlePrefix;
						inColor = true;
						currentPrefix = settlePrefix;
					}
				}
			}
			segments[segCount++] = origChar;
		}
	}

	if (inColor) {
		segments[segCount++] = ILLUMINATE_CLOSE;
	}

	return segments.slice(0, segCount).join('');
}

function spawnRipple(
	pos: number,
	now: number,
	dur: number = RIPPLE_DUR_DEFAULT,
	spread: number = RIPPLE_SPREAD_DEFAULT,
	seed?: number,
	contentChange?: boolean,
): Ripple {
	const jitteredDur = Math.round(dur * (0.9 + Math.random() * 0.2));
	return { pos, time: now, dur: jitteredDur, spread, seed: seed ?? makeAnimationSeed(String(pos), now), contentChange };
}

function spawnIlluminateRipple(pos: number, now: number, config: IlluminateConfig, seed?: number, contentChange?: boolean): Ripple {
	const jitteredDur = Math.round(config.duration * (0.9 + Math.random() * 0.2));
	return { pos, time: now - (config.initialTimeOffset || 0), dur: jitteredDur, spread: config.spread, seed: seed ?? makeAnimationSeed(String(pos), now), contentChange };
}

function getRippleDuration(textLength: number, baseDur: number = RIPPLE_DUR_DEFAULT): number {
	if (textLength <= 5) return Math.max(baseDur, 950);
	if (textLength <= 10) return Math.max(baseDur, 850);
	return baseDur;
}

function spawnSecondaryRipple(primary: Ripple): Ripple {
	const delay = Math.max(0, Math.min(SECONDARY_RIPPLE_DELAY_MS, primary.dur * 0.4) + (Math.random() * 40 - 20));
	return {
		...primary,
		time: primary.time + delay,
		dur: primary.dur * 0.6,
		spread: primary.spread * SECONDARY_RIPPLE_STRENGTH,
		seed: (primary.seed ?? 0) + 1,
		contentChange: primary.contentChange,
	};
}

function spawnRippleForText(pos: number, now: number, textLength: number, seed?: number, contentChange?: boolean): Ripple[] {
	const primary = spawnRipple(pos, now, getRippleDuration(textLength), RIPPLE_SPREAD_DEFAULT, seed, contentChange);
	return [primary, spawnSecondaryRipple(primary)];
}

function spawnIlluminateRippleForText(pos: number, now: number, config: IlluminateConfig, textLength: number, seed?: number, contentChange?: boolean): Ripple[] {
	// Illuminate labels use intentional per-config durations (400ms for labels, 1200ms for content)
	// Skip getRippleDuration floor which forces short text to 1150-1300ms — that's meant for streaming content, not tool labels
	const dur = config.duration;
	const primary = spawnIlluminateRipple(pos, now, { ...config, duration: dur }, seed, contentChange);
	return [primary, spawnSecondaryRipple(primary)];
}

function spawnTpsRipples(pos: number, now: number): Ripple[] {
	// TPS flash is intentionally brief — no secondary ripple
	return [spawnRipple(pos, now, TPS_FLASH_DUR, TPS_FLASH_SPREAD)];
}

function spawnTpsIlluminateRipples(pos: number, now: number): Ripple[] {
	// TPS flash is intentionally brief — no secondary ripple
	return [spawnIlluminateRipple(pos, now, ILLUMINATE_CONFIGS.tps)];
}

/**
 * Compute a ripple spawn center with random jitter.
 * The position is chosen uniformly between 20% and 80% of the text
 * length (or the center for very short strings), giving a varied
 * but never edge-clamped ripple origin.
 */
function randomizedCenter(length: number, jitterRatio?: number, rng?: FastRNG): number {
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

function computePulseIntensity(state: LineState, now: number): number | undefined {
	const hasActive = state.ripples.some(r => now - r.time < r.dur);
	if (!hasActive) {
		if (state.lastRippleEndTime === 0 && state.ripples.length > 0) {
			state.lastRippleEndTime = now;
		}
	} else {
		state.lastRippleEndTime = 0;
	}
	if (state.lastRippleEndTime > 0) {
		const timeSinceEnd = now - state.lastRippleEndTime;
		if (timeSinceEnd < PULSE_WINDOW_MS) {
			return 0.5;  // Steady constant — no intensity oscillation
		}
		state.lastRippleEndTime = 0;
	}
	return undefined;
}

function applyScramble(text: string, state: LineState, now: number, mode: ScrambleMode, lineKey?: LineKey, rng?: () => string): string {
	if (mode === 'cascade') {
		if (!state.queue.length) return state.displayedText || text;
		const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
		if (isCascadeComplete(state.queue, frame, state.queueMaxEnd)) {
			state.queue = [];
			return state.displayedText || text;
		}
		return computeCascadeFrame(state.queue, frame, rng);
	} else if (mode === 'illuminate') {
		const config = lineKey === 'msg'
			? ILLUMINATE_CONFIGS.msgContent
			: lineKey === 'act'
				? ILLUMINATE_CONFIGS.actLabel
				: undefined;
		const pulseIntensity = computePulseIntensity(state, now);
		return applyRipples(text, state.ripples, now, config, undefined, undefined, pulseIntensity);
	} else {
		const pulseIntensity = computePulseIntensity(state, now);
		return applyRipples(text, state.ripples, now, undefined, undefined, undefined, pulseIntensity);
	}
}

// ---------------------------------------------------------------------------
// processLine — unified change detection (cascade/ripple)
// ---------------------------------------------------------------------------

function processLine(
	state: LineState,
	newText: string,
	now: number,
	mode: ScrambleMode,
	lineKey?: LineKey,
): void {
	if (state.completed) return;

	// Illuminate mode: debounce-based stable ripple for msg:, immediate for act:/aim:
	if (mode === 'illuminate') {
		if (!state.initialized) {
			state.lastText = newText;
			state.initialized = true;
			if (lineKey === 'msg') {
				state.displayedText = newText;
				state.lastFlushTime = now;
				state.lastTextChangeTime = now;
			} else {
				state.displayedText = newText;
				state.lastFlushTime = now;
				state.lastAnimTime = now;
			}
			return;
		}

		// msg: content — chunk-based ripple (plain while buffering, ripple on chunk threshold)
		if (lineKey === 'msg') {
			const textChanged = state.lastText !== newText;

			// Clean up expired ripples (keep within afterglow window)
			let keep = 0;
			for (let i = 0; i < state.ripples.length; i++) {
				if (now - state.ripples[i].time < state.ripples[i].dur + (state.ripples[i].contentChange ? ECHO_AFTERGLOW_MS : AFTERGLOW_MS)) {
					state.ripples[keep++] = state.ripples[i];
				}
			}
			state.ripples.length = keep;

			const hasActiveRipples = state.ripples.some(r => now - r.time < r.dur);
			const gap = now - state.lastTextChangeTime;

			if (textChanged) {
				const delta = Math.max(0, newText.length - state.lastText.length);
				state.lastText = newText;
				state.phraseBuffer = newText;
				state.lastTextChangeTime = now;
				state.charsSinceLastFlush += delta;
				// During active ripple, keep displayedText frozen (text being scrambled)
				// Between ripples, displayedText stays as last rippled text for chunk detection
			}

			// F1: accumulator — periodic ripples during dense streaming
			if ((state.ripples.length < 3 || state.charsSinceLastFlush >= 60) && state.charsSinceLastFlush >= 20 && newText !== state.displayedText) {
				state.displayedText = newText;
				state.lastFlushTime = now;
				state.lastAnimTime = now;
				state.charsSinceLastFlush = 0;
				state.ripples.push(...spawnIlluminateRippleForText(randomizedCenter(newText.length), now, ILLUMINATE_CONFIGS.msgContent, newText.length, undefined, true));
			} else if ((state.ripples.length < 3 || state.charsSinceLastFlush >= 60) && shouldFlushPhrase(newText, state.displayedText, state.lastFlushTime, now)) {
				state.displayedText = newText;
				state.lastFlushTime = now;
				state.lastAnimTime = now;
				state.charsSinceLastFlush = 0;
				state.ripples.push(...spawnIlluminateRippleForText(randomizedCenter(newText.length), now, ILLUMINATE_CONFIGS.msgContent, newText.length, undefined, true));
			} else if ((state.ripples.length < 3 || state.charsSinceLastFlush >= 60) && newText !== state.displayedText && now - state.lastTextChangeTime > MSG_CHUNK_DRAIN_MS) {
				// Drain: text stopped arriving and we have unrippled content —
				// ripple it out so it doesn't sit plain indefinitely.
				state.displayedText = newText;
				state.lastFlushTime = now;
				state.lastAnimTime = now;
				state.charsSinceLastFlush = 0;
				state.ripples.push(...spawnIlluminateRippleForText(randomizedCenter(newText.length), now, ILLUMINATE_CONFIGS.msgContent, newText.length, undefined, true));
			} else if ((state.ripples.length < 3 || state.charsSinceLastFlush >= 60) && newText !== state.displayedText && gap > STREAMING_RESUME_GAP_MS) {
				// Streaming resumed after a long pause (e.g., tool call) —
				// force a fresh ripple on the accumulated content.
				state.displayedText = newText;
				state.lastFlushTime = now;
				state.lastAnimTime = now;
				state.charsSinceLastFlush = 0;
				state.ripples.push(...spawnIlluminateRippleForText(randomizedCenter(newText.length), now, ILLUMINATE_CONFIGS.msgContent, newText.length, undefined, true));
			}
			return;
		}

		// act: and aim: — existing immediate update with config
		if (state.lastText === newText) {
			return;
		}
		const hadRipples = state.ripples.length > 0;
		const hadActiveRipplesBefore = state.ripples.some(r => now - r.time < r.dur);
		state.ripples = state.ripples.filter(r => now - r.time < r.dur + (r.contentChange ? ECHO_AFTERGLOW_MS : AFTERGLOW_MS));
		const justExpired = hadRipples && !hadActiveRipplesBefore;
		const hasActiveRipples = state.ripples.some(r => now - r.time < r.dur);
		if (hasActiveRipples) {
			state.lastText = newText;
			return;
		}
		const cooledDown = now - state.lastAnimTime >= MIN_RIPPLE_INTERVAL;
		if (!cooledDown && !justExpired) {
			state.lastText = newText;
			return;
		}
		state.displayedText = newText;
		state.lastText = newText;
		state.lastFlushTime = now;
		state.lastAnimTime = now;
		const config = lineKey === 'act' ? ILLUMINATE_CONFIGS.actLabel : undefined;
		if (config) {
			state.ripples.push(...spawnIlluminateRippleForText(randomizedCenter(newText.length), now, config, newText.length, undefined, false));
		} else {
			state.ripples.push(...spawnRippleForText(randomizedCenter(newText.length), now, newText.length, undefined, false));
		}
		let keep = 0;
		for (let i = 0; i < state.ripples.length; i++) {
			if (now - state.ripples[i].time < state.ripples[i].dur + (state.ripples[i].contentChange ? ECHO_AFTERGLOW_MS : AFTERGLOW_MS)) {
				state.ripples[keep++] = state.ripples[i];
			}
		}
		state.ripples.length = keep;
		return;
	}

	// Standard modes (stream/cascade/ripple)
	const textChanged = state.lastText !== newText;
	if (!state.initialized) {
		state.lastText = newText;
		state.initialized = true;
		state.lastAnimTime = now;
		if (mode === 'cascade') {
			state.queue = buildQueue('', newText);
			state.startTime = now;
			state.queueMaxEnd = state.queue.reduce((max, item) => Math.max(max, item.end), 0);
		} else if (mode === 'ripple') {
			state.ripples.push(...spawnRippleForText(randomizedCenter(newText.length), now, newText.length, undefined, lineKey === 'msg'));
		}
		return;
	}
	if (!textChanged) return;
	const oldText = state.lastText;
	// Detect tail-view slides: if old suffix matches new prefix significantly,
	// the visible window is just sliding — don't restart animation.
	const overlap = computeOverlapLen(oldText, newText);
	const minLen = Math.min(oldText.length, newText.length);
	const isExtension = newText.startsWith(oldText);
	if (!isExtension && overlap > 0 && overlap >= minLen * 0.5) {
		state.lastText = newText;
		state.displayedText = newText;
		return;
	}
	const cooledDown = now - state.lastAnimTime >= MIN_RIPPLE_INTERVAL;
	state.lastText = newText;
	if (cooledDown) {
		state.displayedText = newText;
		state.lastAnimTime = now;
		if (mode === 'cascade') {
			state.queue = buildQueue(oldText, newText);
			state.startTime = now;
			state.queueMaxEnd = state.queue.reduce((max, item) => Math.max(max, item.end), 0);
		} else {
			state.ripples.push(...spawnRippleForText(randomizedCenter(newText.length), now, newText.length, undefined, lineKey === 'msg'));
		}
	}
	if (mode === 'ripple') {
		let keep = 0;
		for (let i = 0; i < state.ripples.length; i++) {
			if (now - state.ripples[i].time < state.ripples[i].dur + (state.ripples[i].contentChange ? ECHO_AFTERGLOW_MS : AFTERGLOW_MS)) {
				state.ripples[keep++] = state.ripples[i];
			}
		}
		state.ripples.length = keep;
	}
}

// ---------------------------------------------------------------------------
// ScrambleStateManager
// ---------------------------------------------------------------------------

function createLineState(): LineState {
	return {
		lastText: '',
		queue: [],
		queueMaxEnd: 0,
		startTime: 0,
		ripples: [],
		lastAnimTime: 0,
		initialized: false,
		completed: false,
		phraseBuffer: '',
		displayedText: '',
		pendingText: '',
		lastFlushTime: 0,
		targetText: '',
		resolvedMask: new Set(),
		lastAccessTime: Date.now(),
		lastTextChangeTime: 0,
		lastRippleEndTime: 0,
		charsSinceLastFlush: 0,
	};
}

function createValueFlashState(): ValueFlashState {
	return { prev: '', ripples: [], queue: [], queueMaxEnd: 0, startTime: 0, lastValueChangeTime: 0, lastFlashTime: 0, completed: false, lastRippleEndTime: 0 };
}

function createTypewriterState(speed: number): TypewriterState {
	return {
		fullText: '',
		revealedCount: 0,
		lastRevealTime: 0,
		speed,
		scrambleWidth: STREAM_SCRAMBLE_WIDTH,
		completed: false,
		cursorChars: [],
		lastVisibleText: '',
	};
}

/**
 * Compute the longest suffix of `oldStr` that matches a prefix of `newStr`.
 * Used for tail-view window sliding: when the visible text shifts, we want
 * to know how many chars from the old view are still present at the start
 * of the new view so revealedCount can be adjusted smoothly.
 */
function computeOverlapLen(oldStr: string, newStr: string): number {
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
function isMinorStaticMutation(oldStr: string, newStr: string): boolean {
	const maxLen = Math.max(oldStr.length, newStr.length);
	if (maxLen === 0) return true;
	let same = 0;
	const minLen = Math.min(oldStr.length, newStr.length);
	for (let i = 0; i < minLen; i++) {
		if (oldStr[i] === newStr[i]) same++;
	}
	return same / maxLen >= 0.5;
}

const MAX_FLOW_ENTRIES = 128;
const MAX_CACHE_AGE_MS = 5 * 60 * 1000; // 5 minutes

export class ScrambleStateManager {
	private static readonly VALID_MODES: readonly ScrambleMode[] = ['stream', 'cascade', 'ripple', 'illuminate'];
	private mode: ScrambleMode = DEFAULT_MODE;
	private cache = new Map<string, Record<LineKey, LineState>>();
	private tpsState = new Map<string, ValueFlashState>();
	private actKpiState = new Map<string, ValueFlashState>();
	private msgKpiState = new Map<string, ValueFlashState>();
	private streamState = new Map<string, { msg: TypewriterState; act: TypewriterState }>();
	private genericCache = new Map<string, LineState>();
	private randomPool: string[] = [];
	private randomPoolIndex = 0;

	private fillRandomPool(): void {
		this.randomPool = new Array(RANDOM_POOL_SIZE);
		for (let i = 0; i < RANDOM_POOL_SIZE; i++) {
			this.randomPool[i] = SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
		}
		this.randomPoolIndex = 0;
	}

	private poolRandomChar(): string {
		if (this.randomPoolIndex >= this.randomPool.length - POOL_REFILL_THRESHOLD) {
			this.fillRandomPool();
		}
		return this.randomPool[this.randomPoolIndex++];
	}

	setMode(mode: ScrambleMode): void {
		if (!ScrambleStateManager.VALID_MODES.includes(mode)) {
			throw new Error(`Invalid scramble mode: ${mode}. Expected one of: ${ScrambleStateManager.VALID_MODES.join(', ')}`);
		}
		this.mode = mode;
		this.clear();
	}

	getMode(): ScrambleMode {
		return this.mode;
	}

	private getState(id: string, key: LineKey): LineState {
		let record = this.cache.get(id);
		if (!record) {
			record = { aim: createLineState(), act: createLineState(), msg: createLineState() };
			this.cache.set(id, record);
		}
		return record[key];
	}

	private getStreamState(id: string, key: 'msg' | 'act'): TypewriterState {
		let record = this.streamState.get(id);
		if (!record) {
			record = { msg: createTypewriterState(STREAM_SPEED_MSG), act: createTypewriterState(STREAM_SPEED_ACT) };
			this.streamState.set(id, record);
		}
		return record[key];
	}

	// -----------------------------------------------------------------------
	// Generic text animation (any key, any text)
	// -----------------------------------------------------------------------

	private getGenericState(id: string, key: string, now: number): LineState {
		const cacheKey = `${id}#${key}`;
		let state = this.genericCache.get(cacheKey);
		if (!state) {
			state = createLineState();
			this.genericCache.set(cacheKey, state);
		}
		state.lastAccessTime = now;
		return state;
	}

	updateText(id: string, key: string, text: string, now: number, isComplete: boolean = false, staticLine: boolean = false): ScrambleResult {
		if (isComplete) {
			const state = this.genericCache.get(`${id}#${key}`);
			if (!state) return { label: key, content: text, isAnimating: false };
		}
		const state = this.getGenericState(id, key, now);
		// Reset if a previously-completed flow is now running again
		if (!isComplete && state.completed) {
			state.completed = false;
			state.queue = [];
			state.ripples = [];
			state.lastText = '';
			state.initialized = false;
			state.phraseBuffer = '';
			state.displayedText = '';
			state.pendingText = '';
			state.lastFlushTime = 0;
			state.lastRippleEndTime = 0;
			state.charsSinceLastFlush = 0;
		}
		if (isComplete) {
			state.completed = true;
			state.queue = [];
			state.ripples = [];
		}
		if (state.completed) return { label: key, content: text, isAnimating: false };
		// Trigger initial reveal animation for static text (non-stream modes)
		if (!state.initialized && this.mode !== 'stream') {
			state.lastText = text;
			state.initialized = true;
			state.lastAnimTime = now;
			if (this.mode === 'cascade') {
				state.queue = buildQueue('', text);
				state.startTime = now;
				state.queueMaxEnd = state.queue.reduce((max, item) => Math.max(max, item.end), 0);
			} else if (this.mode === 'illuminate') {
				const updateConfig = key === 'result' ? ILLUMINATE_CONFIGS.msgContent : ILLUMINATE_CONFIGS.flowMeta;
				state.ripples.push(...spawnIlluminateRippleForText(randomizedCenter(text.length), now, updateConfig, text.length, undefined, true));
			} else {
				state.ripples.push(...spawnRippleForText(randomizedCenter(text.length), now, text.length, undefined, true));
			}
		} else if (staticLine && state.initialized) {
			const oldText = state.lastText;
			const textChanged = oldText !== text;
			state.lastText = text;
			if (this.mode === 'illuminate') {
				state.displayedText = text;
				state.pendingText = '';
			}
			if (textChanged) {
				if (isMinorStaticMutation(oldText, text)) {
					// minor mutation (e.g. trailing stat digit) — don't restart animation
				} else if (now - state.lastAnimTime >= MIN_RIPPLE_INTERVAL) {
					state.lastAnimTime = now;
					if (this.mode === 'cascade') {
						state.queue = buildQueue('', text);
						state.startTime = now;
						state.queueMaxEnd = state.queue.reduce((max, item) => Math.max(max, item.end), 0);
					} else if (this.mode === 'illuminate') {
						state.ripples = [];
						const updateConfig = key === 'result' ? ILLUMINATE_CONFIGS.msgContent : ILLUMINATE_CONFIGS.flowMeta;
						state.ripples.push(...spawnIlluminateRippleForText(randomizedCenter(text.length), now, updateConfig, text.length, undefined, true));
					} else {
						state.ripples = [];
						state.ripples.push(...spawnRippleForText(randomizedCenter(text.length), now, text.length, undefined, true));
					}
				}
			}
		} else {
			processLine(state, text, now, this.mode);
		}
		const content = applyScramble(text, state, now, this.mode, undefined, () => this.poolRandomChar());
		const isAnimating = this.isLineAnimating(state, now);
		return { label: key, content, isAnimating };
	}

	// -----------------------------------------------------------------------
	// aim: — cascade/ripple/illuminate on text change
	// -----------------------------------------------------------------------

	updateAim(id: string, text: string, now: number, isComplete: boolean = false, staticLine: boolean = false): ScrambleResult {
		if (isComplete) {
			const record = this.cache.get(id);
			if (!record) return { label: 'aim:', content: text, isAnimating: false };
		}
		const state = this.getState(id, 'aim');
		// Reset if a previously-completed flow is now running again (new flow started)
		if (!isComplete && state.completed) {
			state.completed = false;
			state.queue = [];
			state.ripples = [];
			state.lastText = '';
			state.initialized = false;
			state.phraseBuffer = '';
			state.displayedText = '';
			state.pendingText = '';
			state.lastFlushTime = 0;
			state.lastRippleEndTime = 0;
			state.charsSinceLastFlush = 0;
		}
		if (isComplete) {
			state.completed = true;
			state.queue = [];
			state.ripples = [];
		}
		if (state.completed) return { label: 'aim:', content: text, isAnimating: false };
		// Stream mode: aim is static text, no typewriter animation
		if (this.mode === 'stream') {
			return { label: 'aim:', content: text, isAnimating: false };
		}
		// Trigger initial reveal animation for aim on first call
		if (!state.initialized) {
			state.lastText = text;
			state.initialized = true;
			state.lastAnimTime = now;
			if (this.mode === 'cascade') {
				state.queue = buildQueue('', text);
				state.startTime = now;
				state.queueMaxEnd = state.queue.reduce((max, item) => Math.max(max, item.end), 0);
			} else if (this.mode === 'illuminate') {
				state.ripples.push(...spawnIlluminateRippleForText(randomizedCenter(text.length), now, ILLUMINATE_CONFIGS.aimLabel, text.length, undefined, false));
			} else {
				state.ripples.push(...spawnRippleForText(randomizedCenter(text.length), now, text.length, undefined, false));
			}
		} else if (staticLine && state.initialized) {
			const oldText = state.lastText;
			const textChanged = oldText !== text;
			state.lastText = text;
			if (this.mode === 'illuminate') {
				state.displayedText = text;
				state.pendingText = '';
			}
			if (textChanged) {
				if (isMinorStaticMutation(oldText, text)) {
					// minor mutation — don't restart animation
				} else if (now - state.lastAnimTime >= MIN_RIPPLE_INTERVAL) {
					state.lastAnimTime = now;
					if (this.mode === 'cascade') {
						state.queue = buildQueue('', text);
						state.startTime = now;
						state.queueMaxEnd = state.queue.reduce((max, item) => Math.max(max, item.end), 0);
					} else if (this.mode === 'illuminate') {
						state.ripples = [];
						state.ripples.push(...spawnIlluminateRippleForText(randomizedCenter(text.length), now, ILLUMINATE_CONFIGS.aimLabel, text.length, undefined, false));
					} else {
						state.ripples = [];
						state.ripples.push(...spawnRippleForText(randomizedCenter(text.length), now, text.length, undefined, false));
					}
				}
			} else if (!this.isLineAnimating(state, now)) {
				state.queue = [];
				state.ripples = [];
			}
		} else {
			processLine(state, text, now, this.mode);
		}
		const content = applyScramble(text, state, now, this.mode, undefined, () => this.poolRandomChar());
		const isAnimating = this.isLineAnimating(state, now);
		return { label: 'aim:', content, isAnimating };
	}

	// -----------------------------------------------------------------------
	// act: — stream/cascade/ripple on text change
	// -----------------------------------------------------------------------

	updateAct(id: string, text: string, now: number, isComplete: boolean = false, staticLine: boolean = false): ScrambleResult {
		if (isComplete) {
			const record = this.cache.get(id);
			if (!record) return { label: 'act:', content: text, isAnimating: false };
		}
		const state = this.getState(id, 'act');
		// Reset if a previously-completed flow is now running again (new flow started)
		if (!isComplete && state.completed) {
			state.completed = false;
			state.queue = [];
			state.ripples = [];
			state.lastText = '';
			state.initialized = false;
			state.phraseBuffer = '';
			state.displayedText = '';
			state.pendingText = '';
			state.lastFlushTime = 0;
			state.lastRippleEndTime = 0;
			state.charsSinceLastFlush = 0;
		}
		if (isComplete) {
			state.completed = true;
			state.queue = [];
			state.ripples = [];
		}
		if (state.completed) return { label: 'act:', content: text, isAnimating: false };
		if (!state.initialized) {
			state.lastText = text;
			state.initialized = true;
			state.lastAnimTime = now;
			if (this.mode === 'cascade') {
				state.queue = buildQueue('', text);
				state.startTime = now;
				state.queueMaxEnd = state.queue.reduce((max, item) => Math.max(max, item.end), 0);
			} else if (this.mode === 'illuminate') {
				state.ripples.push(...spawnIlluminateRippleForText(randomizedCenter(text.length), now, ILLUMINATE_CONFIGS.actLabel, text.length, undefined, false));
				state.displayedText = text;
			} else {
				state.ripples.push(...spawnRippleForText(randomizedCenter(text.length), now, text.length, undefined, false));
			}
		} else if (staticLine && state.initialized) {
			const oldText = state.lastText;
			const textChanged = oldText !== text;
			state.lastText = text;
			if (this.mode === 'illuminate') {
				state.displayedText = text;
				state.pendingText = '';
			}
			if (textChanged) {
				if (isMinorStaticMutation(oldText, text)) {
					// minor mutation — don't restart animation
				} else if (now - state.lastAnimTime >= MIN_RIPPLE_INTERVAL) {
					state.lastAnimTime = now;
					if (this.mode === 'cascade') {
						state.queue = buildQueue('', text);
						state.startTime = now;
						state.queueMaxEnd = state.queue.reduce((max, item) => Math.max(max, item.end), 0);
					} else if (this.mode === 'illuminate') {
						state.ripples = [];
						state.ripples.push(...spawnIlluminateRippleForText(randomizedCenter(text.length), now, ILLUMINATE_CONFIGS.actLabel, text.length, undefined, false));
					} else {
						state.ripples = [];
						state.ripples.push(...spawnRippleForText(randomizedCenter(text.length), now, text.length, undefined, false));
					}
				}
			} else if (!this.isLineAnimating(state, now)) {
				state.queue = [];
				state.ripples = [];
			}
		} else {
			processLine(state, text, now, this.mode, 'act');
		}
		const content = applyScramble(text, state, now, this.mode, 'act', () => this.poolRandomChar());
		const isAnimating = this.isLineAnimating(state, now);
		return { label: 'act:', content, isAnimating };
	}

	// -----------------------------------------------------------------------
	// msg: — stream/cascade/ripple on text change
	// -----------------------------------------------------------------------

	updateMsg(id: string, text: string, now: number, isComplete: boolean = false, budget?: number, staticLine: boolean = false): ScrambleResult {
		const visibleText = budget !== undefined ? tailText(text, budget) : text;

		if (isComplete) {
			const record = this.cache.get(id);
			if (!record) return { label: 'msg:', content: visibleText, isAnimating: false };
		}
		const state = this.getState(id, 'msg');
		// Reset if a previously-completed flow is now running again (new flow started)
		if (!isComplete && state.completed) {
			state.completed = false;
			state.queue = [];
			state.ripples = [];
			state.lastText = '';
			state.initialized = false;
			state.phraseBuffer = '';
			state.displayedText = '';
			state.pendingText = '';
			state.lastFlushTime = 0;
			state.lastRippleEndTime = 0;
		}
		if (isComplete) {
			state.completed = true;
			state.queue = [];
			state.ripples = [];
		}
		if (state.completed) return { label: 'msg:', content: visibleText, isAnimating: false };
		if (!state.initialized) {
			state.lastText = visibleText;
			state.initialized = true;
			state.lastFlushTime = now;
			if (this.mode === 'cascade') {
				state.displayedText = visibleText;
				state.phraseBuffer = visibleText;
				state.queue = buildQueue('', visibleText);
				state.startTime = now;
				state.queueMaxEnd = state.queue.reduce((max, item) => Math.max(max, item.end), 0);
				state.lastAnimTime = now;
			} else if (this.mode === 'illuminate') {
				state.displayedText = visibleText;
				state.phraseBuffer = visibleText;
				state.lastAnimTime = 0;
				state.lastTextChangeTime = now;
			} else {
				state.displayedText = visibleText;
				state.phraseBuffer = visibleText;
				state.ripples.push(...spawnRippleForText(randomizedCenter(visibleText.length), now, visibleText.length));
				state.lastAnimTime = now;
			}
		} else if (staticLine && state.initialized) {
			const oldText = state.lastText;
			const textChanged = oldText !== visibleText;

			if (this.mode === 'stream') {
				state.lastText = visibleText;
				// stream mode: text displays directly, no buffering needed
			} else if (this.mode === 'illuminate') {
				// Chunk-based ripple: plain text while buffering, ripple on chunk threshold
				// Clean up expired ripples
				state.ripples = state.ripples.filter(r => now - r.time < r.dur + (r.contentChange ? ECHO_AFTERGLOW_MS : AFTERGLOW_MS));
				state.queue = [];

				const hasActiveRipples = state.ripples.some(r => now - r.time < r.dur);
				const gap = now - state.lastTextChangeTime;

				if (textChanged) {
					const delta = Math.max(0, visibleText.length - state.lastText.length);
					state.lastText = visibleText;
					state.phraseBuffer = visibleText;
					state.lastTextChangeTime = now;
					state.charsSinceLastFlush += delta;
				}

				// F1: accumulator — periodic ripples during dense streaming
				if ((state.ripples.length < 3 || state.charsSinceLastFlush >= 60) && state.charsSinceLastFlush >= 20 && visibleText !== state.displayedText) {
					state.displayedText = visibleText;
					state.lastFlushTime = now;
					state.lastAnimTime = now;
					state.charsSinceLastFlush = 0;
					state.ripples.push(...spawnIlluminateRippleForText(randomSentenceStart(visibleText), now, ILLUMINATE_CONFIGS.msgContent, visibleText.length, undefined, true));
				} else if ((state.ripples.length < 3 || state.charsSinceLastFlush >= 60) && shouldFlushPhrase(visibleText, state.displayedText, state.lastFlushTime, now)) {
					state.displayedText = visibleText;
					state.lastFlushTime = now;
					state.lastAnimTime = now;
					state.charsSinceLastFlush = 0;
					state.ripples.push(...spawnIlluminateRippleForText(randomSentenceStart(visibleText), now, ILLUMINATE_CONFIGS.msgContent, visibleText.length, undefined, true));
				} else if ((state.ripples.length < 3 || state.charsSinceLastFlush >= 60) && visibleText !== state.displayedText && now - state.lastTextChangeTime > MSG_CHUNK_DRAIN_MS) {
					// Drain: text stopped arriving and we have unrippled content —
					// ripple it out so it doesn't sit plain indefinitely.
					state.displayedText = visibleText;
					state.lastFlushTime = now;
					state.lastAnimTime = now;
					state.charsSinceLastFlush = 0;
					state.ripples.push(...spawnIlluminateRippleForText(randomSentenceStart(visibleText), now, ILLUMINATE_CONFIGS.msgContent, visibleText.length, undefined, true));
				} else if ((state.ripples.length < 3 || state.charsSinceLastFlush >= 60) && visibleText !== state.displayedText && gap > STREAMING_RESUME_GAP_MS) {
					// Streaming resumed after a long pause (e.g., tool call) —
					// force a fresh ripple on the accumulated content.
					state.displayedText = visibleText;
					state.lastFlushTime = now;
					state.lastAnimTime = now;
					state.charsSinceLastFlush = 0;
					state.ripples.push(...spawnIlluminateRippleForText(randomSentenceStart(visibleText), now, ILLUMINATE_CONFIGS.msgContent, visibleText.length, undefined, true));
				}
			} else {
				// Existing behavior for cascade and ripple modes
				if (this.isLineAnimating(state, now)) {
					// Animation active — suppress ALL text changes.
					// Old text stays frozen on screen while the active ripple
					// plays to completion. No overlapping ripples.
				} else {
					// Animation NOT active — clean up expired ripples/queues
					// and handle text changes with cooldown check.
					const hadRipples = state.ripples.length > 0;
					const hadActiveRipplesBefore = state.ripples.some(r => now - r.time < r.dur);
					state.ripples = state.ripples.filter(r => now - r.time < r.dur + (r.contentChange ? ECHO_AFTERGLOW_MS : AFTERGLOW_MS));
					state.queue = [];
					const justExpired = hadRipples && !hadActiveRipplesBefore;

					if (!textChanged) {
						if (state.displayedText !== visibleText) {
							// Commit latest text without ripple
							state.displayedText = visibleText;
							state.lastText = visibleText;
							state.phraseBuffer = visibleText;
						}
						// If the last ripple just expired and text is stable,
						// start the cooldown from now for future changes.
						if (justExpired) {
							state.lastAnimTime = now;
						}
						// Fully stable — nothing to do
					} else if (justExpired || now - state.lastAnimTime >= MIN_RIPPLE_INTERVAL) {
						// Spawn ONE fresh ripple immediately if the old one just expired
						// (no overlap risk — previous ripple is fully gone) OR if cooled down.
						state.lastText = visibleText;
						state.displayedText = visibleText;
						state.lastAnimTime = now;
						state.phraseBuffer = visibleText;
						if (this.mode === 'cascade') {
							state.queue = buildQueue(oldText, visibleText);
							state.startTime = now;
							state.queueMaxEnd = state.queue.reduce((max, item) => Math.max(max, item.end), 0);
						} else {
							state.ripples.push(...spawnRippleForText(randomSentenceStart(visibleText), now, visibleText.length, undefined, true));
						}
					} else {
						// Not cooled down — track latest text but keep displayedText frozen
						// so any residual scramble from previous frames stays visible.
						state.lastText = visibleText;
						// DO NOT update displayedText or phraseBuffer — prevents plain-text flash
					}
				}
			}
		} else {
			processLine(state, visibleText, now, this.mode, 'msg');
		}
		const hasActiveRipple = this.isLineAnimating(state, now);
		// Always render visibleText — ripple wavefront scrambles whatever it hits,
		// and new content outside the wavefront shows as plain. state.displayedText
		// stays frozen for chunk-detection (shouldFlushPhrase), not for rendering.
		const displayText = visibleText;
		const content = applyScramble(displayText, state, now, this.mode, 'msg', () => this.poolRandomChar());
		const isAnimating = this.isLineAnimating(state, now);
		return { label: 'msg:', content, isAnimating };
	}

	// -----------------------------------------------------------------------
	// STREAM mode: typewriter progressive reveal
	// -----------------------------------------------------------------------

	/**
	 * Stream msg: text with typewriter reveal.
	 *
	 * Tail-view semantics: only the last `budget` chars are visible. As text
	 * grows the window slides. We track `revealedCount` relative to the
	 * CURRENT visible text so that previously-visible resolved chars stay
	 * resolved and only newly-entered chars are scrambled.
	 */
	streamMsg(id: string, fullText: string, now: number, isComplete: boolean, budget: number): string {
		if (isComplete) {
			const record = this.streamState.get(id);
			if (!record) {
				const cleanText = stripAnsi(fullText);
				return tailText(cleanText, budget);
			}
		}
		const state = this.getStreamState(id, 'msg');

		if (isComplete && !state.completed) {
			state.completed = true;
		}

		// Reset if a previously-completed flow is now running again (new flow started)
		if (!isComplete && state.completed) {
			state.completed = false;
			state.revealedCount = 0;
			state.lastRevealTime = 0;
			state.cursorChars = [];
			state.fullText = '';
			state.lastVisibleText = '';
		}

		// Strip ANSI for stable comparison
		const cleanText = stripAnsi(fullText);

		// Compute old and new visible windows (tail text)
		const oldVisibleText = state.lastVisibleText || '';
		const newVisibleText = tailText(cleanText, budget);

		if (oldVisibleText) {
			// Find how much of the old visible text is still at the start of
			// the new visible text. Chars that slid out of view reduce the
			// revealed count so the visible window doesn't flash to pure noise.
			// Only trust the overlap if the new text continues from the old;
			// otherwise it's a rewrite and we start from zero.
			let overlapLen = 0;
			if (state.fullText && cleanText.startsWith(state.fullText)) {
				overlapLen = computeOverlapLen(oldVisibleText, newVisibleText);
			} else if (oldVisibleText && newVisibleText) {
				// Non-extension (backtracking/rephrasing): preserve revealed count if visible window still overlaps significantly
				const candidateOverlap = computeOverlapLen(oldVisibleText, newVisibleText);
				const minVisibleLen = Math.min(oldVisibleText.length, newVisibleText.length);
				if (candidateOverlap >= minVisibleLen * 0.5) {
					overlapLen = candidateOverlap;
				}
			}
			const charsSlidOut = oldVisibleText.length - overlapLen;
			state.revealedCount = Math.max(0, state.revealedCount - charsSlidOut);
			if (charsSlidOut > 0) {
				// Reset scramble cursor when the visible window shifts so stale
				// scramble chars don't linger at wrong positions.
				state.cursorChars = [];
			}
		}

		state.fullText = cleanText;
		state.lastVisibleText = newVisibleText;

		// Advance cursor
		if (state.completed) {
			state.revealedCount = newVisibleText.length;
		} else if (state.lastRevealTime > 0) {
			const elapsed = Math.max(0, now - state.lastRevealTime);
			const charsToReveal = Math.floor(elapsed / state.speed);
			if (charsToReveal > 0) {
				state.revealedCount = Math.min(state.revealedCount + charsToReveal, newVisibleText.length);
				state.lastRevealTime += charsToReveal * state.speed;
			}
		} else {
			// First frame — start the clock
			state.lastRevealTime = now;
		}

		// All revealed
		if (state.revealedCount >= newVisibleText.length) {
			return newVisibleText;
		}

		return renderStreamText(newVisibleText, state.revealedCount, state.scrambleWidth, state.cursorChars);
	}

	/**
	 * Stream act: text with typewriter reveal.
	 * When tool call text changes, reset the buffer and reveal new text.
	 * Budget controls truncation (truncateChars, shows beginning).
	 */
	streamAct(id: string, fullText: string, now: number, isComplete: boolean, budget: number): string {
		if (isComplete) {
			const record = this.streamState.get(id);
			if (!record) {
				const cleanText = stripAnsi(fullText);
				return cleanText.length > budget ? cleanText.slice(0, budget) : cleanText;
			}
		}
		const state = this.getStreamState(id, 'act');

		if (isComplete && !state.completed) {
			state.completed = true;
		}

		// Reset if a previously-completed flow is now running again (new flow started)
		if (!isComplete && state.completed) {
			state.completed = false;
			state.revealedCount = 0;
			state.lastRevealTime = 0;
			state.cursorChars = [];
			state.fullText = '';
		}

		// Strip ANSI for stable comparison (formatFlowToolCall adds color codes)
		const cleanText = stripAnsi(fullText);

		// Detect tool call change — reset only when the tool name (first word) changes.
		// This avoids restarting the typewriter for minor arg changes of the same tool.
		if (state.fullText && cleanText !== state.fullText) {
			const oldTool = state.fullText.split(' ')[0];
			const newTool = cleanText.split(' ')[0];
			if (oldTool !== newTool) {
				state.fullText = cleanText;
				state.revealedCount = 0;
				state.lastRevealTime = now;
				state.cursorChars = [];
			} else {
				state.fullText = cleanText;
			}
		} else if (!state.fullText) {
			state.fullText = cleanText;
		}

		// Advance cursor
		if (state.completed) {
			state.revealedCount = state.fullText.length;
		} else if (state.lastRevealTime > 0) {
			const elapsed = Math.max(0, now - state.lastRevealTime);
			const charsToReveal = Math.floor(elapsed / state.speed);
			if (charsToReveal > 0) {
				state.revealedCount = Math.min(state.revealedCount + charsToReveal, state.fullText.length);
				state.lastRevealTime += charsToReveal * state.speed;
			}
		} else {
			state.lastRevealTime = now;
		}

		// All revealed
		if (state.revealedCount >= state.fullText.length) {
			return state.fullText.length > budget ? state.fullText.slice(0, budget) : state.fullText;
		}

		// Compute visible window (truncated, shows beginning for tool calls)
		const visibleText = state.fullText.length > budget ? state.fullText.slice(0, budget) : state.fullText;
		const visibleRevealed = Math.min(state.revealedCount, visibleText.length);

		if (visibleRevealed >= visibleText.length) {
			return visibleText;
		}

		return renderStreamText(visibleText, visibleRevealed, state.scrambleWidth, state.cursorChars);
	}

	// -----------------------------------------------------------------------
	// Value flash helpers (shared by TPS, act KPI, msg KPI)
	// -----------------------------------------------------------------------

	private _setupValueFlash(state: ValueFlashState, value: string, now: number): void {
		if (this.mode === 'cascade') {
			state.queue = buildQueue(state.prev, value, CASCADE_FLASH_MAX_START, CASCADE_FLASH_MAX_LENGTH);
			state.startTime = now;
			state.queueMaxEnd = state.queue.reduce((max, item) => Math.max(max, item.end), 0);
		} else if (this.mode === 'illuminate') {
			state.ripples = spawnTpsIlluminateRipples(randomizedCenter(value.length), now);
			state.startTime = now;
		} else {
			state.ripples = spawnTpsRipples(randomizedCenter(value.length), now);
		}
	}

	private _renderValueFlash(state: ValueFlashState, value: string, now: number): string {
		if (this.mode === 'cascade') {
			if (state.queue.length) {
				const frame = Math.max(0, Math.floor((now - state.startTime) / CASCADE_FRAME_MS));
				if (isCascadeComplete(state.queue, frame, state.queueMaxEnd)) {
					state.queue = [];
					state.startTime = now;
					return value;
				}
				return computeCascadeFrame(state.queue, frame, () => this.poolRandomChar());
			}
			return value;
		} else if (this.mode === 'illuminate') {
			if (state.ripples.some(r => now - r.time < r.dur + FLASH_AFTERGLOW_MS)) {
				return applyRipples(value, state.ripples, now, ILLUMINATE_CONFIGS.tps);
			}
			state.ripples = [];
			state.startTime = now;
			return value;
		} else {
			if (state.ripples.some(r => now - r.time < r.dur + FLASH_AFTERGLOW_MS)) {
				return applyRipples(value, state.ripples, now);
			}
			state.ripples = [];
			state.startTime = now;
			return value;
		}
	}

	private _updateValueKpi(
		map: Map<string, ValueFlashState>,
		id: string,
		value: string,
		now: number,
		isComplete: boolean,
		staticLine: boolean
	): ValueFlashState {
		if (isComplete) {
			const s = map.get(id);
			if (!s) {
				const newState = createValueFlashState();
				newState.completed = true;
				map.set(id, newState);
				return newState;
			}
			s.completed = true;
			s.queue = [];
			s.ripples = [];
			return s;
		}

		let state = map.get(id);
		const isFirstCall = !state;
		if (!state) {
			state = createValueFlashState();
			state.prev = value;
			state.lastValueChangeTime = now;
			map.set(id, state);
		}

		// Reset if a previously-completed flow is now running again
		if (!isComplete && state.completed) {
			state.completed = false;
			state.prev = '';
			state.queue = [];
			state.ripples = [];
			state.startTime = 0;
			state.lastRippleEndTime = 0;
			state.lastFlashTime = 0;
		}

		if (state.completed) return state;

		const cooldownElapsed = now - state.lastFlashTime >= TPS_FLASH_COOLDOWN_MS;

		if (state.prev !== value) {
			let shouldFlash = staticLine ? state.startTime === 0 : true;
			state.lastValueChangeTime = now;
			if (shouldFlash && cooldownElapsed) {
				this._setupValueFlash(state, value, now);
				state.lastFlashTime = now;
			} else if (this.mode === 'cascade') {
				state.queue = [];
			}
			state.prev = value;
		}

		if (isFirstCall && staticLine && state.startTime === 0 && cooldownElapsed) {
			this._setupValueFlash(state, value, now);
			state.lastFlashTime = now;
		}

		return state;
	}

	// -----------------------------------------------------------------------
	// TPS flash (cascade/ripple modes only)
	// -----------------------------------------------------------------------

	updateTps(id: string, tpsText: string, now: number, isComplete: boolean = false, staticLine: boolean = false): string {
		if (!tpsText || tpsText.trim() === '-') return tpsText;
		if (isComplete) {
			const s = this.tpsState.get(id);
			if (!s) return tpsText;
		}
		let state = this.tpsState.get(id);
		const isFirstCall = !state;
		if (!state) {
			state = createValueFlashState();
			state.prev = tpsText;
			state.lastValueChangeTime = now;
			this.tpsState.set(id, state);
		}
		// Reset if a previously-completed flow is now running again (new flow started)
		if (!isComplete && state.completed) {
			state.completed = false;
			state.prev = '';
			state.queue = [];
			state.ripples = [];
			state.startTime = 0;
			state.lastRippleEndTime = 0;
			state.lastFlashTime = 0;
		}
		if (isComplete) {
			state.completed = true;
			state.queue = [];
			state.ripples = [];
		}
		if (state.completed) return tpsText;
		const cooldownElapsed = now - state.lastFlashTime >= TPS_FLASH_COOLDOWN_MS;
		if (state.prev !== tpsText) {
			// Hysteresis: only flash on significant change or after settle time
			// Static line: only allow flash on the very first value change
			let shouldFlash = staticLine ? state.startTime === 0 : true;
			const prevVal = parseFloat(state.prev);
			const newVal = parseFloat(tpsText);
			if (!isNaN(prevVal) && !isNaN(newVal) && prevVal !== 0) {
				const deltaPct = Math.abs(newVal - prevVal) / prevVal;
				const timeSinceLastChange = state.lastValueChangeTime > 0 ? now - state.lastValueChangeTime : 0;
				shouldFlash = deltaPct > TPS_HYSTERESIS_PCT || timeSinceLastChange > TPS_HYSTERESIS_MS;
			}
			state.lastValueChangeTime = now;
			if (shouldFlash && cooldownElapsed) {
				this._setupValueFlash(state, tpsText, now);
				state.lastFlashTime = now;
			} else if (this.mode === 'cascade') {
				state.queue = []; // suppress old cascade when new value arrives without flash
			}
			state.prev = tpsText;
		}
		if (isFirstCall && staticLine && state.startTime === 0 && cooldownElapsed) {
			// Static line: trigger initial flash on first value even though prev was set
			this._setupValueFlash(state, tpsText, now);
			state.lastFlashTime = now;
		}
		return this._renderValueFlash(state, tpsText, now);
	}

	updateActKpi(id: string, value: string, now: number, isComplete: boolean = false, staticLine: boolean = false): string {
		const state = this._updateValueKpi(this.actKpiState, id, value, now, isComplete, staticLine);
		return this._renderValueFlash(state, value, now);
	}

	updateMsgKpi(id: string, value: string, now: number, isComplete: boolean = false, staticLine: boolean = false): string {
		const state = this._updateValueKpi(this.msgKpiState, id, value, now, isComplete, staticLine);
		return this._renderValueFlash(state, value, now);
	}

	// -----------------------------------------------------------------------
	// Animation status helpers
	// -----------------------------------------------------------------------

	private isLineAnimating(state: LineState, now: number): boolean {
		if (state.completed) return false;
		if (this.mode === 'cascade') {
			if (!state.queue.length) return false;
			const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
			return !isCascadeComplete(state.queue, frame, state.queueMaxEnd);
		} else {
			return state.ripples.some((rp) => rp.time + rp.dur + (rp.contentChange ? ECHO_AFTERGLOW_MS : AFTERGLOW_MS) > now);
		}
	}

	private isStreamAnimating(state: TypewriterState): boolean {
		if (state.completed) return false;
		const visibleText = state.lastVisibleText || state.fullText;
		return state.revealedCount < visibleText.length;
	}

	hasActiveAnimations(id: string, now: number): boolean {
		// Stream mode
		if (this.mode === 'stream') {
			const streamRecord = this.streamState.get(id);
			if (streamRecord) {
				if (this.isStreamAnimating(streamRecord.msg)) return true;
				if (this.isStreamAnimating(streamRecord.act)) return true;
			}
			return false;
		}
		// Cascade/ripple/illuminate
		const record = this.cache.get(id);
		if (record) {
			for (const key of ['aim', 'act', 'msg'] as LineKey[]) {
				if (this.isLineAnimating(record[key], now)) return true;
			}
		}
		// Generic cache entries for this id
		const prefix = `${id}#`;
		for (const [key, state] of this.genericCache) {
			if (key.startsWith(prefix) && this.isLineAnimating(state, now)) return true;
		}
		return false;
	}

	hasAnyActiveAnimations(now: number): boolean {
		// Stream mode
		if (this.mode === 'stream') {
			for (const record of this.streamState.values()) {
				if (this.isStreamAnimating(record.msg)) return true;
				if (this.isStreamAnimating(record.act)) return true;
			}
			return false;
		}
		// Cascade/ripple/illuminate
		for (const record of this.cache.values()) {
			for (const key of ['aim', 'act', 'msg'] as LineKey[]) {
				if (this.isLineAnimating(record[key], now)) return true;
			}
		}
		for (const state of this.tpsState.values()) {
			if (state.completed) continue;
			if (this.mode === 'cascade') {
				if (state.queue.length) {
					const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
					if (!isCascadeComplete(state.queue, frame, state.queueMaxEnd)) return true;
				}
			} else {
				if (state.ripples.some(r => r.time + r.dur + FLASH_AFTERGLOW_MS > now)) return true;
			}
		}
		for (const state of this.actKpiState.values()) {
			if (state.completed) continue;
			if (this.mode === 'cascade') {
				if (state.queue.length) {
					const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
					if (!isCascadeComplete(state.queue, frame, state.queueMaxEnd)) return true;
				}
			} else {
				if (state.ripples.some(r => r.time + r.dur + FLASH_AFTERGLOW_MS > now)) return true;
			}
		}
		for (const state of this.msgKpiState.values()) {
			if (state.completed) continue;
			if (this.mode === 'cascade') {
				if (state.queue.length) {
					const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
					if (!isCascadeComplete(state.queue, frame, state.queueMaxEnd)) return true;
				}
			} else {
				if (state.ripples.some(r => r.time + r.dur + FLASH_AFTERGLOW_MS > now)) return true;
			}
		}
		for (const state of this.genericCache.values()) {
			if (this.isLineAnimating(state, now)) return true;
		}
		return false;
	}

	clear(): void {
		this.cache.clear();
		this.tpsState.clear();
		this.actKpiState.clear();
		this.msgKpiState.clear();
		this.streamState.clear();
		this.genericCache.clear();
	}

	private sweepCompletedEntries(): void {
		if (this.cache.size <= MAX_FLOW_ENTRIES && this.streamState.size <= MAX_FLOW_ENTRIES && this.tpsState.size <= MAX_FLOW_ENTRIES && this.actKpiState.size <= MAX_FLOW_ENTRIES && this.msgKpiState.size <= MAX_FLOW_ENTRIES && this.genericCache.size <= MAX_FLOW_ENTRIES * 2) {
			return;
		}
		for (const [id, record] of this.cache) {
			if (record.aim.completed && record.act.completed && record.msg.completed) {
				this.cache.delete(id);
			}
		}
		for (const [id, state] of this.streamState) {
			if (state.msg.completed && state.act.completed) {
				this.streamState.delete(id);
			}
		}
		for (const [id, state] of this.tpsState) {
			if (state.completed) {
				this.tpsState.delete(id);
			}
		}
		for (const [id, state] of this.actKpiState) {
			if (state.completed) {
				this.actKpiState.delete(id);
			}
		}
		for (const [id, state] of this.msgKpiState) {
			if (state.completed) {
				this.msgKpiState.delete(id);
			}
		}
		for (const [key, state] of this.genericCache) {
			if (state.completed) {
				this.genericCache.delete(key);
			}
		}
		// Age-based eviction for orphaned never-completed generic entries
		const now = Date.now();
		for (const [key, state] of this.genericCache) {
			if (now - state.lastAccessTime > MAX_CACHE_AGE_MS) {
				this.genericCache.delete(key);
			}
		}
	}

	completeFlow(id: string): void {
		const record = this.cache.get(id);
		if (record) {
			for (const key of ['aim', 'act', 'msg'] as LineKey[]) {
				record[key].completed = true;
				record[key].queue = [];
				record[key].ripples = [];
				record[key].phraseBuffer = '';
				record[key].displayedText = '';
				record[key].pendingText = '';
				record[key].lastFlushTime = 0;
				record[key].lastRippleEndTime = 0;
			}
		}
		const tpsState = this.tpsState.get(id);
		if (tpsState) {
			tpsState.completed = true;
			tpsState.queue = [];
			tpsState.ripples = [];
			tpsState.lastRippleEndTime = 0;
		}
		const actKpiState = this.actKpiState.get(id);
		if (actKpiState) {
			actKpiState.completed = true;
			actKpiState.queue = [];
			actKpiState.ripples = [];
		}
		const msgKpiState = this.msgKpiState.get(id);
		if (msgKpiState) {
			msgKpiState.completed = true;
			msgKpiState.queue = [];
			msgKpiState.ripples = [];
		}
		const streamRecord = this.streamState.get(id);
		if (streamRecord) {
			streamRecord.msg.completed = true;
			streamRecord.msg.revealedCount = streamRecord.msg.lastVisibleText?.length ?? streamRecord.msg.fullText.length;
			streamRecord.act.completed = true;
			streamRecord.act.revealedCount = streamRecord.act.fullText.length;
		}
		// Mark generic entries for this id as completed
		const prefix = `${id}#`;
		for (const [key, state] of this.genericCache) {
			if (key.startsWith(prefix)) {
				state.completed = true;
				state.queue = [];
				state.ripples = [];
				state.lastRippleEndTime = 0;
			}
		}
		this.sweepCompletedEntries();
	}

	/** Legacy aliases */
	hasActiveRipples(id: string, now: number): boolean {
		return this.hasActiveAnimations(id, now);
	}

	hasAnyActiveRipples(now: number): boolean {
		return this.hasAnyActiveAnimations(now);
	}
}

/**
 * Shared animation timer — wired by any renderer that uses scrambleManager.
 * Uses chained setTimeout (not setInterval) to avoid TUI ghost frames.
 */
export function runScrambleTimer(args: Record<string, any> | undefined): void {
	if (args?.invalidate && args?.state) {
		const s = (args.state as any).__scramble = (args.state as any).__scramble || {};
		const now = Date.now();
		const hasActive = scrambleManager.hasAnyActiveAnimations(now);

		if (hasActive) {
			if (!s.animTimer) {
				const interval = CASCADE_FRAME_MS;
				s.animTimer = setTimeout(() => {
					s.animTimer = undefined;
					args.invalidate!();
				}, interval);
			}
		} else if (s.animTimer) {
			clearTimeout(s.animTimer);
			s.animTimer = undefined;
		}
	}
}

/** Module-level singleton for use across render calls. */
export const scrambleManager = new ScrambleStateManager();
