import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createBatchTool, suggestSimilarFiles, isWithinDirectory } from "../batch.js";

describe("batch tool", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-batch-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function createTool() {
		return createBatchTool();
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
				{ o: [{ op: "read", path: "test.txt" }] },
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
					o: [
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
				{ o: [{ op: "read", path: "bom.txt" }] },
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
				{ o: [{ op: "read", path: "nonexistent.txt" }] },
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
				{ o: [{ op: "read", path: "lines.txt" }] },
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
					{ o: [{ op: "read", path: "offset.txt", offset: 3 }] },
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
					{ o: [{ op: "read", path: "limit.txt", limit: 2 }] },
					undefined,
					undefined,
					makeCtx(tmpDir),
				);

				expect(result.details.results[0].content).toBe("line1\nline2\n\n[4 more lines in file. Use s=3 to continue.]");
				// Should include continuation hint since there are more lines
				expect(result.details.results[0].content).toContain("more lines in file");
				expect(result.details.results[0].content).toContain("s=3");
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
					{ o: [{ op: "read", path: "both.txt", offset: 2, limit: 2 }] },
					undefined,
					undefined,
					makeCtx(tmpDir),
				);

				expect(result.details.results[0].content).toBe("b\nc\n\n[3 more lines in file. Use s=4 to continue.]");
				expect(result.details.results[0].content).toContain("3 more lines in file");
				expect(result.details.results[0].content).toContain("s=4");
			});

			it("throws when offset is beyond file length", async () => {
				fs.writeFileSync(path.join(tmpDir, "short.txt"), "a\nb\n", "utf-8");

				const tool = createTool();
				const result = await tool.execute(
					"call-1",
					{ o: [{ op: "read", path: "short.txt", offset: 10 }] },
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
					{ o: [{ op: "read", path: "full.txt" }] },
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
					{ o: [{ op: "read", path: "small.txt", limit: 100 }] },
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
					{ o: [{ op: "read", path: "large.txt" }] },
					undefined,
					undefined,
					makeCtx(tmpDir),
				);

				expect(result.details.results[0].truncated).toBe(true);
				expect(result.details.results[0].content).toContain("[Showing lines 1-2000 of 3000");
				expect(result.details.results[0].content).toContain("s=2001");
				expect(result.details.results[0].totalLines).toBe(3000);
			});

			it("includes truncation warning in summary", async () => {
				const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
				fs.writeFileSync(path.join(tmpDir, "large.txt"), lines.join("\n"), "utf-8");

				const tool = createTool();
				const result = await tool.execute(
					"call-1",
					{ o: [{ op: "read", path: "large.txt" }] },
					undefined,
					undefined,
					makeCtx(tmpDir),
				);

				expect(result.content[0].text).toContain("⚠ large.txt truncated");
				expect(result.content[0].text).toContain("s=2001");
			});
		});
	});

	describe("write operations", () => {
		it("creates a new file", async () => {
			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					o: [
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
					o: [
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
					o: [
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
					o: [
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
					o: [
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
					o: [
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
					o: [
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
					o: [
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

		it("preserves trailing whitespace on unedited lines during fuzzy match", async () => {
			fs.writeFileSync(
				path.join(tmpDir, "trim.txt"),
				"keep trailing  \n  edit me  \nalso keep  \n",
				"utf-8",
			);

			const tool = createTool();
			await tool.execute(
				"call-1",
				{
					o: [
						{
							op: "edit",
							path: "trim.txt",
							edits: [{ oldText: "  edit me", newText: "  edited" }],
						},
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			const edited = fs.readFileSync(path.join(tmpDir, "trim.txt"), "utf-8");
			expect(edited).toBe("keep trailing  \n  edited  \nalso keep  \n");
		});

		it("preserves trailing whitespace during fuzzy match when oldText ends with newline", async () => {
			fs.writeFileSync(
				path.join(tmpDir, "trim-nl.txt"),
				"keep trailing  \n  edit me  \nalso keep  \n",
				"utf-8",
			);

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					o: [
						{
							op: "edit",
							path: "trim-nl.txt",
							edits: [{ oldText: "  edit me\n", newText: "  edited\n" }],
						},
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0].status).toBe("ok");
			const edited = fs.readFileSync(path.join(tmpDir, "trim-nl.txt"), "utf-8");
			expect(edited).toBe("keep trailing  \n  edited  \nalso keep  \n");
		});

		it("preserves trailing whitespace on all lines during multi-line fuzzy match", async () => {
			fs.writeFileSync(
				path.join(tmpDir, "multi-trim.txt"),
				"line1   \nline2  \nline3   \n",
				"utf-8",
			);

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					o: [
						{
							op: "edit",
							path: "multi-trim.txt",
							edits: [{ oldText: "line1\nline2\n", newText: "A\nB\n" }],
						},
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0].status).toBe("ok");
			const edited = fs.readFileSync(path.join(tmpDir, "multi-trim.txt"), "utf-8");
			expect(edited).toBe("A   \nB  \nline3   \n");
		});

		it("returns error with hint for missing oldText", async () => {
			fs.writeFileSync(path.join(tmpDir, "miss.txt"), "hello\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					o: [
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
				hint: "Re-read the file first, then retry with exact f (oldText).",
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
					o: [
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
					o: [
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

		it("rejects deleting a directory", async () => {
			fs.mkdirSync(path.join(tmpDir, "a-dir"));

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					o: [{ op: "delete", path: "a-dir" }],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				op: "delete",
				status: "error",
				error: expect.stringContaining("Cannot delete directory"),
			});
			expect(fs.existsSync(path.join(tmpDir, "a-dir"))).toBe(true);
		});

		it("deletes a file", async () => {
			fs.writeFileSync(path.join(tmpDir, "delete-me.txt"), "bye\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					o: [{ op: "delete", path: "delete-me.txt" }],
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
					o: [{ op: "delete", path: "nope.txt" }],
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
					o: [
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
					o: [
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
					o: [
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
					o: [
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
					o: [{ op: "read", path: "../../../etc/hostname" }],
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
				{ o: [{ op: "read", path: "safe.txt" }] },
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
				{ o: [{ op: "read", path: filePath }] },
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0].status).toBe("ok");
		});
	});

	describe("abort signal", () => {

		it("aborts mid-batch between operations", async () => {
			fs.writeFileSync(path.join(tmpDir, "a.txt"), "a\n", "utf-8");
			fs.writeFileSync(path.join(tmpDir, "b.txt"), "b\n", "utf-8");

			const tool = createTool();
			const controller = new AbortController();

			const resultPromise = tool.execute(
				"call-1",
				{
					o: [
						{ op: "read", path: "a.txt" },
						{ op: "read", path: "b.txt" },
					],
				},
				controller.signal,
				undefined,
				makeCtx(tmpDir),
			);

			controller.abort();

			const result = await resultPromise;

			expect(result.details.results[0].status).toBe("ok");
			expect(result.details.results[1].status).toBe("skipped");
			expect(result.details.results[1].error).toBe("Operation aborted.");
		});

		it("returns error when signal is already aborted", async () => {
			const tool = createTool();
			const controller = new AbortController();
			controller.abort();

			const result = await tool.execute(
				"call-1",
				{ o: [{ op: "read", path: "any.txt" }] },
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
					o: [
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
					o: [
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


	describe("single-letter format and new features", () => {
		it("accepts new single-letter format directly", async () => {
			fs.writeFileSync(path.join(tmpDir, "newfmt.txt"), "hello\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				[{ o: "read", p: "newfmt.txt" }],
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				op: "read",
				status: "ok",
			});
		});

		it("accepts new single-letter edit format", async () => {
			fs.writeFileSync(path.join(tmpDir, "newedit.txt"), "hello\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				[{ o: "edit", p: "newedit.txt", e: [{ f: "hello", r: "world" }] }],
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				op: "edit",
				status: "ok",
			});
			expect(fs.readFileSync(path.join(tmpDir, "newedit.txt"), "utf-8")).toBe("world\n");
		});

		it("accepts new single-letter write format", async () => {
			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				[{ o: "write", p: "newwrite.txt", c: "content\n" }],
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				op: "write",
				status: "ok",
			});
			expect(fs.readFileSync(path.join(tmpDir, "newwrite.txt"), "utf-8")).toBe("content\n");
		});

		it("accepts new single-letter read with s and l", async () => {
			fs.writeFileSync(
				path.join(tmpDir, "sl.txt"),
				"a\nb\nc\nd\ne\n",
				"utf-8",
			);

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				[{ o: "read", p: "sl.txt", s: 2, l: 2 }],
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0].content).toBe("b\nc\n\n[3 more lines in file. Use s=4 to continue.]");
		});

		it("handles bare array with legacy property names (no operations wrapper)", async () => {
			fs.writeFileSync(path.join(tmpDir, "bare.txt"), "hello\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				[{ op: "read", path: "bare.txt" }],
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				op: "read",
				status: "ok",
			});
		});

		it("infers write operation for empty string content", async () => {
			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				[{ p: "empty.txt", c: "" }],
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				op: "write",
				status: "ok",
			});
			expect(fs.readFileSync(path.join(tmpDir, "empty.txt"), "utf-8")).toBe("");
		});

		it("throws error with actual op value for unknown operation type", async () => {
			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				[{ o: "bogus", p: "file.txt" }],
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				op: "bogus",
				status: "error",
			});
			expect(result.details.results[0].error).toContain("bogus");
		});
	});
	describe("empty operations", () => {
		it("returns error for empty operations array", async () => {
			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{ o: [] },
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("o array is required");
		});
	});

	describe("error hints", () => {
		it("provides hint for file not found on edit", async () => {
			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					o: [
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
					o: [
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
					o: [{ op: "delete", path: "../../../tmp/trap.txt" }],
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
					o: [
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
				{ o: [{ op: "read", path: "huge-line.txt" }] },
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

describe("tilde expansion", () => {
	let tmpDir: string;

	function createTool() {
		return createBatchTool();
	}

	function makeCtx(cwd: string) {
		return { cwd };
	}

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-tilde-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("reads a file using ~ path", async () => {
		const subDir = path.join(tmpDir, "sub");
		fs.mkdirSync(subDir, { recursive: true });
		fs.writeFileSync(path.join(subDir, "tilde-test.txt"), "hello tilde\n", "utf-8");

		const tool = createTool();
		const result = await tool.execute(
			"call-1",
			{ o: [{ op: "read", p: "~/tilde-test.txt" }] },
			undefined,
			undefined,
			makeCtx(tmpDir),
		);

		// ~ expands to os.homedir(), NOT tmpDir. The error should be about
		// file not found or path traversal (homedir is outside cwd), NOT a crash.
		expect(result.details.results[0].status).toBe("error");
		const err = result.details.results[0].error ?? "";
		const isExpectedError =
			err.includes("File not found") ||
			err.includes("Path not found") ||
			err.includes("Path traversal") ||
			err.includes("ENOENT");
		expect(isExpectedError).toBe(true);
	});

	it("rejects ~ path that resolves outside cwd for write", async () => {
		const tool = createTool();
		const result = await tool.execute(
			"call-1",
			{ o: [{ o: "write", p: "~/malicious.txt", c: "hacked\n" }] },
			undefined,
			undefined,
			makeCtx(tmpDir),
		);

		// ~ expands to os.homedir() which is outside tmpDir cwd
		expect(result.details.results[0].status).toBe("error");
		expect(result.details.results[0].error).toContain("Path traversal");
	});
});

describe("symlink traversal guard", () => {
	let tmpDir: string;

	function createTool() {
		return createBatchTool();
	}

	function makeCtx(cwd: string) {
		return { cwd };
	}

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-sym-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("blocks reading a symlink that points outside cwd", async () => {
		const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-outside-"));
		fs.writeFileSync(path.join(outsideDir, "secret.txt"), "secret content\n", "utf-8");

		const symPath = path.join(tmpDir, "leak.txt");
		fs.symlinkSync(path.join(outsideDir, "secret.txt"), symPath);

		const tool = createTool();
		const result = await tool.execute(
			"call-1",
			{ o: [{ op: "read", p: "leak.txt" }] },
			undefined,
			undefined,
			makeCtx(tmpDir),
		);

		expect(result.details.results[0]).toMatchObject({
			op: "read",
			status: "error",
			error: expect.stringContaining("symlink points outside"),
		});

		fs.rmSync(outsideDir, { recursive: true, force: true });
	});

	it("blocks writing through a symlink that points outside cwd", async () => {
		const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-outside-"));
		fs.writeFileSync(path.join(outsideDir, "target.txt"), "original\n", "utf-8");

		const symPath = path.join(tmpDir, "symlink.txt");
		fs.symlinkSync(path.join(outsideDir, "target.txt"), symPath);

		const tool = createTool();
		const result = await tool.execute(
			"call-1",
			{ o: [{ o: "write", p: "symlink.txt", c: "hacked\n" }] },
			undefined,
			undefined,
			makeCtx(tmpDir),
		);

		expect(result.details.results[0]).toMatchObject({
			op: "write",
			status: "error",
			error: expect.stringContaining("symlink points outside"),
		});

		// Verify the original file was NOT modified
		const content = fs.readFileSync(path.join(outsideDir, "target.txt"), "utf-8");
		expect(content).toBe("original\n");

		fs.rmSync(outsideDir, { recursive: true, force: true });
	});

	it("allows reading a symlink that points within cwd", async () => {
		fs.writeFileSync(path.join(tmpDir, "real.txt"), "real content\n", "utf-8");

		const symPath = path.join(tmpDir, "link.txt");
		fs.symlinkSync(path.join(tmpDir, "real.txt"), symPath);

		const tool = createTool();
		const result = await tool.execute(
			"call-1",
			{ o: [{ op: "read", p: "link.txt" }] },
			undefined,
			undefined,
			makeCtx(tmpDir),
		);

		expect(result.details.results[0]).toMatchObject({
			op: "read",
			status: "ok",
		});
		expect(result.details.results[0].content).toBe("real content\n");
	});

	it("blocks directory symlink traversal", async () => {
		const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-outside-"));
		fs.writeFileSync(path.join(outsideDir, "nested-secret.txt"), "secret\n", "utf-8");

		const symDir = path.join(tmpDir, "leak-dir");
		fs.symlinkSync(outsideDir, symDir);

		const tool = createTool();
		const result = await tool.execute(
			"call-1",
			{ o: [{ op: "read", p: "leak-dir/nested-secret.txt" }] },
			undefined,
			undefined,
			makeCtx(tmpDir),
		);

		expect(result.details.results[0]).toMatchObject({
			op: "read",
			status: "error",
			error: expect.stringContaining("Path traversal"),
		});

		fs.rmSync(outsideDir, { recursive: true, force: true });
	});
});

describe("suggestSimilarFiles", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-suggest-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("suggests similar filename on typo", async () => {
		fs.writeFileSync(path.join(tmpDir, "config.json"), "{}", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "package.json"), "{}", "utf-8");

		const suggestions = await suggestSimilarFiles("confg.json", tmpDir);
		expect(suggestions).toContain("config.json");
	});

	it("suggests similar filename with different extension", async () => {
		fs.writeFileSync(path.join(tmpDir, "data.ts"), "export {};", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "data.js"), "module.exports = {};", "utf-8");

		const suggestions = await suggestSimilarFiles("data.tx", tmpDir);
		expect(suggestions.length).toBeGreaterThan(0);
		expect(suggestions.some(s => s.includes("data.ts") || s.includes("data.js"))).toBe(true);
	});

	it("returns empty array for completely different names", async () => {
		fs.writeFileSync(path.join(tmpDir, "abc.txt"), "content", "utf-8");

		const suggestions = await suggestSimilarFiles("zzzzz.txt", tmpDir);
		expect(suggestions).toEqual([]);
	});

	it("skips hidden files and node_modules", async () => {
		fs.writeFileSync(path.join(tmpDir, ".hidden.txt"), "hidden", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "visible.txt"), "visible", "utf-8");
		fs.mkdirSync(path.join(tmpDir, "node_modules"));
		fs.writeFileSync(path.join(tmpDir, "node_modules", "pkg.txt"), "pkg", "utf-8");

		const suggestions = await suggestSimilarFiles("visble.txt", tmpDir);
		expect(suggestions).toContain("visible.txt");
		expect(suggestions.every(s => !s.includes(".hidden"))).toBe(true);
		expect(suggestions.every(s => !s.includes("node_modules"))).toBe(true);
	});

	it("suggests directories with trailing slash", async () => {
		fs.mkdirSync(path.join(tmpDir, "src"));
		fs.writeFileSync(path.join(tmpDir, "srcr"), "file", "utf-8");

		const suggestions = await suggestSimilarFiles("sr", tmpDir);
		expect(suggestions.some(s => s.includes("src/") || s.includes("src"))).toBe(true);
	});

	it("returns empty array for non-existent directory", async () => {
		const suggestions = await suggestSimilarFiles("nonexistent/file.txt", tmpDir);
		expect(suggestions).toEqual([]);
	});

	it("limits suggestions to 3", async () => {
		fs.writeFileSync(path.join(tmpDir, "file1.txt"), "1", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "file2.txt"), "2", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "file3.txt"), "3", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "file4.txt"), "4", "utf-8");

		const suggestions = await suggestSimilarFiles("file.txt", tmpDir);
		expect(suggestions.length).toBeLessThanOrEqual(3);
	});
});

describe("isWithinDirectory", () => {
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

	afterEach(() => {
		if (originalPlatform) {
			Object.defineProperty(process, "platform", originalPlatform);
		}
	});

	it("returns true for exact match on POSIX", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		expect(isWithinDirectory("/project", "/project")).toBe(true);
	});

	it("returns true for child within parent on POSIX", () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		expect(isWithinDirectory("/project/src/file.ts", "/project")).toBe(true);
	});

	it("returns false for outside path on POSIX", () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		expect(isWithinDirectory("/other/file.ts", "/project")).toBe(false);
	});

	it("returns true for exact match case-insensitive on Windows", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		expect(isWithinDirectory("C:\\Project", "c:\\project")).toBe(true);
	});

	it("returns true for child within parent case-insensitive on Windows", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		expect(isWithinDirectory("c:\\project\\src\\file.ts", "C:\\Project")).toBe(true);
	});

	it("returns false for outside path on Windows", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		expect(isWithinDirectory("D:\\other\\file.ts", "C:\\Project")).toBe(false);
	});
});

describe("edge cases", () => {
	let tmpDir: string;

	function createTool() {
		return createBatchTool();
	}

	function makeCtx(cwd: string) {
		return { cwd };
	}

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-edge-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("edit edge cases", () => {
		it("rejects overlapping edits", async () => {
			fs.writeFileSync(path.join(tmpDir, "overlap.txt"), "abcde\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					o: [
						{
							op: "edit",
							path: "overlap.txt",
							edits: [
								{ oldText: "abc", newText: "ABC" },
								{ oldText: "cde", newText: "CDE" },
							],
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
				error: expect.stringContaining("overlap"),
				hint: "Merge overlapping edits into one.",
			});
		});

		it("rejects empty oldText", async () => {
			fs.writeFileSync(path.join(tmpDir, "empty-old.txt"), "content\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					o: [
						{
							op: "edit",
							path: "empty-old.txt",
							edits: [{ oldText: "", newText: "replaced" }],
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
				error: expect.stringContaining("must not be empty"),
			});
		});

		it("preserves BOM during edit", async () => {
			fs.writeFileSync(path.join(tmpDir, "bom-edit.txt"), "\uFEFFhello world\n", "utf-8");

			const tool = createTool();
			await tool.execute(
				"call-1",
				{
					o: [
						{
							op: "edit",
							path: "bom-edit.txt",
							edits: [{ oldText: "hello world", newText: "hello earth" }],
						},
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			const edited = fs.readFileSync(path.join(tmpDir, "bom-edit.txt"), "utf-8");
			expect(edited.startsWith("\uFEFF")).toBe(true);
			expect(edited).toBe("\uFEFFhello earth\n");
		});
	});

	describe("path validation edge cases", () => {
		it("blocks write when ancestor symlink resolves outside cwd", async () => {
			const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-ancestor-out-"));
			const linkPath = path.join(tmpDir, "link");
			fs.symlinkSync(outsideDir, linkPath);

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					o: [{ op: "write", path: "link/subdir/new.txt", content: "data\n" }],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				op: "write",
				status: "error",
				error: expect.stringContaining("ancestor directory is outside"),
			});

			fs.rmSync(outsideDir, { recursive: true, force: true });
		});

		it("allows broken symlink within cwd (read fails with file not found, not traversal)", async () => {
			fs.symlinkSync("nonexistent.txt", path.join(tmpDir, "broken.txt"));

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{ o: [{ op: "read", path: "broken.txt" }] },
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				op: "read",
				status: "error",
				error: expect.stringContaining("not found"),
			});
			expect(result.details.results[0].error).not.toContain("Path traversal");
		});
	});

	describe("read edge cases", () => {
		it("truncates by bytes across multiple lines", async () => {
			// Each line is ~1KB, 60 lines = ~60KB total (> 50KB limit)
			const lines = Array.from({ length: 60 }, (_, i) => `line ${i.toString().padStart(1000, "0")}`);
			fs.writeFileSync(path.join(tmpDir, "multi-byte.txt"), lines.join("\n"), "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{ o: [{ op: "read", path: "multi-byte.txt" }] },
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				op: "read",
				status: "ok",
				truncated: true,
			});
			expect(result.details.results[0].content).toContain("[Showing lines");
			expect(result.details.results[0].content).toContain("Use s=");
		});

		it("returns error for unreadable file", async () => {
			if (process.getuid && process.getuid() === 0) {
				// Root bypasses file permissions; skip on CI/containers running as root
				return;
			}

			const filePath = path.join(tmpDir, "secret.txt");
			fs.writeFileSync(filePath, "secret\n", "utf-8");
			fs.chmodSync(filePath, 0o000);

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{ o: [{ op: "read", path: "secret.txt" }] },
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				op: "read",
				status: "error",
				error: expect.stringContaining("not readable"),
				hint: "Check file permissions.",
			});

			// Restore permissions so afterEach can clean up
			fs.chmodSync(filePath, 0o644);
		});
	});

	describe("prepareArguments legacy branches", () => {
		it("handles args.op array", async () => {
			fs.writeFileSync(path.join(tmpDir, "op-arr.txt"), "hello\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{ op: [{ path: "op-arr.txt" }] },
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				op: "read",
				status: "ok",
			});
		});

		it("handles args.operations array", async () => {
			fs.writeFileSync(path.join(tmpDir, "ops-arr.txt"), "hello\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{ operations: [{ path: "ops-arr.txt" }] },
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				op: "read",
				status: "ok",
			});
		});

		it("handles single-operation shorthand with p", async () => {
			fs.writeFileSync(path.join(tmpDir, "shorthand.txt"), "hello\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{ p: "shorthand.txt" },
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0]).toMatchObject({
				op: "read",
				status: "ok",
			});
		});

		it("returns error for non-object input", async () => {
			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				null as any,
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("o array is required");
		});
	});

	describe("summary pluralization and combinations", () => {
		it("pluralizes multiple reads, writes, edits, and deletes", async () => {
			fs.writeFileSync(path.join(tmpDir, "r1.txt"), "a\n", "utf-8");
			fs.writeFileSync(path.join(tmpDir, "r2.txt"), "b\n", "utf-8");
			fs.writeFileSync(path.join(tmpDir, "e1.txt"), "old1\n", "utf-8");
			fs.writeFileSync(path.join(tmpDir, "e2.txt"), "old2\n", "utf-8");
			fs.writeFileSync(path.join(tmpDir, "d1.txt"), "x\n", "utf-8");
			fs.writeFileSync(path.join(tmpDir, "d2.txt"), "y\n", "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{
					o: [
						{ op: "read", path: "r1.txt" },
						{ op: "read", path: "r2.txt" },
						{ op: "write", path: "w1.txt", content: "c\n" },
						{ op: "write", path: "w2.txt", content: "d\n" },
						{ op: "edit", path: "e1.txt", edits: [{ oldText: "old1", newText: "new1" }] },
						{ op: "edit", path: "e2.txt", edits: [{ oldText: "old2", newText: "new2" }] },
						{ op: "delete", path: "d1.txt" },
						{ op: "delete", path: "d2.txt" },
					],
				},
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			const text = result.content[0].text;
			expect(text).toContain("2 reads");
			expect(text).toContain("2 writes");
			expect(text).toContain("2 edits");
			expect(text).toContain("2 deletes");
		});

		it("includes byte truncation warning in summary", async () => {
			const lines = Array.from({ length: 60 }, (_, i) => `line ${i.toString().padStart(1000, "0")}`);
			fs.writeFileSync(path.join(tmpDir, "byte-warn.txt"), lines.join("\n"), "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{ o: [{ op: "read", path: "byte-warn.txt" }] },
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.content[0].text).toContain("⚠ byte-warn.txt truncated");
			expect(result.content[0].text).toContain("Use s=");
		});
	});
});
