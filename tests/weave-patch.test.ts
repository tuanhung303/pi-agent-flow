import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWeavePatchTool } from "../weave-patch.js";

describe("weave_patch tool", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-weave-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function createTool() {
		return createWeavePatchTool();
	}

	function makeCtx(cwd: string) {
		return { cwd };
	}

	describe("read operations", () => {
		it("reads a single file", async () => {
			const filePath = path.join(tmpDir, "test.txt");
			fs.writeFileSync(filePath, "hello world\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{ operations: [{ op: "read", path: "test.txt" }] },
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.content[0].text).toContain("✓ 1 operations: 1 read");
    expect(result.content[0].text).toContain("--- test.txt (2 lines) ---");
    expect(result.content[0].text).toContain("hello world");
			expect(result.details.results[0]).toMatchObject({
				op: "read",
				path: "test.txt",
				status: "ok",
				content: "hello world\n",
				totalLines: 2, // "hello world" + "" (split on \n)
			});
		});

		it("reads multiple files", async () => {
			fs.writeFileSync(path.join(tmpDir, "a.txt"), "content a\n", "utf-8");
			fs.writeFileSync(path.join(tmpDir, "b.txt"), "content b\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [
						{ op: "read", path: "a.txt" },
						{ op: "read", path: "b.txt" },
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.content[0].text).toContain("✓ 2 operations: 2 reads");
    expect(result.content[0].text).toContain("--- a.txt (2 lines) ---");
    expect(result.content[0].text).toContain("content a");
    expect(result.content[0].text).toContain("--- b.txt (2 lines) ---");
    expect(result.content[0].text).toContain("content b");
			expect(result.details.results).toHaveLength(2);
			expect(result.details.results[0].content).toBe("content a\n");
			expect(result.details.results[1].content).toBe("content b\n");
			expect(result.details.results[0].totalLines).toBe(2);
			expect(result.details.results[1].totalLines).toBe(2);
		});

		it("strips BOM from read content", async () => {
			const filePath = path.join(tmpDir, "bom.txt");
			fs.writeFileSync(filePath, "\uFEFFhello BOM\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{ operations: [{ op: "read", path: "bom.txt" }] },
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0].content).toBe("hello BOM\n");
		});

		it("returns error with hint for missing file", async () => {
			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{ operations: [{ op: "read", path: "nonexistent.txt" }] },
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.content[0].text).toContain("✗ 1 failed");
			expect(result.details.results[0]).toMatchObject({
				op: "read",
				status: "error",
				error: expect.stringContaining("nonexistent.txt"),
				hint: "Verify the path exists.",
			});
		});

		it("includes totalLines in read results", async () => {
			fs.writeFileSync(path.join(tmpDir, "lines.txt"), "a\nb\nc\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{ operations: [{ op: "read", path: "lines.txt" }] },
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0].totalLines).toBe(4); // "a", "b", "c", ""
		});

		describe("offset/limit", () => {
			it("reads with offset (1-indexed)", async () => {
				fs.writeFileSync(
					path.join(tmpDir, "offset.txt"),
					"line1\nline2\nline3\nline4\nline5\n",
					"utf-8",
				);

				const tool = createTool();
				const result = await tool.execute(
					"call-1",
					{ operations: [{ op: "read", path: "offset.txt", offset: 3 }] },
					undefined,
					undefined,
					makeCtx(tmpDir),
				);

				expect(result.details.results[0].content).toBe("line3\nline4\nline5\n");
				expect(result.details.results[0].status).toBe("ok");
			});

			it("reads with limit", async () => {
				fs.writeFileSync(
					path.join(tmpDir, "limit.txt"),
					"line1\nline2\nline3\nline4\nline5\n",
					"utf-8",
				);

				const tool = createTool();
				const result = await tool.execute(
					"call-1",
					{ operations: [{ op: "read", path: "limit.txt", limit: 2 }] },
					undefined,
					undefined,
					makeCtx(tmpDir),
				);

				expect(result.details.results[0].content).toBe("line1\nline2\n\n[4 more lines in file. Use offset=3 to continue.]");
				// Should include continuation hint since there are more lines
				// Should include continuation hint since there are more lines
				expect(result.details.results[0].content).toContain("more lines in file");
				expect(result.details.results[0].content).toContain("offset=3");
			});

			it("reads with offset and limit combined", async () => {
				fs.writeFileSync(
					path.join(tmpDir, "both.txt"),
					"a\nb\nc\nd\ne\n",
					"utf-8",
				);

				const tool = createTool();
				const result = await tool.execute(
					"call-1",
					{ operations: [{ op: "read", path: "both.txt", offset: 2, limit: 2 }] },
					undefined,
					undefined,
					makeCtx(tmpDir),
				);

				expect(result.details.results[0].content).toBe("b\nc\n\n[3 more lines in file. Use offset=4 to continue.]");
				expect(result.details.results[0].content).toContain("3 more lines in file");
				expect(result.details.results[0].content).toContain("offset=4");
			});

			it("throws when offset is beyond file length", async () => {
				fs.writeFileSync(path.join(tmpDir, "short.txt"), "a\nb\n", "utf-8");

				const tool = createTool();
				const result = await tool.execute(
					"call-1",
					{ operations: [{ op: "read", path: "short.txt", offset: 10 }] },
					undefined,
					undefined,
					makeCtx(tmpDir),
				);

				expect(result.details.results[0]).toMatchObject({
					op: "read",
					status: "error",
					error: expect.stringContaining("Offset 10 is beyond end of file"),
					hint: "Use a smaller offset within the file length.",
				});
			});

			it("reads entire file when no offset/limit specified", async () => {
				fs.writeFileSync(
					path.join(tmpDir, "full.txt"),
					"first\nsecond\nthird\n",
					"utf-8",
				);

				const tool = createTool();
				const result = await tool.execute(
					"call-1",
					{ operations: [{ op: "read", path: "full.txt" }] },
					undefined,
					undefined,
					makeCtx(tmpDir),
				);

				expect(result.details.results[0].content).toBe("first\nsecond\nthird\n");
				expect(result.details.results[0].content).not.toContain("more lines");
				expect(result.details.results[0].truncated).toBeUndefined();
			});

			it("reads with limit beyond file length returns full remaining content", async () => {
				fs.writeFileSync(path.join(tmpDir, "small.txt"), "a\nb\n", "utf-8");

				const tool = createTool();
				const result = await tool.execute(
					"call-1",
					{ operations: [{ op: "read", path: "small.txt", limit: 100 }] },
					undefined,
					undefined,
					makeCtx(tmpDir),
				);

				expect(result.details.results[0].content).toBe("a\nb\n");
				expect(result.details.results[0].content).not.toContain("more lines");
			});
		});

		describe("truncation", () => {
			it("truncates large files at 2000 lines", async () => {
				const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
				fs.writeFileSync(path.join(tmpDir, "large.txt"), lines.join("\n"), "utf-8");

				const tool = createTool();
				const result = await tool.execute(
					"call-1",
					{ operations: [{ op: "read", path: "large.txt" }] },
					undefined,
					undefined,
					makeCtx(tmpDir),
				);

				expect(result.details.results[0].truncated).toBe(true);
				expect(result.details.results[0].content).toContain("[Showing lines 1-2000 of 3000");
				expect(result.details.results[0].content).toContain("offset=2001");
				expect(result.details.results[0].totalLines).toBe(3000);
			});

			it("includes truncation warning in summary", async () => {
				const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
				fs.writeFileSync(path.join(tmpDir, "large.txt"), lines.join("\n"), "utf-8");

				const tool = createTool();
				const result = await tool.execute(
					"call-1",
					{ operations: [{ op: "read", path: "large.txt" }] },
					undefined,
					undefined,
					makeCtx(tmpDir),
				);

				expect(result.content[0].text).toContain("⚠ large.txt truncated");
				expect(result.content[0].text).toContain("offset=2001");
			});
		});
	});

	describe("write operations", () => {
		it("creates a new file", async () => {
			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [
						{ op: "write", path: "new.txt", content: "new content\n" },
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.content[0].text).toContain("✓ 1 operations: 1 write");
    expect(result.content[0].text).toContain("write: new.txt");
    expect(result.content[0].text).toContain("12 bytes");
			expect(result.details.results[0]).toMatchObject({
				op: "write",
				path: "new.txt",
				status: "ok",
				bytes: Buffer.byteLength("new content\n", "utf-8"),
			});

			const written = fs.readFileSync(path.join(tmpDir, "new.txt"), "utf-8");
			expect(written).toBe("new content\n");
		});

		it("overwrites existing file", async () => {
			fs.writeFileSync(path.join(tmpDir, "existing.txt"), "old\n", "utf-8");

			const tool = createTool();
			await tool.execute(
				"call-1",
				{
					operations: [
						{ op: "write", path: "existing.txt", content: "new\n" },
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			const written = fs.readFileSync(path.join(tmpDir, "existing.txt"), "utf-8");
			expect(written).toBe("new\n");
		});

		it("creates parent directories", async () => {
			const tool = createTool();
			await tool.execute(
				"call-1",
				{
					operations: [
						{ op: "write", path: "a/b/c/deep.txt", content: "deep\n" },
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			const written = fs.readFileSync(path.join(tmpDir, "a", "b", "c", "deep.txt"), "utf-8");
			expect(written).toBe("deep\n");
		});

		it("writes multiple files", async () => {
			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [
						{ op: "write", path: "x.txt", content: "x\n" },
						{ op: "write", path: "y.txt", content: "y\n" },
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.content[0].text).toContain("✓ 2 operations: 2 writes");
    expect(result.content[0].text).toContain("write: x.txt");
    expect(result.content[0].text).toContain("write: y.txt");
			expect(fs.readFileSync(path.join(tmpDir, "x.txt"), "utf-8")).toBe("x\n");
			expect(fs.readFileSync(path.join(tmpDir, "y.txt"), "utf-8")).toBe("y\n");
		});
	});

	describe("edit operations", () => {
		it("performs a single edit", async () => {
			fs.writeFileSync(path.join(tmpDir, "edit.txt"), "hello world\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [
						{
							op: "edit",
							path: "edit.txt",
							edits: [{ oldText: "hello world", newText: "hello earth" }],
						},
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.content[0].text).toContain("✓ 1 operations: 1 edit");
    expect(result.content[0].text).toContain("edit: edit.txt");
			expect(result.details.results[0]).toMatchObject({
				op: "edit",
				status: "ok",
				blocksChanged: 1,
				diff: expect.stringContaining("+"),
			});

			const edited = fs.readFileSync(path.join(tmpDir, "edit.txt"), "utf-8");
			expect(edited).toBe("hello earth\n");
		});

		it("performs multiple edits on same file", async () => {
			fs.writeFileSync(
				path.join(tmpDir, "multi.txt"),
				"line 1\nline 2\nline 3\n",
				"utf-8",
			);

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [
						{
							op: "edit",
							path: "multi.txt",
							edits: [
								{ oldText: "line 1", newText: "LINE 1" },
								{ oldText: "line 3", newText: "LINE 3" },
							],
						},
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0].blocksChanged).toBe(2);
			expect(result.details.results[0].diff).toBeDefined();

			const edited = fs.readFileSync(path.join(tmpDir, "multi.txt"), "utf-8");
			expect(edited).toBe("LINE 1\nline 2\nLINE 3\n");
		});

		it("performs edits on multiple files", async () => {
			fs.writeFileSync(path.join(tmpDir, "a.txt"), "alpha\n", "utf-8");
			fs.writeFileSync(path.join(tmpDir, "b.txt"), "beta\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [
						{
							op: "edit",
							path: "a.txt",
							edits: [{ oldText: "alpha", newText: "ALPHA" }],
						},
						{
							op: "edit",
							path: "b.txt",
							edits: [{ oldText: "beta", newText: "BETA" }],
						},
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.content[0].text).toContain("✓ 2 operations: 2 edits");
    expect(result.content[0].text).toContain("edit: a.txt");
    expect(result.content[0].text).toContain("edit: b.txt");
			expect(fs.readFileSync(path.join(tmpDir, "a.txt"), "utf-8")).toBe("ALPHA\n");
			expect(fs.readFileSync(path.join(tmpDir, "b.txt"), "utf-8")).toBe("BETA\n");
		});

		it("uses fuzzy matching with trim fallback", async () => {
			fs.writeFileSync(
				path.join(tmpDir, "fuzzy.txt"),
				"  indented line  \n",
				"utf-8",
			);

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [
						{
							op: "edit",
							path: "fuzzy.txt",
							edits: [{ oldText: "  indented line", newText: "  changed line" }],
						},
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0].status).toBe("ok");

			const edited = fs.readFileSync(path.join(tmpDir, "fuzzy.txt"), "utf-8");
			expect(edited).toContain("changed line");
		});

		it("returns error with hint for missing oldText", async () => {
			fs.writeFileSync(path.join(tmpDir, "miss.txt"), "hello\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [
						{
							op: "edit",
							path: "miss.txt",
							edits: [{ oldText: "nonexistent", newText: "replacement" }],
						},
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				op: "edit",
				status: "error",
				error: expect.stringContaining("Could not find"),
				hint: "Re-read the file first, then retry with exact oldText.",
			});
		});

		it("returns error with hint for duplicate oldText", async () => {
			fs.writeFileSync(
				path.join(tmpDir, "dup.txt"),
				"same same different\n",
				"utf-8",
			);

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [
						{
							op: "edit",
							path: "dup.txt",
							edits: [{ oldText: "same", newText: "changed" }],
						},
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				op: "edit",
				status: "error",
				error: expect.stringContaining("occurrences"),
				hint: "Add more surrounding context to make oldText unique.",
			});
		});

		it("includes diff summary in edit results", async () => {
			fs.writeFileSync(
				path.join(tmpDir, "diff.txt"),
				"line1\nline2\nline3\n",
				"utf-8",
			);

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [
						{
							op: "edit",
							path: "diff.txt",
							edits: [
								{ oldText: "line1", newText: "LINE1" },
								{ oldText: "line3", newText: "LINE3" },
							],
						},
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0].diff).toBe("+2 -2 lines");
		});

		it("preserves line endings (CRLF)", async () => {
			fs.writeFileSync(
				path.join(tmpDir, "crlf.txt"),
				"line1\r\nline2\r\n",
				"utf-8",
			);

			const tool = createTool();
			await tool.execute(
				"call-1",
				{
					operations: [
						{
							op: "edit",
							path: "crlf.txt",
							edits: [{ oldText: "line1", newText: "LINE1" }],
						},
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			const edited = fs.readFileSync(path.join(tmpDir, "crlf.txt"));
			expect(edited.includes("\r\n")).toBe(true);
		});
	});

	describe("delete operations", () => {
		it("deletes a file", async () => {
			fs.writeFileSync(path.join(tmpDir, "delete-me.txt"), "bye\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [{ op: "delete", path: "delete-me.txt" }],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.content[0].text).toContain("✓ 1 operations: 1 delete");
    expect(result.content[0].text).toContain("delete: delete-me.txt");
			expect(result.details.results[0]).toMatchObject({
				op: "delete",
				status: "ok",
			});
			expect(fs.existsSync(path.join(tmpDir, "delete-me.txt"))).toBe(false);
		});

		it("returns error when deleting nonexistent file", async () => {
			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [{ op: "delete", path: "nope.txt" }],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				op: "delete",
				status: "error",
			});
		});
	});

	describe("mixed operations", () => {
		it("performs mixed read/write/edit in one call", async () => {
			fs.writeFileSync(path.join(tmpDir, "existing.txt"), "old content\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [
						{ op: "read", path: "existing.txt" },
						{ op: "write", path: "new.txt", content: "new file\n" },
						{
							op: "edit",
							path: "existing.txt",
							edits: [{ oldText: "old content", newText: "updated content" }],
						},
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.content[0].text).toContain("✓ 3 operations: 1 read, 1 write, 1 edit");
    expect(result.content[0].text).toContain("--- existing.txt");
    expect(result.content[0].text).toContain("write: new.txt");
    expect(result.content[0].text).toContain("edit: existing.txt");
			expect(result.details.results).toHaveLength(3);
			expect(result.details.results[0].status).toBe("ok");
			expect(result.details.results[1].status).toBe("ok");
			expect(result.details.results[2].status).toBe("ok");

			expect(fs.readFileSync(path.join(tmpDir, "new.txt"), "utf-8")).toBe("new file\n");
			expect(fs.readFileSync(path.join(tmpDir, "existing.txt"), "utf-8")).toBe(
				"updated content\n",
			);
		});

		it("executes operations in array order", async () => {
			fs.writeFileSync(path.join(tmpDir, "ordered.txt"), "step1\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [
						{
							op: "edit",
							path: "ordered.txt",
							edits: [{ oldText: "step1", newText: "step2" }],
						},
						{
							op: "edit",
							path: "ordered.txt",
							edits: [{ oldText: "step2", newText: "step3" }],
						},
						{ op: "read", path: "ordered.txt" },
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			// The read should see step3 (edits applied sequentially)
			expect(result.details.results[2].content).toBe("step3\n");
		});
	});

	describe("skip-on-failure", () => {
		it("skips remaining operations after failure", async () => {
			fs.writeFileSync(path.join(tmpDir, "ok.txt"), "ok\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [
						{ op: "read", path: "ok.txt" },
						{ op: "read", path: "missing.txt" },
						{ op: "write", path: "skipped.txt", content: "should not be written\n" },
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0].status).toBe("ok");
			expect(result.details.results[1].status).toBe("error");
			expect(result.details.results[2].status).toBe("skipped");

			// The skipped write should not have created the file
			expect(fs.existsSync(path.join(tmpDir, "skipped.txt"))).toBe(false);

			// Summary should show the failure with hint
			expect(result.content[0].text).toContain("✗ 1 failed, 1 skipped");
			expect(result.content[0].text).toContain("✓ 1 read ok");
		});

		it("continues after skipped operations are not executed", async () => {
			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [
						{ op: "read", path: "nonexistent.txt" },
						{ op: "write", path: "should-skip.txt", content: "nope\n" },
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0].status).toBe("error");
			expect(result.details.results[1].status).toBe("skipped");
		});
	});

	describe("path traversal guard", () => {
		it("blocks path traversal outside cwd", async () => {
			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [{ op: "read", path: "../../../etc/hostname" }],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				op: "read",
				status: "error",
				error: expect.stringContaining("Path traversal"),
				hint: "Use a path within the working directory.",
			});
		});

		it("allows relative paths within cwd", async () => {
			fs.writeFileSync(path.join(tmpDir, "safe.txt"), "safe\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{ operations: [{ op: "read", path: "safe.txt" }] },
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0].status).toBe("ok");
		});

		it("allows absolute paths within cwd", async () => {
			const filePath = path.join(tmpDir, "abs.txt");
			fs.writeFileSync(filePath, "absolute\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{ operations: [{ op: "read", path: filePath }] },
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0].status).toBe("ok");
		});
	});

	describe("abort signal", () => {
		it("returns error when signal is already aborted", async () => {
			const tool = createTool();
			const controller = new AbortController();
			controller.abort();

			const result = await tool.execute(
				"call-1",
				{ operations: [{ op: "read", path: "any.txt" }] },
				controller.signal,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.isError).toBe(true);
		});
	});

	describe("prepareArguments shim", () => {
		it("infers op from fields when missing", async () => {
			fs.writeFileSync(path.join(tmpDir, "infer.txt"), "content\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [
						{ path: "infer.txt" }, // no op, should infer "read"
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				op: "read",
				status: "ok",
			});
		});

		it("handles stringified edits", async () => {
			fs.writeFileSync(path.join(tmpDir, "str.txt"), "hello\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [
						{
							op: "edit",
							path: "str.txt",
							edits: JSON.stringify([{ oldText: "hello", newText: "world" }]),
						},
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0].status).toBe("ok");
		});

		it("handles legacy top-level oldText/newText", async () => {
			fs.writeFileSync(path.join(tmpDir, "legacy.txt"), "old\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					path: "legacy.txt",
					oldText: "old",
					newText: "new",
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				op: "edit",
				status: "ok",
			});
		});
	});

	describe("empty operations", () => {
		it("returns error for empty operations array", async () => {
			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{ operations: [] },
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("operations array is required");
		});
	});

	describe("error hints", () => {
		it("provides hint for file not found on edit", async () => {
			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [
						{
							op: "edit",
							path: "nonexistent.txt",
							edits: [{ oldText: "a", newText: "b" }],
						},
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				status: "error",
				hint: "Verify the path exists.",
			});
		});

		it("provides hint for no changes needed", async () => {
			fs.writeFileSync(path.join(tmpDir, "same.txt"), "same content\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [
						{
							op: "edit",
							path: "same.txt",
							edits: [{ oldText: "same content\n", newText: "same content\n" }],
						},
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				status: "error",
				error: expect.stringContaining("No changes"),
				hint: "File already has this content. No edit needed.",
			});
		});

		it("provides hint for path traversal on delete", async () => {
			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [{ op: "delete", path: "../../../tmp/trap.txt" }],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				status: "error",
				hint: "Use a path within the working directory.",
			});
		});

		it("includes error and hint in the summary line", async () => {
			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					operations: [
						{ op: "read", path: "missing.txt" },
						{ op: "write", path: "skipped.txt", content: "nope" },
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			const text = result.content[0].text;
			expect(text).toContain("✗ 1 failed, 1 skipped");
			expect(text).toContain("✗ read missing.txt:");
			expect(text).toContain("— Verify the path exists.");
		});
	});

	describe("first-line exceeds byte limit", () => {
		it("throws when a single line exceeds the byte limit", async () => {
			// Create a file with a single very long line (> 50KB)
			const hugeLine = "x".repeat(60 * 1024); // 60KB
			fs.writeFileSync(path.join(tmpDir, "huge-line.txt"), hugeLine, "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{ operations: [{ op: "read", path: "huge-line.txt" }] },
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				op: "read",
				status: "error",
				error: expect.stringContaining("Line 1 exceeds limit"),
			});
		});
	});
});
