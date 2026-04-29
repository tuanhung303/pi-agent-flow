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

			expect(result.content[0].text).toBe("1 read. 0 failed.");
			expect(result.details.results[0]).toMatchObject({
				op: "read",
				path: "test.txt",
				status: "ok",
				content: "hello world\n",
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

			expect(result.content[0].text).toBe("2 reads. 0 failed.");
			expect(result.details.results).toHaveLength(2);
			expect(result.details.results[0].content).toBe("content a\n");
			expect(result.details.results[1].content).toBe("content b\n");
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

		it("returns error for missing file", async () => {
			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{ operations: [{ op: "read", path: "nonexistent.txt" }] },
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.content[0].text).toBe("1 failed.");
			expect(result.details.results[0]).toMatchObject({
				op: "read",
				status: "error",
			});
			expect(result.details.results[0].error).toContain("nonexistent.txt");
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

			expect(result.content[0].text).toBe("1 write. 0 failed.");
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

			expect(result.content[0].text).toBe("2 writes. 0 failed.");
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

			expect(result.content[0].text).toBe("1 edit. 0 failed.");
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

			expect(result.content[0].text).toBe("2 edits. 0 failed.");
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

		it("returns error for missing oldText", async () => {
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
			});
			expect(result.details.results[0].error).toContain("Could not find");
		});

		it("returns error for duplicate oldText", async () => {
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
			});
			expect(result.details.results[0].error).toContain("occurrences");
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

			expect(result.content[0].text).toBe("1 delete. 0 failed.");
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

			expect(result.content[0].text).toBe("1 read, 1 write, 1 edit. 0 failed.");
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
			});
			expect(result.details.results[0].error).toContain("Path traversal");
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
			// Call prepareArguments directly if exposed, or test via execute
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

	describe("truncation", () => {
		it("truncates large files at 2000 lines", async () => {
			const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}\n`);
			fs.writeFileSync(path.join(tmpDir, "large.txt"), lines.join(""), "utf-8");

			const tool = createTool();
			const result = await tool.execute(
				"call-1",
				{ operations: [{ op: "read", path: "large.txt" }] },
				undefined,
				undefined,
				makeCtx(tmpDir),
			);

			expect(result.details.results[0].content).toContain("(truncated)");
		});
	});
});
