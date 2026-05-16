import * as os from "node:os";
import { describe, expect, it } from "vitest";
import { formatBatchOpsSummary } from "../src/batch/summary.js";

describe("batch summary helpers", () => {
	it("formats repeated operations consistently for all consumers", () => {
		expect(
			formatBatchOpsSummary({
				o: [
					{ o: "read", p: `${os.homedir()}/project/file.ts` },
					{ o: "read", p: `${os.homedir()}/project/file.ts` },
					{ o: "edit", p: "src/foo.ts", e: [{ f: "a", r: "b" }, { f: "c", r: "d" }] },
				],
			}),
		).toBe("read ~/project/file.ts×2, edit src/foo.ts (2 blocks)");
	});

	it("keeps the empty batch label stable", () => {
		expect(formatBatchOpsSummary({ o: [] })).toBe("batch (empty)");
	});
});
