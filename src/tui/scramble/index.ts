// Re-exports preserving the public API of the former src/tui/scramble.ts
export {
	scrambleManager,
	ScrambleStateManager,
	runScrambleTimer,
	DynamicScrambleText,
	setAnimationConfig,
} from './manager.js';

export {
	getLiveText,
	setLiveText,
	clearLiveText,
	FastRNG,
	THIN_BRAILLE_SPARK,
} from './constants.js';

export type {
	AnimationConfig,
	ScrambleResult,
	GlitchQueueItem,
	LineState,
	LineKey,
	ValueFlashState,
} from './constants.js';

export {
	buildGlitchQueue,
	buildMsgGlitchQueue,
	computeGlitchFrame,
	isGlitchComplete,
	applyScramble,
} from './algorithm.js';

export {
	hashNoise,
	makeAnimationSeed,
	selectScrambleChar,
	selectSparkChar,
} from './utils.js';
