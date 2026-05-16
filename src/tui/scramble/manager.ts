// Auto-generated from src/tui/scramble.ts split
import type { UsageStats } from '../../types/flow.js';
import { stripAnsi, tailText, truncateChars } from '../render-utils.js';
import type { Component } from '@mariozechner/pi-tui';
import { Text, truncateToWidth } from '@mariozechner/pi-tui';
import {
	AnimationConfig,
	ScrambleMode,
	ScrambleResult,
	LineState,
	LineKey,
	ValueFlashState,
	TypewriterState,
	DEFAULT_MODE,
	ILLUMINATE_CONFIGS,
	CASCADE_FRAME_MS,
	CASCADE_MAX_START,
	CASCADE_MAX_LENGTH,
	CASCADE_FLASH_MAX_START,
	CASCADE_FLASH_MAX_LENGTH,
	GLITCH_FADE_OUT_FRAMES,
	GLITCH_MAX_START,
	GLITCH_MAX_LENGTH,
	GLITCH_SHORT_MAX_START,
	GLITCH_SHORT_MAX_LENGTH,
	GLITCH_COOLDOWN_MS,
	MIN_RIPPLE_INTERVAL,
	MSG_CHUNK_DRAIN_MS,
	STREAMING_RESUME_GAP_MS,
	MSG_PULSE_COOLDOWN_MS,
	TPS_FLASH_COOLDOWN_MS,
	TPS_HYSTERESIS_PCT,
	TPS_HYSTERESIS_MS,
	AFTERGLOW_MS,
	ECHO_AFTERGLOW_MS,
	FLASH_AFTERGLOW_MS,
	STREAM_SPEED_MSG,
	STREAM_SPEED_ACT,
	STREAM_SCRAMBLE_WIDTH,
	setLiveText,
	clearLiveText,
	MAX_FLOW_ENTRIES,
	MAX_CACHE_AGE_MS,
	RANDOM_POOL_SIZE,
	SCRAMBLE_CHARS,
	POOL_REFILL_THRESHOLD,
	DIM_ON,
	DIM_OFF,
} from './constants.js';
import {
	computeOverlapLen,
	isMinorStaticMutation,
	randomizedCenter,
	randomSentenceStart,
	findSentenceStarts,
	findPhraseBoundary,
	shouldFlushPhrase,
} from './utils.js';
import {
	applyRipples,
	computePulseIntensity,
	spawnRippleForText,
	spawnIlluminateRippleForText,
} from './effects.js';
import {
	renderStreamText,
	buildQueue,
	computeCascadeFrame,
	buildGlitchQueue,
	buildMsgGlitchQueue,
	computeGlitchFrame,
	applyScramble,
	isGlitchComplete,
	isCascadeComplete,
} from './algorithm.js';
function processLine(
	state: LineState,
	newText: string,
	now: number,
	mode: ScrambleMode,
	lineKey?: LineKey,
	glitchEnabled: boolean = true,
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
			const glitchCooledDown = now - state.lastGlitchTime >= GLITCH_COOLDOWN_MS;
			const previousText = state.lastText;
			const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
			const glitchComplete = isGlitchComplete(state.glitchQueue, frame);

			if (state.glitchQueue.length > 0 && glitchComplete) {
				if (!state.pendingGlitch) {
					state.glitchQueue = [];
					state.glitchFrame = 0;
					state.targetText = '';
					state.displayedText = newText;
					state.lastText = newText;
					state.charsSinceLastFlush = 0;
				} else {
					// Leave queue intact so applyScramble can hand off pendingGlitch
					const settledText = newText;
					state.displayedText = settledText;
					state.lastText = settledText;
					state.charsSinceLastFlush = 0;
				}
			}

			if (textChanged) {
				const isExtension = newText.startsWith(state.lastText);
				const delta = Math.max(0, newText.length - state.lastText.length);
				state.lastText = newText;
				state.phraseBuffer = newText;
				state.lastTextChangeTime = now;
				if (!isExtension) {
					state.charsSinceLastFlush = 0;
				}
				state.charsSinceLastFlush += delta;
			}

			// Sync displayedText when text is stable and no glitch is active
			if (!textChanged && state.displayedText !== newText && state.glitchQueue.length === 0 && !state.pendingGlitch) {
				state.displayedText = newText;
			}

			// F1: accumulator — periodic ripples during dense streaming
			if ((state.ripples.length < 6 || state.charsSinceLastFlush >= 80) && state.charsSinceLastFlush >= 20 && newText !== state.displayedText) {
				const oldDisplayed = state.displayedText || previousText;
				state.lastFlushTime = now;
				state.lastAnimTime = now;
				state.charsSinceLastFlush = 0;
				state.ripples = [];
				if (glitchEnabled) {
					if (glitchCooledDown && glitchComplete) {
						state.glitchQueue = buildMsgGlitchQueue(oldDisplayed, newText);
						state.startTime = now;
						state.glitchFrame = 0;
						state.lastGlitchTime = now;
					} else if (state.glitchQueue.length > 0) {
						// Queue pending glitch for when current one completes
						state.pendingGlitch = buildMsgGlitchQueue(oldDisplayed, newText);
						state.pendingOldDisplayed = oldDisplayed;
						state.pendingNewDisplayed = newText;
						state.pendingStartTime = now;
					}
				} else {
					state.displayedText = newText;
				}
			} else if ((state.ripples.length < 6 || state.charsSinceLastFlush >= 80) && shouldFlushPhrase(newText, state.displayedText, state.lastFlushTime, now)) {
				const oldDisplayed = state.displayedText || previousText;
				state.lastFlushTime = now;
				state.lastAnimTime = now;
				state.charsSinceLastFlush = 0;
				state.ripples = [];
				if (glitchEnabled) {
					if (glitchCooledDown && glitchComplete) {
						state.glitchQueue = buildMsgGlitchQueue(oldDisplayed, newText);
						state.startTime = now;
						state.glitchFrame = 0;
						state.lastGlitchTime = now;
					} else if (state.glitchQueue.length > 0) {
						// Queue pending glitch for when current one completes
						state.pendingGlitch = buildMsgGlitchQueue(oldDisplayed, newText);
						state.pendingOldDisplayed = oldDisplayed;
						state.pendingNewDisplayed = newText;
						state.pendingStartTime = now;
					}
				} else {
					state.displayedText = newText;
				}
			} else if ((state.ripples.length < 6 || state.charsSinceLastFlush >= 80) && newText !== state.displayedText && now - state.lastTextChangeTime > MSG_CHUNK_DRAIN_MS) {
				// Drain: text stopped arriving and we have unrippled content —
				// glitch it out so it doesn't sit plain indefinitely.
				const oldDisplayed = state.displayedText || previousText;
				state.lastFlushTime = now;
				state.lastAnimTime = now;
				state.charsSinceLastFlush = 0;
				state.ripples = [];
				if (glitchEnabled) {
					if (glitchCooledDown && glitchComplete) {
						state.glitchQueue = buildMsgGlitchQueue(oldDisplayed, newText);
						state.startTime = now;
						state.glitchFrame = 0;
						state.lastGlitchTime = now;
					} else if (state.glitchQueue.length > 0) {
						// Queue pending glitch for when current one completes
						state.pendingGlitch = buildMsgGlitchQueue(oldDisplayed, newText);
						state.pendingOldDisplayed = oldDisplayed;
						state.pendingNewDisplayed = newText;
						state.pendingStartTime = now;
					}
				} else {
					state.displayedText = newText;
				}
			} else if ((state.ripples.length < 6 || state.charsSinceLastFlush >= 80) && newText !== state.displayedText && gap > STREAMING_RESUME_GAP_MS) {
				// Streaming resumed after a long pause (e.g., tool call) —
				// force a fresh glitch on the accumulated content.
				const oldDisplayed = state.displayedText || previousText;
				state.lastFlushTime = now;
				state.lastAnimTime = now;
				state.charsSinceLastFlush = 0;
				state.ripples = [];
				if (glitchEnabled) {
					if (glitchCooledDown && glitchComplete) {
						state.glitchQueue = buildMsgGlitchQueue(oldDisplayed, newText);
						state.startTime = now;
						state.glitchFrame = 0;
						state.lastGlitchTime = now;
					} else if (state.glitchQueue.length > 0) {
						// Queue pending glitch for when current one completes
						state.pendingGlitch = buildMsgGlitchQueue(oldDisplayed, newText);
						state.pendingOldDisplayed = oldDisplayed;
						state.pendingNewDisplayed = newText;
						state.pendingStartTime = now;
					}
				} else {
					state.displayedText = newText;
				}
			}
			return;
		}

		// act: and aim: — glitch animation
		if (state.lastText === newText) {
			return;
		}
		// Clear completed glitch queue so we can start a new one
		if (state.glitchQueue.length > 0) {
			const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
			if (isGlitchComplete(state.glitchQueue, frame)) {
				state.glitchQueue = [];
				state.glitchFrame = 0;
				state.pendingGlitch = null;
				state.pendingOldDisplayed = '';
				state.pendingNewDisplayed = '';
				state.pendingStartTime = 0;
			}
		}
		if (state.glitchQueue.length > 0) {
			state.lastText = newText;
			return;
		}
		const hadRipples = state.ripples.length > 0;
		state.ripples = state.ripples.filter(r => now - r.time < r.dur + (r.contentChange ? ECHO_AFTERGLOW_MS : AFTERGLOW_MS));
		const cooledDown = now - state.lastAnimTime >= MIN_RIPPLE_INTERVAL;
		if (!cooledDown && !hadRipples) {
			state.lastText = newText;
			return;
		}
		const oldDisplayed = state.displayedText;
		state.displayedText = newText;
		state.lastText = newText;
		state.lastFlushTime = now;
		state.lastAnimTime = now;
		if (glitchEnabled) {
			state.glitchQueue = buildGlitchQueue(oldDisplayed || '', newText);
			state.startTime = now;
			state.glitchFrame = 0;
			state.lastGlitchTime = now;
		}
		state.ripples = [];
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
			state.queueMaxEnd = state.queue.reduce((max, item) => Math.max(max, item.fadeOutEnd ?? item.end), 0);
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
			state.queueMaxEnd = state.queue.reduce((max, item) => Math.max(max, item.fadeOutEnd ?? item.end), 0);
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
		glitchQueue: [],
		glitchFrame: 0,
		lastGlitchTime: 0,
		pendingGlitch: null,
		pendingOldDisplayed: '',
		pendingNewDisplayed: '',
		pendingStartTime: 0,
	};
}

function createValueFlashState(): ValueFlashState {
	return { prev: '', ripples: [], queue: [], queueMaxEnd: 0, startTime: 0, lastValueChangeTime: 0, lastFlashTime: 0, completed: false, lastRippleEndTime: 0, glitchQueue: [], glitchFrame: 0, lastGlitchTime: 0 };
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
	private animationConfig: AnimationConfig = { enabled: true, glitch: true };

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

	setAnimationConfig(config: AnimationConfig): void {
		this.animationConfig = config;
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
		if (!this.animationConfig.enabled) {
			return { label: key, content: text, isAnimating: false };
		}
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
			state.glitchQueue = [];
			state.glitchFrame = 0;
			state.pendingGlitch = null;
			state.pendingOldDisplayed = '';
			state.pendingNewDisplayed = '';
			state.pendingStartTime = 0;
			state.targetText = '';
		}
		if (isComplete) {
			state.completed = true;
			state.queue = [];
			state.ripples = [];
			state.pendingGlitch = null;
			state.pendingOldDisplayed = '';
			state.pendingNewDisplayed = '';
			state.pendingStartTime = 0;
			state.targetText = '';
		}
		if (state.completed) {
			if (this.mode === 'illuminate' && state.glitchQueue.length > 0) {
				const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
				if (!isGlitchComplete(state.glitchQueue, frame)) {
					const config = key === 'msg:' ? ILLUMINATE_CONFIGS.msgContent : key === 'act:' ? ILLUMINATE_CONFIGS.actLabel : undefined;
					const content = computeGlitchFrame(state.glitchQueue, frame, () => this.poolRandomChar(), text, config);
					return { label: key, content, isAnimating: true };
				}
				state.glitchQueue = [];
				state.glitchFrame = 0;
			}
			// FIX: Ensure displayedText is synced even in completed state
			state.displayedText = text;
			state.lastText = text;
			return { label: key, content: text, isAnimating: false };
		}
		// Trigger initial reveal animation for static text (non-stream modes)
		if (!state.initialized && this.mode !== 'stream') {
			state.lastText = text;
			state.initialized = true;
			state.lastAnimTime = now;
			if (this.mode === 'cascade') {
				state.queue = buildQueue('', text);
				state.startTime = now;
				state.queueMaxEnd = state.queue.reduce((max, item) => Math.max(max, item.fadeOutEnd ?? item.end), 0);
			} else if (this.mode === 'illuminate') {
				state.glitchQueue = buildGlitchQueue('', text);
				state.startTime = now;
				state.lastGlitchTime = now;
				state.glitchFrame = 0;
			} else {
				state.ripples.push(...spawnRippleForText(randomizedCenter(text.length), now, text.length, undefined, true));
			}
		} else if (staticLine && state.initialized) {
			const oldText = state.lastText;
			const textChanged = oldText !== text;
			state.lastText = text;
			let oldDisplayed = '';
			if (this.mode === 'illuminate') {
				oldDisplayed = state.displayedText || '';
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
						state.queueMaxEnd = state.queue.reduce((max, item) => Math.max(max, item.fadeOutEnd ?? item.end), 0);
					} else if (this.mode === 'illuminate') {
						if (this.animationConfig.glitch) {
							const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
							const glitchComplete = isGlitchComplete(state.glitchQueue, frame);
							if (glitchComplete) {
								state.ripples = [];
								state.glitchQueue = buildGlitchQueue(oldDisplayed, text);
								state.startTime = now;
								state.lastGlitchTime = now;
								state.glitchFrame = 0;
							} else if (state.glitchQueue.length > 0) {
								state.pendingGlitch = buildGlitchQueue(oldDisplayed, text);
								state.pendingOldDisplayed = oldDisplayed;
								state.pendingNewDisplayed = text;
								state.pendingStartTime = now;
							}
						} else {
							state.ripples = [];
							state.ripples.push(...spawnRippleForText(randomizedCenter(text.length), now, text.length, undefined, true));
						}
					} else {
						state.ripples = [];
						state.ripples.push(...spawnRippleForText(randomizedCenter(text.length), now, text.length, undefined, true));
					}
				}
			}
		} else {
			processLine(state, text, now, this.mode, undefined, this.animationConfig.glitch);
		}
		const content = applyScramble(text, state, now, this.mode, undefined, () => this.poolRandomChar(), this.animationConfig.glitch);
		const isAnimating = this.isLineAnimating(state, now);
		return { label: key, content, isAnimating };
	}

	// -----------------------------------------------------------------------
	// aim: — cascade/ripple/illuminate on text change
	// -----------------------------------------------------------------------

	updateAim(id: string, text: string, now: number, isComplete: boolean = false, staticLine: boolean = false): ScrambleResult {
		if (!this.animationConfig.enabled) {
			return { label: 'aim:', content: text, isAnimating: false };
		}
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
			state.glitchQueue = [];
			state.glitchFrame = 0;
			state.pendingGlitch = null;
			state.pendingOldDisplayed = '';
			state.pendingNewDisplayed = '';
			state.pendingStartTime = 0;
		}
		if (isComplete) {
			state.completed = true;
			state.queue = [];
			state.ripples = [];
			state.glitchQueue = [];
			state.glitchFrame = 0;
			state.pendingGlitch = null;
			state.pendingOldDisplayed = '';
			state.pendingNewDisplayed = '';
			state.pendingStartTime = 0;
		}
		if (state.completed) {
			if (this.mode === 'illuminate' && state.glitchQueue.length > 0) {
				const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
				if (!isGlitchComplete(state.glitchQueue, frame)) {
					const content = computeGlitchFrame(state.glitchQueue, frame, () => this.poolRandomChar(), text, undefined);
					return { label: 'aim:', content, isAnimating: true };
				}
				state.glitchQueue = [];
				state.glitchFrame = 0;
			}
			// FIX: Ensure displayedText is synced even in completed state
			state.displayedText = text;
			state.lastText = text;
			return { label: 'aim:', content: text, isAnimating: false };
		}
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
				state.queueMaxEnd = state.queue.reduce((max, item) => Math.max(max, item.fadeOutEnd ?? item.end), 0);
			} else if (this.mode === 'illuminate') {
				state.glitchQueue = buildGlitchQueue('', text);
				state.startTime = now;
				state.lastGlitchTime = now;
				state.glitchFrame = 0;
			} else {
				state.ripples.push(...spawnRippleForText(randomizedCenter(text.length), now, text.length, undefined, false));
			}
		} else if (staticLine && state.initialized) {
			const oldText = state.lastText;
			const textChanged = oldText !== text;
			state.lastText = text;
			let oldDisplayed = '';
			if (this.mode === 'illuminate') {
				oldDisplayed = state.displayedText || '';
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
						state.queueMaxEnd = state.queue.reduce((max, item) => Math.max(max, item.fadeOutEnd ?? item.end), 0);
					} else if (this.mode === 'illuminate') {
						if (this.animationConfig.glitch) {
							const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
							const glitchComplete = isGlitchComplete(state.glitchQueue, frame);
							if (glitchComplete) {
								state.ripples = [];
								state.glitchQueue = buildGlitchQueue(oldDisplayed, text);
								state.startTime = now;
								state.lastGlitchTime = now;
								state.glitchFrame = 0;
							} else if (state.glitchQueue.length > 0) {
								state.pendingGlitch = buildGlitchQueue(oldDisplayed, text);
								state.pendingOldDisplayed = oldDisplayed;
								state.pendingNewDisplayed = text;
								state.pendingStartTime = now;
							}
						} else {
							state.ripples = [];
							state.ripples.push(...spawnRippleForText(randomizedCenter(text.length), now, text.length, undefined, false));
						}
					} else {
						state.ripples = [];
						state.ripples.push(...spawnRippleForText(randomizedCenter(text.length), now, text.length, undefined, false));
					}
				}
			} else if (!this.isLineAnimating(state, now)) {
				state.queue = [];
				state.ripples = [];
				state.glitchQueue = [];
				state.glitchFrame = 0;
				state.pendingGlitch = null;
				state.pendingOldDisplayed = '';
				state.pendingNewDisplayed = '';
				state.pendingStartTime = 0;
			}
		} else {
			processLine(state, text, now, this.mode, undefined, this.animationConfig.glitch);
		}
		const content = applyScramble(text, state, now, this.mode, undefined, () => this.poolRandomChar(), this.animationConfig.glitch);
		const isAnimating = this.isLineAnimating(state, now);
		return { label: 'aim:', content, isAnimating };
	}

	// -----------------------------------------------------------------------
	// act: — stream/cascade/ripple on text change
	// -----------------------------------------------------------------------

	updateAct(id: string, text: string, now: number, isComplete: boolean = false, staticLine: boolean = false): ScrambleResult {
		if (!this.animationConfig.enabled) {
			return { label: 'act:', content: text, isAnimating: false };
		}
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
			state.glitchQueue = [];
			state.glitchFrame = 0;
			state.pendingGlitch = null;
			state.pendingOldDisplayed = '';
			state.pendingNewDisplayed = '';
			state.pendingStartTime = 0;
		}
		if (isComplete) {
			state.completed = true;
			state.queue = [];
			state.ripples = [];
			state.pendingGlitch = null;
			state.pendingOldDisplayed = '';
			state.pendingNewDisplayed = '';
			state.pendingStartTime = 0;
		}
		if (state.completed) {
			if (this.mode === 'illuminate' && state.glitchQueue.length > 0) {
				const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
				if (!isGlitchComplete(state.glitchQueue, frame)) {
					const content = computeGlitchFrame(state.glitchQueue, frame, () => this.poolRandomChar(), text, ILLUMINATE_CONFIGS.actLabel);
					return { label: 'act:', content, isAnimating: true };
				}
				state.glitchQueue = [];
				state.glitchFrame = 0;
			}
			// FIX: Ensure displayedText is synced even in completed state
			state.displayedText = text;
			state.lastText = text;
			return { label: 'act:', content: text, isAnimating: false };
		}
		if (!state.initialized) {
			state.lastText = text;
			state.initialized = true;
			state.lastAnimTime = now;
			if (this.mode === 'cascade') {
				state.queue = buildQueue('', text);
				state.startTime = now;
				state.queueMaxEnd = state.queue.reduce((max, item) => Math.max(max, item.fadeOutEnd ?? item.end), 0);
			} else if (this.mode === 'illuminate') {
				state.glitchQueue = buildGlitchQueue('', text);
				state.startTime = now;
				state.lastGlitchTime = now;
				state.glitchFrame = 0;
				state.displayedText = text;
			} else {
				state.ripples.push(...spawnRippleForText(randomizedCenter(text.length), now, text.length, undefined, false));
			}
		} else if (staticLine && state.initialized) {
			const oldText = state.lastText;
			const textChanged = oldText !== text;
			state.lastText = text;
			let oldDisplayed = '';
			if (this.mode === 'illuminate') {
				oldDisplayed = state.displayedText || '';
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
						state.queueMaxEnd = state.queue.reduce((max, item) => Math.max(max, item.fadeOutEnd ?? item.end), 0);
					} else if (this.mode === 'illuminate') {
						if (this.animationConfig.glitch) {
							const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
							const glitchComplete = isGlitchComplete(state.glitchQueue, frame);
							if (glitchComplete) {
								state.ripples = [];
								state.glitchQueue = buildGlitchQueue(oldDisplayed, text);
								state.startTime = now;
								state.lastGlitchTime = now;
								state.glitchFrame = 0;
							} else if (state.glitchQueue.length > 0) {
								state.pendingGlitch = buildGlitchQueue(oldDisplayed, text);
								state.pendingOldDisplayed = oldDisplayed;
								state.pendingNewDisplayed = text;
								state.pendingStartTime = now;
							}
						} else {
							state.ripples = [];
							state.ripples.push(...spawnRippleForText(randomizedCenter(text.length), now, text.length, undefined, false));
						}
					} else {
						state.ripples = [];
						state.ripples.push(...spawnRippleForText(randomizedCenter(text.length), now, text.length, undefined, false));
					}
				}
			} else if (!this.isLineAnimating(state, now)) {
				state.queue = [];
				state.ripples = [];
				state.glitchQueue = [];
				state.glitchFrame = 0;
				state.pendingGlitch = null;
				state.pendingOldDisplayed = '';
				state.pendingNewDisplayed = '';
				state.pendingStartTime = 0;
			}
		} else {
			processLine(state, text, now, this.mode, 'act', this.animationConfig.glitch);
		}
		const content = applyScramble(text, state, now, this.mode, 'act', () => this.poolRandomChar(), this.animationConfig.glitch);
		const isAnimating = this.isLineAnimating(state, now);
		return { label: 'act:', content, isAnimating };
	}

	// -----------------------------------------------------------------------
	// msg: — stream/cascade/ripple on text change
	// -----------------------------------------------------------------------

	updateMsg(id: string, text: string, now: number, isComplete: boolean = false, budget?: number, staticLine: boolean = false): ScrambleResult {
		const visibleText = budget !== undefined ? tailText(text, budget) : text;

		if (!this.animationConfig.enabled) {
			return { label: 'msg:', content: visibleText, isAnimating: false };
		}
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
			state.glitchQueue = [];
			state.glitchFrame = 0;
			state.pendingGlitch = null;
			state.pendingOldDisplayed = '';
			state.pendingNewDisplayed = '';
			state.pendingStartTime = 0;
		}
		if (isComplete) {
			state.completed = true;
			state.queue = [];
			state.ripples = [];
			state.pendingGlitch = null;
			state.pendingOldDisplayed = '';
			state.pendingNewDisplayed = '';
			state.pendingStartTime = 0;
		}
		if (state.completed) {
			if (this.mode === 'illuminate' && state.glitchQueue.length > 0) {
				const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
				if (!isGlitchComplete(state.glitchQueue, frame)) {
					const content = computeGlitchFrame(state.glitchQueue, frame, () => this.poolRandomChar(), visibleText, ILLUMINATE_CONFIGS.msgContent);
					return { label: 'msg:', content, isAnimating: true };
				}
				state.glitchQueue = [];
				state.glitchFrame = 0;
			}
			// FIX: Ensure displayedText is synced even in completed state
			state.displayedText = visibleText;
			state.lastText = visibleText;
			return { label: 'msg:', content: visibleText, isAnimating: false };
		}
		if (!state.initialized) {
			state.lastText = visibleText;
			state.initialized = true;
			state.lastFlushTime = now;
			if (this.mode === 'cascade') {
				state.displayedText = visibleText;
				state.phraseBuffer = visibleText;
				state.queue = buildQueue('', visibleText);
				state.startTime = now;
				state.queueMaxEnd = state.queue.reduce((max, item) => Math.max(max, item.fadeOutEnd ?? item.end), 0);
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
				// Chunk-based glitch: keep text readable, then hand off one chunk at a time.
				// Clean up expired ripples
				state.ripples = state.ripples.filter(r => now - r.time < r.dur + (r.contentChange ? ECHO_AFTERGLOW_MS : AFTERGLOW_MS));
				state.queue = [];

				const gap = now - state.lastTextChangeTime;
				const glitchCooledDown = now - state.lastGlitchTime >= GLITCH_COOLDOWN_MS;
				const previousText = state.lastText;
				const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
				const glitchComplete = isGlitchComplete(state.glitchQueue, frame);

				if (state.glitchQueue.length > 0 && glitchComplete) {
					if (!state.pendingGlitch) {
						const resolvedTarget = state.targetText;
						const hasDiverged = state.lastText !== resolvedTarget;
						const enoughChars = state.charsSinceLastFlush >= 20;
						state.displayedText = resolvedTarget;
						state.targetText = '';
						state.glitchQueue = [];
						state.glitchFrame = 0;
						state.charsSinceLastFlush = 0;
						if (this.animationConfig.glitch && hasDiverged && enoughChars) {
							state.glitchQueue = buildMsgGlitchQueue(resolvedTarget, state.lastText);
							state.targetText = state.lastText;
							state.startTime = now;
							state.glitchFrame = 0;
							state.lastGlitchTime = now;
						}
					} else {
						// Leave queue intact for applyScramble pending handoff
						state.displayedText = state.targetText;
						state.charsSinceLastFlush = 0;
					}
				}

				if (textChanged) {
					const isExtension = visibleText.startsWith(state.lastText);
					const delta = Math.max(0, visibleText.length - state.lastText.length);
					state.lastText = visibleText;
					state.phraseBuffer = visibleText;
					state.lastTextChangeTime = now;
					if (!isExtension) {
						state.charsSinceLastFlush = 0;
					}
					state.charsSinceLastFlush += delta;
				}

				// Sync displayedText when text is stable and no glitch is active
				if (!textChanged && state.displayedText !== visibleText && state.glitchQueue.length === 0 && !state.pendingGlitch) {
					state.displayedText = visibleText;
				}

				const canStartPulse = state.lastGlitchTime === 0 || now - state.lastGlitchTime >= MSG_PULSE_COOLDOWN_MS;
				const startOrQueueMsgGlitch = (oldDisplayed: string): void => {
					state.lastFlushTime = now;
					state.lastAnimTime = now;
					state.charsSinceLastFlush = 0;
					state.ripples = [];
					if (this.animationConfig.glitch) {
						if (glitchCooledDown && glitchComplete) {
							state.glitchQueue = buildMsgGlitchQueue(oldDisplayed, visibleText);
							state.targetText = visibleText;
							state.startTime = now;
							state.glitchFrame = 0;
							state.lastGlitchTime = now;
						} else if (state.glitchQueue.length > 0) {
							state.pendingGlitch = buildMsgGlitchQueue(oldDisplayed, visibleText);
							state.pendingOldDisplayed = oldDisplayed;
							state.pendingNewDisplayed = visibleText;
							state.pendingStartTime = now;
						}
					} else {
						state.displayedText = visibleText;
						state.ripples.push(...spawnRippleForText(randomizedCenter(visibleText.length), now, visibleText.length, undefined, true));
					}
				};

				// Start one controlled msg handoff only when enough new text has accumulated.
				if (canStartPulse && (state.ripples.length < 6 || state.charsSinceLastFlush >= 80) && state.charsSinceLastFlush >= 20 && visibleText !== state.displayedText) {
					startOrQueueMsgGlitch(state.displayedText || previousText);
				} else if (canStartPulse && (state.ripples.length < 6 || state.charsSinceLastFlush >= 80) && shouldFlushPhrase(visibleText, state.displayedText, state.lastFlushTime, now)) {
					startOrQueueMsgGlitch(state.displayedText || previousText);
				} else if (canStartPulse && (state.ripples.length < 6 || state.charsSinceLastFlush >= 80) && visibleText !== state.displayedText && now - state.lastTextChangeTime > MSG_CHUNK_DRAIN_MS) {
					startOrQueueMsgGlitch(state.displayedText || previousText);
				} else if (canStartPulse && (state.ripples.length < 6 || state.charsSinceLastFlush >= 80) && visibleText !== state.displayedText && gap > STREAMING_RESUME_GAP_MS) {
					startOrQueueMsgGlitch(state.displayedText || previousText);
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
					state.glitchQueue = [];
					state.glitchFrame = 0;
					state.pendingGlitch = null;
					state.pendingOldDisplayed = '';
					state.pendingNewDisplayed = '';
					state.pendingStartTime = 0;
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
							state.queueMaxEnd = state.queue.reduce((max, item) => Math.max(max, item.fadeOutEnd ?? item.end), 0);
						} else {
							state.ripples.push(...spawnRippleForText(randomSentenceStart(visibleText), now, visibleText.length, undefined, true));
						}
					} else {
						// Not cooled down — track latest text but keep displayedText frozen
						// so any residual scramble from previous frames stays visible.
						state.lastText = visibleText;
						state.displayedText = visibleText;
					}
				}
			}
		} else {
			processLine(state, visibleText, now, this.mode, 'msg', this.animationConfig.glitch);
		}
		let displayText: string;
		if (this.mode === 'illuminate' && staticLine && state.glitchQueue.length > 0) {
			// Freeze displayed text during active msg glitch so streaming
			// changes don't leak through the animation. Only freeze when visible
			// text has grown beyond the snapshot; if it shrunk (truncation),
			// respect the shorter visible text.
			const frozenTarget = state.targetText || state.displayedText;
			displayText = visibleText.length > frozenTarget.length ? frozenTarget : visibleText;
		} else {
			// Only suppress tail-window slides (high overlap), not meaningful text changes.
			const overlap = computeOverlapLen(state.displayedText, visibleText);
			const minDispLen = Math.min(state.displayedText.length, visibleText.length);
			const isTailSlide = overlap > 0 && overlap >= minDispLen * 0.5;
			const suppressTailSlide = this.mode === 'illuminate' && staticLine && !isComplete && state.displayedText !== '' && state.displayedText !== visibleText && isTailSlide;
			displayText = suppressTailSlide ? state.displayedText : visibleText;
		}
		const content = applyScramble(displayText, state, now, this.mode, 'msg', () => this.poolRandomChar(), this.animationConfig.glitch);
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
		if (!this.animationConfig.enabled) {
			const cleanText = stripAnsi(fullText);
			return tailText(cleanText, budget);
		}
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
		if (!this.animationConfig.enabled) {
			const cleanText = stripAnsi(fullText);
			return cleanText.length > budget ? cleanText.slice(0, budget) : cleanText;
		}
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
			state.queueMaxEnd = state.queue.reduce((max, item) => Math.max(max, item.fadeOutEnd ?? item.end), 0);
		} else {
			state.glitchQueue = buildGlitchQueue(state.prev, value, GLITCH_SHORT_MAX_START, GLITCH_SHORT_MAX_LENGTH);
			state.startTime = now;
			state.lastGlitchTime = now;
			state.glitchFrame = 0;
			state.ripples = [];
			state.queue = [];
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
		} else {
			if (state.glitchQueue.length > 0) {
				const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
				if (isGlitchComplete(state.glitchQueue, frame)) {
					state.glitchQueue = [];
					state.prev = value;
					return value;
				}
				return computeGlitchFrame(state.glitchQueue, frame, () => this.poolRandomChar(), value, undefined);
			}
			state.prev = value;
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
			state.glitchQueue = [];
			state.glitchFrame = 0;
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
		if (!this.animationConfig.enabled) return tpsText;
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
		if (!this.animationConfig.enabled) return value;
		const state = this._updateValueKpi(this.actKpiState, id, value, now, isComplete, staticLine);
		return this._renderValueFlash(state, value, now);
	}

	updateMsgKpi(id: string, value: string, now: number, isComplete: boolean = false, staticLine: boolean = false): string {
		if (!this.animationConfig.enabled) return value;
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
			if (state.glitchQueue.length > 0) {
				const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
				return !isGlitchComplete(state.glitchQueue, frame);
			}
			if (state.pendingGlitch && state.pendingGlitch.length > 0) return true;
			return state.ripples.some((rp) => rp.time + rp.dur + (rp.contentChange ? ECHO_AFTERGLOW_MS : AFTERGLOW_MS) > now);
		}
	}

	private isStreamAnimating(state: TypewriterState): boolean {
		if (state.completed) return false;
		const visibleText = state.lastVisibleText || state.fullText;
		return state.revealedCount < visibleText.length;
	}

	hasActiveAnimations(id: string, now: number): boolean {
		const prefix = `${id}#`;
		// Stream mode
		if (this.mode === 'stream') {
			const exact = this.streamState.get(id);
			if (exact) {
				if (this.isStreamAnimating(exact.msg)) return true;
				if (this.isStreamAnimating(exact.act)) return true;
			}
			for (const [key, record] of this.streamState) {
				if (key.startsWith(prefix)) {
					if (this.isStreamAnimating(record.msg)) return true;
					if (this.isStreamAnimating(record.act)) return true;
				}
			}
			return false;
		}
		// Cascade/ripple/illuminate — exact match
		const record = this.cache.get(id);
		if (record) {
			for (const key of ['aim', 'act', 'msg'] as LineKey[]) {
				if (this.isLineAnimating(record[key], now)) return true;
			}
		}
		// Prefix match for sub-flows (multi#0, panel#1, etc.)
		for (const [key, rec] of this.cache) {
			if (key.startsWith(prefix)) {
				for (const lineKey of ['aim', 'act', 'msg'] as LineKey[]) {
					if (this.isLineAnimating(rec[lineKey], now)) return true;
				}
			}
		}
		// Generic cache entries for this id
		for (const [key, state] of this.genericCache) {
			if (key.startsWith(prefix) && this.isLineAnimating(state, now)) return true;
		}
		// Value flash states — exact + prefix
		const checkValueState = (map: Map<string, ValueFlashState>): boolean => {
			const exact = map.get(id);
			if (exact && !exact.completed) {
				if (this.mode === 'cascade') {
					if (exact.queue.length) {
						const frame = Math.floor((now - exact.startTime) / CASCADE_FRAME_MS);
						if (!isCascadeComplete(exact.queue, frame, exact.queueMaxEnd)) return true;
					}
				} else {
					if (exact.glitchQueue.length > 0) {
						const frame = Math.floor((now - exact.startTime) / CASCADE_FRAME_MS);
						if (!isGlitchComplete(exact.glitchQueue, frame)) return true;
					}
				}
			}
			for (const [key, state] of map) {
				if (key.startsWith(prefix) && !state.completed) {
					if (this.mode === 'cascade') {
						if (state.queue.length) {
							const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
							if (!isCascadeComplete(state.queue, frame, state.queueMaxEnd)) return true;
						}
					} else {
						if (state.glitchQueue.length > 0) {
							const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
							if (!isGlitchComplete(state.glitchQueue, frame)) return true;
						}
					}
				}
			}
			return false;
		};
		if (checkValueState(this.tpsState)) return true;
		if (checkValueState(this.actKpiState)) return true;
		if (checkValueState(this.msgKpiState)) return true;
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
				if (state.glitchQueue.length > 0) {
					const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
					if (!isGlitchComplete(state.glitchQueue, frame)) return true;
				}
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
				if (state.glitchQueue.length > 0) {
					const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
					if (!isGlitchComplete(state.glitchQueue, frame)) return true;
				}
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
				if (state.glitchQueue.length > 0) {
					const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
					if (!isGlitchComplete(state.glitchQueue, frame)) return true;
				}
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
		clearLiveText(id);
		const record = this.cache.get(id);
		if (record) {
			for (const key of ['aim', 'act', 'msg'] as LineKey[]) {
				record[key].completed = true;
				record[key].queue = [];
				record[key].ripples = [];
				record[key].lastRippleEndTime = 0;
				record[key].pendingGlitch = null;
				record[key].pendingOldDisplayed = '';
				record[key].pendingNewDisplayed = '';
				record[key].pendingStartTime = 0;
				record[key].glitchQueue = [];
				record[key].glitchFrame = 0;
				record[key].targetText = '';
			}
		}
		const tpsState = this.tpsState.get(id);
		if (tpsState) {
			tpsState.completed = true;
			tpsState.queue = [];
			tpsState.ripples = [];
			tpsState.lastRippleEndTime = 0;
			tpsState.glitchQueue = [];
			tpsState.glitchFrame = 0;
		}
		const actKpiState = this.actKpiState.get(id);
		if (actKpiState) {
			actKpiState.completed = true;
			actKpiState.queue = [];
			actKpiState.ripples = [];
			actKpiState.glitchQueue = [];
			actKpiState.glitchFrame = 0;
		}
		const msgKpiState = this.msgKpiState.get(id);
		if (msgKpiState) {
			msgKpiState.completed = true;
			msgKpiState.queue = [];
			msgKpiState.ripples = [];
			msgKpiState.glitchQueue = [];
			msgKpiState.glitchFrame = 0;
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
				state.pendingGlitch = null;
				state.pendingOldDisplayed = '';
				state.pendingNewDisplayed = '';
				state.pendingStartTime = 0;
				state.lastRippleEndTime = 0;
				state.glitchQueue = [];
				state.glitchFrame = 0;
				state.targetText = '';
			}
		}
		this.sweepCompletedEntries();
	}

	renderStatic(text: string): string {
		if (this.mode !== 'illuminate' || !text) return text;
		return DIM_ON + text + DIM_OFF;
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
export function runScrambleTimer(args: Record<string, any> | undefined, id?: string): void {
	if (args?.invalidate && args?.state) {
		const s = (args.state as any).__scramble = (args.state as any).__scramble || {};
		const now = Date.now();
		const hasActive = id ? scrambleManager.hasActiveAnimations(id, now) : scrambleManager.hasAnyActiveAnimations(now);

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

// ---------------------------------------------------------------------------
// DynamicScrambleText — TUI component that recomputes scramble on re-render
// ---------------------------------------------------------------------------

export class DynamicScrambleText implements Component {
	private base: Text;
	constructor(
		initialContent: string,
		private getScrambleContent: () => string,
		private truncated: boolean = false,
	) {
		this.base = new Text(initialContent, 0, 0);
	}
	invalidate(): void { this.base.invalidate(); }
	render(width: number): string[] {
		const content = this.getScrambleContent();
		// Replace newlines/tabs with spaces to keep animation on a stable single line
		const safeContent = content.replace(/[\r\n\t]+/g, ' ');
		// truncateToWidth is a safety net only. Renderers are responsible for
		// computing column budgets and truncating text before passing it here.
		this.base.setText(this.truncated ? truncateToWidth(safeContent, width) : safeContent);
		return this.base.render(width);
	}
}

/** Standalone setter that delegates to the singleton manager. */
export function setAnimationConfig(config: AnimationConfig): void {
	scrambleManager.setAnimationConfig(config);
}

/** Module-level singleton for use across render calls. */
export const scrambleManager = new ScrambleStateManager();
