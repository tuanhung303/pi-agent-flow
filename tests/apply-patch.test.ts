import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	parsePatch,
	seekSequence,
	computeReplacements,
	applyReplacements,
	applyPatch,
	ParseError,
	ComputeReplacementsError,
	type Hunk,
	type UpdateFileChunk,
} from "../src/batch/apply-patch.js";

// ---------------------------------------------------------------------------
// Parser tests
// ---------------------------------------------------------------------------

describe("parsePatch", () => {
	it("parses a minimal patch with add and delete hunks", () => {
		const patch = `*** Begin Patch
*** Add File: foo.txt
+hello
*** Delete File: bar.txt
*** End Patch`;
		const result = parsePatch(patch);
		expect(result.hunks).toHaveLength(2);
		expect(result.hunks[0]).toEqual({ type: "add", path: "foo.txt", contents: "hello\n" });
		expect(result.hunks[1]).toEqual({ type: "delete", path: "bar.txt" });
	});

	it("parses an update hunk with a single chunk", () => {
		const patch = `*** Begin Patch
*** Update File: src/main.ts
@@ def main():
-    pass
+    return 42
*** End Patch`;
		const result = parsePatch(patch);
		expect(result.hunks).toHaveLength(1);
		const hunk = result.hunks[0] as Hunk & { type: "update" };
		expect(hunk.type).toBe("update");
		expect(hunk.path).toBe("src/main.ts");
		expect(hunk.chunks).toHaveLength(1);
		expect(hunk.chunks[0]).toEqual({
			changeContext: "def main():",
			oldLines: ["    pass"],
			newLines: ["    return 42"],
			isEndOfFile: false,
		});
	});

	it("parses an update hunk with missing context for the first chunk", () => {
		const patch = `*** Begin Patch
*** Update File: file.py
 import foo
+bar
*** End Patch`;
		const result = parsePatch(patch);
		const hunk = result.hunks[0] as Hunk & { type: "update" };
		expect(hunk.chunks[0].changeContext).toBeUndefined();
		expect(hunk.chunks[0].oldLines).toEqual(["import foo"]);
		expect(hunk.chunks[0].newLines).toEqual(["import foo", "bar"]);
	});

	it("parses an update hunk with multiple chunks", () => {
		const patch = `*** Begin Patch
*** Update File: multi.txt
@@ foo
-bar
+BAR
@@ baz
-qux
+QUX
*** End Patch`;
		const result = parsePatch(patch);
		const hunk = result.hunks[0] as Hunk & { type: "update" };
		expect(hunk.chunks).toHaveLength(2);
		expect(hunk.chunks[0].changeContext).toBe("foo");
		expect(hunk.chunks[1].changeContext).toBe("baz");
	});

	it("parses a move directive", () => {
		const patch = `*** Begin Patch
*** Update File: old.txt
*** Move to: new.txt
@@
-line
+line2
*** End Patch`;
		const result = parsePatch(patch);
		const hunk = result.hunks[0] as Hunk & { type: "update" };
		expect(hunk.path).toBe("old.txt");
		expect(hunk.movePath).toBe("new.txt");
	});

	it("parses an add hunk with multiple lines", () => {
		const patch = `*** Begin Patch
*** Add File: add.py
+abc
+def
*** End Patch`;
		const result = parsePatch(patch);
		expect(result.hunks[0]).toEqual({ type: "add", path: "add.py", contents: "abc\ndef\n" });
	});

	it("parses environment id preamble", () => {
		const patch = `*** Begin Patch
*** Environment ID: remote
*** Add File: hello.txt
+hello
*** End Patch`;
		const result = parsePatch(patch);
		expect(result.environmentId).toBe("remote");
		expect(result.hunks).toHaveLength(1);
	});

	it("rejects empty environment id", () => {
		const patch = `*** Begin Patch
*** Environment ID:   
*** End Patch`;
		expect(() => parsePatch(patch)).toThrow(ParseError);
	});

	it("rejects missing begin patch marker", () => {
		expect(() => parsePatch("bad")).toThrow(ParseError);
	});

	it("rejects missing end patch marker", () => {
		expect(() => parsePatch("*** Begin Patch\nbad")).toThrow(ParseError);
	});

	it("rejects empty update hunk", () => {
		const patch = `*** Begin Patch
*** Update File: test.py
*** End Patch`;
		expect(() => parsePatch(patch)).toThrow(ParseError);
	});

	it("rejects invalid hunk header", () => {
		const patch = `*** Begin Patch
bad
*** End Patch`;
		expect(() => parsePatch(patch)).toThrow(ParseError);
	});

	it("rejects update hunk with unexpected line", () => {
		const patch = `*** Begin Patch
*** Update File: test.py
@@
bad
*** End Patch`;
		expect(() => parsePatch(patch)).toThrow(ParseError);
	});

	it("parses lenient heredoc wrapper <<EOF", () => {
		const patch = `<<EOF
*** Begin Patch
*** Update File: f.py
@@
-old
+new
*** End Patch
EOF`;
		const result = parsePatch(patch);
		expect(result.hunks).toHaveLength(1);
		expect(result.patch).not.toContain("<<EOF");
	});

	it("parses lenient heredoc wrapper <<'EOF'", () => {
		const patch = `<<'EOF'
*** Begin Patch
*** Update File: f.py
@@
-old
+new
*** End Patch
EOF`;
		const result = parsePatch(patch);
		expect(result.hunks).toHaveLength(1);
	});

	it("parses lenient heredoc wrapper <<\"EOF\"", () => {
		const patch = `<<"EOF"
*** Begin Patch
*** Update File: f.py
@@
-old
+new
*** End Patch
EOF`;
		const result = parsePatch(patch);
		expect(result.hunks).toHaveLength(1);
	});

	it("rejects mismatched heredoc quotes", () => {
		const patch = `<<"EOF'
*** Begin Patch
*** Update File: f.py
@@
-old
+new
*** End Patch
EOF`;
		expect(() => parsePatch(patch)).toThrow(ParseError);
	});

	it("parses update hunk with EOF marker", () => {
		const patch = `*** Begin Patch
*** Update File: eof.txt
@@
+appended
*** End of File
*** End Patch`;
		const result = parsePatch(patch);
		const hunk = result.hunks[0] as Hunk & { type: "update" };
		expect(hunk.chunks[0].isEndOfFile).toBe(true);
		expect(hunk.chunks[0].oldLines).toEqual([]);
		expect(hunk.chunks[0].newLines).toEqual(["appended"]);
	});

	it("parses update hunk with empty context marker", () => {
		const patch = `*** Begin Patch
*** Update File: empty.txt
@@
-old
+new
*** End Patch`;
		const result = parsePatch(patch);
		const hunk = result.hunks[0] as Hunk & { type: "update" };
		expect(hunk.chunks[0].changeContext).toBeUndefined();
	});

	it("parses update hunk with empty lines in chunk", () => {
		const patch = `*** Begin Patch
*** Update File: empty.txt
@@ context
 
-removed
+added
*** End Patch`;
		const result = parsePatch(patch);
		const hunk = result.hunks[0] as Hunk & { type: "update" };
		expect(hunk.chunks[0].oldLines).toEqual(["", "removed"]);
		expect(hunk.chunks[0].newLines).toEqual(["", "added"]);
	});
});

// ---------------------------------------------------------------------------
// seekSequence tests
// ---------------------------------------------------------------------------

describe("seekSequence", () => {
	it("finds exact match", () => {
		const lines = ["foo", "bar", "baz"];
		expect(seekSequence(lines, ["bar", "baz"], 0, false)).toBe(1);
	});

	it("finds rstrip match ignoring trailing whitespace", () => {
		const lines = ["foo  ", "bar\t"];
		expect(seekSequence(lines, ["foo", "bar"], 0, false)).toBe(0);
	});

	it("finds trim match ignoring leading and trailing whitespace", () => {
		const lines = ["  foo  ", "  bar\t"];
		expect(seekSequence(lines, ["foo", "bar"], 0, false)).toBe(0);
	});

	it("finds unicode normalised match", () => {
		const lines = ["import asyncio  # local import \u2013 avoids top\u2011level dep"];
		expect(seekSequence(lines, ["import asyncio  # local import - avoids top-level dep"], 0, false)).toBe(0);
	});

	it("returns start for empty pattern", () => {
		expect(seekSequence(["a", "b"], [], 5, false)).toBe(5);
	});

	it("returns undefined when pattern is longer than input", () => {
		expect(seekSequence(["one"], ["too", "many"], 0, false)).toBeUndefined();
	});

	it("searches from start index", () => {
		const lines = ["a", "b", "a", "b"];
		expect(seekSequence(lines, ["a", "b"], 1, false)).toBe(2);
	});

	it("eof mode searches from end of file", () => {
		const lines = ["a", "b", "c", "d"];
		expect(seekSequence(lines, ["c", "d"], 0, true)).toBe(2);
	});

	it("returns undefined when no match", () => {
		expect(seekSequence(["a", "b", "c"], ["x", "y"], 0, false)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// computeReplacements + applyReplacements tests
// ---------------------------------------------------------------------------

describe("computeReplacements", () => {
	it("computes a simple replacement", () => {
		const lines = ["foo", "bar", "baz"];
		const chunks: UpdateFileChunk[] = [
			{ oldLines: ["bar"], newLines: ["BAR"], isEndOfFile: false },
		];
		const reps = computeReplacements(lines, "test", chunks);
		expect(reps).toEqual([{ startIdx: 1, oldLen: 1, newLines: ["BAR"] }]);
	});

	it("computes replacement with context", () => {
		const lines = ["foo", "bar", "baz", "qux"];
		const chunks: UpdateFileChunk[] = [
			{ changeContext: "bar", oldLines: ["baz"], newLines: ["BAZ"], isEndOfFile: false },
		];
		const reps = computeReplacements(lines, "test", chunks);
		expect(reps).toEqual([{ startIdx: 2, oldLen: 1, newLines: ["BAZ"] }]);
	});

	it("computes pure addition at end of file", () => {
		const lines = ["foo", "bar"];
		const chunks: UpdateFileChunk[] = [
			{ oldLines: [], newLines: ["baz"], isEndOfFile: true },
		];
		const reps = computeReplacements(lines, "test", chunks);
		expect(reps).toEqual([{ startIdx: 2, oldLen: 0, newLines: ["baz"] }]);
	});

	it("computes interleaved changes", () => {
		const lines = ["a", "b", "c", "d", "e", "f"];
		const chunks: UpdateFileChunk[] = [
			{ changeContext: "a", oldLines: ["b"], newLines: ["B"], isEndOfFile: false },
			{ changeContext: "c", oldLines: ["d", "e"], newLines: ["D", "E"], isEndOfFile: false },
			{ changeContext: "f", oldLines: [], newLines: ["g"], isEndOfFile: true },
		];
		const reps = computeReplacements(lines, "test", chunks);
		expect(reps).toEqual([
			{ startIdx: 1, oldLen: 1, newLines: ["B"] },
			{ startIdx: 3, oldLen: 2, newLines: ["D", "E"] },
			{ startIdx: 6, oldLen: 0, newLines: ["g"] },
		]);
	});

	it("handles trailing empty sentinel in oldLines", () => {
		const lines = ["foo", "bar"];
		const chunks: UpdateFileChunk[] = [
			{ oldLines: ["foo", ""], newLines: ["FOO", ""], isEndOfFile: false },
		];
		const reps = computeReplacements(lines, "test", chunks);
		expect(reps).toEqual([{ startIdx: 0, oldLen: 1, newLines: ["FOO"] }]);
	});

	it("throws when context is not found", () => {
		const lines = ["a", "b", "c"];
		const chunks: UpdateFileChunk[] = [
			{ changeContext: "missing", oldLines: ["b"], newLines: ["B"], isEndOfFile: false },
		];
		expect(() => computeReplacements(lines, "test", chunks)).toThrow(ComputeReplacementsError);
	});

	it("throws when oldLines are not found", () => {
		const lines = ["a", "b", "c"];
		const chunks: UpdateFileChunk[] = [
			{ oldLines: ["missing"], newLines: ["x"], isEndOfFile: false },
		];
		expect(() => computeReplacements(lines, "test", chunks)).toThrow(ComputeReplacementsError);
	});
});

describe("applyReplacements", () => {
	it("applies a single replacement", () => {
		const lines = ["foo", "bar", "baz"];
		const reps = [{ startIdx: 1, oldLen: 1, newLines: ["BAR"] }];
		expect(applyReplacements(lines, reps)).toEqual(["foo", "BAR", "baz"]);
	});

	it("applies multiple replacements in reverse order", () => {
		const lines = ["a", "b", "c", "d", "e"];
		const reps = [
			{ startIdx: 3, oldLen: 1, newLines: ["D"] },
			{ startIdx: 1, oldLen: 1, newLines: ["B"] },
		];
		expect(applyReplacements(lines, reps)).toEqual(["a", "B", "c", "D", "e"]);
	});

	it("applies insertion (oldLen=0)", () => {
		const lines = ["foo", "bar"];
		const reps = [{ startIdx: 1, oldLen: 0, newLines: ["mid"] }];
		expect(applyReplacements(lines, reps)).toEqual(["foo", "mid", "bar"]);
	});

	it("applies deletion (newLines empty)", () => {
		const lines = ["foo", "bar", "baz"];
		const reps = [{ startIdx: 1, oldLen: 1, newLines: [] }];
		expect(applyReplacements(lines, reps)).toEqual(["foo", "baz"]);
	});
});

// ---------------------------------------------------------------------------
// End-to-end applyPatch tests
// ---------------------------------------------------------------------------

describe("applyPatch engine", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-apply-patch-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("adds a file", async () => {
		const patch = `*** Begin Patch
*** Add File: add.txt
+hello
+world
*** End Patch`;
		const result = await applyPatch(patch, tmpDir);
		expect(result.affected.added).toEqual(["add.txt"]);
		const content = fs.readFileSync(path.join(tmpDir, "add.txt"), "utf-8");
		expect(content).toBe("hello\nworld\n");
	});

	it("deletes a file", async () => {
		fs.writeFileSync(path.join(tmpDir, "del.txt"), "bye", "utf-8");
		const patch = `*** Begin Patch
*** Delete File: del.txt
*** End Patch`;
		const result = await applyPatch(patch, tmpDir);
		expect(result.affected.deleted).toEqual(["del.txt"]);
		expect(fs.existsSync(path.join(tmpDir, "del.txt"))).toBe(false);
	});

	it("updates a file", async () => {
		fs.writeFileSync(path.join(tmpDir, "upd.txt"), "foo\nbar\n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: upd.txt
@@
 foo
-bar
+baz
*** End Patch`;
		const result = await applyPatch(patch, tmpDir);
		expect(result.affected.modified).toEqual(["upd.txt"]);
		const content = fs.readFileSync(path.join(tmpDir, "upd.txt"), "utf-8");
		expect(content).toBe("foo\nbaz\n");
	});

	it("updates a file with context", async () => {
		fs.writeFileSync(path.join(tmpDir, "ctx.txt"), "a\nb\nc\nd\n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: ctx.txt
@@ b
-c
+C
*** End Patch`;
		const result = await applyPatch(patch, tmpDir);
		const content = fs.readFileSync(path.join(tmpDir, "ctx.txt"), "utf-8");
		expect(content).toBe("a\nb\nC\nd\n");
	});

	it("moves a file", async () => {
		fs.writeFileSync(path.join(tmpDir, "src.txt"), "line\n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: src.txt
*** Move to: dst.txt
@@
-line
+line2
*** End Patch`;
		const result = await applyPatch(patch, tmpDir);
		expect(result.affected.modified).toEqual(["dst.txt"]);
		expect(fs.existsSync(path.join(tmpDir, "src.txt"))).toBe(false);
		const content = fs.readFileSync(path.join(tmpDir, "dst.txt"), "utf-8");
		expect(content).toBe("line2\n");
	});

	it("applies multiple hunks in one patch", async () => {
		fs.writeFileSync(path.join(tmpDir, "a.txt"), "", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "b.txt"), "old\n", "utf-8");
		const patch = `*** Begin Patch
*** Add File: c.txt
+new
*** Update File: b.txt
@@
-old
+new
*** Delete File: a.txt
*** End Patch`;
		const result = await applyPatch(patch, tmpDir);
		expect(result.affected.added).toEqual(["c.txt"]);
		expect(result.affected.modified).toEqual(["b.txt"]);
		expect(result.affected.deleted).toEqual(["a.txt"]);
		expect(fs.existsSync(path.join(tmpDir, "a.txt"))).toBe(false);
		expect(fs.readFileSync(path.join(tmpDir, "b.txt"), "utf-8")).toBe("new\n");
		expect(fs.readFileSync(path.join(tmpDir, "c.txt"), "utf-8")).toBe("new\n");
	});

	it("applies interleaved changes", async () => {
		fs.writeFileSync(path.join(tmpDir, "interleaved.txt"), "a\nb\nc\nd\ne\nf\n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: interleaved.txt
@@
 a
-b
+B
@@
 c
 d
-e
+E
@@
 f
+g
*** End of File
*** End Patch`;
		const result = await applyPatch(patch, tmpDir);
		const content = fs.readFileSync(path.join(tmpDir, "interleaved.txt"), "utf-8");
		expect(content).toBe("a\nB\nc\nd\nE\nf\ng\n");
	});

	it("handles pure addition followed by removal", async () => {
		fs.writeFileSync(path.join(tmpDir, "panic.txt"), "line1\nline2\nline3\n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: panic.txt
@@
+after-context
+second-line
@@
 line1
-line2
-line3
+line2-replacement
*** End Patch`;
		const result = await applyPatch(patch, tmpDir);
		const content = fs.readFileSync(path.join(tmpDir, "panic.txt"), "utf-8");
		expect(content).toBe("line1\nline2-replacement\nafter-context\nsecond-line\n");
	});

	it("matches unicode dashes with ascii dashes", async () => {
		const original = "import asyncio  # local import \u2013 avoids top\u2011level dep\n";
		fs.writeFileSync(path.join(tmpDir, "unicode.py"), original, "utf-8");
		const patch = `*** Begin Patch
*** Update File: unicode.py
@@
-import asyncio  # local import - avoids top-level dep
+import asyncio  # HELLO
*** End Patch`;
		const result = await applyPatch(patch, tmpDir);
		const content = fs.readFileSync(path.join(tmpDir, "unicode.py"), "utf-8");
		expect(content).toBe("import asyncio  # HELLO\n");
	});

	it("resolves relative paths against cwd", async () => {
		const patch = `*** Begin Patch
*** Add File: relative.txt
+content
*** End Patch`;
		const result = await applyPatch(patch, tmpDir);
		expect(result.affected.added).toEqual(["relative.txt"]);
		expect(fs.existsSync(path.join(tmpDir, "relative.txt"))).toBe(true);
	});

	it("resolves absolute paths directly", async () => {
		const absPath = path.join(tmpDir, "absolute.txt");
		const patch = `*** Begin Patch
*** Add File: ${absPath}
+absolute content
*** End Patch`;
		const result = await applyPatch(patch, tmpDir);
		expect(result.affected.added).toEqual([absPath]);
		expect(fs.existsSync(absPath)).toBe(true);
	});

	it("throws on invalid patch", async () => {
		const patch = `not a patch`;
		await expect(applyPatch(patch, tmpDir)).rejects.toThrow();
	});

	it("throws when update target is missing", async () => {
		const patch = `*** Begin Patch
*** Update File: missing.txt
@@
-old
+new
*** End Patch`;
		await expect(applyPatch(patch, tmpDir)).rejects.toThrow("File not found");
	});

	it("throws when oldLines cannot be found", async () => {
		fs.writeFileSync(path.join(tmpDir, "bad.txt"), "a\nb\n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: bad.txt
@@
-missing
+new
*** End Patch`;
		await expect(applyPatch(patch, tmpDir)).rejects.toThrow("Failed to find expected lines");
	});

	it("creates parent directories for added files", async () => {
		const patch = `*** Begin Patch
*** Add File: nested/dir/file.txt
+deep
*** End Patch`;
		await applyPatch(patch, tmpDir);
		expect(fs.existsSync(path.join(tmpDir, "nested", "dir", "file.txt"))).toBe(true);
	});

	it("creates parent directories for moved files", async () => {
		fs.writeFileSync(path.join(tmpDir, "src.txt"), "data\n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: src.txt
*** Move to: nested/dst.txt
@@
-data
+data2
*** End Patch`;
		await applyPatch(patch, tmpDir);
		expect(fs.existsSync(path.join(tmpDir, "nested", "dst.txt"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Batch integration tests
// ---------------------------------------------------------------------------

describe("batch patch integration", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-batch-patch-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("executes patch op through batch tool", async () => {
		const { createBatchTool } = await import("../src/batch/index.js");
		const tool = createBatchTool();
		const patch = `*** Begin Patch
*** Add File: batch-patch.txt
+hello from batch
*** End Patch`;
		const result = await tool.execute(
			"call-1",
			{ o: [{ o: "patch", p: ".", c: patch }] },
			undefined,
			undefined,
			{ cwd: tmpDir },
		);
		expect(result.details.results[0].status).toBe("ok");
		expect(result.details.results[0].op).toBe("patch");
		expect(result.details.results[0].affected?.added).toContain("batch-patch.txt");
		const content = fs.readFileSync(path.join(tmpDir, "batch-patch.txt"), "utf-8");
		expect(content).toBe("hello from batch\n");
	});
});
