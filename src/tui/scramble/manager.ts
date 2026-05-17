// Auto-generated from src/tui/scramble.ts split
import { stripAnsi, tailText, truncateChars } from '../render-utils.js';
import type { Component } from '@mariozechner/pi-tui';
import { Text, truncateToWidth } from '@mariozechner/pi-tui';
import {
	AnimationConfig,
	ScrambleResult,
	LineState,
	LineKey,
	ValueFlashState,
	GLITCH_FRAME_MS,
	GLITCH_MAX_START,
	GLITCH_MAX_LENGTH,
	GLITCH_SHORT_MAX_START,
	GLITCH_SHORT_MAX_LENGTH,
	GLITCH_COOLDOWN_MS,
	MIN_GLITCH_INTERVAL,
	TPS_HYSTERESIS_PCT,
	TPS_HYSTERESIS_MS,
	TPS_FLASH_COOLDOWN_MS,
	setLiveText,
	clearLiveText,
	MAX_FLOW_ENTRIES,
	MAX_CACHE_AGE_MS,
	RANDOM_POOL_SIZE,
	SCRAMBLE_CHARS,
	POOL_REFILL_THRESHOLD,
} from './constants.js';
import {
	computeOverlapLen,
	isMinorStaticMutation,
	randomizedCenter,
} from './utils.js';
import {
	buildGlitchQueue,
	buildMsgGlitchQueue,
	computeGlitchFrame,
	applyScramble,
	isGlitchComplete,
} from './algorithm.js';

// ---------------------------------------------------------------------------
// processLine — unified change detection (glitch only)
// ---------------------------------------------------------------------------

function processLine(state: LineState, newText: string, now: number, lineKey?: LineKey, glitchEnabled: boolean = true): void {
	if (state.completed) return;
	if (!state.initialized) {
		state.lastText = newText;
		state.displayedText = newText;
		state.initialized = true;
		state.lastAnimTime = now;
		return;
	}
	const textChanged = state.lastText !== newText;
	if (!textChanged) return;

	const oldText = state.lastText;
	state.lastText = newText;

	const overlap = computeOverlapLen(oldText, newText);
	const minLen = Math.min(oldText.length, newText.length);
	const isExtension = newText.startsWith(oldText);
	if (!isExtension && overlap > 0 && overlap >= minLen * 0.5) {
		state.displayedText = newText;
		return;
	}

	const cooldownMs = lineKey === 'msg' ? GLITCH_COOLDOWN_MS : MIN_GLITCH_INTERVAL;
	const cooledDown = now - state.lastGlitchTime >= cooldownMs;
	if (!cooledDown) {
		if (lineKey !== 'msg') {
			state.displayedText = newText;
		}
		return;
	}

	const oldDisplayed = state.displayedText || oldText;
	if (lineKey === 'msg') {
		state.targetText = newText;
	} else {
		state.displayedText = newText;
	}
	state.lastAnimTime = now;

	if (glitchEnabled) {
		if (state.glitchQueue.length > 0) {
			const frame = Math.floor((now - state.startTime) / GLITCH_FRAME_MS);
			if (!isGlitchComplete(state.glitchQueue, frame)) {
				state.pendingGlitch = lineKey === 'msg'
					? buildMsgGlitchQueue(oldDisplayed, newText)
					: buildGlitchQueue(oldDisplayed, newText);
				state.pendingOldDisplayed = oldDisplayed;
				state.pendingNewDisplayed = newText;
				state.pendingStartTime = now;
				return;
			}
		}
		state.glitchQueue = lineKey === 'msg'
			? buildMsgGlitchQueue(oldDisplayed, newText)
			: buildGlitchQueue(oldDisplayed, newText);
		state.targetText = newText;
		state.startTime = now;
		state.glitchFrame = 0;
		state.lastGlitchTime = now;
	} else if (lineKey === 'msg') {
		state.displayedText = newText;
	}
}

// ---------------------------------------------------------------------------
// ScrambleStateManager
// ---------------------------------------------------------------------------

function createLineState(): LineState {
	return {
		lastText: '',
		displayedText: '',
		targetText: '',
		startTime: 0,
		lastAnimTime: 0,
		initialized: false,
		completed: false,
		lastAccessTime: Date.now(),
		glitchQueue: [],
		glitchFrame: 0,
		lastGlitchTime: Number.NEGATIVE_INFINITY,
		pendingGlitch: null,
		pendingOldDisplayed: '',
		pendingNewDisplayed: '',
		pendingStartTime: 0,
	};
}

function createValueFlashState(): ValueFlashState {
	return {
		prev: '',
		startTime: 0,
		lastValueChangeTime: 0,
		lastFlashTime: 0,
		completed: false,
		glitchQueue: [],
		glitchFrame: 0,
		lastGlitchTime: 0,
	};
}

export class ScrambleStateManager {
	private cache = new Map<string, Record<LineKey, LineState>>();
	private tpsState = new Map<string, ValueFlashState>();
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
		if (!isComplete && state.completed) {
			state.completed = false;
			state.lastText = '';
			state.displayedText = '';
			state.targetText = '';
			state.initialized = false;
			state.glitchQueue = [];
			state.glitchFrame = 0;
			state.pendingGlitch = null;
			state.pendingOldDisplayed = '';
			state.pendingNewDisplayed = '';
			state.pendingStartTime = 0;
		}
		if (isComplete) {
			state.completed = true;
			state.glitchQueue = [];
			state.glitchFrame = 0;
			state.pendingGlitch = null;
			state.pendingOldDisplayed = '';
			state.pendingNewDisplayed = '';
			state.pendingStartTime = 0;
		}
		if (state.completed) {
			if (state.glitchQueue.length > 0) {
				const frame = Math.floor((now - state.startTime) / GLITCH_FRAME_MS);
				if (!isGlitchComplete(state.glitchQueue, frame)) {
					const content = computeGlitchFrame(state.glitchQueue, frame, () => this.poolRandomChar(), text);
					return { label: key, content, isAnimating: true };
				}
				state.glitchQueue = [];
				state.glitchFrame = 0;
			}
			state.displayedText = text;
			state.lastText = text;
			return { label: key, content: text, isAnimating: false };
		}
		if (!state.initialized) {
			state.lastText = text;
			state.displayedText = text;
			state.initialized = true;
			state.lastAnimTime = now;
			if (this.animationConfig.glitch) {
				state.glitchQueue = buildGlitchQueue('', text);
				state.startTime = now;
				state.lastGlitchTime = now;
				state.glitchFrame = 0;
			}
		} else if (staticLine && state.initialized) {
			const oldText = state.lastText;
			const textChanged = oldText !== text;
			state.lastText = text;
			const oldDisplayed = state.displayedText || '';
			state.displayedText = text;
			if (textChanged) {
				if (isMinorStaticMutation(oldText, text)) {
					// minor mutation — don't restart animation
				} else if (now - state.lastAnimTime >= MIN_GLITCH_INTERVAL) {
					state.lastAnimTime = now;
					if (this.animationConfig.glitch) {
						const frame = Math.floor((now - state.startTime) / GLITCH_FRAME_MS);
						const glitchComplete = isGlitchComplete(state.glitchQueue, frame);
						if (glitchComplete) {
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
					}
				}
			} else if (!this.isLineAnimating(state, now)) {
				state.glitchQueue = [];
				state.glitchFrame = 0;
				state.pendingGlitch = null;
				state.pendingOldDisplayed = '';
				state.pendingNewDisplayed = '';
				state.pendingStartTime = 0;
			}
		} else {
			processLine(state, text, now, undefined, this.animationConfig.glitch);
		}
		const content = applyScramble(text, state, now, undefined, () => this.poolRandomChar(), this.animationConfig.glitch);
		const isAnimating = this.isLineAnimating(state, now);
		return { label: key, content, isAnimating };
	}

	updateAim(id: string, text: string, now: number, isComplete: boolean = false, staticLine: boolean = false): ScrambleResult {
		if (!this.animationConfig.enabled) {
			return { label: 'aim:', content: text, isAnimating: false };
		}
		if (isComplete) {
			const record = this.cache.get(id);
			if (!record) return { label: 'aim:', content: text, isAnimating: false };
		}
		const state = this.getState(id, 'aim');
		if (!isComplete && state.completed) {
			state.completed = false;
			state.lastText = '';
			state.displayedText = '';
			state.targetText = '';
			state.initialized = false;
			state.glitchQueue = [];
			state.glitchFrame = 0;
			state.pendingGlitch = null;
			state.pendingOldDisplayed = '';
			state.pendingNewDisplayed = '';
			state.pendingStartTime = 0;
		}
		if (isComplete) {
			state.completed = true;
			state.glitchQueue = [];
			state.glitchFrame = 0;
			state.pendingGlitch = null;
			state.pendingOldDisplayed = '';
			state.pendingNewDisplayed = '';
			state.pendingStartTime = 0;
		}
		if (state.completed) {
			if (state.glitchQueue.length > 0) {
				const frame = Math.floor((now - state.startTime) / GLITCH_FRAME_MS);
				if (!isGlitchComplete(state.glitchQueue, frame)) {
					const content = computeGlitchFrame(state.glitchQueue, frame, () => this.poolRandomChar(), text);
					return { label: 'aim:', content, isAnimating: true };
				}
				state.glitchQueue = [];
				state.glitchFrame = 0;
			}
			state.displayedText = text;
			state.lastText = text;
			return { label: 'aim:', content: text, isAnimating: false };
		}
		if (!state.initialized) {
			state.lastText = text;
			state.initialized = true;
			state.lastAnimTime = now;
			if (this.animationConfig.glitch) {
				state.glitchQueue = buildGlitchQueue('', text);
				state.startTime = now;
				state.lastGlitchTime = now;
				state.glitchFrame = 0;
			}
		} else if (staticLine && state.initialized) {
			const oldText = state.lastText;
			const textChanged = oldText !== text;
			state.lastText = text;
			const oldDisplayed = state.displayedText || '';
			state.displayedText = text;
			if (textChanged) {
				if (isMinorStaticMutation(oldText, text)) {
					// minor mutation — don't restart animation
				} else if (now - state.lastAnimTime >= MIN_GLITCH_INTERVAL) {
					state.lastAnimTime = now;
					if (this.animationConfig.glitch) {
						const frame = Math.floor((now - state.startTime) / GLITCH_FRAME_MS);
						const glitchComplete = isGlitchComplete(state.glitchQueue, frame);
						if (glitchComplete) {
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
					}
				}
			} else if (!this.isLineAnimating(state, now)) {
				state.glitchQueue = [];
				state.glitchFrame = 0;
				state.pendingGlitch = null;
				state.pendingOldDisplayed = '';
				state.pendingNewDisplayed = '';
				state.pendingStartTime = 0;
			}
		} else {
			processLine(state, text, now, undefined, this.animationConfig.glitch);
		}
		const content = applyScramble(text, state, now, undefined, () => this.poolRandomChar(), this.animationConfig.glitch);
		const isAnimating = this.isLineAnimating(state, now);
		return { label: 'aim:', content, isAnimating };
	}

	updateAct(id: string, text: string, now: number, isComplete: boolean = false, staticLine: boolean = false): ScrambleResult {
		if (!this.animationConfig.enabled) {
			return { label: 'act:', content: text, isAnimating: false };
		}
		if (isComplete) {
			const record = this.cache.get(id);
			if (!record) return { label: 'act:', content: text, isAnimating: false };
		}
		const state = this.getState(id, 'act');
		if (!isComplete && state.completed) {
			state.completed = false;
			state.lastText = '';
			state.displayedText = '';
			state.targetText = '';
			state.initialized = false;
			state.glitchQueue = [];
			state.glitchFrame = 0;
			state.pendingGlitch = null;
			state.pendingOldDisplayed = '';
			state.pendingNewDisplayed = '';
			state.pendingStartTime = 0;
		}
		if (isComplete) {
			state.completed = true;
			state.glitchQueue = [];
			state.glitchFrame = 0;
			state.pendingGlitch = null;
			state.pendingOldDisplayed = '';
			state.pendingNewDisplayed = '';
			state.pendingStartTime = 0;
		}
		if (state.completed) {
			if (state.glitchQueue.length > 0) {
				const frame = Math.floor((now - state.startTime) / GLITCH_FRAME_MS);
				if (!isGlitchComplete(state.glitchQueue, frame)) {
					const content = computeGlitchFrame(state.glitchQueue, frame, () => this.poolRandomChar(), text);
					return { label: 'act:', content, isAnimating: true };
				}
				state.glitchQueue = [];
				state.glitchFrame = 0;
			}
			state.displayedText = text;
			state.lastText = text;
			return { label: 'act:', content: text, isAnimating: false };
		}
		if (!state.initialized) {
			state.lastText = text;
			state.initialized = true;
			state.lastAnimTime = now;
			if (this.animationConfig.glitch) {
				state.glitchQueue = buildGlitchQueue('', text);
				state.startTime = now;
				state.lastGlitchTime = now;
				state.glitchFrame = 0;
			}
		} else if (staticLine && state.initialized) {
			const oldText = state.lastText;
			const textChanged = oldText !== text;
			state.lastText = text;
			const oldDisplayed = state.displayedText || '';
			state.displayedText = text;
			if (textChanged) {
				if (isMinorStaticMutation(oldText, text)) {
					// minor mutation — don't restart animation
				} else if (now - state.lastAnimTime >= MIN_GLITCH_INTERVAL) {
					state.lastAnimTime = now;
					if (this.animationConfig.glitch) {
						const frame = Math.floor((now - state.startTime) / GLITCH_FRAME_MS);
						const glitchComplete = isGlitchComplete(state.glitchQueue, frame);
						if (glitchComplete) {
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
					}
				}
			} else if (!this.isLineAnimating(state, now)) {
				state.glitchQueue = [];
				state.glitchFrame = 0;
				state.pendingGlitch = null;
				state.pendingOldDisplayed = '';
				state.pendingNewDisplayed = '';
				state.pendingStartTime = 0;
			}
		} else {
			processLine(state, text, now, 'act', this.animationConfig.glitch);
		}
		const content = applyScramble(text, state, now, 'act', () => this.poolRandomChar(), this.animationConfig.glitch);
		const isAnimating = this.isLineAnimating(state, now);
		return { label: 'act:', content, isAnimating };
	}

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
		if (!isComplete && state.completed) {
			state.completed = false;
			state.lastText = '';
			state.displayedText = '';
			state.targetText = '';
			state.initialized = false;
			state.glitchQueue = [];
			state.glitchFrame = 0;
			state.pendingGlitch = null;
			state.pendingOldDisplayed = '';
			state.pendingNewDisplayed = '';
			state.pendingStartTime = 0;
		}
		if (isComplete) {
			state.completed = true;
			state.glitchQueue = [];
			state.glitchFrame = 0;
			state.pendingGlitch = null;
			state.pendingOldDisplayed = '';
			state.pendingNewDisplayed = '';
			state.pendingStartTime = 0;
		}
		if (state.completed) {
			if (state.glitchQueue.length > 0) {
				const frame = Math.floor((now - state.startTime) / GLITCH_FRAME_MS);
				if (!isGlitchComplete(state.glitchQueue, frame)) {
					const content = computeGlitchFrame(state.glitchQueue, frame, () => this.poolRandomChar(), visibleText);
					return { label: 'msg:', content, isAnimating: true };
				}
				state.glitchQueue = [];
				state.glitchFrame = 0;
			}
			state.displayedText = visibleText;
			state.lastText = visibleText;
			return { label: 'msg:', content: visibleText, isAnimating: false };
		}
		if (!state.initialized) {
			state.lastText = visibleText;
			state.initialized = true;
			state.displayedText = visibleText;
			state.lastAnimTime = now;
			if (this.animationConfig.glitch) {
				state.glitchQueue = buildMsgGlitchQueue('', visibleText);
				state.targetText = visibleText;
				state.startTime = now;
				state.lastGlitchTime = now;
				state.glitchFrame = 0;
			}
		} else if (staticLine && state.initialized) {
			const oldText = state.lastText;
			const textChanged = oldText !== visibleText;
			state.lastText = visibleText;
			const oldDisplayed = state.displayedText || '';
			let willAnimate = false;
			if (textChanged) {
				if (isMinorStaticMutation(oldText, visibleText)) {
					// minor mutation — don't restart animation
				} else if (now - state.lastAnimTime >= MIN_GLITCH_INTERVAL) {
					state.lastAnimTime = now;
					if (this.animationConfig.glitch) {
						const frame = Math.floor((now - state.startTime) / GLITCH_FRAME_MS);
						const glitchComplete = isGlitchComplete(state.glitchQueue, frame);
						if (glitchComplete) {
							state.glitchQueue = buildMsgGlitchQueue(oldDisplayed, visibleText);
							state.targetText = visibleText;
							state.startTime = now;
							state.lastGlitchTime = now;
							state.glitchFrame = 0;
							willAnimate = true;
						} else if (state.glitchQueue.length > 0) {
							state.pendingGlitch = buildMsgGlitchQueue(oldDisplayed, visibleText);
							state.pendingOldDisplayed = oldDisplayed;
							state.pendingNewDisplayed = visibleText;
							state.pendingStartTime = now;
							willAnimate = true;
						}
					}
				}
			} else if (!this.isLineAnimating(state, now)) {
				state.glitchQueue = [];
				state.glitchFrame = 0;
				state.pendingGlitch = null;
				state.pendingOldDisplayed = '';
				state.pendingNewDisplayed = '';
				state.pendingStartTime = 0;
			}
			if (!willAnimate) {
				state.displayedText = visibleText;
			}
		} else {
			processLine(state, visibleText, now, 'msg', this.animationConfig.glitch);
		}
		let displayText: string;
		if (staticLine && state.glitchQueue.length > 0) {
			const frozenTarget = state.targetText || state.displayedText;
			displayText = visibleText.length > frozenTarget.length ? frozenTarget : visibleText;
		} else {
			const overlap = computeOverlapLen(state.displayedText, visibleText);
			const minDispLen = Math.min(state.displayedText.length, visibleText.length);
			const isTailSlide = overlap > 0 && overlap >= minDispLen * 0.5;
			const suppressTailSlide = staticLine && !isComplete && state.displayedText !== '' && state.displayedText !== visibleText && isTailSlide;
			displayText = suppressTailSlide ? state.displayedText : visibleText;
		}
		const content = applyScramble(displayText, state, now, 'msg', () => this.poolRandomChar(), this.animationConfig.glitch);
		const isAnimating = this.isLineAnimating(state, now);
		return { label: 'msg:', content, isAnimating };
	}

	// -----------------------------------------------------------------------
	// Value flash helpers (shared by TPS, act KPI, msg KPI)
	// -----------------------------------------------------------------------

	private _setupValueFlash(state: ValueFlashState, value: string, now: number): void {
		state.glitchQueue = buildGlitchQueue(state.prev, value, GLITCH_SHORT_MAX_START, GLITCH_SHORT_MAX_LENGTH);
		state.startTime = now;
		state.lastGlitchTime = now;
		state.glitchFrame = 0;
	}

	private _renderValueFlash(state: ValueFlashState, value: string, now: number): string {
		if (state.glitchQueue.length > 0) {
			const frame = Math.floor((now - state.startTime) / GLITCH_FRAME_MS);
			if (isGlitchComplete(state.glitchQueue, frame)) {
				state.glitchQueue = [];
				state.prev = value;
				return value;
			}
			return computeGlitchFrame(state.glitchQueue, frame, () => this.poolRandomChar(), value);
		}
		state.prev = value;
		return value;
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
			s.glitchQueue = [];
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

		if (!isComplete && state.completed) {
			state.completed = false;
			state.prev = '';
			state.glitchQueue = [];
			state.startTime = 0;
			state.lastGlitchTime = 0;
			state.lastFlashTime = 0;
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
	// TPS flash
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
		if (!isComplete && state.completed) {
			state.completed = false;
			state.prev = '';
			state.glitchQueue = [];
			state.startTime = 0;
			state.lastGlitchTime = 0;
			state.lastFlashTime = 0;
		}
		if (isComplete) {
			state.completed = true;
			state.glitchQueue = [];
		}
		if (state.completed) return tpsText;
		const cooldownElapsed = now - state.lastFlashTime >= TPS_FLASH_COOLDOWN_MS;
		if (state.prev !== tpsText) {
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
			}
			state.prev = tpsText;
		}
		if (isFirstCall && staticLine && state.startTime === 0 && cooldownElapsed) {
			this._setupValueFlash(state, tpsText, now);
			state.lastFlashTime = now;
		}
		return this._renderValueFlash(state, tpsText, now);
	}

	// -----------------------------------------------------------------------
	// Animation status helpers
	// -----------------------------------------------------------------------

	private isLineAnimating(state: LineState, now: number): boolean {
		if (state.completed) return false;
		if (state.glitchQueue.length > 0) {
			const frame = Math.floor((now - state.startTime) / GLITCH_FRAME_MS);
			if (!isGlitchComplete(state.glitchQueue, frame)) return true;
		}
		if (state.pendingGlitch && state.pendingGlitch.length > 0) return true;
		return false;
	}

	hasActiveAnimations(id: string, now: number): boolean {
		const prefix = `${id}#`;
		const record = this.cache.get(id);
		if (record) {
			for (const key of ['aim', 'act', 'msg'] as LineKey[]) {
				if (this.isLineAnimating(record[key], now)) return true;
			}
		}
		for (const [key, rec] of this.cache) {
			if (key.startsWith(prefix)) {
				for (const lineKey of ['aim', 'act', 'msg'] as LineKey[]) {
					if (this.isLineAnimating(rec[lineKey], now)) return true;
				}
			}
		}
		for (const [key, state] of this.genericCache) {
			if (key.startsWith(prefix) && this.isLineAnimating(state, now)) return true;
		}
		const checkValueState = (map: Map<string, ValueFlashState>): boolean => {
			const exact = map.get(id);
			if (exact && !exact.completed) {
				if (exact.glitchQueue.length > 0) {
					const frame = Math.floor((now - exact.startTime) / GLITCH_FRAME_MS);
					if (!isGlitchComplete(exact.glitchQueue, frame)) return true;
				}
			}
			for (const [key, state] of map) {
				if (key.startsWith(prefix) && !state.completed) {
					if (state.glitchQueue.length > 0) {
						const frame = Math.floor((now - state.startTime) / GLITCH_FRAME_MS);
						if (!isGlitchComplete(state.glitchQueue, frame)) return true;
					}
				}
			}
			return false;
		};
		if (checkValueState(this.tpsState)) return true;
		return false;
	}

	hasAnyActiveAnimations(now: number): boolean {
		for (const record of this.cache.values()) {
			for (const key of ['aim', 'act', 'msg'] as LineKey[]) {
				if (this.isLineAnimating(record[key], now)) return true;
			}
		}
		for (const state of this.tpsState.values()) {
			if (state.completed) continue;
			if (state.glitchQueue.length > 0) {
				const frame = Math.floor((now - state.startTime) / GLITCH_FRAME_MS);
				if (!isGlitchComplete(state.glitchQueue, frame)) return true;
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
		this.genericCache.clear();
	}

	private sweepCompletedEntries(): void {
		if (this.cache.size <= MAX_FLOW_ENTRIES && this.tpsState.size <= MAX_FLOW_ENTRIES && this.genericCache.size <= MAX_FLOW_ENTRIES * 2) {
			return;
		}
		for (const [id, record] of this.cache) {
			if (record.aim.completed && record.act.completed && record.msg.completed) {
				this.cache.delete(id);
			}
		}
		for (const [id, state] of this.tpsState) {
			if (state.completed) {
				this.tpsState.delete(id);
			}
		}
		for (const [key, state] of this.genericCache) {
			if (state.completed) {
				this.genericCache.delete(key);
			}
		}
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
				record[key].glitchQueue = [];
				record[key].glitchFrame = 0;
				record[key].pendingGlitch = null;
				record[key].pendingOldDisplayed = '';
				record[key].pendingNewDisplayed = '';
				record[key].pendingStartTime = 0;
				record[key].targetText = '';
			}
		}
		const tpsState = this.tpsState.get(id);
		if (tpsState) {
			tpsState.completed = true;
			tpsState.glitchQueue = [];
			tpsState.glitchFrame = 0;
		}
		const prefix = `${id}#`;
		for (const [key, state] of this.genericCache) {
			if (key.startsWith(prefix)) {
				state.completed = true;
				state.glitchQueue = [];
				state.glitchFrame = 0;
				state.pendingGlitch = null;
				state.pendingOldDisplayed = '';
				state.pendingNewDisplayed = '';
				state.pendingStartTime = 0;
				state.targetText = '';
			}
		}
		this.sweepCompletedEntries();
	}

	renderStatic(text: string): string {
		return text;
	}

}

// ---------------------------------------------------------------------------
// Shared animation timer
// ---------------------------------------------------------------------------

export function runScrambleTimer(args: Record<string, any> | undefined, id?: string): void {
	if (args?.invalidate && args?.state) {
		const s = (args.state as any).__scramble = (args.state as any).__scramble || {};
		const now = Date.now();
		const hasActive = id ? scrambleManager.hasActiveAnimations(id, now) : scrambleManager.hasAnyActiveAnimations(now);

		if (hasActive) {
			if (!s.animTimer) {
				s.animTimer = setTimeout(() => {
					s.animTimer = undefined;
					args.invalidate!();
				}, GLITCH_FRAME_MS);
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
		const safeContent = content.replace(/[\r\n\t]+/g, ' ');
		this.base.setText(this.truncated ? truncateToWidth(safeContent, width) : safeContent);
		return this.base.render(width);
	}
}

/** Standalone setter that transitions to the singleton manager. */
export function setAnimationConfig(config: AnimationConfig): void {
	scrambleManager.setAnimationConfig(config);
}

/** Module-level singleton for use across render calls. */
export const scrambleManager = new ScrambleStateManager();
