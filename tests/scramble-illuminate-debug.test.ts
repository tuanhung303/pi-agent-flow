/**
 * Frame-by-frame simulation test for glitch behavior.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ScrambleStateManager, isGlitchComplete, buildGlitchQueue, computeGlitchFrame } from '../src/tui/scramble/index.js';

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, '');
}

const TEST_ID = 'debug-id';
const FRAME_MS = 11;

describe('Glitch debug — specific bug scenarios', () => {
	let manager: ScrambleStateManager;

	beforeEach(() => {
		manager = new ScrambleStateManager();
	});

	it('truncated text during active glitch does NOT show old queue chars beyond tail length', () => {
		const base = 100_000_000;
		const longText = 'This is a very long message that definitely exceeds any reasonable tail budget and contains many words across multiple sentences. Here is the end.';
		const shortTail = 'Here is the end.';

		// Initialize with short text, then change to long text to trigger glitch
		manager.updateMsg(TEST_ID, shortTail, base, false, undefined, true);
		manager.updateMsg(TEST_ID, longText, base + 100, false, undefined, true);

		// Now simulate what renderFlowCollapsed does for a COMPLETED flow:
		// it passes tailText(longText, budget) to updateMsg while glitch is active.
		// We call updateMsg with shortTail (simulating truncation) mid-glitch.
		let foundOldChar = false;
		let finalOutput = '';
		for (let f = 0; f < 200; f++) {
			const t = base + 100 + f * FRAME_MS;
			const r = manager.updateMsg(TEST_ID, shortTail, t, false, undefined, true);
			const stripped = stripAnsi(r.content);
			finalOutput = stripped;
			// The old long text starts with 'This...' — if any old char leaks,
			// we might see 'T', 'h', 'i', 's' at positions beyond the tail length.
			// Since the tail is 'Here is the end.', any char not in that string
			// at a position >= tail length is old content.
			const cache = (manager as any).cache;
			const record = cache.get(TEST_ID);
			const s = record.msg;
			const maxEnd = s.glitchQueue.length > 0 ? Math.max(...s.glitchQueue.map((e: any) => e.fadeOutEnd ?? e.end)) : 0;
			const frame = Math.floor((t - s.startTime) / FRAME_MS);
			if (stripped.length > shortTail.length) {
				const extra = stripped.slice(shortTail.length);
				const visibleExtra = extra.replace(/\x1b\[[0-9;]*m/g, '');
				// With orphan scramble rendering, extra chars beyond current text
				// are dim scramble/spark symbols — not old text leakage.
				// Old text leakage would show ASCII letters from the long text.
				const hasOldTextChar = /[a-zA-Z]/.test(visibleExtra);
				if (hasOldTextChar) {
					foundOldChar = true;
					console.log(`Frame ${f}: EXTRA! frame=${frame} maxEnd=${maxEnd} gLen=${s.glitchQueue.length} out="${stripped.slice(0,30)}..." vExtra="${visibleExtra}"`);
				}
			}
			if (!r.isAnimating) {
				console.log(`Completed at frame ${f}, output="${stripped}"`);
				break;
			}
		}
		expect(foundOldChar).toBe(false);
		expect(finalOutput).toBe(shortTail);
	});

	it('icon snap-back: glitch strips icons then they reappear after completion', () => {
		const base = 200_000_000;
		const textWithIcons = '✔ Success and ✖ Failure';

		manager.updateMsg(TEST_ID, textWithIcons, base, false, undefined, true);
		manager.updateMsg(TEST_ID, textWithIcons, base + 100, false, undefined, true);

		let duringGlitch = '';
		let afterGlitch = '';
		for (let f = 0; f < 200; f++) {
			const t = base + 100 + f * FRAME_MS;
			const r = manager.updateMsg(TEST_ID, textWithIcons, t, false, undefined, true);
			if (r.isAnimating) {
				duringGlitch = stripAnsi(r.content);
			} else {
				afterGlitch = stripAnsi(r.content);
				break;
			}
		}

		console.log('During glitch:', duringGlitch);
		console.log('After glitch:', afterGlitch);
		console.log('Original:', textWithIcons);

		// During glitch, icons should be stripped (cleanCurrent)
		expect(duringGlitch).not.toContain('✔');
		expect(duringGlitch).not.toContain('✖');
		// After glitch, icons should be back
		expect(afterGlitch).toBe(textWithIcons);
	});

	it('computeGlitchFrame direct test: resolved positions beyond cleanCurrent are skipped', () => {
		const queue = buildGlitchQueue('abcdefgh', 'xyz');
		const result = computeGlitchFrame(queue, 999, () => 'X', 'xy');
		const stripped = stripAnsi(result);
		console.log('result:', stripped);
		// 'xy' is shorter than queue length (8).
		// Resolved positions beyond cleanCurrent.length should be SKIPPED.
		expect(stripped).toBe('xy');
	});

	it('computeGlitchFrame with longer currentText appends extras', () => {
		const queue = buildGlitchQueue('abc', 'def');
		const result = computeGlitchFrame(queue, 999, () => 'X', 'defghij');
		const stripped = stripAnsi(result);
		expect(stripped).toBe('defghij');
	});
});
