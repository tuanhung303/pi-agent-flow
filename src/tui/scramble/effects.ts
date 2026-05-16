// Auto-generated from src/tui/scramble.ts split
import {
	Ripple,
	LineState,
	IlluminateConfig,
	ILLUMINATE_CONFIGS,
	DEPTH_BAND_MAX,
	RIPPLE_DUR_DEFAULT,
	RIPPLE_SPREAD_DEFAULT,
	ECHO_AFTERGLOW_MS,
	AFTERGLOW_MS,
	PULSE_WINDOW_MS,
	SECONDARY_RIPPLE_DELAY_MS,
	SECONDARY_RIPPLE_STRENGTH,
	DIM_ON,
	DIM_OFF,
	ILLUMINATE_CLOSE,
	RESET_COLOR,
	CYAN_GLOW, WARM_GLOW, PEACH_GLOW, ORANGE_GLOW, SKY_GLOW, WHITE_GLOW,
	BOLD_ON, BOLD_OFF,
	getSegmentBuffer,
} from './constants.js';
import {
	easeOutCubic,
	smoothstep,
	lerp,
	hashNoise,
	selectScrambleChar,
	selectSparkChar,
	makeAnimationSeed,
} from './utils.js';
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
	return config.color;
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
						// Gradient peak: vivid salmon → capped bright salmon (stay closer to theme)
						const t = Math.min(1, crestDepth / 1.5);
						const cr = Math.round(lerp(255, 255, t));
						const cg = Math.round(lerp(90, 170, t));
						const cb = Math.round(lerp(70, 150, t));
						prefix = `\x1b[38;2;${cr};${cg};${cb}m`;
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

export function spawnRippleForText(pos: number, now: number, textLength: number, seed?: number, contentChange?: boolean): Ripple[] {
	const primary = spawnRipple(pos, now, getRippleDuration(textLength), RIPPLE_SPREAD_DEFAULT, seed, contentChange);
	return [primary, spawnSecondaryRipple(primary)];
}

export function spawnIlluminateRippleForText(pos: number, now: number, config: IlluminateConfig, textLength: number, seed?: number, contentChange?: boolean): Ripple[] {
	// Illuminate labels use intentional per-config durations (400ms for labels, 1200ms for content)
	// Skip getRippleDuration floor which forces short text to 1150-1300ms — that's meant for streaming content, not tool labels
	const dur = config.duration;
	const primary = spawnIlluminateRipple(pos, now, { ...config, duration: dur }, seed, contentChange);
	return [primary, spawnSecondaryRipple(primary)];
}

/**
 * Compute a ripple spawn center with random jitter.
 * The position is chosen uniformly between 20% and 80% of the text
 * length (or the center for very short strings), giving a varied
 * but never edge-clamped ripple origin.
 */
export function computePulseIntensity(state: LineState, now: number): number | undefined {
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

