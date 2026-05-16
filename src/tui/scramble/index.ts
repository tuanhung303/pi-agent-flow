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
	ILLUMINATE_CONFIGS,
	DEFAULT_MODE,
	THIN_BRAILLE_SPARK,
	CYAN_GLOW,
	WARM_GLOW,
	PEACH_GLOW,
	ORANGE_GLOW,
	SKY_GLOW,
	WHITE_GLOW,
	BOLD_ON,
	BOLD_OFF,
	RESET_COLOR,
} from './constants.js';

export type {
	AnimationConfig,
	ScrambleMode,
	IlluminateConfig,
	ScrambleResult,
	Ripple,
	QueueItem,
	GlitchQueueItem,
	LineState,
	LineKey,
	ValueFlashState,
	TypewriterState,
} from './constants.js';

export {
	renderStreamText,
	buildQueue,
	computeCascadeFrame,
	buildGlitchQueue,
	computeGlitchFrame,
	isGlitchComplete,
	isCascadeComplete,
	applyScramble,
} from './algorithm.js';

export {
	applyRipples,
} from './effects.js';

export {
	hashNoise,
	makeAnimationSeed,
	findSentenceStarts,
	randomSentenceStart,
	selectScrambleChar,
	selectSparkChar,
} from './utils.js';
