// Auto-generated from src/tui/scramble.ts split
import {
	QueueItem,
	GlitchQueueItem,
	LineState,
	LineKey,
	ScrambleMode,
	IlluminateConfig,
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
	GLITCH_RERANDOMIZE,
	MSG_GLITCH_MIN_FRAMES,
	STREAM_RERANDOMIZE_RATE,
	STREAM_SPEED_MSG,
	STREAM_SCRAMBLE_WIDTH,
	DIM_ON,
	DIM_OFF,
	MSG_CHUNK_DRAIN_MS,
	STREAMING_RESUME_GAP_MS,
	MIN_RIPPLE_INTERVAL,
	GLITCH_COOLDOWN_MS,
	MSG_PULSE_COOLDOWN_MS,
	TPS_FLASH_COOLDOWN_MS,
	AFTERGLOW_MS,
	ECHO_AFTERGLOW_MS,
	FLASH_AFTERGLOW_MS,
	poolRandomChar,
	getSegmentBuffer,
	DEFAULT_MODE,
	ILLUMINATE_CONFIGS,
} from './constants.js';
import {
	easeOutCubic,
	smoothstep,
	easeOutQuad,
	stripDecorativeIcons,
	hashNoise,
	computeOverlapLen,
	isMinorStaticMutation,
	randomizedCenter,
	findSentenceStarts,
	randomSentenceStart,
	makeAnimationSeed,
	selectSparkChar,
} from './utils.js';
import { FastRNG } from './constants.js';
import {
	applyRipples,
	computePulseIntensity,
} from './effects.js';
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
	const cleanOld = stripDecorativeIcons(oldText);
	const cleanNew = stripDecorativeIcons(newText);
	const length = Math.max(cleanOld.length, cleanNew.length);
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
		const fadeOutEnd = to === '' ? end + GLITCH_FADE_OUT_FRAMES : undefined;
		queue.push({ from, to, start, end, fadeOutEnd });
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
		const fadeOutEnd = item.fadeOutEnd;
		if (fadeOutEnd !== undefined && clampedFrame >= item.end && clampedFrame < fadeOutEnd) {
			if (!inDim) { result += DIM_ON; inDim = true; }
			result += getChar();
		} else if (clampedFrame >= (fadeOutEnd ?? item.end)) {
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

// ---------------------------------------------------------------------------
// Pure algorithm: GLITCH (TextScramble faithful port with Unicode braille)
// ---------------------------------------------------------------------------

export function buildGlitchQueue(oldText: string, newText: string, maxStart: number = GLITCH_MAX_START, maxLength: number = GLITCH_MAX_LENGTH): GlitchQueueItem[] {
	const queue: GlitchQueueItem[] = [];
	const cleanOld = stripDecorativeIcons(oldText);
	const cleanNew = stripDecorativeIcons(newText);
	const length = Math.max(cleanOld.length, cleanNew.length);
	for (let i = 0; i < length; i++) {
		const from = cleanOld[i] || '';
		const to = cleanNew[i] || '';
		const start = Math.floor(Math.random() * maxStart);
		const end = start + Math.floor(Math.random() * maxLength);
		const fadeOutEnd = to === '' ? end + GLITCH_FADE_OUT_FRAMES : undefined;
		queue.push({ from, to, start, end, fadeOutEnd, char: null });
	}
	// Task A: proportional fade-out timing based on deletion count
	let deletedCount = 0;
	for (const item of queue) {
		if (item.to === '' && item.from !== '') {
			deletedCount++;
		}
	}
	const bonusFrames = Math.min(8, Math.floor(deletedCount / 2));
	if (bonusFrames > 0) {
		for (const item of queue) {
			if (item.fadeOutEnd !== undefined) {
				item.fadeOutEnd += bonusFrames;
			}
		}
	}
	return queue;
}

export function buildMsgGlitchQueue(oldText: string, newText: string): GlitchQueueItem[] {
	const queue = buildGlitchQueue(oldText, newText);
	if (queue.length === 0) return queue;
	const maxEnd = queue.reduce((max, item) => Math.max(max, item.fadeOutEnd ?? item.end), 0);
	// Scale minimum with text length: short text resolves faster, long text keeps weight.
	const scaledMinFrames = Math.min(MSG_GLITCH_MIN_FRAMES, Math.max(55, Math.ceil(queue.length * 3.5)));
	const extension = scaledMinFrames - maxEnd;
	if (extension <= 0) {
		for (const item of queue) {
			if (item.to !== '') {
				item.settleEnd = item.end + 14 + Math.floor(Math.random() * 10);
			}
		}
		return queue;
	}
	for (const item of queue) {
		item.end += extension;
		if (item.fadeOutEnd !== undefined) {
			item.fadeOutEnd += extension;
		}
		if (item.to !== '') {
			item.settleEnd = item.end + 14 + Math.floor(Math.random() * 10);
		}
	}
	return queue;
}

export function computeGlitchFrame(
	queue: GlitchQueueItem[],
	frame: number,
	rng: () => string,
	currentText?: string,
	config?: IlluminateConfig,
	seed: number = 0,
): string {
	const cleanCurrent = currentText != null ? stripDecorativeIcons(currentText) : undefined;
	let output = '';
	let inDim = false;

	// Pre-compute sparkle indices for settle phase (2-3 chars per frame)
	const sparkleCount = 2 + Math.floor(hashNoise(seed, 0xBEEF, frame, 55) * 2);
	const sparkleIndices = new Set<number>();
	for (let s = 0; s < sparkleCount; s++) {
		const idx = Math.floor(hashNoise(seed, 0xCAFE + s, frame, 66) * queue.length);
		if (idx >= 0 && idx < queue.length) sparkleIndices.add(idx);
	}

	for (let i = 0; i < queue.length; i++) {
		const entry = queue[i];
		const fadeOutEnd = entry.fadeOutEnd;
		const settleEnd = entry.settleEnd;
		const resolvedChar = cleanCurrent?.[i] ?? entry.to;
		const isOrphan = cleanCurrent != null && i >= cleanCurrent.length;

		if (fadeOutEnd !== undefined && frame >= entry.end && frame < fadeOutEnd) {
			if (!inDim) { output += DIM_ON; inDim = true; }
			const rollFade = hashNoise(seed, i, frame, 77);
			if (!entry.char || rollFade < GLITCH_RERANDOMIZE) {
				entry.char = rng();
			}
			if (isOrphan) {
				// Task C: orphan dissolve in fade-out
				const fadeProgress = (frame - entry.end) / (fadeOutEnd - entry.end);
				if (fadeProgress < 0.5) {
					output += entry.char;
				} else {
					const dissolveThreshold = 1 - (fadeProgress - 0.5) * 2;
					if (hashNoise(seed, i, frame, 123) < dissolveThreshold) {
						output += entry.char;
					}
				}
			} else {
				output += entry.char;
			}
		} else if (settleEnd !== undefined && frame >= entry.end && frame < settleEnd) {
			if (inDim) { output += DIM_OFF; inDim = false; }
			if (isOrphan) {
				// Position beyond current text — skip
			} else {
				if (sparkleIndices.has(i)) {
					output += selectSparkChar(seed, i, frame);
				} else {
					output += resolvedChar;
				}
			}
		} else if (frame >= (settleEnd ?? fadeOutEnd ?? entry.end)) {
			if (inDim) { output += DIM_OFF; inDim = false; }
			if (isOrphan) {
				// Position beyond current text — character no longer visible (e.g. tail
				// truncation or text shrink), skip it rather than showing stale entry.to.
			} else {
				output += resolvedChar;
			}
		} else if (frame >= entry.start) {
			if (inDim) { output += DIM_OFF; inDim = false; }
			const rollScramble = hashNoise(seed, i, frame, 88);
			if (!entry.char || rollScramble < GLITCH_RERANDOMIZE) {
				entry.char = rng();
			}
			let outChar = entry.char;
			const window = entry.end - entry.start;
			// Task D: expand spark-in for new chars
			if (window > 0 && entry.from === '' && entry.to !== '' && frame < entry.start + window * 0.25) {
				outChar = selectSparkChar(seed, i, frame);
			} else if (window > 0 && entry.to !== '' && !isOrphan && frame >= entry.start + window * 0.6) {
				const t = (frame - (entry.start + window * 0.6)) / (window * 0.4);
				const peekEase = smoothstep(0, 1, t);
				const roll = hashNoise(seed, i, frame, 99);
				if (roll < peekEase) {
					outChar = resolvedChar;
				}
			}
			if (isOrphan) {
				// Task B: orphan scramble rendering
				if (!inDim) { output += DIM_ON; inDim = true; }
				output += outChar;
			} else {
				output += outChar;
			}
		} else {
			// Not started yet
			if (inDim) { output += DIM_OFF; inDim = false; }
			if (isOrphan) {
				// Position beyond current text — character being deleted, skip
			} else {
				output += cleanCurrent?.[i] ?? entry.from;
			}
		}
	}
	// Append any currentText characters beyond the queue length.
	// When streaming text grows after a glitch queue was built, new characters
	// beyond queue.length would be invisible without this append.
	if (cleanCurrent && cleanCurrent.length > queue.length) {
		if (inDim) { output += DIM_OFF; inDim = false; }
		output += cleanCurrent.slice(queue.length);
	}
	if (inDim) output += DIM_OFF;
	return output;
}

export function isGlitchComplete(queue: GlitchQueueItem[], frame: number): boolean {
	if (queue.length === 0) return true;
	return frame >= Math.max(...queue.map(e => e.settleEnd ?? e.fadeOutEnd ?? e.end));
}

function shouldStartGlitch(state: { lastGlitchTime: number; glitchQueue: unknown[] }, now: number, cooldownMs: number): boolean {
	if (state.glitchQueue.length > 0) return false; // already animating
	return now - state.lastGlitchTime >= cooldownMs;
}

export function isCascadeComplete(queue: QueueItem[], frame: number, maxEnd?: number): boolean {
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
export function applyScramble(text: string, state: LineState, now: number, mode: ScrambleMode, lineKey?: LineKey, rng?: () => string, glitchEnabled: boolean = true): string {
	if (mode === 'cascade') {
		if (!state.queue.length) return text;
		const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
		if (isCascadeComplete(state.queue, frame, state.queueMaxEnd)) {
			state.queue = [];
			return text;
		}
		return computeCascadeFrame(state.queue, frame, rng);
	} else if (mode === 'illuminate') {
		const config = lineKey === 'msg'
			? ILLUMINATE_CONFIGS.msgContent
			: lineKey === 'act'
				? ILLUMINATE_CONFIGS.actLabel
				: undefined;
		if (state.glitchQueue.length > 0 && glitchEnabled) {
			const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
			if (isGlitchComplete(state.glitchQueue, frame)) {
				state.glitchQueue = [];
				state.glitchFrame = 0;
				// Check for pending glitch
				if (state.pendingGlitch && state.pendingGlitch.length > 0) {
					state.glitchQueue = state.pendingGlitch;
					state.startTime = now;
					state.glitchFrame = 0;
					state.lastGlitchTime = now;
					state.targetText = state.pendingNewDisplayed;
					state.displayedText = text;
					// Preserve lastText — it holds the latest buffered text
					state.pendingGlitch = null;
					state.pendingOldDisplayed = '';
					state.pendingNewDisplayed = '';
					state.pendingStartTime = 0;
					const pendingText = lineKey === 'msg' ? state.targetText : text;
					return computeGlitchFrame(state.glitchQueue, 0, rng ?? poolRandomChar, pendingText, config);
				}
				// Sync displayedText to targetText (the resolved target), then check
				// if new text arrived during the glitch and start a fresh one.
				const resolvedTarget = state.targetText || text;
				const hasDiverged = state.lastText !== resolvedTarget;
				const enoughChars = state.charsSinceLastFlush >= 20;
				state.displayedText = resolvedTarget;
				state.targetText = '';
				state.charsSinceLastFlush = 0;
				if (hasDiverged && enoughChars) {
					state.glitchQueue = buildMsgGlitchQueue(resolvedTarget, state.lastText);
					state.targetText = state.lastText;
					state.startTime = now;
					state.glitchFrame = 0;
					state.lastGlitchTime = now;
					return computeGlitchFrame(state.glitchQueue, 0, rng ?? poolRandomChar, state.targetText, config);
				}
				return resolvedTarget;
			}
			const glitchText = lineKey === 'msg'
				? (state.targetText && state.targetText.length > text.length ? text : (state.targetText || text))
				: text;
			return computeGlitchFrame(state.glitchQueue, frame, rng ?? poolRandomChar, glitchText, config);
		}
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

