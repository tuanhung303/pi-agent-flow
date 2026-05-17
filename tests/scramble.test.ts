/**
 * Unit tests for glitch-only text scramble effect.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import {
	buildGlitchQueue,
	buildMsgGlitchQueue,
	computeGlitchFrame,
	isGlitchComplete,
	applyScramble,
	ScrambleStateManager,
	selectScrambleChar,
	selectSparkChar,
	THIN_BRAILLE_SPARK,
	FastRNG,
	makeAnimationSeed,
	hashNoise,
	DynamicScrambleText,
} from '../src/tui/scramble/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DIM_ON = '\x1b[2m';
const DIM_OFF = '\x1b[22m';

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function hasAnsi(s: string): boolean {
	return s.includes("\x1b");
}

const TEST_ID = 'test-id';
const SCRAMBLE_CHAR_SET = '·∘∙~⋆˚｡+×◇°⠌⠡⠜⠣⠪⠹⠸⠷⠮⠯⠿⠾';

beforeAll(() => {
	let callCount = 0;
	vi.spyOn(Math, 'random').mockImplementation(() => {
		return callCount++ % 2 === 0 ? 0.25 : 0.9;
	});
});
afterAll(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Glitch algorithm tests
// ---------------------------------------------------------------------------

describe('buildGlitchQueue', () => {
	it('sets fadeOutEnd for removed chars (long → short)', () => {
		const queue = buildGlitchQueue('hello world', 'hi', 40, 40);
		for (let i = 2; i < queue.length; i++) {
			expect(queue[i].fadeOutEnd).toBeDefined();
			expect(queue[i].fadeOutEnd).toBeGreaterThan(queue[i].end);
		}
	});

	it('does not set fadeOutEnd for kept or new chars', () => {
		const queue = buildGlitchQueue('hello', 'world', 40, 40);
		for (const item of queue) {
			if (item.to !== '') {
				expect(item.fadeOutEnd).toBeUndefined();
			}
		}
	});

	it('fadeOutEnd includes proportional bonus frames', () => {
		const queue = buildGlitchQueue('abcdef', 'ab', 0, 0);
		const bonus = Math.min(8, Math.floor(4 / 2));
		for (let i = 2; i < queue.length; i++) {
			expect(queue[i].fadeOutEnd).toBe(queue[i].end + 18 + bonus);
		}
	});
});

describe('buildMsgGlitchQueue', () => {
	it('extends short queues to meet minimum duration', () => {
		const queue = buildMsgGlitchQueue('ab', 'cd');
		const maxEnd = queue.reduce((max, item) => Math.max(max, item.fadeOutEnd ?? item.end), 0);
		expect(maxEnd).toBeGreaterThanOrEqual(55);
	});

	it('adds settleEnd for kept chars when extended', () => {
		const queue = buildMsgGlitchQueue('ab', 'cd');
		for (const item of queue) {
			if (item.to !== '') {
				expect(item.settleEnd).toBeDefined();
			}
		}
	});
});

describe('computeGlitchFrame', () => {
	it('renders dim sparkles during fade-out window for removed chars', () => {
		const queue: any[] = [
			{ from: 'a', to: 'x', start: 0, end: 5, char: null },
			{ from: 'b', to: '', start: 0, end: 5, fadeOutEnd: 23, char: null },
		];
		const rng = () => '~';
		const result = computeGlitchFrame(queue, 10, rng);
		expect(stripAnsi(result)).toBe('x~');
		expect(result).toContain(DIM_ON);
		expect(result).toContain(DIM_OFF);
	});

	it('removed chars render as empty string after fadeOutEnd', () => {
		const queue: any[] = [
			{ from: 'a', to: 'x', start: 0, end: 5, char: null },
			{ from: 'b', to: '', start: 0, end: 5, fadeOutEnd: 23, char: null },
		];
		const rng = () => '~';
		const result = computeGlitchFrame(queue, 25, rng);
		expect(stripAnsi(result)).toBe('x');
		expect(result).not.toContain(DIM_ON);
	});

	it('groups contiguous fade-out chars under single dim pair', () => {
		const queue: any[] = [
			{ from: 'a', to: '', start: 0, end: 5, fadeOutEnd: 23, char: null },
			{ from: 'b', to: '', start: 0, end: 5, fadeOutEnd: 23, char: null },
		];
		const rng = () => '~';
		const result = computeGlitchFrame(queue, 10, rng);
		const dimOnCount = (result.match(/\x1b\[2m/g) || []).length;
		const dimOffCount = (result.match(/\x1b\[22m/g) || []).length;
		expect(dimOnCount).toBe(1);
		expect(dimOffCount).toBe(1);
	});

	it('preserves from chars before start even with fadeOutEnd', () => {
		const queue: any[] = [
			{ from: 'a', to: '', start: 5, end: 10, fadeOutEnd: 28, char: null },
		];
		const rng = () => '~';
		const result = computeGlitchFrame(queue, 2, rng);
		expect(stripAnsi(result)).toBe('a');
		expect(result).not.toContain(DIM_ON);
	});

	it('long-to-short transition does not vanish chars before fadeOutEnd', () => {
		const queue = buildGlitchQueue('long text here', 'short', 40, 40);
		const maxEnd = Math.max(...queue.map(e => e.fadeOutEnd ?? e.end));
		const oldMaxEnd = Math.max(...queue.map(e => e.end));
		const rng = () => '~';
		const resultAtOldEnd = computeGlitchFrame(queue, oldMaxEnd, rng);
		expect(stripAnsi(resultAtOldEnd).length).toBeGreaterThan('short'.length);
		const resultAtMaxEnd = computeGlitchFrame(queue, maxEnd + 1, rng);
		expect(stripAnsi(resultAtMaxEnd)).toBe('short');
	});

	it('uses spark chars for first 25% of new char scramble window', () => {
		const queue: any[] = [
			{ from: '', to: 'x', start: 0, end: 10, char: null },
		];
		const rng = () => '~';
		const result = computeGlitchFrame(queue, 1, rng, undefined, 42);
		const stripped = stripAnsi(result);
		expect(THIN_BRAILLE_SPARK).toContain(stripped[0]);
		expect(stripped[0]).not.toBe('~');
	});

	it('uses dense scramble after first 25% for new chars', () => {
		const queue: any[] = [
			{ from: '', to: 'x', start: 0, end: 10, char: null },
		];
		const rng = () => '~';
		const result = computeGlitchFrame(queue, 5, rng, undefined, 42);
		expect(stripAnsi(result)[0]).toBe('~');
	});

	it('appends currentText characters beyond queue length', () => {
		const queue = buildGlitchQueue('ab', 'cd');
		const result = computeGlitchFrame(queue, 999, () => 'X', 'cdefgh');
		expect(stripAnsi(result)).toBe('cdefgh');
	});

	it('strips decorative icons from currentText for index alignment', () => {
		const queue = buildGlitchQueue('ab', 'cd');
		const result = computeGlitchFrame(queue, 999, () => 'X', `${String.fromCodePoint(0x2714)}c${String.fromCodePoint(0x2705)}d`);
		expect(stripAnsi(result)).toBe('cd');
	});
});

describe('isGlitchComplete', () => {
	it('returns true when all entries are past end (no fadeOutEnd)', () => {
		const queue: any[] = [
			{ from: 'a', to: 'x', start: 0, end: 5, char: null },
		];
		expect(isGlitchComplete(queue, 6)).toBe(true);
		expect(isGlitchComplete(queue, 4)).toBe(false);
	});

	it('waits for fadeOutEnd when present', () => {
		const queue: any[] = [
			{ from: 'a', to: 'x', start: 0, end: 5, char: null },
			{ from: 'b', to: '', start: 0, end: 5, fadeOutEnd: 23, char: null },
		];
		expect(isGlitchComplete(queue, 6)).toBe(false);
		expect(isGlitchComplete(queue, 22)).toBe(false);
		expect(isGlitchComplete(queue, 23)).toBe(true);
	});

	it('returns true for empty queue', () => {
		expect(isGlitchComplete([], 0)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// ScrambleStateManager — glitch behavior
// ---------------------------------------------------------------------------

describe('ScrambleStateManager', () => {
	let manager: ScrambleStateManager;

	beforeEach(() => {
		manager = new ScrambleStateManager();
	});

	it('updateAim animates on text change', () => {
		const base = 1_000_000;
		manager.updateAim(TEST_ID, 'initial text', base);
		const result = manager.updateAim(TEST_ID, 'changed text', base + 300);
		expect(result.isAnimating).toBe(true);
	});

	it('updateAct animates on text change', () => {
		const base = 2_000_000;
		manager.updateAct(TEST_ID, 'read file.ts', base);
		const result = manager.updateAct(TEST_ID, 'write other.ts', base + 300);
		expect(result.isAnimating).toBe(true);
	});

	it('updateMsg animates on text change', () => {
		const base = 2_000_000;
		manager.updateMsg(TEST_ID, 'initial', base);
		const result = manager.updateMsg(TEST_ID, 'changed text', base + 300);
		expect(result.isAnimating).toBe(true);
	});

	it('updateText animates on text change', () => {
		const base = 1_000_000;
		manager.updateText('id-1', 'header', 'hello world', base, false, true);
		const result = manager.updateText('id-1', 'header', 'goodbye all', base + 300, false, true);
		expect(result.isAnimating).toBe(true);
	});

	it('same text does not trigger new glitch after completion', () => {
		const base = 2_000_000;
		manager.updateAct(TEST_ID, 'same text', base);
		const during = manager.updateAct(TEST_ID, 'same text', base + 300);
		expect(during.isAnimating).toBe(true);
		const done = manager.updateAct(TEST_ID, 'same text', base + 1500);
		expect(done.isAnimating).toBe(false);
		expect(stripAnsi(done.content)).toBe('same text');
	});

	it('cooldown prevents rapid-fire glitches', () => {
		const base = 2_000_000;
		manager.updateMsg(TEST_ID, 'text one', base);
		manager.updateMsg(TEST_ID, 'text two', base + 300);
		manager.updateMsg(TEST_ID, 'text three', base + 400);
		const duringCooldown = manager.updateMsg(TEST_ID, 'text four', base + 1400);
		expect(duringCooldown.isAnimating).toBe(false);
		const afterCooldown = manager.updateMsg(TEST_ID, 'text five', base + 3000);
		expect(afterCooldown.isAnimating).toBe(true);
		const done = manager.updateMsg(TEST_ID, 'text five', base + 5000);
		expect(done.isAnimating).toBe(false);
	});

	it('flow completion stops animations', () => {
		const base = 8_000_000;
		manager.updateAct(TEST_ID, 'act text', base);
		const result = manager.updateAct(TEST_ID, 'act changed', base + 300, true);
		expect(result.content).toBe('act changed');
		expect(result.isAnimating).toBe(false);
	});

	it('completeFlow clears all line states', () => {
		const base = 8_000_000;
		manager.updateAct(TEST_ID, 'act text', base);
		manager.updateMsg(TEST_ID, 'msg text', base);
		manager.updateAct(TEST_ID, 'act changed', base + 300);
		manager.updateMsg(TEST_ID, 'msg changed', base + 300);
		expect(manager.hasAnyActiveAnimations(base + 300)).toBe(true);
		manager.completeFlow(TEST_ID);
		expect(manager.hasAnyActiveAnimations(base + 300)).toBe(false);
	});

	it('hasAnyActiveAnimations detects glitch', () => {
		const base = 7_000_000;
		manager.updateMsg(TEST_ID, 'init', base);
		expect(manager.hasAnyActiveAnimations(base)).toBe(false);
		manager.updateAct(TEST_ID, 'read file.ts', base + 10);
		expect(manager.hasAnyActiveAnimations(base + 10)).toBe(true);
		manager.updateAct(TEST_ID, 'write file.ts', base + 1300);
		expect(manager.hasAnyActiveAnimations(base + 1350)).toBe(true);
	});

	it('hasActiveAnimations detects sub-flow animations via prefix', () => {
		manager.updateMsg('base#0', 'Hello world', 1_000_000, false, undefined, true);
		manager.updateMsg('base#0', 'Totally different text here.', 1_000_400, false, undefined, true);
		expect(manager.hasActiveAnimations('base', 1_000_410)).toBe(true);
		expect(manager.hasActiveAnimations('base#0', 1_000_510)).toBe(true);
		expect(manager.hasActiveAnimations('base#1', 1_000_510)).toBe(false);
	});

	it('TPS flash triggers on large change (> 15%)', () => {
		const base = 6_000_000;
		manager.updateTps(TEST_ID, '42.3', base);
		manager.updateTps(TEST_ID, '55.0', base + 100);
		expect(manager.hasAnyActiveAnimations(base + 110)).toBe(true);
	});

	it('TPS hysteresis prevents flash on tiny changes', () => {
		const base = 6_000_000;
		manager.updateTps(TEST_ID, '42.3', base);
		const result = manager.updateTps(TEST_ID, '43.1', base + 100);
		expect(result).toBe('43.1');
		expect(hasAnsi(result)).toBe(false);
	});

	it('staticLine minor-mutation guard suppresses re-flash', () => {
		const base = 1_000_000;
		manager.updateText('id-1', 'header', 'scout - lite - tps: 12', base, false, true);
		manager.updateText('id-1', 'header', 'scout - lite - tps: 15', base + 300, false, true);
		expect(manager.hasActiveAnimations('id-1', base + 4500)).toBe(false);
	});

	it('staticLine still flashes on major rewrite beyond cooldown', () => {
		const base = 1_000_000;
		manager.updateText('id-1', 'header', 'scout - lite - tps: 12', base, false, true);
		manager.updateText('id-1', 'header', 'build - heavy - tps: 99', base + 300, false, true);
		expect(manager.hasActiveAnimations('id-1', base + 700)).toBe(true);
	});

	it('sweeps completed flow entries when maps grow large', () => {
		for (let i = 0; i < 200; i++) {
			const id = `flow-${i}`;
			manager.updateMsg(id, 'test', 1_000_000 + i * 10);
			manager.completeFlow(id);
		}
		const fresh = manager.updateMsg('fresh-flow', 'hello', 1_000_000, true);
		expect(fresh.content).toBe('hello');
	});

	it('clear resets all state', () => {
		manager.updateMsg(TEST_ID, 'test', Date.now(), false, undefined, true);
		manager.clear();
		const base = 5_000_000;
		manager.updateMsg(TEST_ID, 'new text', base, false, undefined, true);
		const result = manager.updateMsg(TEST_ID, 'changed text', base + 300, false, undefined, true);
		expect(result.isAnimating).toBe(true);
	});

	it('updateMsg with budget truncates text to visible window', () => {
		const base = 1_000_000;
		const longText = 'a'.repeat(100);
		const result = manager.updateMsg(TEST_ID, longText, base, false, 20);
		expect(stripAnsi(result.content).length).toBeLessThanOrEqual(20);
	});

	it('completed flow with budget returns truncated text', () => {
		const base = 1_000_000;
		const longText = 'x'.repeat(100);
		const result = manager.updateMsg(TEST_ID, longText, base, true, 15);
		expect(stripAnsi(result.content).length).toBeLessThanOrEqual(15);
		expect(result.isAnimating).toBe(false);
	});

	it('msg glitch freezes displayed text during active glitch', () => {
		const base = 60_000_000;
		manager.updateMsg(TEST_ID, 'Hello world', base, false, undefined, true);
		const midText = 'Hello world. How are you today?';
		manager.updateMsg(TEST_ID, midText, base + 400, false, undefined, true);
		const newText = 'Hello world. How are you today? This is brand new streaming content.';
		const during = manager.updateMsg(TEST_ID, newText, base + 500, false, undefined, true);
		const stripped = stripAnsi(during.content);
		expect(stripped).not.toContain('This is brand new streaming content');
		expect(stripped.length).toBeLessThanOrEqual(midText.length + 10);
	});

	it('shrink transition builds proportional fade-out queue', () => {
		const base = 3_000_000;
		manager.updateAct(TEST_ID, 'long text here', base);
		manager.updateAct(TEST_ID, 'hi', base + 100);
		const state = (manager as any).cache.get(TEST_ID)?.act;
		const queue = state?.glitchQueue as any[];
		expect(queue).toBeDefined();
		expect(queue.length).toBeGreaterThan(0);
		const deletedItems = queue.filter((q: any) => q.to === '' && q.from !== '');
		const bonus = Math.min(8, Math.floor(deletedItems.length / 2));
		for (const item of deletedItems) {
			expect(item.fadeOutEnd).toBe(item.end + 18 + bonus);
		}
	});

	it('end-to-end shrink transition resolves to short text', () => {
		const base = 3_000_000;
		manager.updateAct(TEST_ID, 'long text here for sure', base);
		const result = manager.updateAct(TEST_ID, 'short', base + 100);
		expect(result.isAnimating).toBe(true);

		let t = base + 100;
		let lastResult = result;
		while (manager.hasAnyActiveAnimations(t) && t < base + 8000) {
			t += 100;
			lastResult = manager.updateAct(TEST_ID, 'short', t);
		}

		expect(stripAnsi(lastResult.content)).toBe('short');
		expect(lastResult.isAnimating).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// selectScrambleChar tests
// ---------------------------------------------------------------------------

describe('selectScrambleChar', () => {
	it('returns deep glitch chars for depth 1–2', () => {
		const deepChars = '△⃝△⃝○⃝○⃝☐⃝☐⃝⠁⠂⠃⠄⠅⠆⠇⠈⠉⠊⠋⠌⠍⠎⠏⠐⠑⠒⠓';
		for (let d = 1; d <= 2; d++) {
			const c = selectScrambleChar(d, 0, 0);
			expect(deepChars).toContain(c);
		}
	});

	it('returns mid glitch chars for depth 3', () => {
		const midChars = '△⃝△⃝○⃝x○⃝☐⃝☐⃝+✕✦△⃝⠁⠂⠃⠄⠅⠆⠇⠈⠉⠊⠋';
		const c = selectScrambleChar(3, 0, 0);
		expect(midChars).toContain(c);
	});

	it('returns shallow glitch chars for depth 4+', () => {
		const shallowChars = '△⃝△⃝○⃝x✕△⃝+⠌⠡⠜';
		for (let d = 4; d <= 6; d++) {
			const c = selectScrambleChar(d, 0, 0);
			expect(shallowChars).toContain(c);
		}
	});

	it('produces same char for same inputs with seed', () => {
		const c1 = selectScrambleChar(1, 0, 0, 12345);
		const c2 = selectScrambleChar(1, 0, 0, 12345);
		expect(c1).toBe(c2);
	});

	it('falls back to deterministic mode without seed', () => {
		const c1 = selectScrambleChar(1, 0, 0);
		const c2 = selectScrambleChar(1, 0, 0);
		expect(c1).toBe(c2);
	});
});

// ---------------------------------------------------------------------------
// FastRNG and hashNoise tests
// ---------------------------------------------------------------------------

describe('FastRNG', () => {
	it('produces deterministic sequence for same seed', () => {
		const rng1 = new FastRNG(12345);
		const rng2 = new FastRNG(12345);
		for (let i = 0; i < 100; i++) {
			expect(rng1.next()).toBe(rng2.next());
		}
	});

	it('produces values in [0, 1)', () => {
		const rng = new FastRNG(12345);
		for (let i = 0; i < 100; i++) {
			const v = rng.next();
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});

	it('nextInt returns values in [0, max)', () => {
		const rng = new FastRNG(12345);
		for (let i = 0; i < 100; i++) {
			const v = rng.nextInt(10);
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(10);
		}
	});
});

describe('hashNoise', () => {
	it('produces same output for same inputs', () => {
		const n1 = hashNoise(12345, 0, 0, 1);
		const n2 = hashNoise(12345, 0, 0, 1);
		expect(n1).toBe(n2);
	});

	it('produces values in [0, 1)', () => {
		for (let i = 0; i < 100; i++) {
			const n = hashNoise(i, i * 2, i * 3, i % 4 + 1);
			expect(n).toBeGreaterThanOrEqual(0);
			expect(n).toBeLessThan(1);
		}
	});
});

describe('makeAnimationSeed', () => {
	it('produces same seed for same text and timestamp', () => {
		const s1 = makeAnimationSeed('hello', 1000);
		const s2 = makeAnimationSeed('hello', 1000);
		expect(s1).toBe(s2);
	});

	it('produces different seeds for different text', () => {
		const s1 = makeAnimationSeed('hello', 1000);
		const s2 = makeAnimationSeed('world', 1000);
		expect(s1).not.toBe(s2);
	});
});

// ---------------------------------------------------------------------------
// DynamicScrambleText tests
// ---------------------------------------------------------------------------

describe('DynamicScrambleText', () => {
	it('renders initial content', () => {
		const comp = new DynamicScrambleText('hello', () => 'world');
		const result = comp.render(80);
		expect(result[0]).toBe('world');
	});

	it('re-renders when content changes', () => {
		let content = 'first';
		const comp = new DynamicScrambleText('first', () => content);
		expect(comp.render(80)[0]).toBe('first');
		content = 'second';
		comp.invalidate();
		expect(comp.render(80)[0]).toBe('second');
	});
});
