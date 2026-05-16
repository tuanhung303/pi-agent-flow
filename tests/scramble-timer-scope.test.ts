/**
 * Tests for the timer-scope fix:
 * 1) hasActiveAnimations(id) must detect TPS / actKPI / msgKPI animations.
 * 2) hasActiveAnimations(id) must detect sub-flow animations via prefix.
 * 3) completeFlow must fully clear glitchQueue / glitchFrame / targetText.
 * 4) runScrambleTimer scoping: idle flow must not see active animations from other flows.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { ScrambleStateManager } from '../src/tui/scramble/index.js';

const TEST_ID = 'scope-id';
const BASE = 1_000_000;

// Stabilise Math.random() so glitch timing is deterministic across test runs.
beforeAll(() => {
	let callCount = 0;
	vi.spyOn(Math, 'random').mockImplementation(() => {
		return callCount++ % 2 === 0 ? 0.25 : 0.9;
	});
});
afterAll(() => {
	vi.restoreAllMocks();
});

describe('ScrambleStateManager — timer scope & cleanup', () => {
	let manager: ScrambleStateManager;

	beforeEach(() => {
		manager = new ScrambleStateManager();
	});

	it('hasActiveAnimations detects TPS glitch for the exact id', () => {
		manager.updateTps(TEST_ID, '42.3', BASE, false, true);
		// Check immediately after first flash setup (frame 0, queue non-empty)
		expect(manager.hasActiveAnimations(TEST_ID, BASE + 1)).toBe(true);
		expect(manager.hasActiveAnimations('other-id', BASE + 1)).toBe(false);
	});

	it('hasActiveAnimations detects actKPI glitch for the exact id', () => {
		manager.updateActKpi(TEST_ID, '12', BASE, false, true);
		// Check immediately after first flash setup (frame 0, queue non-empty)
		expect(manager.hasActiveAnimations(TEST_ID, BASE + 1)).toBe(true);
		expect(manager.hasActiveAnimations('other-id', BASE + 1)).toBe(false);
	});

	it('hasActiveAnimations detects msgKPI glitch for the exact id', () => {
		manager.updateMsgKpi(TEST_ID, '?10k?5k', BASE, false, true);
		manager.updateMsgKpi(TEST_ID, '?20k?10k', BASE + 100, false, true);
		expect(manager.hasActiveAnimations(TEST_ID, BASE + 110)).toBe(true);
		expect(manager.hasActiveAnimations('other-id', BASE + 110)).toBe(false);
	});

	it('hasActiveAnimations detects sub-flow animations via prefix', () => {
		// Simulate multi-flow panel where sub-flow ids are "base#0", "base#1"
		manager.updateMsg('base#0', 'Hello world', BASE, false, undefined, true);
		manager.updateMsg('base#0', 'Totally different text here.', BASE + 400, false, undefined, true);
		expect(manager.hasActiveAnimations('base', BASE + 410)).toBe(true);
		expect(manager.hasActiveAnimations('base#0', BASE + 110)).toBe(true);
		expect(manager.hasActiveAnimations('base#1', BASE + 110)).toBe(false);
	});

	it('completeFlow clears glitchQueue, glitchFrame, and targetText for aim/act/msg', () => {
		manager.updateMsg(TEST_ID, 'Start', BASE, false, undefined, true);
		manager.updateMsg(TEST_ID, 'Start text. Changed text here.', BASE + 400, false, undefined, true);

		const stateBefore = (manager as any).cache.get(TEST_ID).msg;
		expect(stateBefore.glitchQueue.length).toBeGreaterThan(0);
		expect(stateBefore.targetText).not.toBe('');

		manager.completeFlow(TEST_ID);

		const stateAfter = (manager as any).cache.get(TEST_ID).msg;
		expect(stateAfter.glitchQueue.length).toBe(0);
		expect(stateAfter.glitchFrame).toBe(0);
		expect(stateAfter.targetText).toBe('');
		expect(stateAfter.pendingGlitch).toBeNull();
		expect(stateAfter.completed).toBe(true);
	});

	it('completeFlow clears glitchQueue and glitchFrame for value states', () => {
		manager.updateTps(TEST_ID, '42.3', BASE, false, true);

		const tpsBefore = (manager as any).tpsState.get(TEST_ID);
		expect(tpsBefore.glitchQueue.length).toBeGreaterThan(0);

		manager.completeFlow(TEST_ID);

		const tpsAfter = (manager as any).tpsState.get(TEST_ID);
		expect(tpsAfter.glitchQueue.length).toBe(0);
		expect(tpsAfter.glitchFrame).toBe(0);
		expect(tpsAfter.completed).toBe(true);
	});

	it('global hasAnyActiveAnimations is false when only completed flows remain', () => {
		manager.updateMsg(TEST_ID, 'Hello world', BASE, false, undefined, true);
		manager.updateMsg(TEST_ID, 'Hello world. How are you today?', BASE + 100, false, undefined, true);

		// Let it settle
		let t = BASE + 100;
		while (manager.hasAnyActiveAnimations(t) && t < BASE + 20000) {
			t += 200;
			manager.updateMsg(TEST_ID, 'Hello world. How are you today?', t, false, undefined, true);
		}
		expect(manager.hasAnyActiveAnimations(t)).toBe(false);

		manager.completeFlow(TEST_ID);
		expect(manager.hasAnyActiveAnimations(t + 100)).toBe(false);
	});

	it('idle widget does not invalidate because another widget is active', () => {
		// idle flow
		manager.updateMsg('idle', 'Idle text', BASE, false, undefined, true);
		manager.completeFlow('idle');

		// active flow
		const longText = 'A very long active text that contains many characters and a sentence boundary. Here is more text to ensure a glitch is triggered properly.';
		manager.updateMsg('active', 'Active text', BASE, false, undefined, true);
		manager.updateMsg('active', longText, BASE + 400, false, undefined, true);

		// Idle scoped check must be false even while active is animating
		expect(manager.hasActiveAnimations('idle', BASE + 110)).toBe(false);
		expect(manager.hasActiveAnimations('active', BASE + 110)).toBe(true);
		expect(manager.hasAnyActiveAnimations(BASE + 110)).toBe(true);
	});
});
