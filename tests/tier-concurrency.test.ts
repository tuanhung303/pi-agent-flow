import { describe, it, expect, vi } from "vitest";
import { mapFlowConcurrentByTier, type FlowTier } from "../src/flow.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapFlowConcurrentByTier", () => {
	it("returns empty array for empty input", async () => {
		const result = await mapFlowConcurrentByTier(
			[],
			() => "lite",
			{ lite: 4, flash: 1, full: 1 },
			4,
			async () => "x",
		);
		expect(result).toEqual([]);
	});

	it("runs all items when concurrency is sufficient", async () => {
		const items = [
			{ tier: "lite" as const },
			{ tier: "lite" as const },
			{ tier: "flash" as const },
			{ tier: "full" as const },
		];
		const results = await mapFlowConcurrentByTier(
			items,
			(item) => item.tier,
			{ lite: 4, flash: 2, full: 2 },
			4,
			async (item, i) => `${item.tier}-${i}`,
		);
		expect(results).toEqual(["lite-0", "lite-1", "flash-2", "full-3"]);
	});

	it("respects per-tier concurrency limits", async () => {
		const items = Array.from({ length: 6 }, (_, i) => ({ id: i, tier: "flash" as const }));
		let maxParallel = 0;
		let current = 0;

		const results = await mapFlowConcurrentByTier(
			items,
			(item) => item.tier,
			{ lite: 4, flash: 2, full: 1 },
			8,
			async (item) => {
				current++;
				maxParallel = Math.max(maxParallel, current);
				await delay(20);
				current--;
				return item.id;
			},
		);

		expect(results).toEqual([0, 1, 2, 3, 4, 5]);
		expect(maxParallel).toBeLessThanOrEqual(2); // flash tier capped at 2
	});

	it("respects global max concurrency across tiers", async () => {
		const items = [
			{ id: 0, tier: "lite" as const },
			{ id: 1, tier: "lite" as const },
			{ id: 2, tier: "flash" as const },
			{ id: 3, tier: "full" as const },
			{ id: 4, tier: "lite" as const },
		];
		let maxParallel = 0;
		let current = 0;

		const results = await mapFlowConcurrentByTier(
			items,
			(item) => item.tier,
			{ lite: 10, flash: 10, full: 10 },
			2, // global cap of 2
			async (item) => {
				current++;
				maxParallel = Math.max(maxParallel, current);
				await delay(20);
				current--;
				return item.id;
			},
		);

		expect(results).toEqual([0, 1, 2, 3, 4]);
		expect(maxParallel).toBeLessThanOrEqual(2); // global cap of 2
	});

	it("enforces both tier and global caps simultaneously", async () => {
		const items = [
			{ id: 0, tier: "lite" as const },
			{ id: 1, tier: "lite" as const },
			{ id: 2, tier: "lite" as const },
			{ id: 3, tier: "flash" as const },
			{ id: 4, tier: "flash" as const },
		];
		let maxParallel = 0;
		let current = 0;

		const results = await mapFlowConcurrentByTier(
			items,
			(item) => item.tier,
			{ lite: 4, flash: 1, full: 1 },
			3, // global cap of 3
			async (item) => {
				current++;
				maxParallel = Math.max(maxParallel, current);
				await delay(20);
				current--;
				return item.id;
			},
		);

		expect(results).toEqual([0, 1, 2, 3, 4]);
		expect(maxParallel).toBeLessThanOrEqual(3); // global cap
	});

	it("handles all items of the same tier", async () => {
		const items = Array.from({ length: 5 }, (_, i) => ({ id: i, tier: "lite" as const }));
		const results = await mapFlowConcurrentByTier(
			items,
			(item) => item.tier,
			{ lite: 2, flash: 1, full: 1 },
			4,
			async (item) => item.id,
		);
		expect(results).toEqual([0, 1, 2, 3, 4]);
	});

	it("preserves result order matching input order", async () => {
		const items = [
			{ id: "a", tier: "full" as const },
			{ id: "b", tier: "lite" as const },
			{ id: "c", tier: "flash" as const },
			{ id: "d", tier: "lite" as const },
		];
		const results = await mapFlowConcurrentByTier(
			items,
			(item) => item.tier,
			{ lite: 4, flash: 1, full: 1 },
			4,
			async (item) => item.id,
		);
		expect(results).toEqual(["a", "b", "c", "d"]);
	});

	it("handles zero tier concurrency by falling back to at least 1", async () => {
		const items = [
			{ id: 0, tier: "flash" as const },
			{ id: 1, tier: "flash" as const },
		];
		const results = await mapFlowConcurrentByTier(
			items,
			(item) => item.tier,
			{ lite: 4, flash: 0, full: 1 }, // flash=0 should be clamped to 1
			4,
			async (item) => item.id,
		);
		expect(results).toEqual([0, 1]);
	});
});
