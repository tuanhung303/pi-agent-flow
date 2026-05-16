// Auto-generated from src/tui/scramble.ts split
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


// ---------------------------------------------------------------------------
// Animation config
// ---------------------------------------------------------------------------

export interface AnimationConfig {
	enabled: boolean;
	glitch: boolean;
}

// ---------------------------------------------------------------------------
// Live text store — mutable source for DynamicScrambleText closures
// ---------------------------------------------------------------------------

const liveTextMap = new Map<string, string>();

export function setLiveText(key: string, text: string): void {
	liveTextMap.set(key, text);
}

export function getLiveText(key: string): string | undefined {
	return liveTextMap.get(key);
}

export function clearLiveText(key: string): void {
	liveTextMap.delete(key);
}

// ---------------------------------------------------------------------------
// Direct streaming text — no key lookup, no fallback chain
// ---------------------------------------------------------------------------

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

export const DEEP_GLITCH = '·∘∙*˚｡⠁⠂⠃⠄⠅⠆⠇⠈⠉⠊⠋⠌⠍⠎⠏⠐⠑⠒⠓';
/** Mid glitch: dots, light sparkles, medium braille for depth (3) */
export const MID_GLITCH = '·∘∙~⋆˚｡+×◇°⠁⠂⠃⠄⠅⠆⠇⠈⠉⠊⠋';
/** Shallow glitch: heavy sparkles + light braille for outer depths (4+) — the wavefront crest */
export const SHALLOW_GLITCH = '·∘∙~×°+⠌⠡⠜';
/** Classic scramble set for stream/cascade/ripple fallback — balanced braille + sparkle mix */
export const SCRAMBLE_CHARS = '·∘∙~⋆˚｡+×◇°⠌⠡⠜⠣⠪⠹⠸⠷⠮⠯⠿⠾';
/** Sparkle and thin braille mix for afterglow "pop" */
export const SPARK_CHARS = '·∘∙⋆˚｡⠂⠄⠈⠐⠠⡀⢀⠃⠆⠉⠘⠰⡁⢂';
/** Backward-compat alias */
export const THIN_BRAILLE_SPARK = SPARK_CHARS;

export const DECORATIVE_ICON_RE = /[✔✅✖❌◐✓]/g;
export const CYAN_GLOW = '\x1b[38;2;0;255;204m';
export const WARM_GLOW = '\x1b[38;2;255;140;120m';
export const PEACH_GLOW = '\x1b[38;2;255;160;140m';
export const ORANGE_GLOW = '\x1b[38;2;255;190;130m';
export const SKY_GLOW = '\x1b[38;2;80;170;255m';
export const WHITE_GLOW = '\x1b[38;2;255;255;255m';
export const RESET_COLOR = '\x1b[39m';
export const BOLD_ON = '\x1b[1m';
export const BOLD_OFF = '\x1b[22m';

export const DIM_ON = '\x1b[2m';
export const DIM_OFF = '\x1b[22m';

/** Illuminate close: resets foreground color only. No bg or bold/dim resets
 *  needed — bold is never applied, and enclosing dim context is preserved. */
export const ILLUMINATE_CLOSE = '\x1b[39m';

// ---------------------------------------------------------------------------
// Illuminate per-target effect configs
// ---------------------------------------------------------------------------

export interface IlluminateConfig {
	color: string;
	duration: number;
	spread: number;
	glowIntensity: 'high' | 'medium' | 'low' | 'variable';
	initialTimeOffset?: number;
	crestOnly?: boolean;
	spark?: boolean;
	scramble?: boolean; // default true; when false, keep original text during ripple (no garble)
}

export const ILLUMINATE_CONFIGS: Record<string, IlluminateConfig> = {
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

export const RIPPLE_DUR_DEFAULT = 520;
export const RIPPLE_SPREAD_DEFAULT = 1;
export const MIN_RIPPLE_INTERVAL = 300;
export const DEPTH_BAND_MAX = 7;
export const TPS_FLASH_DUR = 105;
export const TPS_FLASH_SPREAD = 0.5;
export const AFTERGLOW_MS = 420;
export const ECHO_AFTERGLOW_MS = 650;
export const FLASH_AFTERGLOW_MS = 137; // shorter afterglow for TPS/KPI value flashes
export const PULSE_WINDOW_MS = 600;
export const PULSE_CYCLE_MS = 998;
export const CASCADE_FRAME_MS = 11;
export const CASCADE_MAX_START = 28;
export const CASCADE_MAX_LENGTH = 28;
export const CASCADE_FLASH_MAX_START = 4;
export const CASCADE_FLASH_MAX_LENGTH = 6;

// Illuminate phrase buffering
export const MAX_PHRASE_BUFFER_TIME = 560;
export const MIN_PHRASE_LENGTH = 60;

// Drain timeout: partial chunk ripples when text stops changing for this long.
// Tokens arrive ~200ms apart at 196 TPS; 350ms is long enough to avoid firing
// during active streaming but short enough to feel responsive when tool calls pause.
export const MSG_CHUNK_DRAIN_MS = 120;

// Msg pulses should mark meaningful progress, not every streaming update.
// This is start-to-start; with the ~0.8s glitch duration it leaves about 2s quiet.
export const MSG_PULSE_COOLDOWN_MS = 2500;

// Resume gap: after a long pause (e.g. tool call), treat resumed chunks as a
// fresh stream and force a ripple effect.
export const STREAMING_RESUME_GAP_MS = 2000;

// TPS hysteresis
export const SECONDARY_RIPPLE_DELAY_MS = 84;
export const SECONDARY_RIPPLE_STRENGTH = 0.75;

// TPS hysteresis
export const TPS_HYSTERESIS_PCT = 0.15;
export const TPS_HYSTERESIS_MS = 2000;
export const TPS_FLASH_COOLDOWN_MS = 3000;

// Stream mode constants
export const STREAM_SPEED_MSG = 35;       // ms per char for msg: (~29 chars/sec)
export const STREAM_SPEED_ACT = 25;       // ms per char for act: (~40 chars/sec)
export const STREAM_SCRAMBLE_WIDTH = 5;   // scramble chars at cursor position
export const STREAM_RERANDOMIZE_RATE = 0.28; // 28% chance to re-randomize (CodePen style)
export const GLITCH_RERANDOMIZE = 0.12;
export const GLITCH_MAX_START = 40;
export const GLITCH_MAX_LENGTH = 40;
export const MSG_GLITCH_MIN_DURATION_MS = 2000;
export const MSG_GLITCH_MIN_FRAMES = Math.ceil(MSG_GLITCH_MIN_DURATION_MS / CASCADE_FRAME_MS);
export const GLITCH_SHORT_MAX_START = 10;
export const GLITCH_SHORT_MAX_LENGTH = 10;
export const GLITCH_COOLDOWN_MS = 1000;
export const GLITCH_FADE_OUT_FRAMES = 18;

// ---------------------------------------------------------------------------
// Easing and interpolation helpers
// ---------------------------------------------------------------------------

/** Ease-out cubic: organic deceleration for ripple expansion.
 *  Blended 70% ease-out + 30% linear for a snappier wavefront. */
export type ScrambleMode = 'stream' | 'cascade' | 'ripple' | 'illuminate';

export const DEFAULT_MODE: ScrambleMode = 'illuminate';

// ---------------------------------------------------------------------------
// Types — shared
// ---------------------------------------------------------------------------

export interface Ripple {
	pos: number;
	time: number;
	dur: number;
	spread: number;
	seed?: number;
	contentChange?: boolean;
}

export interface QueueItem {
	from: string;
	to: string;
	start: number;
	end: number;
	fadeOutEnd?: number;
	char?: string;
}

export interface GlitchQueueItem {
	from: string;
	to: string;
	start: number;
	end: number;
	fadeOutEnd?: number;
	settleEnd?: number;
	char: string | null;
}

export interface LineState {
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
	// Stable target for the active msg: glitch handoff.
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
	// Glitch effect queue (msg: in illuminate mode)
	glitchQueue: GlitchQueueItem[];
	glitchFrame: number;
	lastGlitchTime: number;
	// Pending glitch queue (queued while another glitch is active)
	pendingGlitch: GlitchQueueItem[] | null;
	pendingOldDisplayed: string;
	pendingNewDisplayed: string;
	pendingStartTime: number;
}

/** Phrase boundary detection for illuminate msg: streaming */
export type LineKey = 'aim' | 'act' | 'msg';

export interface ScrambleResult {
	label: string;
	content: string;
	isAnimating: boolean;
}

export interface ValueFlashState {
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
	// Glitch effect for value flashes (tps, actKpi, msgKpi)
	glitchQueue: GlitchQueueItem[];
	glitchFrame: number;
	lastGlitchTime: number;
}

// ---------------------------------------------------------------------------
// Types — stream mode
// ---------------------------------------------------------------------------

export interface TypewriterState {
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

export function randomChar(): string {
	return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
}

// ---------------------------------------------------------------------------
// Fast random char pool — pre-filled to reduce Math.random() calls ~80%
// ---------------------------------------------------------------------------

export const RANDOM_POOL_SIZE = 2048;
export const POOL_REFILL_THRESHOLD = 512; // refill when 25% remaining

let randomPool: string[] = [];
let randomPoolIndex = 0;

export function fillRandomPool(rng?: FastRNG): void {
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

export function poolRandomChar(): string {
	if (randomPoolIndex >= randomPool.length - POOL_REFILL_THRESHOLD) {
		fillRandomPool();
	}
	return randomPool[randomPoolIndex++];
}

// ---------------------------------------------------------------------------
// Pre-allocated segment buffer — reused across frames to reduce GC pressure
// ---------------------------------------------------------------------------

export let segmentBuffer: string[] = [];

export function getSegmentBuffer(minSize: number): string[] {
	if (segmentBuffer.length < minSize) {
		segmentBuffer = new Array(Math.max(minSize, 512));
	}
	return segmentBuffer;
}

// ---------------------------------------------------------------------------
// Pure algorithm: STREAM (typewriter progressive reveal)
export const MAX_FLOW_ENTRIES = 128;
export const MAX_CACHE_AGE_MS = 5 * 60 * 1000; // 5 minutes

