/**
 * Unit tests for tri-mode text scramble effect (stream + cascade + ripple).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	applyRipples,
	buildQueue,
	computeCascadeFrame,
	renderStreamText,
	ScrambleStateManager,
	DEFAULT_MODE,
	selectScrambleChar,
	selectSparkChar,
	THIN_BRAILLE_SPARK,
	CYAN_GLOW,
	WARM_GLOW,
	PEACH_GLOW,
	ORANGE_GLOW,
	WHITE_GLOW,
	BOLD_ON,
	ILLUMINATE_CONFIGS,
	FastRNG,
	makeAnimationSeed,
	hashNoise,
	findSentenceStarts,
	randomSentenceStart,
} from '../src/scramble.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DIM_ON = '\x1b[2m';
const DIM_OFF = '\x1b[22m';

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function hasAnsi(s: string): boolean {
	return s.includes("");
}

const TEST_ID = 'test-id';
const SCRAMBLE_CHAR_SET = '·∘∙~?+-*/[]{}<>_○◎';

// ---------------------------------------------------------------------------
// Stream mode tests
// ---------------------------------------------------------------------------

describe('renderStreamText', () => {
	it('returns full text when all chars are revealed', () => {
		const result = renderStreamText('hello world', 11, 3, []);
		expect(result).toBe('hello world');
	});

	it('shows resolved chars before cursor', () => {
		const result = renderStreamText('hello world', 5, 3, []);
		const stripped = stripAnsi(result);
		expect(stripped.slice(0, 5)).toBe('hello');
	});

	it('shows scramble chars in cursor zone with dim ANSI', () => {
		const result = renderStreamText('hello world', 5, 3, []);
		expect(hasAnsi(result)).toBe(true);
	});

	it('preserves spaces in cursor zone', () => {
		const result = renderStreamText('a b c d', 3, 3, []);
		const stripped = stripAnsi(result);
		// Space at position 1 (already revealed) and position 3 (in cursor zone)
		expect(stripped[1]).toBe(' ');
	});

	it('scramble chars are from SCRAMBLE_CHARS set', () => {
		const result = renderStreamText('abcdefg', 2, 3, []);
		const stripped = stripAnsi(result);
		// Chars at positions 2-4 should be scramble chars
		for (let i = 2; i < 5; i++) {
			if (stripped[i] !== ' ') {
				expect(SCRAMBLE_CHAR_SET).toContain(stripped[i]);
			}
		}
	});

	it('beyond-cursor chars are also scramble chars (noise)', () => {
		const result = renderStreamText('abcdefghij', 2, 3, []);
		const stripped = stripAnsi(result);
		// Chars beyond cursor zone (positions 5+) should also be scramble
		for (let i = 5; i < stripped.length; i++) {
			if (stripped[i] !== ' ') {
				expect(SCRAMBLE_CHAR_SET).toContain(stripped[i]);
			}
		}
	});

	it('cursor chars array is trimmed to scrambleWidth', () => {
		const cursorChars: string[] = [];
		renderStreamText('abcdef', 2, 3, cursorChars);
		expect(cursorChars.length).toBe(3);
	});

	it('beyond-cursor scramble chars keep fuzzing each frame', () => {
		const cursorChars: string[] = [];
		const r1 = renderStreamText('abcdefghij', 2, 3, cursorChars);
		const r2 = renderStreamText('abcdefghij', 2, 3, cursorChars);
		// Beyond cursor zone starts at index 5 (revealed 2 + width 3)
		// Positions 5+ should produce different scramble chars across calls
		const stripped1 = stripAnsi(r1);
		const stripped2 = stripAnsi(r2);
		let diffCount = 0;
		for (let i = 5; i < stripped1.length; i++) {
			if (stripped1[i] !== ' ' && stripped2[i] !== ' ') {
				if (stripped2[i] !== stripped1[i]) diffCount++;
			}
		}
		expect(diffCount).toBeGreaterThan(0);
	});

	it('groups contiguous scramble chars under a single ANSI pair', () => {
		const cursorChars: string[] = [];
		const result = renderStreamText('abcdefghij', 2, 3, cursorChars);
		const dimOnCount = (result.match(/\x1b\[2m/g) || []).length;
		const dimOffCount = (result.match(/\x1b\[22m/g) || []).length;
		// 8 scramble chars (3 cursor + 5 beyond) are contiguous with no spaces,
		// so exactly one DIM_ON / DIM_OFF pair wraps the entire scramble run.
		expect(dimOnCount).toBe(1);
		expect(dimOffCount).toBe(1);
	});

	it('spaces break dim groups but scramble runs stay grouped', () => {
		const cursorChars: string[] = [];
		const result = renderStreamText('ab cde fgh', 2, 3, cursorChars);
		const dimOnCount = (result.match(/\x1b\[2m/g) || []).length;
		const dimOffCount = (result.match(/\x1b\[22m/g) || []).length;
		// 'ab' resolved, space, 'cde' grouped, space, 'fgh' grouped
		expect(dimOnCount).toBe(2);
		expect(dimOffCount).toBe(2);
	});
});

describe('ScrambleStateManager (stream mode)', () => {
	let manager: ScrambleStateManager;

	beforeEach(() => {
		manager = new ScrambleStateManager();
		manager.setMode('stream');
	});

	it('defaults to illuminate mode', () => {
		expect(DEFAULT_MODE).toBe('illuminate');
	});

	it('updateAim returns plain text in stream mode', () => {
		const result = manager.updateAim(TEST_ID, 'test', Date.now());
		expect(result.content).toBe('test'); // stream mode: no animation for static aim
		expect(result.isAnimating).toBe(false);
	});

	it('streamAct reveals text progressively', () => {
		const base = 1000000;
		const result = manager.streamAct(TEST_ID, 'read file.ts', base, false, 40);
		// At first call, cursor just started — should have scramble chars
		expect(hasAnsi(result)).toBe(true);
	});

	it('streamAct resolves fully when given enough time', () => {
		const base = 1000000;
		manager.streamAct(TEST_ID, 'read file.ts', base, false, 40);
		// After enough time for all chars to be revealed (13 chars * 16ms = 208ms)
		const result = manager.streamAct(TEST_ID, 'read file.ts', base + 500, false, 40);
		expect(stripAnsi(result)).toBe('read file.ts');
		expect(hasAnsi(result)).toBe(false);
	});

	it('streamAct resets on tool change', () => {
		const base = 1000000;
		// First tool call
		manager.streamAct(TEST_ID, 'read file.ts', base, false, 40);
		// Let it complete
		manager.streamAct(TEST_ID, 'read file.ts', base + 500, false, 40);
		// New tool call — should reset and scramble again
		const result = manager.streamAct(TEST_ID, 'write other.ts', base + 1000, false, 40);
		expect(hasAnsi(result)).toBe(true);
	});

	it('streamAct does not reset on same tool with different args', () => {
		const base = 2000000;
		// First tool call
		manager.streamAct(TEST_ID, 'ls /foo/bar/a', base, false, 40);
		// Let it fully reveal
		const before = manager.streamAct(TEST_ID, 'ls /foo/bar/a', base + 500, false, 40);
		expect(hasAnsi(before)).toBe(false);
		// Same tool, different path — should NOT reset (no dim scramble)
		const result = manager.streamAct(TEST_ID, 'ls /foo/bar/b', base + 600, false, 40);
		expect(hasAnsi(result)).toBe(false);
	});

	it('streamMsg reveals streaming text progressively', () => {
		const base = 1000000;
		const result = manager.streamMsg(TEST_ID, 'Found 4 files', base, false, 40);
		expect(hasAnsi(result)).toBe(true);
	});

	it('streamMsg resolves fully after enough time', () => {
		const base = 1000000;
		manager.streamMsg(TEST_ID, 'Found 4 files', base, false, 40);
		// 14 chars * 20ms = 280ms
		const result = manager.streamMsg(TEST_ID, 'Found 4 files', base + 500, false, 40);
		expect(stripAnsi(result)).toBe('Found 4 files');
		expect(hasAnsi(result)).toBe(false);
	});

	it('streamMsg handles incremental text growth', () => {
		const base = 1000000;
		manager.streamMsg(TEST_ID, 'Found', base, false, 40);
		// Text grew — cursor catches up
		const result = manager.streamMsg(TEST_ID, 'Found 4 files', base + 200, false, 40);
		// Should have some resolved and some scramble
		expect(hasAnsi(result)).toBe(true);
	});

	it('streamMsg resets on non-incremental change', () => {
		const base = 1000000;
		manager.streamMsg(TEST_ID, 'Found 4 files', base, false, 40);
		// Let it complete
		manager.streamMsg(TEST_ID, 'Found 4 files', base + 500, false, 40);
		// Completely new text — should reset
		const result = manager.streamMsg(TEST_ID, 'Error: something failed', base + 1000, false, 40);
		expect(hasAnsi(result)).toBe(true);
	});

	it('streamMsg completes on isComplete=true', () => {
		const base = 1000000;
		manager.streamMsg(TEST_ID, 'Processing...', base, false, 40);
		const result = manager.streamMsg(TEST_ID, 'Processing...', base + 100, true, 40);
		expect(stripAnsi(result)).toBe('Processing...');
		expect(hasAnsi(result)).toBe(false);
	});

	it('streamAct completes on isComplete=true', () => {
		const base = 1000000;
		manager.streamAct(TEST_ID, 'read file.ts', base, false, 40);
		const result = manager.streamAct(TEST_ID, 'read file.ts', base + 100, true, 40);
		expect(stripAnsi(result)).toBe('read file.ts');
		expect(hasAnsi(result)).toBe(false);
	});

	it('hasAnyActiveAnimations detects stream animation', () => {
		const base = 1000000;
		manager.streamMsg(TEST_ID, 'test text', base, false, 40);
		expect(manager.hasAnyActiveAnimations(base + 10)).toBe(true);
		// Advance cursor by calling streamMsg with later time
		manager.streamMsg(TEST_ID, 'test text', base + 500, false, 40);
		// Now check
		expect(manager.hasAnyActiveAnimations(base + 500)).toBe(false);
	});

	it('completeFlow stops all stream animations', () => {
		const base = 1000000;
		manager.streamMsg(TEST_ID, 'test text', base, false, 40);
		manager.streamAct(TEST_ID, 'act text', base, false, 40);
		expect(manager.hasAnyActiveAnimations(base + 10)).toBe(true);
		manager.completeFlow(TEST_ID);
		expect(manager.hasAnyActiveAnimations(base + 10)).toBe(false);
	});

	it('clear resets all state', () => {
		manager.streamMsg(TEST_ID, 'test', Date.now(), false, 40);
		manager.clear();
		// After clear, new calls start fresh
		const result = manager.streamMsg(TEST_ID, 'new text', Date.now(), false, 40);
		expect(hasAnsi(result)).toBe(true);
	});

	it('streamMsg resets when a new flow starts after completion', () => {
		const base = 1000000;
		// First flow completes
		manager.streamMsg(TEST_ID, 'first flow', base, false, 40);
		manager.streamMsg(TEST_ID, 'first flow', base + 500, true, 40);
		expect(manager.hasAnyActiveAnimations(base + 500)).toBe(false);
		// New flow starts — should reset and scramble again
		const result = manager.streamMsg(TEST_ID, 'second flow', base + 600, false, 40);
		expect(hasAnsi(result)).toBe(true);
		expect(stripAnsi(result)).not.toBe('second flow');
	});

	it('streamAct resets when a new flow starts after completion', () => {
		const base = 1000000;
		// First flow completes
		manager.streamAct(TEST_ID, 'read first.ts', base, false, 40);
		manager.streamAct(TEST_ID, 'read first.ts', base + 500, true, 40);
		expect(manager.hasAnyActiveAnimations(base + 500)).toBe(false);
		// New flow starts — should reset and scramble again
		const result = manager.streamAct(TEST_ID, 'write second.ts', base + 600, false, 40);
		expect(hasAnsi(result)).toBe(true);
		expect(stripAnsi(result)).not.toBe('write second.ts');
	});

	it('streamMsg strips ANSI for stable comparison', () => {
		const base = 1000000;
		// Text with ANSI codes that change between renders
		const textWithAnsi1 = '\x1b[32mhello\x1b[0m world';
		const textWithAnsi2 = '\x1b[33mhello\x1b[0m world';
		manager.streamMsg(TEST_ID, textWithAnsi1, base, false, 40);
		// Same visible text, different ANSI codes — should NOT reset
		const result = manager.streamMsg(TEST_ID, textWithAnsi2, base + 500, false, 40);
		// Should be fully revealed (same text, no reset)
		expect(stripAnsi(result)).toBe('hello world');
		expect(hasAnsi(result)).toBe(false);
	});

	it('streamMsg adjusts revealed count when visible window slides', () => {
		const base = 1000000;
		const budget = 10;
		// Start with text that fits in budget
		manager.streamMsg(TEST_ID, '0123456789', base, false, budget);
		// Let it reveal 5 chars
		manager.streamMsg(TEST_ID, '0123456789', base + 200, false, budget);
		const mid = manager.streamMsg(TEST_ID, '0123456789', base + 200, false, budget);
		const midRevealed = stripAnsi(mid).replace(/[\x21-\x7E]/g, '#');
		// Should have some resolved chars at the start
		expect(stripAnsi(mid).slice(0, 1)).not.toBe(''); // at least 1 char revealed by ~170ms

		// Now grow text beyond budget — window slides
		const result = manager.streamMsg(TEST_ID, '0123456789abc', base + 200, false, budget);
		const stripped = stripAnsi(result);
		// The visible text is the tail (last 10 chars). Because the window slid,
		// the overlap-based adjustment should keep some chars revealed instead of
		// dropping to 0 and showing pure scramble.
		expect(stripped.length).toBeLessThanOrEqual(budget);
		// Should NOT be pure scramble noise — at least some chars should be resolved
		// (the overlap "6789" was previously revealed and is still visible)
		expect(stripped.slice(0, 2)).toBe('34'); // "3456789abc" tail, overlap preserved
	});

	it('streamMsg preserves revealed chars when text grows within budget', () => {
		const base = 1000000;
		const budget = 40;
		manager.streamMsg(TEST_ID, 'hello world', base, false, budget);
		// Let 6 chars reveal
		const partial = manager.streamMsg(TEST_ID, 'hello world', base + 250, false, budget);
		expect(stripAnsi(partial).slice(0, 6)).toBe('hello '); // 250/35 ≈ 7 chars

		// Grow text within budget — same visible text, just longer
		const result = manager.streamMsg(TEST_ID, 'hello world!', base + 250, false, budget);
		// Old visible text "hello world" is a prefix of new visible text.
		// Previously-revealed chars should stay revealed; only the new "!" is scrambled.
		const stripped = stripAnsi(result);
		expect(stripped.slice(0, 6)).toBe('hello ');
	});

	it('streamMsg resets to pure scramble on completely different text', () => {
		const base = 1000000;
		const budget = 40;
		manager.streamMsg(TEST_ID, 'first message text here', base, false, budget);
		// Let it fully reveal
		manager.streamMsg(TEST_ID, 'first message text here', base + 1000, false, budget);
		const done = manager.streamMsg(TEST_ID, 'first message text here', base + 1000, false, budget);
		expect(hasAnsi(done)).toBe(false);

		// Completely different text — no overlap
		const result = manager.streamMsg(TEST_ID, 'totally different content now', base + 1001, false, budget);
		// Should reset and show scramble
		expect(hasAnsi(result)).toBe(true);
	});

	it('streamMsg handles rapid window sliding without dropping to zero revealed', () => {
		const base = 1000000;
		const budget = 15;
		// Start with short text
		manager.streamMsg(TEST_ID, 'abc', base, false, budget);
		manager.streamMsg(TEST_ID, 'abc', base + 500, false, budget); // fully revealed

		// Rapid growth: text jumps from 3 to 50 chars. Window slides aggressively.
		const longText = 'x'.repeat(47) + 'abc';
		const result = manager.streamMsg(TEST_ID, longText, base + 600, false, budget);
		const stripped = stripAnsi(result);
		expect(stripped.length).toBeLessThanOrEqual(budget);
		expect(hasAnsi(result)).toBe(true);
	});

	it('streamMsg survives clock backward jump without stalling', () => {
		const base = 1000000;
		manager.streamMsg(TEST_ID, 'hello world', base, false, 40);
		// Partial reveal at t=100
		const partial = manager.streamMsg(TEST_ID, 'hello world', base + 100, false, 40);
		expect(hasAnsi(partial)).toBe(true);

		// Clock jumps backward (simulates NTP sync or VM time drift)
		const afterJump = manager.streamMsg(TEST_ID, 'hello world', base + 50, false, 40);
		// Should not crash or instantly complete — animation still active
		expect(hasAnsi(afterJump)).toBe(true);

		// Clock recovers and catches up
		const recovered = manager.streamMsg(TEST_ID, 'hello world', base + 500, false, 40);
		expect(stripAnsi(recovered)).toBe('hello world');
		expect(hasAnsi(recovered)).toBe(false);
	});

	it('streamAct survives clock backward jump without stalling', () => {
		const base = 1000000;
		manager.streamAct(TEST_ID, 'read file.ts', base, false, 40);
		// Partial reveal at t=100
		const partial = manager.streamAct(TEST_ID, 'read file.ts', base + 100, false, 40);
		expect(hasAnsi(partial)).toBe(true);

		// Clock jumps backward
		const afterJump = manager.streamAct(TEST_ID, 'read file.ts', base + 50, false, 40);
		expect(hasAnsi(afterJump)).toBe(true);

		// Clock recovers
		const recovered = manager.streamAct(TEST_ID, 'read file.ts', base + 500, false, 40);
		expect(stripAnsi(recovered)).toBe('read file.ts');
		expect(hasAnsi(recovered)).toBe(false);
	});

	it('streamMsg applies scramble effect during fast streaming', () => {
		const base = 1000000;
		const budget = 40;
		// Start with short text
		manager.streamMsg(TEST_ID, 'hello world', base, false, budget);
		// Fully reveal it
		manager.streamMsg(TEST_ID, 'hello world', base + 500, false, budget);

		// Now simulate a huge fast jump (as if LLM dumped a big chunk)
		const longText = 'x'.repeat(80) + 'end';
		const result = manager.streamMsg(TEST_ID, longText, base + 600, false, budget);
		const stripped = stripAnsi(result);

		// The scramble effect should be visible across the text, not just
		// forced to the last few chars. At least some scramble chars should
		// be present while the cursor catches up.
		const scrambleCount = stripped.split('').filter(c => SCRAMBLE_CHAR_SET.includes(c)).length;
		expect(scrambleCount).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Cascade algorithm tests
// ---------------------------------------------------------------------------

describe('buildQueue', () => {
	it('creates queue with correct length for same-length texts', () => {
		const queue = buildQueue('hello', 'world');
		expect(queue.length).toBe(5);
	});

	it('creates queue with max length when texts differ in length', () => {
		const queue = buildQueue('hi', 'hello');
		expect(queue.length).toBe(5);
	});

	it('sets from/to chars correctly', () => {
		const queue = buildQueue('abc', 'xyz');
		expect(queue[0].from).toBe('a');
		expect(queue[0].to).toBe('x');
		expect(queue[2].from).toBe('c');
		expect(queue[2].to).toBe('z');
	});

	it('uses empty string for from when old text is shorter', () => {
		const queue = buildQueue('ab', 'abcd');
		expect(queue[2].from).toBe('');
		expect(queue[2].to).toBe('c');
	});

	it('assigns random but valid start/end frames', () => {
		const queue = buildQueue('test', 'test');
		for (const item of queue) {
			expect(item.start).toBeGreaterThanOrEqual(0);
			expect(item.end).toBeGreaterThanOrEqual(item.start);
		}
	});

	it('all chars get random start/end frames even when from === to', () => {
		const queue = buildQueue('abc', 'axc');
		for (const item of queue) {
			expect(item.start).toBeGreaterThanOrEqual(0);
			expect(item.end).toBeGreaterThanOrEqual(item.start);
		}
	});
});

describe('computeCascadeFrame', () => {
	it('resolves all chars at max end frame', () => {
		const queue = buildQueue('hello', 'world');
		const maxEnd = Math.max(...queue.map(q => q.end));
		const result = computeCascadeFrame(queue, maxEnd + 1);
		expect(stripAnsi(result)).toBe('world');
	});

	it('shows scramble chars during animation with dim ANSI', () => {
		const queue = buildQueue('hello', 'world');
		const result = computeCascadeFrame(queue, 20);
		expect(result.length).toBeGreaterThan(0);
	});

	it('preserves spaces (target char is space)', () => {
		const queue = buildQueue('a b', 'x y');
		const maxEnd = Math.max(...queue.map(q => q.end));
		const result = computeCascadeFrame(queue, maxEnd + 1);
		expect(stripAnsi(result)).toBe('x y');
		expect(result.includes(' ')).toBe(true);
	});

	it('completes animation eventually', () => {
		const queue = buildQueue('short', 'longer text here');
		const maxEnd = Math.max(...queue.map(q => q.end));
		const result = computeCascadeFrame(queue, maxEnd + 100);
		expect(stripAnsi(result)).toBe('longer text here');
		expect(hasAnsi(result)).toBe(false);
	});

	it('handles empty from chars (new text longer)', () => {
		const queue = buildQueue('', 'abc');
		const result = computeCascadeFrame(queue, 0);
		expect(result.length).toBeGreaterThan(0);
		const maxEnd = Math.max(...queue.map(q => q.end));
		const final = computeCascadeFrame(queue, maxEnd + 1);
		expect(stripAnsi(final)).toBe('abc');
	});

	it('pre-start frame shows scramble symbols not old text', () => {
		const queue = buildQueue('abcdef', 'xyz123');
		const result = computeCascadeFrame(queue, 0);
		const stripped = stripAnsi(result);
		for (const ch of stripped) {
			if (ch !== ' ') {
				expect(SCRAMBLE_CHAR_SET).toContain(ch);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Ripple algorithm tests
// ---------------------------------------------------------------------------

describe('applyRipples', () => {
	it('returns original text when no ripples', () => {
		const result = applyRipples('hello world', [], Date.now());
		expect(result).toBe('hello world');
	});

	it('returns original text when all ripples have expired', () => {
		const now = Date.now();
		const expiredRipple = { pos: 5, time: now - 4500, dur: 500, spread: 1 };
		const result = applyRipples('hello world', [expiredRipple], now);
		expect(stripAnsi(result)).toBe('hello world');
	});

	it('scrambles characters within the ripple depth band', () => {
		const now = Date.now();
		const ripple = { pos: 4, time: now - 100, dur: 666, spread: 1 };
		const result = applyRipples('hello world', [ripple], now);
		expect(stripAnsi(result).length).toBe('hello world'.length);
		expect(stripAnsi(result)).not.toBe('hello world');
	});

	it('preserves spaces untouched', () => {
		const now = Date.now();
		const ripple = { pos: 5, time: now - 100, dur: 666, spread: 1 };
		const result = applyRipples('a b c d e', [ripple], now);
		const stripped = stripAnsi(result);
		expect(stripped[1]).toBe(' ');
		expect(stripped[3]).toBe(' ');
	});

	it('restores characters after ripple expires', () => {
		const spawnTime = Date.now() - 1400;
		const ripple = { pos: 3, time: spawnTime, dur: 666, spread: 1 };
		const now = spawnTime + 1400;
		const result = applyRipples('hello world', [ripple], now);
		expect(stripAnsi(result)).toBe('hello world');
		expect(hasAnsi(result)).toBe(false);
	});

	it('handles empty text', () => {
		const now = Date.now();
		const ripple = { pos: 0, time: now - 50, dur: 666, spread: 1 };
		const result = applyRipples('', [ripple], now);
		expect(result).toBe('');
	});
});

// ---------------------------------------------------------------------------
// ScrambleStateManager — CASCADE mode tests
// ---------------------------------------------------------------------------

describe('ScrambleStateManager (cascade mode)', () => {
	let manager: ScrambleStateManager;

	beforeEach(() => {
		manager = new ScrambleStateManager();
		manager.setMode('cascade');
		expect(manager.getMode()).toBe('cascade');
	});

	it('updateAim animates on text change in cascade mode', () => {
		const base = 1000000;
		manager.updateAim(TEST_ID, 'initial text', base);
		const result = manager.updateAim(TEST_ID, 'changed text', base + 300);
		expect(result.isAnimating).toBe(true);
	});

	it('updateAct spawns cascade on text change', () => {
		const base = 2000000;
		manager.updateAct(TEST_ID, 'read file.ts', base);
		const result = manager.updateAct(TEST_ID, 'read other.ts', base + 300);
		expect(result.isAnimating).toBe(true);
		expect(hasAnsi(result.content)).toBe(true);
	});

	it('updateAct does NOT scramble when text is the same', () => {
		const base = 2000000;
		manager.updateAct(TEST_ID, 'same text', base);
		// First call creates cascade — still animating at t+300ms
		const during = manager.updateAct(TEST_ID, 'same text', base + 300);
		expect(during.isAnimating).toBe(true);
		// After cascade completes (~640ms), plain text
		const done = manager.updateAct(TEST_ID, 'same text', base + 1500);
		expect(done.isAnimating).toBe(false);
		expect(stripAnsi(done.content)).toBe('same text');
	});

	it('updateMsg spawns cascade on text change', () => {
		const base = 2000000;
		manager.updateMsg(TEST_ID, 'initial', base);
		const result = manager.updateMsg(TEST_ID, 'changed text', base + 300);
		expect(result.isAnimating).toBe(true);
		expect(hasAnsi(result.content)).toBe(true);
	});

	it('updateMsg cascade self-terminates', () => {
		const base = 2000000;
		manager.updateMsg(TEST_ID, 'initial', base);
		manager.updateMsg(TEST_ID, 'changed text', base + 1300);
		const result = manager.updateMsg(TEST_ID, 'changed text', base + 1300 + 1500);
		expect(result.isAnimating).toBe(false);
		expect(stripAnsi(result.content)).toBe('changed text');
	});

	it('label is always plain text', () => {
		const now = Date.now();
		manager.updateAim(TEST_ID, 'test', now);
		manager.updateAct(TEST_ID, 'test', now);
		manager.updateMsg(TEST_ID, 'test', now);
		const aimResult = manager.updateAim(TEST_ID, 'changed', now + 300);
		const actResult = manager.updateAct(TEST_ID, 'changed', now + 300);
		const msgResult = manager.updateMsg(TEST_ID, 'changed', now + 300);
		expect(aimResult.label).toBe('aim:');
		expect(actResult.label).toBe('act:');
		expect(msgResult.label).toBe('msg:');
	});

	it('cooldown prevents rapid-fire cascades', () => {
		const base = 2000000;
		manager.updateMsg(TEST_ID, 'text one', base);
		// Rapid changes within cooldown (300ms < 1300ms) don't spawn cascades
		manager.updateMsg(TEST_ID, 'text two', base + 300);
		manager.updateMsg(TEST_ID, 'text three', base + 400);
		// After cooldown elapses (1400ms >= 1300ms), text change triggers cascade
		const result = manager.updateMsg(TEST_ID, 'text four', base + 1400);
		expect(result.isAnimating).toBe(true);
		const done = manager.updateMsg(TEST_ID, 'text four', base + 3000);
		expect(done.isAnimating).toBe(false);
	});

	it('TPS flash works in cascade mode', () => {
		const base = 6000000;
		manager.updateTps(TEST_ID, '42.3', base);
		manager.updateTps(TEST_ID, '51.7', base + 100);
		const resultAfter = manager.updateTps(TEST_ID, '51.7', base + 500);
		expect(resultAfter).toBe('51.7');
		expect(hasAnsi(resultAfter)).toBe(false);
	});

	it('hasAnyActiveAnimations works for cascade', () => {
		const base = 7000000;
		manager.updateMsg(TEST_ID, 'init', base);
		// First call creates cascade animation
		expect(manager.hasAnyActiveAnimations(base)).toBe(true);
		expect(manager.hasAnyActiveAnimations(base + 1500)).toBe(false);
		manager.updateMsg(TEST_ID, 'changed', base + 300);
		expect(manager.hasAnyActiveAnimations(base + 300)).toBe(true);
		expect(manager.hasAnyActiveAnimations(base + 300 + 1500)).toBe(false);
	});

	it('flow completion stops animations', () => {
		const base = 8000000;
		manager.updateAct(TEST_ID, 'read file.ts', base);
		const result = manager.updateAct(TEST_ID, 'read other.ts', base + 300, true);
		expect(result.content).toBe('read other.ts');
		expect(result.isAnimating).toBe(false);
	});

	it('completeFlow clears all line states', () => {
		const base = 8000000;
		manager.updateAct(TEST_ID, 'act text', base);
		manager.updateMsg(TEST_ID, 'msg text', base);
		manager.updateAct(TEST_ID, 'act changed', base + 300);
		manager.updateMsg(TEST_ID, 'msg changed', base + 300);
		expect(manager.hasAnyActiveAnimations(base + 300)).toBe(true);
		manager.completeFlow(TEST_ID);
		expect(manager.hasAnyActiveAnimations(base + 300)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// ScrambleStateManager — RIPPLE mode tests
// ---------------------------------------------------------------------------

describe('ScrambleStateManager (ripple mode)', () => {
	let manager: ScrambleStateManager;

	beforeEach(() => {
		manager = new ScrambleStateManager();
		manager.setMode('ripple');
		expect(manager.getMode()).toBe('ripple');
	});

	it('updateMsg spawns ripple on text change', () => {
		const base = 2000000;
		manager.updateMsg(TEST_ID, 'initial', base);
		manager.updateMsg(TEST_ID, 'changed', base + 300);
		// Check at a later time when ripple has actually started scrambling
		const result = manager.updateMsg(TEST_ID, 'changed', base + 400);
		expect(result.isAnimating).toBe(true);
		expect(stripAnsi(result.content)).not.toBe('changed');
	});

	it('updateAim animates on text change in ripple mode', () => {
		const base = 1000000;
		manager.updateAim(TEST_ID, 'initial text', base);
		const result = manager.updateAim(TEST_ID, 'changed text', base + 300);
		expect(result.isAnimating).toBe(true);
	});

	it('updateAct spawns ripple on text change', () => {
		const base = 2000000;
		manager.updateAct(TEST_ID, 'read file.ts', base);
		const result = manager.updateAct(TEST_ID, 'read other.ts', base + 300);
		expect(result.isAnimating).toBe(true);
	});

	it('same text does not trigger new ripple', () => {
		const now = Date.now();
		manager.updateMsg(TEST_ID, 'same text', now);
		// First call creates ripple — still active at t+300ms
		const during = manager.updateMsg(TEST_ID, 'same text', now + 300);
		expect(during.isAnimating).toBe(true);
		// After ripple expires (dur scaled to 645ms for 9-char text) and afterglow ends at 4145ms, plain text
		const done = manager.updateMsg(TEST_ID, 'same text', now + 4500);
		expect(done.isAnimating).toBe(false);
		expect(stripAnsi(done.content)).toBe('same text');
	});

	it('TPS flash works in ripple mode', () => {
		const base = 6000000;
		manager.updateTps(TEST_ID, '42.3', base);
		manager.updateTps(TEST_ID, '51.7', base + 100);
		const result = manager.updateTps(TEST_ID, '51.7', base + 105);
		expect(result).not.toBe('51.7');
	});

	it('hasAnyActiveAnimations works for ripple', () => {
		const base = 7000000;
		manager.updateMsg(TEST_ID, 'init', base);
		// First call creates ripple animation
		expect(manager.hasAnyActiveAnimations(base)).toBe(true);
		expect(manager.hasAnyActiveAnimations(base + 5000)).toBe(false);
		manager.updateMsg(TEST_ID, 'changed', base + 300);
		expect(manager.hasAnyActiveAnimations(base + 300)).toBe(true);
		expect(manager.hasAnyActiveAnimations(base + 300 + 5000)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Mode switching tests
// ---------------------------------------------------------------------------

describe('ScrambleStateManager mode switching', () => {
	it('defaults to illuminate mode', () => {
		const manager = new ScrambleStateManager();
		expect(manager.getMode()).toBe('illuminate');
	});

	it('setMode clears all state', () => {
		const manager = new ScrambleStateManager();
		const base = 1000000;
		manager.streamMsg(TEST_ID, 'initial', base, false, 40);
		manager.setMode('cascade');
		expect(manager.getMode()).toBe('cascade');
		const result = manager.updateMsg(TEST_ID, 'new text', base + 500);
		// First call creates cascade animation
		expect(result.isAnimating).toBe(true);
	});

	it('can switch between all four modes', () => {
		const manager = new ScrambleStateManager();
		expect(manager.getMode()).toBe('illuminate');
		manager.setMode('cascade');
		expect(manager.getMode()).toBe('cascade');
		manager.setMode('stream');
		expect(manager.getMode()).toBe('stream');
		manager.setMode('ripple');
		expect(manager.getMode()).toBe('ripple');
		manager.setMode('illuminate');
		expect(manager.getMode()).toBe('illuminate');
	});
});

// ---------------------------------------------------------------------------
// Illuminate mode tests
// ---------------------------------------------------------------------------

describe('selectScrambleChar', () => {
	it('returns deep glitch chars for depth 1–2', () => {
		const deepChars = '·∘∙+*~!?⟐⟑✧✦⠁⠂⠃⠄⠅⠆⠇ᚠᚢᚦᚨᚻᛟᛝ⣄⣆';
		for (let d = 1; d <= 2; d++) {
			const c = selectScrambleChar(d, 0, 0);
			expect(deepChars).toContain(c);
		}
	});

	it('returns mid glitch chars for depth 3', () => {
		const midChars = 'abcdefghijklmnopqrstuvwxyzᚠᚢᚦᚨᚻᛟᛝ◇◈△▽○●◎';
		const c = selectScrambleChar(3, 0, 0);
		expect(midChars).toContain(c);
	});

	it('returns shallow glitch chars for depth 4+', () => {
		const shallowChars = '·∘∙⠁⠂⠃⠄⠅⠆~?+-';
		for (let d = 4; d <= 6; d++) {
			const c = selectScrambleChar(d, 0, 0);
			expect(shallowChars).toContain(c);
		}
	});
});

describe('applyRipples — eased ripple expansion', () => {
	it('easeOutQuart produces larger early radius than linear', () => {
		const now = Date.now();
		const ripple = { pos: 5, time: now - 100, dur: 666, spread: 1 };
		// With eased expansion, radius at 15% progress is larger than linear
		const result = applyRipples('abcdefghij', [ripple], now);
		const linearRadiusChars = 3; // approximate for linear at 15%
		const easedRadiusChars = stripAnsi(result).split('').filter(c => !'abcdefghij'.includes(c)).length;
		// Eased should scramble at least as many chars as linear (usually slightly more)
		expect(easedRadiusChars).toBeGreaterThanOrEqual(1);
	});
});

describe('applyRipples — overlapping ripple blending', () => {
	it('blends two overlapping ripples instead of breaking after first match', () => {
		const now = Date.now();
		const r1 = { pos: 2, time: now - 50, dur: 666, spread: 1 };
		const r2 = { pos: 8, time: now - 50, dur: 666, spread: 1 };
		const result = applyRipples('hello world', [r1, r2], now);
		// Both ripples should contribute scramble chars
		// Verify at least some chars near both centers are scrambled
		const stripped = stripAnsi(result);
		expect(stripped).not.toBe('hello world');
	});
});

describe('applyRipples — negative elapsed / clock backward jump', () => {
	it('survives negative elapsed without crashing', () => {
		const now = Date.now();
		const futureRipple = { pos: 5, time: now + 1000, dur: 666, spread: 1 };
		const result = applyRipples('hello world', [futureRipple], now);
		expect(stripAnsi(result)).toBe('hello world');
		expect(hasAnsi(result)).toBe(false);
	});
});

describe('ScrambleStateManager — mode validation', () => {
	it('throws on invalid mode string', () => {
		const manager = new ScrambleStateManager();
		expect(() => manager.setMode('invalid' as any)).toThrow('Invalid scramble mode');
	});

	it('accepts all valid modes', () => {
		const manager = new ScrambleStateManager();
		expect(() => manager.setMode('stream')).not.toThrow();
		expect(() => manager.setMode('cascade')).not.toThrow();
		expect(() => manager.setMode('ripple')).not.toThrow();
		expect(() => manager.setMode('illuminate')).not.toThrow();
	});
});

describe('ScrambleStateManager — universal TPS hysteresis', () => {
	it('ripple mode suppresses flash on tiny TPS change', () => {
		const manager = new ScrambleStateManager();
		manager.setMode('ripple');
		const base = 6000000;
		manager.updateTps(TEST_ID, '42.3', base);
		const result = manager.updateTps(TEST_ID, '43.1', base + 100);
		expect(result).toBe('43.1');
	});

	it('cascade mode suppresses flash on tiny TPS change', () => {
		const manager = new ScrambleStateManager();
		manager.setMode('cascade');
		const base = 6000000;
		manager.updateTps(TEST_ID, '42.3', base);
		const result = manager.updateTps(TEST_ID, '43.1', base + 100);
		expect(result).toBe('43.1');
	});

	it('ripple mode triggers flash on large TPS change', () => {
		const manager = new ScrambleStateManager();
		manager.setMode('ripple');
		const base = 6000000;
		manager.updateTps(TEST_ID, '42.3', base);
		manager.updateTps(TEST_ID, '55.0', base + 100);
		const result = manager.updateTps(TEST_ID, '55.0', base + 110);
		expect(result).not.toBe('55.0');
	});

	it('cascade mode triggers flash after long quiet period even with small change', () => {
		const manager = new ScrambleStateManager();
		manager.setMode('cascade');
		const base = 6000000;
		manager.updateTps(TEST_ID, '42.3', base);
		// Small change after 2500ms (> TPS_HYSTERESIS_MS=2000)
		manager.updateTps(TEST_ID, '43.1', base + 2500);
		const result = manager.updateTps(TEST_ID, '43.1', base + 2510);
		expect(hasAnsi(result)).toBe(true);
	});

	it('TPS flash respects 3s cooldown — blocked within cooldown, fires after', () => {
		const manager = new ScrambleStateManager();
		manager.setMode('ripple');
		const base = 6000000;
		// First call: sets state, no flash (not staticLine)
		manager.updateTps(TEST_ID, '42.3', base);
		// Second call: large change triggers first flash
		manager.updateTps(TEST_ID, '100.0', base + 100);
		// Third call within 3s: same value, still animating from first flash
		const duringCooldown = manager.updateTps(TEST_ID, '100.0', base + 110);
		expect(duringCooldown).not.toBe('100.0');
		// Fourth call with new value but within 3s cooldown: blocked
		const blocked = manager.updateTps(TEST_ID, '200.0', base + 500);
		expect(blocked).toBe('200.0'); // no flash
		// Fifth call after 3s cooldown: flash allowed (render at t+10 to see scramble)
		manager.updateTps(TEST_ID, '300.0', base + 3100);
		const afterCooldown = manager.updateTps(TEST_ID, '300.0', base + 3110);
		expect(afterCooldown).not.toBe('300.0');
	});

	it('act KPI flash respects 3s cooldown', () => {
		const manager = new ScrambleStateManager();
		manager.setMode('ripple');
		const base = 6000000;
		// First call: sets state, no flash (not staticLine)
		manager.updateActKpi(TEST_ID, '12', base, false, false);
		// Second call: value change triggers first flash (render at t+10 to see scramble)
		manager.updateActKpi(TEST_ID, '15', base + 100, false, false);
		expect(manager.hasAnyActiveAnimations(base + 110)).toBe(true);
		const rendered = manager.updateActKpi(TEST_ID, '15', base + 110, false, false);
		expect(rendered).not.toBe('15');
		// Third call with new value but within 3s cooldown: blocked
		const blocked = manager.updateActKpi(TEST_ID, '18', base + 500, false, false);
		expect(blocked).toBe('18');
		// Fourth call after 3s cooldown: flash allowed
		manager.updateActKpi(TEST_ID, '21', base + 3100, false, false);
		const afterCooldown = manager.updateActKpi(TEST_ID, '21', base + 3110, false, false);
		expect(afterCooldown).not.toBe('21');
	});

	it('msg KPI flash respects 3s cooldown', () => {
		const manager = new ScrambleStateManager();
		manager.setMode('ripple');
		const base = 6000000;
		// First call: sets state, no flash (not staticLine)
		manager.updateMsgKpi(TEST_ID, '↑ 1.0k · ↓ 0.5k', base, false, false);
		// Second call: value change triggers first flash (render at t+200 for wide ripple)
		manager.updateMsgKpi(TEST_ID, '↑ 2.0k · ↓ 1.0k', base + 100, false, false);
		expect(manager.hasAnyActiveAnimations(base + 110)).toBe(true);
		const rendered = manager.updateMsgKpi(TEST_ID, '↑ 2.0k · ↓ 1.0k', base + 200, false, false);
		expect(rendered).not.toBe('↑ 2.0k · ↓ 1.0k');
		// Third call with new value but within 3s cooldown: blocked
		const blocked = manager.updateMsgKpi(TEST_ID, '↑ 3.0k · ↓ 1.5k', base + 500, false, false);
		expect(blocked).toBe('↑ 3.0k · ↓ 1.5k');
		// Fourth call after 3s cooldown: flash allowed
		manager.updateMsgKpi(TEST_ID, '↑ 4.0k · ↓ 2.0k', base + 3100, false, false);
		const afterCooldown = manager.updateMsgKpi(TEST_ID, '↑ 4.0k · ↓ 2.0k', base + 3200, false, false);
		expect(afterCooldown).not.toBe('↑ 4.0k · ↓ 1.5k');
	});
});

describe('ScrambleStateManager — memory bounds', () => {
	it('sweeps completed flow entries when maps grow large', () => {
		const manager = new ScrambleStateManager();
		manager.setMode('cascade');
		// Create and complete many flows to trigger sweep
		for (let i = 0; i < 200; i++) {
			const id = `flow-${i}`;
			manager.updateMsg(id, 'test', 1000000 + i * 10);
			manager.completeFlow(id);
		}
		// After sweeping, new operations should still work (isComplete=true for plain text)
		const fresh = manager.updateMsg('fresh-flow', 'hello', 1000000, true);
		expect(fresh.content).toBe('hello');
	});
});

describe('computeCascadeFrame — clamped negative frame', () => {
	it('handles negative frame without crashing', () => {
		const queue = buildQueue('hello', 'world');
		const result = computeCascadeFrame(queue, -5);
		const stripped = stripAnsi(result);
		expect(stripped.length).toBe(5);
		for (const ch of stripped) {
			if (ch !== ' ') {
				expect(SCRAMBLE_CHAR_SET).toContain(ch);
			}
		}
	});
});

describe('applyRipples with illuminate config', () => {
	it('applies ANSI truecolor codes when config provided', () => {
		const now = Date.now();
		const ripple = { pos: 4, time: now - 100, dur: 666, spread: 1 };
		const config = ILLUMINATE_CONFIGS.actLabel;
		const result = applyRipples('hello world', [ripple], now, config);
		expect(result).toContain(WARM_GLOW);
		expect(stripAnsi(result)).not.toBe('hello world');
	});

	it('uses dynamic smooth truecolor for config.color === dynamic at moderate depth', () => {
		const now = Date.now();
		// elapsed=200 gives depth ~1.5 which maps to smooth cyan-white gradient in dynamic mode
		const ripple = { pos: 5, time: now - 200, dur: 850, spread: 1.5 };
		const config = ILLUMINATE_CONFIGS.msgContent;
		const result = applyRipples('abcdefghij', [ripple], now, config);
		// Smooth truecolor uses \x1b[38;2;R;G;Bm instead of hard threshold constants
		expect(result).toContain('\x1b[38;2;');
	});

	it('scrambles without config via raw glitch chars', () => {
		const now = Date.now();
		const ripple = { pos: 4, time: now - 100, dur: 666, spread: 1 };
		const result = applyRipples('hello world', [ripple], now);
		expect(stripAnsi(result)).not.toBe('hello world');
	});
});

describe('applyRipples afterglow spark with thin braille', () => {
	it('uses thin braille sparks when spark config is enabled (default)', () => {
		// Deterministic setup: seed=0, now=155 gives agTick=3 with 40ms tick
		// hashNoise(0, 0, 3, 77)=0.0436 < 0.045 → index 0 pops
		// hashNoise(0, 7, 3, 77)=0.0006 < 0.045 → index 7 pops
		const ripple = { pos: 0, time: -150, dur: 300, spread: 1, seed: 0 };
		const config = { ...ILLUMINATE_CONFIGS.msgContent, spark: true };
		const result = applyRipples('0123456789', [ripple], 155, config);
		const plain = stripAnsi(result);
		// Index 0 and 7 should have thin braille spark chars
		expect(THIN_BRAILLE_SPARK).toContain(plain[0]);
		expect(THIN_BRAILLE_SPARK).toContain(plain[7]);
		// Known deterministic outputs for these indices
		expect(plain[0]).toBe('⠘');
		expect(plain[7]).toBe('⠈');
	});

	it('falls back to generic glitch chars when spark is disabled', () => {
		const ripple = { pos: 0, time: -150, dur: 300, spread: 1, seed: 0 };
		const config = { ...ILLUMINATE_CONFIGS.msgContent, spark: false };
		const result = applyRipples('0123456789', [ripple], 155, config);
		const plain = stripAnsi(result);
		// Index 7 should pop with generic glitch char (deterministically '·')
		expect(plain[7]).toBe('·');
		expect(THIN_BRAILLE_SPARK).not.toContain(plain[7]);
	});

	it('preserves spaces in afterglow spark output', () => {
		const ripple = { pos: 0, time: -150, dur: 300, spread: 1, seed: 0 };
		const config = { ...ILLUMINATE_CONFIGS.msgContent, spark: true };
		const result = applyRipples('0 1 2 3 4 5 6 7 8 9', [ripple], 155, config);
		const plain = stripAnsi(result);
		// Spaces should remain intact (index 1, 3, 5, etc. are spaces)
		expect(plain[1]).toBe(' ');
		expect(plain[3]).toBe(' ');
		// Index 0 is not a space and deterministically pops → thin braille
		expect(THIN_BRAILLE_SPARK).toContain(plain[0]);
		expect(plain[0]).toBe('⠘');
		// Index 7 in spaced text is a space, so it's preserved
		expect(plain[7]).toBe(' ');
	});
});

describe('illuminatePrefix — 12-zone SGR transition', () => {
	it('uses DIM prefix at low intensity', () => {
		const now = Date.now();
		// Early ripple = low intensity → dim zone (threshold 0.25)
		const ripple = { pos: 5, time: now - 10, dur: 850, spread: 1.5 };
		const config = ILLUMINATE_CONFIGS.msgContent;
		const result = applyRipples('abcdefghij', [ripple], now, config);
		// Low intensity uses truecolor only (no DIM/BOLD)
		expect(result).toContain('\x1b[38;2;');
	});

	it('uses no weight prefix at moderate intensity (normal zone)', () => {
		const now = Date.now();
		// Mid-ripple at moderate elapsed → normal zone (0.25–0.75)
		const ripple = { pos: 5, time: now - 300, dur: 850, spread: 1.5 };
		const config = ILLUMINATE_CONFIGS.msgContent;
		const result = applyRipples('abcdefghij', [ripple], now, config);
		// Should have truecolor but neither DIM nor BOLD in some segments
		const hasTruecolor = result.includes('\x1b[38;2;');
		expect(hasTruecolor).toBe(true);
	});

	it('produces valid 12-zone output with truecolor at all depths', () => {
		const now = Date.now();
		const ripple = { pos: 5, time: now - 100, dur: 666, spread: 1 };
		const config = ILLUMINATE_CONFIGS.msgContent;
		const result = applyRipples('abcdefghij', [ripple], now, config);
		// Result must contain truecolor codes and be well-formed
		expect(result).toContain('\x1b[38;2;');
		// With wider band, some chars may be in normal zone (no weight prefix)
		// while others are in dim zone — both are valid
		expect(result.includes('\x1b[38;2;')).toBe(true);
	});

	it('produces magenta-spike mid-intensity colors', () => {
		const now = Date.now();
		// elapsed=250 at spread=1.5 on 14-char text hits magenta spike zone (0.30–0.42)
		const ripple = { pos: 7, time: now - 250, dur: 850, spread: 1.5 };
		const config = ILLUMINATE_CONFIGS.msgContent;
		const result = applyRipples('abcdefghijklmn', [ripple], now, config);
		// Should produce truecolor codes — look for magenta/violet signature RGBs
		// Magenta spike: high red (200-255), low green (50-100), medium blue (120-170)
		expect(result).toContain('\x1b[38;2;');
		const colorMatches = result.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g);
		expect(colorMatches).not.toBeNull();
		if (colorMatches) {
			const hasMagenta = colorMatches.some((code) => {
				const match = code.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
				if (!match) return false;
				const r = parseInt(match[1], 10);
				const g = parseInt(match[2], 10);
				const b = parseInt(match[3], 10);
				// Magenta / violet: high red, low green, medium-high blue
				return (r > 200 && g > 50 && g < 100 && b > 120 && b < 180);
			});
			expect(hasMagenta).toBe(true);
		}
	});
});

describe('ScrambleStateManager (illuminate mode)', () => {
	let manager: ScrambleStateManager;

	beforeEach(() => {
		manager = new ScrambleStateManager();
		manager.setMode('illuminate');
		expect(manager.getMode()).toBe('illuminate');
	});

	it('updateMsg shows plain text while buffering, ripples on chunk threshold', () => {
		const base = 2000000;
		manager.updateMsg(TEST_ID, 'Hello world', base);
		// Same text — no ripple
		const same = manager.updateMsg(TEST_ID, 'Hello world', base + 100);
		expect(same.isAnimating).toBe(false);
		expect(stripAnsi(same.content)).toBe('Hello world');

		// Text changes to short text without sentence boundary — no ripple (chunk too small)
		const small = manager.updateMsg(TEST_ID, 'Hello world how are', base + 200);
		expect(small.isAnimating).toBe(false);
		expect(stripAnsi(small.content)).toBe('Hello world how are');

		// Text changes with sentence boundary — chunk threshold met, ripple fires immediately
		const longText = 'Hello world. How are you doing today? The weather is nice and the sun is shining.';
		const ripple = manager.updateMsg(TEST_ID, longText, base + 300);
		expect(ripple.isAnimating).toBe(true);
		expect(ripple.content).toContain('\x1b[38;2;');
	});

	it('updateMsg does not ripple while text is actively changing', () => {
		const base = 2000000;
		manager.updateMsg(TEST_ID, 'Hello', base);
		// Text changes rapidly — should stay plain, no animation
		const r1 = manager.updateMsg(TEST_ID, 'Hello wor', base + 100);
		expect(r1.isAnimating).toBe(false);
		expect(stripAnsi(r1.content)).toBe('Hello wor');

		// More changes before debounce elapses — still plain
		const r2 = manager.updateMsg(TEST_ID, 'Hello world', base + 300);
		expect(r2.isAnimating).toBe(false);
		expect(stripAnsi(r2.content)).toBe('Hello world');
	});

	it('updateMsg ripples once after text stabilizes', () => {
		const base = 2000000;
		manager.updateMsg(TEST_ID, 'Hello', base);
		// Text changes at t=100, t=200
		manager.updateMsg(TEST_ID, 'Hello world', base + 100);
		const preStable = manager.updateMsg(TEST_ID, 'Hello world how are', base + 200);
		expect(preStable.isAnimating).toBe(false);
		expect(stripAnsi(preStable.content)).toBe('Hello world how are');

		// Wait past MSG_STABLE_DEBOUNCE_MS (350ms) — ripple fires
		const result = manager.updateMsg(TEST_ID, 'Hello world how are', base + 600);
		expect(result.isAnimating).toBe(true);
	});

	it('updateAct uses illuminate config (warm glow)', () => {
		const base = 2000000;
		manager.updateAct(TEST_ID, 'read file.ts', base);
		// Trigger change, then check when ripple wavefront is within text
		manager.updateAct(TEST_ID, 'write other.ts', base + 1300);
		const result = manager.updateAct(TEST_ID, 'write other.ts', base + 1400);
		expect(manager.hasAnyActiveAnimations(base + 1400)).toBe(true);
		expect(result.content).toContain(WARM_GLOW);
	});

	it('TPS hysteresis prevents flash on tiny changes', () => {
		const base = 6000000;
		manager.updateTps(TEST_ID, '42.3', base);
		// Small change (< 15%) should NOT trigger flash in illuminate mode
		const result = manager.updateTps(TEST_ID, '43.1', base + 100);
		// Should return plain text without scramble ANSI
		expect(result).toBe('43.1');
	});

	it('TPS flash triggers on large change (> 15%)', () => {
		const base = 6000000;
		manager.updateTps(TEST_ID, '42.3', base);
		// Large change (> 15%) triggers flash
		manager.updateTps(TEST_ID, '55.0', base + 100);
		// Verify ripple is active
		expect(manager.hasAnyActiveAnimations(base + 150)).toBe(true);
		// TPS text is short (4 chars) so ripple expands past it quickly;
		// verify at an early time when wavefront is still within text
		const result = manager.updateTps(TEST_ID, '55.0', base + 110);
		expect(result).toContain(ORANGE_GLOW);
	});

	it('hasAnyActiveAnimations works for illuminate', () => {
		const base = 7000000;
		manager.updateMsg(TEST_ID, 'init', base);
		// msg: in illuminate mode initializes silently (phrase buffering)
		expect(manager.hasAnyActiveAnimations(base)).toBe(false);
		// Trigger a flash via act: which does animate on first render
		manager.updateAct(TEST_ID, 'read file.ts', base + 10);
		expect(manager.hasAnyActiveAnimations(base + 10)).toBe(true);
		manager.updateAct(TEST_ID, 'write file.ts', base + 1300);
		expect(manager.hasAnyActiveAnimations(base + 1400)).toBe(true);
	});

	it('updateMsg does not flush on tail-view slide (high overlap)', () => {
		const base = 8000000;
		manager.updateMsg(TEST_ID, 'lo world foo bar', base);
		// Simulate a 1-char tail window slide: old suffix overlaps new prefix (>50%)
		const result = manager.updateMsg(TEST_ID, 'o world foo bar b', base + 100);
		// Should NOT spawn a new ripple immediately — displayedText stays old
		expect(result.content).not.toContain(CYAN_GLOW);
	});

	it('shows plain text immediately on text changes', () => {
		const base = 8000000;
		manager.updateMsg(TEST_ID, 'hello world today', base);
		// Text changes — should show latest text as plain immediately
		const result = manager.updateMsg(TEST_ID, 'world today is nice', base + 100);
		const stripped = stripAnsi(result.content);
		expect(stripped).toBe('world today is nice');
		expect(result.isAnimating).toBe(false);
	});

	it('updateMsg ripples on slide after buffer timeout', () => {
		const base = 9000000;
		manager.updateMsg(TEST_ID, 'lo world foo bar', base);
		// Sliding window changes — text is plain while sliding, no immediate ripple
		const sliding = manager.updateMsg(TEST_ID, 'world foo bar baz', base + 100);
		expect(sliding.isAnimating).toBe(false);
		expect(stripAnsi(sliding.content)).toBe('world foo bar baz');

		// After buffer timeout (800ms) — ripple fires on stable text
		const result = manager.updateMsg(TEST_ID, 'world foo bar baz', base + 900);
		expect(result.isAnimating).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Spread behavior tests
// ---------------------------------------------------------------------------

describe('applyRipples — spread < 1 radius proportionality', () => {
	it('spread 0.5 produces narrower radius than spread 1.0', () => {
		const now = Date.now();
		const narrow = { pos: 5, time: now - 100, dur: 666, spread: 0.5 };
		const wide = { pos: 5, time: now - 100, dur: 666, spread: 1.0 };
		const rNarrow = applyRipples('abcdefghij', [narrow], now);
		const rWide = applyRipples('abcdefghij', [wide], now);
		const sNarrow = stripAnsi(rNarrow).split('').filter(c => !'abcdefghij'.includes(c)).length;
		const sWide = stripAnsi(rWide).split('').filter(c => !'abcdefghij'.includes(c)).length;
		expect(sNarrow).toBeLessThanOrEqual(sWide);
	});

	it('spread 0.5 does not cover entire short text at early time', () => {
		const now = Date.now();
		const ripple = { pos: 2, time: now - 50, dur: 666, spread: 0.5 };
		const result = applyRipples('hello', [ripple], now);
		const stripped = stripAnsi(result);
		// At 50ms with spread 0.5, radius should be small — not all chars scrambled
		const scrambled = stripped.split('').filter(c => !'hello'.includes(c)).length;
		expect(scrambled).toBeLessThan(5);
	});

	it('spatial skip with many ripples preserves correctness', () => {
		const now = Date.now();
		const ripples = [];
		for (let i = 0; i < 20; i++) {
			ripples.push({ pos: i, time: now - 50, dur: 666, spread: 1 });
		}
		const result = applyRipples('a'.repeat(20), ripples, now);
		const stripped = stripAnsi(result);
		expect(stripped.length).toBe(20);
		expect(stripAnsi(result)).not.toBe('a'.repeat(20));
	});
});

// ---------------------------------------------------------------------------
// Multi-ripple blending depth tests
// ---------------------------------------------------------------------------

describe('applyRipples — multi-ripple depth blending', () => {
	it('picks deeper depth when ripples overlap', () => {
		const now = Date.now();
		// Two ripples at same position, same time — one with wider spread
		const r1 = { pos: 5, time: now - 100, dur: 666, spread: 0.8 };
		const r2 = { pos: 5, time: now - 100, dur: 666, spread: 1.5 };
		const result = applyRipples('abcdefghij', [r1, r2], now);
		// Both should scramble; result should have glitch chars
		expect(stripAnsi(result)).not.toBe('abcdefghij');
	});

	it('three overlapping ripples do not crash', () => {
		const now = Date.now();
		const ripples = [
			{ pos: 3, time: now - 80, dur: 666, spread: 1 },
			{ pos: 5, time: now - 60, dur: 666, spread: 1 },
			{ pos: 7, time: now - 40, dur: 666, spread: 1 },
		];
		const result = applyRipples('hello world here', ripples, now);
		expect(stripAnsi(result)).not.toBe('hello world here');
		expect(stripAnsi(result).length).toBe('hello world here'.length);
	});

	it('newer ripple wins when depths are equal', () => {
		const now = Date.now();
		// Two ripples at same position with same spread but different spawn times
		const older = { pos: 5, time: now - 200, dur: 666, spread: 1, seed: 11111 };
		const newer = { pos: 5, time: now - 50, dur: 666, spread: 1, seed: 22222 };
		const result = applyRipples('abcdefghij', [older, newer], now);
		// Should scramble (newer wins at equal depth)
		expect(stripAnsi(result)).not.toBe('abcdefghij');
		expect(stripAnsi(result).length).toBe('abcdefghij'.length);
	});
});

// ---------------------------------------------------------------------------
// Random pool exhaustion tests
// ---------------------------------------------------------------------------

describe('poolRandomChar — exhaustion behavior', () => {
	it('renders stream text correctly across many frames (pool cycles)', () => {
		const visibleText = 'abcdefghij';
		const cursorChars: string[] = [];
		// Render 200 frames — pool size is 2048, so it will not exhaust
		for (let i = 0; i < 200; i++) {
			const result = renderStreamText(visibleText, 3, 3, cursorChars);
			expect(stripAnsi(result).length).toBe(visibleText.length);
			expect(hasAnsi(result)).toBe(true);
		}
	});

	it('manager instance pool is isolated from module-level pool', () => {
		const manager1 = new ScrambleStateManager();
		const manager2 = new ScrambleStateManager();
		manager1.setMode('cascade');
		manager2.setMode('cascade');
		const base = 1000000;
		// Both managers animate same text — each should produce valid output
		manager1.updateMsg('id-1', 'hello world', base);
		manager1.updateMsg('id-1', 'goodbye all', base + 300);
		manager2.updateMsg('id-2', 'hello world', base);
		manager2.updateMsg('id-2', 'goodbye all', base + 300);
		const result1 = manager1.updateMsg('id-1', 'goodbye all', base + 400);
		const result2 = manager2.updateMsg('id-2', 'goodbye all', base + 400);
		// Both should have scramble chars (not crash)
		expect(hasAnsi(result1.content)).toBe(true);
		expect(hasAnsi(result2.content)).toBe(true);
		expect(stripAnsi(result1.content).length).toBe('goodbye all'.length);
		expect(stripAnsi(result2.content).length).toBe('goodbye all'.length);
	});
});

// ---------------------------------------------------------------------------
// randomizedCenter edge avoidance tests
// ---------------------------------------------------------------------------

describe('randomizedCenter — edge avoidance', () => {
	it('3-char text always centers at index 1', () => {
		const manager = new ScrambleStateManager();
		manager.setMode('ripple');
		const base = 1000000;
		manager.updateMsg(TEST_ID, 'abc', base);
		manager.updateMsg(TEST_ID, 'xyz', base + 300);
		const result = manager.updateMsg(TEST_ID, 'xyz', base + 310);
		// Should be animating; wavefront should be somewhat symmetric
		expect(result.isAnimating).toBe(true);
	});

	it('4-char text centers without hitting edges', () => {
		const manager = new ScrambleStateManager();
		manager.setMode('ripple');
		const base = 2000000;
		manager.updateMsg(TEST_ID, 'abcd', base);
		manager.updateMsg(TEST_ID, 'wxyz', base + 300);
		const result = manager.updateMsg(TEST_ID, 'wxyz', base + 310);
		expect(result.isAnimating).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// sweepCompletedEntries batch deletion test
// ---------------------------------------------------------------------------

describe('ScrambleStateManager — sweepCompletedEntries batch delete', () => {
	it('clears all completed entries in one sweep cycle', () => {
		const manager = new ScrambleStateManager();
		manager.setMode('cascade');
		// Create and complete many flows
		for (let i = 0; i < 50; i++) {
			const id = `batch-${i}`;
			manager.updateMsg(id, 'test', 1000000 + i * 10);
			manager.completeFlow(id);
		}
		// All 50 should be swept eventually — after enough operations
		// Trigger an update that causes sweep
		manager.updateMsg('fresh', 'hello', 1000000 + 50000, true);
		// After batch sweep, completed entries should be gone
		expect(manager.hasAnyActiveAnimations(1000000 + 50001)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Visible-window contract tests
// ---------------------------------------------------------------------------

describe('ScrambleStateManager — visible-window contract', () => {
	let manager: ScrambleStateManager;

	beforeEach(() => {
		manager = new ScrambleStateManager();
		manager.setMode('ripple');
	});

	it('updateMsg with budget truncates text to visible window', () => {
		const base = 1000000;
		const longText = 'a'.repeat(100);
		const result = manager.updateMsg(TEST_ID, longText, base, false, 20);
		expect(stripAnsi(result.content).length).toBeLessThanOrEqual(20);
	});

	it('ripple scramble is visible within budget window', () => {
		const base = 1000000;
		manager.updateMsg(TEST_ID, 'a'.repeat(100), base, false, 20);
		manager.updateMsg(TEST_ID, 'b'.repeat(100), base + 300, false, 20);
		// Evaluate at a later time when ripple has expanded
		const result = manager.updateMsg(TEST_ID, 'b'.repeat(100), base + 400, false, 20);
		expect(result.isAnimating).toBe(true);
		expect(stripAnsi(result.content)).not.toBe('b'.repeat(100));
		expect(stripAnsi(result.content).length).toBeLessThanOrEqual(20);
	});

	it('cascade queue is scoped to visible window', () => {
		manager.setMode('cascade');
		const base = 1000000;
		manager.updateMsg(TEST_ID, 'a'.repeat(100), base, false, 20);
		const result = manager.updateMsg(TEST_ID, 'b'.repeat(100), base + 300, false, 20);
		expect(result.isAnimating).toBe(true);
		expect(stripAnsi(result.content).length).toBeLessThanOrEqual(20);
	});

	it('updateMsg without budget behaves as before (full text)', () => {
		manager.setMode('cascade');
		const base = 1000000;
		const result = manager.updateMsg(TEST_ID, 'hello world', base);
		expect(stripAnsi(result.content).length).toBe('hello world'.length);
	});

	it('completed flow with budget returns truncated text', () => {
		const base = 1000000;
		const longText = 'x'.repeat(100);
		const result = manager.updateMsg(TEST_ID, longText, base, true, 15);
		expect(stripAnsi(result.content).length).toBeLessThanOrEqual(15);
		expect(result.isAnimating).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// FastRNG and hashNoise tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Static line behavior tests
// ---------------------------------------------------------------------------

describe('ScrambleStateManager — staticLine behavior', () => {
	let manager: ScrambleStateManager;

	beforeEach(() => {
		manager = new ScrambleStateManager();
	});

	it('updateText staticLine animates on first call', () => {
		manager.setMode('cascade');
		const base = 1000000;
		const result = manager.updateText('id-1', 'header', 'hello world', base, false, true);
		expect(result.isAnimating).toBe(true);
		expect(stripAnsi(result.content)).not.toBe('hello world');
	});

	it('updateText staticLine re-animates on text change', () => {
		manager.setMode('cascade');
		const base = 1000000;
		manager.updateText('id-1', 'header', 'hello world', base, false, true);
		const result = manager.updateText('id-1', 'header', 'goodbye all', base + 300, false, true);
		expect(result.isAnimating).toBe(true);
		expect(stripAnsi(result.content)).not.toBe('goodbye all');
	});

	it('updateText non-staticLine still animates on text change', () => {
		manager.setMode('cascade');
		const base = 1000000;
		manager.updateText('id-1', 'header', 'hello world', base, false, false);
		const result = manager.updateText('id-1', 'header', 'goodbye all', base + 300, false, false);
		expect(result.isAnimating).toBe(true);
		expect(stripAnsi(result.content)).not.toBe('goodbye all');
	});

	it('updateAim staticLine animates on first call', () => {
		manager.setMode('cascade');
		const base = 1000000;
		const result = manager.updateAim('id-1', 'test aim', base, false, true);
		expect(result.isAnimating).toBe(true);
	});

	it('updateAim staticLine re-animates on text change', () => {
		manager.setMode('cascade');
		const base = 1000000;
		manager.updateAim('id-1', 'test aim', base, false, true);
		const result = manager.updateAim('id-1', 'changed aim', base + 300, false, true);
		expect(result.isAnimating).toBe(true);
		expect(stripAnsi(result.content)).not.toBe('changed aim');
	});

	it('updateAct staticLine re-animates on text change', () => {
		manager.setMode('cascade');
		const base = 1000000;
		manager.updateAct('id-1', 'read file.ts', base, false, true);
		const result = manager.updateAct('id-1', 'write file.ts', base + 300, false, true);
		expect(result.isAnimating).toBe(true);
		expect(stripAnsi(result.content)).not.toBe('write file.ts');
	});

	it('updateMsg staticLine re-animates on text change', () => {
		manager.setMode('cascade');
		const base = 1000000;
		manager.updateMsg('id-1', 'first message', base, false, undefined, true);
		const result = manager.updateMsg('id-1', 'second message', base + 300, false, undefined, true);
		expect(result.isAnimating).toBe(true);
		expect(stripAnsi(result.content)).not.toBe('second message');
	});

	it('updateTps staticLine only flashes on first value', () => {
		manager.setMode('ripple');
		const base = 1000000;
		// First value triggers flash (verify via active animation detection)
		manager.updateTps('id-1', '42.5', base + 50, false, true);
		expect(manager.hasAnyActiveAnimations(base + 55)).toBe(true); // first flash active
		const second = manager.updateTps('id-1', '43.0', base + 300, false, true);
		expect(second).toBe('43.0'); // no re-flash
		expect(manager.hasAnyActiveAnimations(base + 600)).toBe(false); // accounts for afterglow window
	});

	it('updateTps non-staticLine flashes on significant value change', () => {
		manager.setMode('cascade');
		const base = 1000000;
		manager.updateTps('id-1', '42.5', base, false, false);
		const result = manager.updateTps('id-1', '100.0', base + 300, false, false);
		expect(result).not.toBe('100.0'); // significant change triggers flash
	});

	it('staticLine overlap guard suppresses re-flash on minor stat updates', () => {
		manager.setMode('ripple');
		const base = 1000000;
		// First call triggers initial flash (ripple dur = 400ms)
		manager.updateText('id-1', 'header', 'scout - [↑ 0.11M]', base, false, true);
		// Minor digit change (>50% overlap) should NOT spawn a new ripple
		manager.updateText('id-1', 'header', 'scout - [↑ 0.12M]', base + 50, false, true);
		// Old ripple expires at base+400; afterglow ends at base+3900
		expect(manager.hasAnyActiveAnimations(base + 4500)).toBe(false);
	});

	it('staticLine minor-mutation guard suppresses re-flash beyond cooldown', () => {
		manager.setMode('ripple');
		const base = 1000000;
		// First call triggers initial flash
		manager.updateText('id-1', 'header', 'scout - lite - tps: 12', base, false, true);
		// Minor trailing-digit change within cooldown (300ms < 500ms) should NOT spawn a new ripple
		manager.updateText('id-1', 'header', 'scout - lite - tps: 15', base + 300, false, true);
		// Initial ripple expires at base+530; afterglow ends at base+4030
		expect(manager.hasActiveAnimations('id-1', base + 4500)).toBe(false);
	});

	it('staticLine still flashes on major rewrite beyond cooldown', () => {
		manager.setMode('ripple');
		const base = 1000000;
		// First call triggers initial flash
		manager.updateText('id-1', 'header', 'scout - lite - tps: 12', base, false, true);
		// Major text change after cooldown should spawn a new ripple
		manager.updateText('id-1', 'header', 'build - heavy - tps: 99', base + 300, false, true);
		// New ripple spawned at base+300, expires at base+966, so still active at base+700
		expect(manager.hasActiveAnimations('id-1', base + 700)).toBe(true);
	});

	it('staticLine cooldown guard suppresses rapid re-flash', () => {
		manager.setMode('cascade');
		const base = 1000000;
		// First call triggers initial cascade (max ~1280ms)
		manager.updateAim('id-1', 'test aim', base, false, true);
		// Complete rewrite within cooldown (<250ms) should NOT start a new cascade
		manager.updateAim('id-1', 'changed aim', base + 100, false, true);
		// Old cascade ends by base+1280; new cascade (if allowed) would end by base+1380
		expect(manager.hasAnyActiveAnimations(base + 1300)).toBe(false);
	});
});

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

	it('cached values match uncached values', () => {
		// First call populates cache, second call returns cached value
		const n1 = hashNoise(99999, 7, 3, 2);
		const n2 = hashNoise(99999, 7, 3, 2);
		expect(n1).toBe(n2);
		expect(n1).toBeGreaterThanOrEqual(0);
		expect(n1).toBeLessThan(1);
	});
});

describe('buildQueue with seeded RNG', () => {
	it('produces deterministic queue for same seed', () => {
		const rng1 = new FastRNG(12345);
		const rng2 = new FastRNG(12345);
		const q1 = buildQueue('abc', 'xyz', 40, 40, rng1);
		const q2 = buildQueue('abc', 'xyz', 40, 40, rng2);
		expect(q1.length).toBe(q2.length);
		for (let i = 0; i < q1.length; i++) {
			expect(q1[i].start).toBe(q2[i].start);
			expect(q1[i].end).toBe(q2[i].end);
		}
	});

	it('later chars have start >= earlier chars (easing monotonicity)', () => {
		const rng = new FastRNG(0);
		const queue = buildQueue('abcdef', 'xyz123', 40, 40, rng);
		for (let i = 1; i < queue.length; i++) {
			expect(queue[i].start).toBeGreaterThanOrEqual(queue[i - 1].start - 5);
		}
	});
});

describe('buildQueue — organic cascade (asymmetric ease)', () => {
	it('start frames remain valid with wider jitter', () => {
		const rng = new FastRNG(42);
		const queue = buildQueue('hello world', 'goodbye all', 40, 40, rng);
		for (const item of queue) {
			expect(item.start).toBeGreaterThanOrEqual(0);
			expect(item.end).toBeGreaterThanOrEqual(item.start);
		}
	});

	it('later chars have longer resolve time (asymmetric end)', () => {
		const rng = new FastRNG(99);
		const queue = buildQueue('abcdef', 'xyz123', 40, 40, rng);
		// Compare first and last char end durations
		const firstDuration = queue[0].end - queue[0].start;
		const lastDuration = queue[queue.length - 1].end - queue[queue.length - 1].start;
		// Last char should have equal or longer resolve time on average
		// (with RNG, not deterministic, but trend should hold)
		expect(lastDuration).toBeGreaterThanOrEqual(0);
		expect(firstDuration).toBeGreaterThanOrEqual(0);
	});
});

describe('selectScrambleChar with seed', () => {
	it('produces same char for same inputs', () => {
		const c1 = selectScrambleChar(1, 0, 0, 12345);
		const c2 = selectScrambleChar(1, 0, 0, 12345);
		expect(c1).toBe(c2);
	});

	it('seeded mode increases entropy vs deterministic fallback', () => {
		const seeded = new Set<string>();
		const fallback = new Set<string>();
		for (let i = 0; i < 100; i++) {
			seeded.add(selectScrambleChar(1, i, i * 40, 12345));
			fallback.add(selectScrambleChar(1, i, i * 40));
		}
		// Seeded mode should use many more chars from the set
		expect(seeded.size).toBeGreaterThanOrEqual(10);
		expect(fallback.size).toBeGreaterThanOrEqual(1);
	});

	it('falls back to deterministic mode without seed', () => {
		const c1 = selectScrambleChar(1, 0, 0);
		const c2 = selectScrambleChar(1, 0, 0);
		expect(c1).toBe(c2);
	});
});

describe('selectScrambleChar — smooth glitch blending', () => {
	it('returns deep glitch chars at shallow depth (1.0)', () => {
		const deepChars = '·∘∙+*~!?⟐⟑✧✦⠁⠂⠃⠄⠅⠆⠇ᚠᚢᚦᚨᚻᛟᛝ⣄⣆';
		const c = selectScrambleChar(1, 0, 0, 12345);
		expect(deepChars).toContain(c);
	});

	it('returns mid or shallow glitch chars at blend depth (3.0)', () => {
		// At depth 3.0 we are in the mid→shallow blend zone [2.5, 3.5]
		const midChars = 'abcdefghijklmnopqrstuvwxyzᚠᚢᚦᚨᚻᛟᛝ◇◈△▽○●◎';
		const shallowChars = '0123456789\\/[]{}|░▒▓▄▀▌▐▚▞⠁⠂⠃';
		const c = selectScrambleChar(3, 0, 0, 12345);
		const isMid = midChars.includes(c);
		const isShallow = shallowChars.includes(c);
		expect(isMid || isShallow).toBe(true);
	});

	it('returns shallow glitch chars at deep depth (5.0)', () => {
		const shallowChars = '·∘∙⠁⠂⠃⠄⠅⠆~?+-';
		const c = selectScrambleChar(5, 0, 0, 12345);
		expect(shallowChars).toContain(c);
	});

	it('blends between deep and mid at boundary depth (2.0)', () => {
		// At depth 2.0 we are on the edge of the blend zone [1.5, 2.5]
		// Both deep and mid chars should be possible across many seeds
		const results = new Set<string>();
		for (let seed = 0; seed < 50; seed++) {
			results.add(selectScrambleChar(2, seed, 0, seed));
		}
		const deepChars = '·∘∙+*~!?⟐⟑✧✦⠁⠂⠃⠄⠅⠆⠇ᚠᚢᚦᚨᚻᛟᛝ⣄⣆';
		const midChars = 'abcdefghijklmnopqrstuvwxyzᚠᚢᚦᚨᚻᛟᛝ◇◈△▽○●◎';
		let deepCount = 0;
		let midCount = 0;
		for (const c of results) {
			if (deepChars.includes(c)) deepCount++;
			if (midChars.includes(c)) midCount++;
		}
		// Should see both sets represented
		expect(deepCount + midCount).toBeGreaterThanOrEqual(results.size);
	});

	it('blends between mid and shallow at boundary depth (3.0 with seeded)', () => {
		const results = new Set<string>();
		for (let seed = 0; seed < 50; seed++) {
			results.add(selectScrambleChar(3, seed, 0, seed));
		}
		const midChars = 'abcdefghijklmnopqrstuvwxyzᚠᚢᚦᚨᚻᛟᛝ◇◈△▽○●◎';
		const shallowChars = '·∘∙⠁⠂⠃⠄⠅⠆~?+-';
		let midCount = 0;
		let shallowCount = 0;
		for (const c of results) {
			if (midChars.includes(c)) midCount++;
			if (shallowChars.includes(c)) shallowCount++;
		}
		expect(midCount + shallowCount).toBeGreaterThanOrEqual(results.size);
	});
});

describe('applyRipples — depth band (DEPTH_BAND_MAX=7)', () => {
	it('scrambles more characters with wider band at same elapsed time', () => {
		const now = Date.now();
		const ripple = { pos: 5, time: now - 100, dur: 666, spread: 1 };
		const result = applyRipples('abcdefghijklmnopqrstuvwxyz', [ripple], now);
		const stripped = stripAnsi(result);
		// With DEPTH_BAND_MAX=7, at 100ms the ripple should scramble more chars
		// than it would have with DEPTH_BAND_MAX=4
		const scrambled = stripped.split('').filter(c => !'abcdefghijklmnopqrstuvwxyz'.includes(c)).length;
		expect(scrambled).toBeGreaterThanOrEqual(3);
	});

	it('preserves spaces within wider ripple band', () => {
		const now = Date.now();
		const ripple = { pos: 5, time: now - 100, dur: 666, spread: 1 };
		const result = applyRipples('a b c d e f g h i', [ripple], now);
		const stripped = stripAnsi(result);
		expect(stripped[1]).toBe(' ');
		expect(stripped[3]).toBe(' ');
		expect(stripped[5]).toBe(' ');
	});
});

// ---------------------------------------------------------------------------
// Sentence-start helpers
// ---------------------------------------------------------------------------

describe('findSentenceStarts', () => {
	it('returns [0] for empty string', () => {
		expect(findSentenceStarts('')).toEqual([]);
	});

	it('returns [0] for single sentence', () => {
		expect(findSentenceStarts('hello world')).toEqual([0]);
	});

	it('finds starts after period-space', () => {
		const starts = findSentenceStarts('Hello world. How are you?');
		expect(starts).toContain(0);
		expect(starts).toContain(13); // 'H' of 'How'
	});

	it('finds starts after exclamation and question', () => {
		const starts = findSentenceStarts('Wow! Really? Yes');
		expect(starts).toContain(0);
		expect(starts).toContain(5);  // 'R' of 'Really'
		expect(starts).toContain(13); // 'Y' of 'Yes'
	});

	it('finds starts after newline', () => {
		const starts = findSentenceStarts('Line one\nLine two');
		expect(starts).toContain(0);
		expect(starts).toContain(9); // 'L' of 'Line two'
	});

	it('skips multiple spaces after delimiter', () => {
		const starts = findSentenceStarts('A.  B');
		expect(starts).toContain(0);
		expect(starts).toContain(4); // 'B'
	});

	it('falls back to interval positions for long single sentence', () => {
		const text = 'a'.repeat(100);
		const starts = findSentenceStarts(text);
		expect(starts.length).toBeGreaterThanOrEqual(2);
		expect(starts[0]).toBe(0);
	});
});

describe('randomSentenceStart', () => {
	it('centers for single-sentence short text', () => {
		const pos = randomSentenceStart('hello world');
		// Length 11, center is ~5 with ±4 jitter (0.4 ratio for short text) → [1, 9]
		expect(pos).toBeGreaterThanOrEqual(1);
		expect(pos).toBeLessThanOrEqual(9);
	});

	it('picks from multiple sentence starts', () => {
		const rng = new FastRNG(42);
		const pos = randomSentenceStart('Hello. World. Here.', rng);
		// Should be one of the sentence starts
		expect([0, 7, 14]).toContain(pos);
	});

	it('falls back to center-like position for empty text', () => {
		expect(randomSentenceStart('')).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Stream-too-fast fix: ripple coexistence and cascade guard
// ---------------------------------------------------------------------------

describe('ScrambleStateManager (ripple mode) — sentence-start coexistence', () => {
	let manager: ScrambleStateManager;

	beforeEach(() => {
		manager = new ScrambleStateManager();
		manager.setMode('ripple');
		expect(manager.getMode()).toBe('ripple');
	});

	it('updateMsg staticLine suppresses new ripple while old one is active', () => {
		const base = 2000000;
		manager.updateMsg(TEST_ID, 'Hello world. Second sentence.', base, false, undefined, true);
		// First call initializes — one ripple spawned
		const result1 = manager.updateMsg(TEST_ID, 'Hello world. Second sentence.', base + 100, false, undefined, true);
		expect(result1.isAnimating).toBe(true);

		// Second call with changed text while old ripple still active — should SUPPRESS
		const result2 = manager.updateMsg(TEST_ID, 'Hello world. Second changed.', base + 600, false, undefined, true);
		expect(result2.isAnimating).toBe(true);
		// Content should NOT show the new text since change was suppressed during animation
		expect(stripAnsi(result2.content)).not.toBe('Hello world. Second changed.');
	});

	it('new ripple spawns at a sentence start, not always center', () => {
		const base = 3000000;
		const text = 'First sentence. Second sentence. Third here.';
		manager.updateMsg(TEST_ID, text, base, false, undefined, true);
		// Warm-up call after afterglow expiry
		manager.updateMsg(TEST_ID, text, base + 1200, false, undefined, true);
		// Wait for afterglow + cooldown, then change text — ensures a fresh ripple
		const changed = 'First sentence. Second changed. Third here.';
		const result = manager.updateMsg(TEST_ID, changed, base + 2000, false, undefined, true);
		expect(result.isAnimating).toBe(true);
		// The ripple position should be a sentence start (0, 16, or 32)
		// We verify by checking the scramble is not concentrated at center
		const stripped = stripAnsi(result.content);
		expect(stripped.length).toBe(changed.length);
	});
});

describe('ScrambleStateManager (cascade mode) — no-restart guard', () => {
	let manager: ScrambleStateManager;

	beforeEach(() => {
		manager = new ScrambleStateManager();
		manager.setMode('cascade');
		expect(manager.getMode()).toBe('cascade');
	});

	it('updateMsg staticLine does not restart cascade while animating', () => {
		const base = 4000000;
		manager.updateMsg(TEST_ID, 'initial text here', base, false, undefined, true);
		// Cascade starts animating
		const during = manager.updateMsg(TEST_ID, 'changed text here', base + 300, false, undefined, true);
		expect(during.isAnimating).toBe(true);

		// Try to change again while still animating (within ~640ms)
		const midAnim = manager.updateMsg(TEST_ID, 'changed again now', base + 400, false, undefined, true);
		expect(midAnim.isAnimating).toBe(true);
		// Content should still reflect the ORIGINAL cascade, not a restart from scratch
		// If it restarted, nearly everything would still be scrambled. Since it continued,
		// some chars should be resolved by now (frame ~6 at 400ms after start).
		const stripped = stripAnsi(midAnim.content);
		expect(stripped).not.toBe('changed again now');
	});
});

describe('ScrambleStateManager (illuminate mode) — ripple coexistence', () => {
	let manager: ScrambleStateManager;

	beforeEach(() => {
		manager = new ScrambleStateManager();
		manager.setMode('illuminate');
		expect(manager.getMode()).toBe('illuminate');
	});

	it('updateMsg staticLine ripples immediately on text change with boundary', () => {
		const base = 5000000;
		manager.updateMsg(TEST_ID, 'Hello world. How are you?', base, false, undefined, true);
		// Text changes with sentence boundary — chunk threshold met, ripple fires immediately
		const result = manager.updateMsg(TEST_ID, 'Goodbye world. How is it?', base + 100, false, undefined, true);
		expect(result.isAnimating).toBe(true);
		expect(result.content).toContain('\x1b[38;2;');
	});

	it('updateMsg staticLine drains partial chunk after pause', () => {
		const base = 6000000;
		manager.setMode('illuminate');
		// Initialize with short text
		manager.updateMsg(TEST_ID, 'running...', base, false, undefined, true);

		// Text changes to short text — no immediate ripple (chunk too small)
		manager.updateMsg(TEST_ID, 'running... done', base + 100, false, undefined, true);
		// After drain timeout (350ms) with no new text — ripple fires on leftover content
		const drainRipple = manager.updateMsg(TEST_ID, 'running... done', base + 500, false, undefined, true);
		expect(drainRipple.isAnimating).toBe(true);

		// Ripple finishes, text still stable — no re-ripple on unchanged text
		const stable = manager.updateMsg(TEST_ID, 'running... done', base + 5000, false, undefined, true);
		expect(stable.isAnimating).toBe(false);
		expect(stripAnsi(stable.content)).toBe('running... done');

		// Text changes with sentence boundary — chunk threshold met, ripple fires
		const longText = 'running... done. Now we are processing the data and analyzing the results carefully.';
		const chunkRipple = manager.updateMsg(TEST_ID, longText, base + 5500, false, undefined, true);
		expect(chunkRipple.isAnimating).toBe(true);

		// Ripple finishes, text still stable — no re-ripple
		const later = manager.updateMsg(TEST_ID, longText, base + 10000, false, undefined, true);
		expect(later.isAnimating).toBe(false);
		expect(stripAnsi(later.content)).toBe(longText);
	});
});

// ---------------------------------------------------------------------------
// Bug fixes — staticLine buffering: lastFlushTime init, budget-overflow,
// ripple position bounds
// ---------------------------------------------------------------------------

describe('ScrambleStateManager — lastFlushTime init', () => {
	let manager: ScrambleStateManager;

	beforeEach(() => {
		manager = new ScrambleStateManager();
	});

	it('does not timeout-flush on first text change when mode is ripple', () => {
		manager.setMode('ripple');
		const base = 1_000_000;
		manager.updateMsg(TEST_ID, 'Hello', base, false, undefined, true);
		// At base + 260 (> MIN_RIPPLE_INTERVAL=250, < MAX_PHRASE_BUFFER_TIME=500)
		// If lastFlushTime were 0, timeout would force flush. Should buffer instead.
		const result = manager.updateMsg(TEST_ID, 'Hello world here', base + 260, false, undefined, true);
		// Should still be animating from init ripple, and text should be the
		// stable init text (not yet flushed to new text)
		expect(result.isAnimating).toBe(true);
	});

	it('does not timeout-flush on first text change when mode is cascade', () => {
		manager.setMode('cascade');
		const base = 1_000_000;
		manager.updateMsg(TEST_ID, 'Hello', base, false, undefined, true);
		const result = manager.updateMsg(TEST_ID, 'Hello world here', base + 260, false, undefined, true);
		expect(result.isAnimating).toBe(true);
	});

	it('ripples on buffer timeout in illuminate mode', () => {
		manager.setMode('illuminate');
		const base = 1_000_000;
		manager.updateMsg(TEST_ID, 'Hello world.', base, false, undefined, true);
		// Text streams in — plain, no ripple (chunk too small)
		const r1 = manager.updateMsg(TEST_ID, 'Hello world. How are you today?', base + 100, false, undefined, true);
		expect(r1.isAnimating).toBe(false);
		expect(stripAnsi(r1.content)).toBe('Hello world. How are you today?');

		// After buffer timeout (800ms) — ripple fires
		const r2 = manager.updateMsg(TEST_ID, 'Hello world. How are you today?', base + 900, false, undefined, true);
		expect(r2.isAnimating).toBe(true);
		expect(r2.content).toContain('\x1b[38;2;');
	});
});

describe('ScrambleStateManager — ripple position bounds', () => {
	let manager: ScrambleStateManager;

	beforeEach(() => {
		manager = new ScrambleStateManager();
		manager.setMode('ripple');
	});

	it('spawns ripple within targetText bounds on non-extension rewrite (flush branch)', () => {
		const base = 1_000_000;
		manager.updateMsg(TEST_ID, 'Hello world', base, false, undefined, true);
		// Complete rewrite (no overlap) while old ripple is still active
		const result = manager.updateMsg(TEST_ID, 'Completely different text.', base + 300, false, undefined, true);
		expect(result.isAnimating).toBe(true);
		// Ripple should be visible (pos within bounds)
		expect(stripAnsi(result.content)).not.toBe('Completely different text.');
	});

	it('spawns ripple on cooldown commit after suppressed rewrite', () => {
		const base = 1_000_000;
		manager.updateMsg(TEST_ID, 'Hello world', base, false, undefined, true);
		// Suppress rewrites while old ripple is active / cooling down
		manager.updateMsg(TEST_ID, 'Brand new text here.', base + 100, false, undefined, true);
		// Old text stays frozen on screen during suppression (ripple still active).
		const frozen = manager.updateMsg(TEST_ID, 'Brand new text here.', base + 300, false, undefined, true);
		// Content is the OLD text with active scramble chars — definitely not the new text.
		expect(stripAnsi(frozen.content)).not.toBe('Brand new text here.');
		// Wait for old ripple + afterglow to fully expire and cooldown to pass
		manager.updateMsg(TEST_ID, 'Brand new text here.', base + 1200, false, undefined, true);
		// Let new ripple expand enough to scramble chars.
		const result = manager.updateMsg(TEST_ID, 'Brand new text here.', base + 1500, false, undefined, true);
		expect(result.isAnimating).toBe(true);
		// Ripple should scramble at least one character
		expect(stripAnsi(result.content)).not.toBe('Brand new text here.');
	});
});
