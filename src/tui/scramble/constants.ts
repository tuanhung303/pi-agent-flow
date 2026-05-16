// Auto-generated from src/tui/scramble.ts split
/**
 * Glitch-only text scramble effect for terminal TUI.
 *
 * Line behavior:
 *   aim: — content stays still, no animation ever
 *   act: — glitch on text change
 *   msg: — glitch on text change
 *   tps: — flash on value change
 */

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
/** Classic scramble set for fallback — balanced braille + sparkle mix */
export const SCRAMBLE_CHARS = '·∘∙~⋆˚｡+×◇°⠌⠡⠜⠣⠪⠹⠸⠷⠮⠯⠿⠾';
/** Sparkle and thin braille mix for afterglow "pop" */
export const SPARK_CHARS = '·∘∙⋆˚｡⠂⠄⠈⠐⠠⡀⢀⠃⠆⠉⠘⠰⡁⢂';
/** Backward-compat alias */
export const THIN_BRAILLE_SPARK = SPARK_CHARS;

export const DECORATIVE_ICON_RE = /[✔✅✖❌◐✓]/g;
export const DIM_ON = '\x1b[2m';
export const DIM_OFF = '\x1b[22m';

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

export const MIN_GLITCH_INTERVAL = 300;
export const GLITCH_RERANDOMIZE = 0.12;
export const GLITCH_FRAME_MS = 11;
export const GLITCH_MAX_START = 40;
export const GLITCH_MAX_LENGTH = 40;
export const GLITCH_SHORT_MAX_START = 10;
export const GLITCH_SHORT_MAX_LENGTH = 10;
export const GLITCH_FADE_OUT_FRAMES = 18;
export const GLITCH_COOLDOWN_MS = 1000;
export const MSG_GLITCH_MIN_DURATION_MS = 2000;
export const MSG_GLITCH_MIN_FRAMES = Math.ceil(MSG_GLITCH_MIN_DURATION_MS / GLITCH_FRAME_MS);

// TPS hysteresis
export const TPS_HYSTERESIS_PCT = 0.15;
export const TPS_HYSTERESIS_MS = 2000;
export const TPS_FLASH_COOLDOWN_MS = 3000;

// ---------------------------------------------------------------------------
// Types — shared
// ---------------------------------------------------------------------------

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
	displayedText: string;
	targetText: string;
	startTime: number;
	lastAnimTime: number;
	initialized: boolean;
	completed: boolean;
	lastAccessTime: number;
	glitchQueue: GlitchQueueItem[];
	glitchFrame: number;
	lastGlitchTime: number;
	pendingGlitch: GlitchQueueItem[] | null;
	pendingOldDisplayed: string;
	pendingNewDisplayed: string;
	pendingStartTime: number;
}

export type LineKey = 'aim' | 'act' | 'msg';

export interface ScrambleResult {
	label: string;
	content: string;
	isAnimating: boolean;
}

export interface ValueFlashState {
	prev: string;
	startTime: number;
	lastValueChangeTime: number;
	lastFlashTime: number;
	completed: boolean;
	glitchQueue: GlitchQueueItem[];
	glitchFrame: number;
	lastGlitchTime: number;
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

export const MAX_FLOW_ENTRIES = 128;
export const MAX_CACHE_AGE_MS = 5 * 60 * 1000; // 5 minutes
