import { describe, it, expect } from "vitest";
import { withFileMutationQueue } from "../src/batch/execute.js";

interface Gate<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

function gate<T>(): Gate<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	return { promise, resolve, reject };
}

describe("withFileMutationQueue", () => {
	it("runs a single operation immediately", async () => {
		const result = await withFileMutationQueue("/tmp/a.txt", async () => "done");
		expect(result).toBe("done");
	});

	it("serializes concurrent operations on the same path", async () => {
		const events: string[] = [];
		const first = gate<void>();
		const second = gate<void>();
		const firstStarted = gate<void>();
		const secondStarted = gate<void>();

		const p1 = withFileMutationQueue("/tmp/shared.txt", async () => {
			events.push("first-start");
			firstStarted.resolve();
			await first.promise;
			events.push("first-end");
			return 1;
		});

		const p2 = withFileMutationQueue("/tmp/shared.txt", async () => {
			events.push("second-start");
			secondStarted.resolve();
			await second.promise;
			events.push("second-end");
			return 2;
		});

		// Wait until the first operation has definitely started.
		await firstStarted.promise;
		expect(events).toEqual(["first-start"]);

		// Release the first operation and wait for the second to start.
		first.resolve();
		await secondStarted.promise;
		expect(events).toEqual(["first-start", "first-end", "second-start"]);

		second.resolve();
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1).toBe(1);
		expect(r2).toBe(2);
		expect(events).toEqual(["first-start", "first-end", "second-start", "second-end"]);
	});

	it("does not block operations on different paths", async () => {
		const events: string[] = [];
		const a = gate<void>();
		const b = gate<void>();

		const pa = withFileMutationQueue("/tmp/a.txt", async () => {
			events.push("a-start");
			await a.promise;
			events.push("a-end");
		});

		const pb = withFileMutationQueue("/tmp/b.txt", async () => {
			events.push("b-start");
			await b.promise;
			events.push("b-end");
		});

		await Promise.resolve();

		// Different paths should execute concurrently.
		expect(events).toContain("a-start");
		expect(events).toContain("b-start");
		expect(events.length).toBe(2);

		a.resolve();
		b.resolve();
		await Promise.all([pa, pb]);
	});

	it("continues the queue after a failed operation", async () => {
		const events: string[] = [];
		const first = gate<void>();

		const p1 = withFileMutationQueue("/tmp/fail.txt", async () => {
			events.push("fail-start");
			await first.promise;
			throw new Error("intentional failure");
		});

		const p2 = withFileMutationQueue("/tmp/fail.txt", async () => {
			events.push("after-fail-start");
			return "recovered";
		});

		await Promise.resolve();
		expect(events).toEqual(["fail-start"]);

		first.resolve();

		await expect(p1).rejects.toThrow("intentional failure");
		await expect(p2).resolves.toBe("recovered");
		expect(events).toEqual(["fail-start", "after-fail-start"]);
	});
});
