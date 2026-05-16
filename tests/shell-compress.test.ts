import { describe, it, expect } from "vitest";
import {
	OutputPolicy,
	classify,
	compressOutput,
	terseFilter,
	lightweightCleanup,
	truncateWithSafetyScan,
	estimateTokens,
	stripAnsi,
} from "../src/batch/shell-compress.js";

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe("classify", () => {
	it("returns Passthrough for npm run dev", () => {
		expect(classify("npm run dev")).toBe(OutputPolicy.Passthrough);
	});

	it("returns Passthrough for npm start", () => {
		expect(classify("npm start")).toBe(OutputPolicy.Passthrough);
	});

	it("returns Passthrough for cargo watch", () => {
		expect(classify("cargo watch")).toBe(OutputPolicy.Passthrough);
	});

	it("returns Passthrough for commands containing watch", () => {
		expect(classify("watch -n 1 ls")).toBe(OutputPolicy.Passthrough);
	});

	it("returns Passthrough for commands containing auth", () => {
		expect(classify("gcloud auth login")).toBe(OutputPolicy.Passthrough);
	});

	it("returns Passthrough for python http.server", () => {
		expect(classify("python -m http.server")).toBe(OutputPolicy.Passthrough);
	});

	it("returns Passthrough for live-server", () => {
		expect(classify("live-server ./public")).toBe(OutputPolicy.Passthrough);
	});

	it("returns Verbatim for cat", () => {
		expect(classify("cat file.txt")).toBe(OutputPolicy.Verbatim);
	});

	it("returns Verbatim for curl", () => {
		expect(classify("curl https://example.com")).toBe(OutputPolicy.Verbatim);
	});

	it("returns Verbatim for kubectl get -o yaml", () => {
		expect(classify("kubectl get pods -o yaml")).toBe(OutputPolicy.Verbatim);
	});

	it("returns Verbatim for docker inspect", () => {
		expect(classify("docker inspect container")).toBe(OutputPolicy.Verbatim);
	});

	it("returns Verbatim for terraform output", () => {
		expect(classify("terraform output")).toBe(OutputPolicy.Verbatim);
	});

	it("returns Verbatim for stripe list", () => {
		expect(classify("stripe customers list")).toBe(OutputPolicy.Verbatim);
	});

	it("returns Verbatim for gh api", () => {
		expect(classify("gh api repos/:owner/:repo")).toBe(OutputPolicy.Verbatim);
	});

	it("returns Compressible for git log", () => {
		expect(classify("git log")).toBe(OutputPolicy.Compressible);
	});

	it("returns Compressible for npm test", () => {
		expect(classify("npm test")).toBe(OutputPolicy.Compressible);
	});

	it("returns Compressible for cargo build", () => {
		expect(classify("cargo build")).toBe(OutputPolicy.Compressible);
	});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

	it("returns Compressible for grep auth (no false positive)", () => {
		expect(classify("grep authentication")).toBe(OutputPolicy.Compressible);
	});

	it("returns Compressible for cat server.log (no false positive)", () => {
		expect(classify("cat server.log")).toBe(OutputPolicy.Verbatim);
	});

	it("returns Compressible for echo watch this (no false positive)", () => {
		expect(classify('echo "watch this"')).toBe(OutputPolicy.Compressible);
	});

	it("returns Passthrough for vite", () => {
		expect(classify("vite")).toBe(OutputPolicy.Passthrough);
	});

	it("returns Compressible for vite build", () => {
		expect(classify("vite build")).toBe(OutputPolicy.Compressible);
	});

	it("returns Passthrough for next dev", () => {
		expect(classify("next dev")).toBe(OutputPolicy.Passthrough);
	});

	it("returns Passthrough for nodemon", () => {
		expect(classify("nodemon server.js")).toBe(OutputPolicy.Passthrough);
	});

	it("returns Passthrough for npm run serve", () => {
		expect(classify("npm run serve")).toBe(OutputPolicy.Passthrough);
	});

	it("returns Passthrough for yarn run watch", () => {
		expect(classify("yarn run watch")).toBe(OutputPolicy.Passthrough);
	});

	it("returns Passthrough for az login", () => {
		expect(classify("az login")).toBe(OutputPolicy.Passthrough);
	});

	it("returns Compressible for az list", () => {
		expect(classify("az account list")).toBe(OutputPolicy.Compressible);
	});

describe("estimateTokens", () => {
	it("returns ceil(length / 4)", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2);
	});
});

describe("stripAnsi", () => {
	it("removes ANSI escape codes", () => {
		const raw = "\x1b[32mgreen\x1b[0m \x1b[1mbold\x1b[22m";
		expect(stripAnsi(raw)).toBe("green bold");
	});

	it("returns plain text unchanged", () => {
		expect(stripAnsi("hello world")).toBe("hello world");
	});
});

// ---------------------------------------------------------------------------
// Terse filter
// ---------------------------------------------------------------------------

describe("terseFilter", () => {
	it("strips ANSI codes", () => {
		const raw = "\x1b[32mgreen\x1b[0m\nline2";
		expect(terseFilter(raw)).toBe("green\nline2");
	});

	it("strips lines starting with \\r", () => {
		const raw = "\rprogress 50%\ndone";
		expect(terseFilter(raw)).toBe("done");
	});

	it("collapses 3+ blank lines to 1", () => {
		const raw = "a\n\n\n\nb";
		expect(terseFilter(raw)).toBe("a\n\nb");
	});

	it("strips pure decoration lines", () => {
		const raw = "header\n───\n───\ncontent";
		expect(terseFilter(raw)).toBe("header\ncontent");
	});

	it("strips missing box-drawing chars (┌ ┐ ┘ ┤ ├ ┴ ┬)", () => {
		const raw = "header\n┌───┐\n├─┴─┤\n┘ ┬\ncontent";
		expect(terseFilter(raw)).toBe("header\ncontent");
	});

	it("strips trailing whitespace", () => {
		const raw = "line1   \nline2\t";
		expect(terseFilter(raw)).toBe("line1\nline2");
	});

	it("returns original if savings < 3%", () => {
		const raw = "short text\nline two";
		expect(terseFilter(raw)).toBe(raw);
	});

	it("applies savings when >= 3%", () => {
		const raw = "\x1b[32mok\x1b[0m\n".repeat(200) + "\n\n\n\n".repeat(20);
		const result = terseFilter(raw);
		expect(result.length).toBeLessThan(raw.length * 0.97);
	});
});

// ---------------------------------------------------------------------------
// Lightweight cleanup
// ---------------------------------------------------------------------------

describe("lightweightCleanup", () => {
	it("strips ANSI, trims trailing whitespace, collapses blanks", () => {
		const raw = "\x1b[32mok\x1b[0m  \n\n\n\nnext";
		expect(lightweightCleanup(raw)).toBe("ok\n\nnext");
	});
});

// ---------------------------------------------------------------------------
// Safety-scan truncation
// ---------------------------------------------------------------------------

describe("truncateWithSafetyScan", () => {
	it("returns null when lines are too short", () => {
		expect(truncateWithSafetyScan(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"])).toBeNull();
	});

	it("keeps head, tail, and safety lines", () => {
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
		lines[15] = "error: something broke";
		lines[16] = "warning: deprecated";
		const result = truncateWithSafetyScan(lines);
		expect(result).toContain("line 1");
		expect(result).toContain("line 5");
		expect(result).toContain("line 26");
		expect(result).toContain("line 30");
		expect(result).toContain("error: something broke");
		expect(result).toContain("warning: deprecated");
		expect(result).toContain("20 lines omitted");
	});

	it("does not match safety needles inside longer words", () => {
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
		lines[15] = "errorBoundary handled";
		const result = truncateWithSafetyScan(lines);
		expect(result).not.toContain("errorBoundary");
		expect(result).toContain("20 lines omitted");
	});

	it("caps safety-relevant lines at 20", () => {
		const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
		for (let i = 10; i < 40; i++) {
			lines[i] = `error ${i}`;
		}
		const result = truncateWithSafetyScan(lines);
		const matches = result!.split("\n").filter((l) => l.startsWith("error"));
		expect(matches.length).toBe(20);
	});

	it("returns null if result is not shorter", () => {
		const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
		const result = truncateWithSafetyScan(lines);
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// compressOutput pipeline
// ---------------------------------------------------------------------------

describe("compressOutput", () => {
	it("returns original for short combined output (<50 tokens)", () => {
		const result = compressOutput("npm test", "ok", "");
		expect(result.stdout).toBe("ok");
		expect(result.savingsPct).toBe(0);
	});

	it("returns original for passthrough commands", () => {
		const big = "a".repeat(1000);
		const result = compressOutput("npm run dev", big, "");
		expect(result.stdout).toBe(big);
		expect(result.savingsPct).toBe(0);
	});

	it("truncates verbatim output over 8000 tokens", () => {
		const lines = Array.from({ length: 4000 }, (_, i) => `line ${i + 1}`);
		const big = lines.join("\n");
		const result = compressOutput("cat big.txt", big, "");
		expect(result.stdout).toContain("line 1");
		expect(result.stdout).toContain("line 30");
		expect(result.stdout).toContain("lines omitted");
		expect(result.stdout).toContain("line 3981");
		expect(result.stdout).toContain("line 4000");
		expect(result.savingsPct).toBeGreaterThan(0);
	});

	it("does not truncate verbatim output under 8000 tokens", () => {
		const text = "line1\nline2\nline3";
		const result = compressOutput("cat small.txt", text, "");
		expect(result.stdout).toBe(text);
		expect(result.savingsPct).toBe(0);
	});

	it("applies terseFilter for compressible commands", () => {
		const text = "\x1b[32mok\x1b[0m  \n\n\n\nnext" + "\n".repeat(200);
		const result = compressOutput("npm test", text, "");
		expect(result.stdout).not.toContain("\x1b[32m");
		expect(result.savingsPct).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Git log compressor
// ---------------------------------------------------------------------------

describe("git log compression", () => {
	it("compresses full git log with ≤3 commits", () => {
		const out = [
			"commit abc1234",
			"Author: A <a@b.com>",
			"Date:   Mon Jan 1 00:00:00 2024",
			"",
			"    feat: initial",
			"",
			"diff --git a/f b/f",
			"+line",
			"commit def5678",
			"Author: B <b@b.com>",
			"Date:   Mon Jan 2 00:00:00 2024",
			"",
			"    feat: second",
			"",
			"diff --git a/f2 b/f2",
			"+line2",
		].join("\n");
		const result = compressOutput("git log -p", out, "");
		expect(result.stdout).toContain("abc1234");
		expect(result.stdout).toContain("def5678");
		expect(result.stdout).toContain("diff --git");
	});

	it("compresses git log with 4-20 commits", () => {
		const blocks = Array.from({ length: 5 }, (_, i) => [
			`commit ${String(i).padStart(7, "0")}abc`,
			`Author: U${i}`,
			"",
			`    msg ${i}`,
			"",
			"diff --git a/f b/f",
			"+change",
			" 1 file changed, 1 insertion(+)",
		]);
		const out = blocks.flat().join("\n") + "\n" + "\x1b[32mpadding\x1b[0m  \n".repeat(20);
		const result = compressOutput("git log -p", out, "");
		// First commit keeps full diff (first 30 lines of diff)
		expect(result.stdout).toContain("diff --git");
		// Later commits are compact
		expect(result.stdout).toContain("[1 files] +1/-0");
	});

	it("compresses git log with >20 commits", () => {
		const blocks = Array.from({ length: 25 }, (_, i) => [
			`commit ${String(i).padStart(7, "0")}abc`,
			"Author: U",
			"",
			`    msg ${i}`,
			"",
			" 1 file changed, 1 insertion(+), 0 deletions(-)",
		]);
		const out = blocks.flat().join("\n") + "\n" + "\x1b[32mpadding\x1b[0m  \n".repeat(20);
		const result = compressOutput("git log", out, "");
		expect(result.stdout).toContain("[25 commits, +25/-0]");
		expect(result.stdout).not.toContain("Author:");
	});

	it("handles git --oneline", () => {
		const lines = Array.from({ length: 120 }, (_, i) => `${String(i).padStart(7, "0")}abc msg ${i}`);
		const result = compressOutput("git log --oneline", lines.join("\n"), "");
		expect(result.stdout).toContain("...(20 more)");
		expect(result.stdout.split("\n").length).toBeLessThanOrEqual(101); // 100 + summary line
	});

	it("handles git --stat", () => {
		const out = [
			"commit abc1234",
			"Author: A",
			"Date:   Mon Jan 1",
			"",
			"    feat: thing",
			"",
			" file.ts | 2 +",
			" 1 file changed, 2 insertions(+)",
		].join("\n") + "\n" + "\x1b[32mpadding\x1b[0m  \n".repeat(20);
		const result = compressOutput("git log --stat", out, "");
		expect(result.stdout).toContain("abc1234");
		expect(result.stdout).toContain("file.ts | 2 +");
		expect(result.stdout).not.toContain("Author:");
	});
});

// ---------------------------------------------------------------------------
// Git commit compressor
// ---------------------------------------------------------------------------

describe("git commit compression", () => {
	it("summarises hooks and commit info", () => {
		const out = [
			"Running pre-commit...",
			"pre-commit passed",
			"[main abc1234] feat: thing",
			" 1 file changed, 2 insertions(+)",
		].join("\n") + "\n" + "\x1b[32mpadding\x1b[0m  \n".repeat(20);
		const result = compressOutput("git commit -m 'feat: thing'", out, "");
		expect(result.stdout).toContain("2 hooks passed");
		expect(result.stdout).toContain("abc1234 (main) feat: thing [1 files, +2/-0]");
	});

	it("shows failed hooks", () => {
		const out = [
			"Running pre-commit...",
			"pre-commit failed",
			"[main abc1234] feat: thing",
			" 1 file changed, 2 insertions(+)",
		].join("\n") + "\n" + "\x1b[32mpadding\x1b[0m  \n".repeat(20);
		const result = compressOutput("git commit -m 'feat: thing'", out, "");
		expect(result.stdout).toContain("1 passed, 1 failed");
		expect(result.stdout).toContain("pre-commit failed");
	});
});

// ---------------------------------------------------------------------------
// Git push compressor
// ---------------------------------------------------------------------------

describe("git push compression", () => {
	it("summarises up-to-date", () => {
		const out = "Everything up-to-date\n" + "\x1b[32mpadding\x1b[0m  \n".repeat(20);
		const result = compressOutput("git push", out, "");
		expect(result.stdout).toBe("ok (up-to-date)");
	});

	it("keeps ref updates", () => {
		const out = "To origin\n   abc..def  main -> main\nDone\n" + "\x1b[32mpadding\x1b[0m  \n".repeat(20);
		const result = compressOutput("git push", out, "");
		expect(result.stdout).toContain("main -> main");
	});

	it("keeps rejected lines", () => {
		const out = "To origin\n ! [rejected] main -> main (non-fast-forward)\nerror\n" + "\x1b[32mpadding\x1b[0m  \n".repeat(20);
		const result = compressOutput("git push", out, "");
		expect(result.stdout).toContain("rejected");
	});

	it("strips remote: lines", () => {
		const out = "remote: Resolving deltas\nremote: done\n   abc..def  main -> main\n" + "\x1b[32mpadding\x1b[0m  \n".repeat(20);
		const result = compressOutput("git push", out, "");
		expect(result.stdout).not.toContain("remote:");
	});
});

// ---------------------------------------------------------------------------
// npm install compressor
// ---------------------------------------------------------------------------

describe("npm install compression", () => {
	it("strips package tree and keeps summary", () => {
		const out = [
			"+ package-a@1.0.0",
			"+ package-b@2.0.0",
			"added 2 packages in 1s",
		].join("\n") + "\n" + "\x1b[32mpadding\x1b[0m  \n".repeat(20);
		const result = compressOutput("npm install", out, "");
		expect(result.stdout).toBe("added 2 packages in 1s");
	});

	it("falls back to last 3 non-tree lines if no summary", () => {
		const out = [
			"+ package-a@1.0.0",
			"info some info",
			"warn some warn",
			"done",
		].join("\n");
		const result = compressOutput("npm install", out, "");
		expect(result.stdout).toContain("warn some warn");
		expect(result.stdout).toContain("done");
	});
});

// ---------------------------------------------------------------------------
// npm test compressor
// ---------------------------------------------------------------------------

describe("npm test compression", () => {
	it("kept summary lines only", () => {
		const out = [
			"PASS  src/a.test.ts",
			"  test one",
			"    ✓ step (1 ms)",
			"Test Suites: 1 passed, 1 total",
			"Tests:       1 passed, 1 total",
			"Time:        0.5s",
		].join("\n") + "\n" + "\x1b[32mpadding\x1b[0m  \n".repeat(20);
		const result = compressOutput("npm test", out, "");
		expect(result.stdout).toContain("PASS  src/a.test.ts");
		expect(result.stdout).toContain("Test Suites:");
		expect(result.stdout).toContain("Tests:");
		expect(result.stdout).toContain("Time:");
		expect(result.stdout).not.toContain("✓ step");
	});

	it("keeps error detail blocks", () => {
		const out = [
			"FAIL  src/b.test.ts",
			"  test two",
			"    ✕ step (1 ms)",
			"",
			"  Error: expected true to be false",
			"    at Object.<anonymous> (b.test.ts:3:1)",
			"",
			"Test Suites: 1 failed, 1 total",
			"Tests:       1 failed, 1 total",
		].join("\n");
		const result = compressOutput("npm test", out, "");
		expect(result.stdout).toContain("FAIL  src/b.test.ts");
		expect(result.stdout).toContain("Error: expected true");
	});
});

// ---------------------------------------------------------------------------
// Cargo compressor
// ---------------------------------------------------------------------------

describe("cargo compression", () => {
	it("strips Compiling lines and keeps summary", () => {
		const out = [
			"Compiling pkg-a v1.0.0",
			"Compiling pkg-b v1.0.0",
			"Finished dev [unoptimized] target(s) in 1.2s",
		].join("\n") + "\n" + "\x1b[32mpadding\x1b[0m  \n".repeat(20);
		const result = compressOutput("cargo build", out, "");
		expect(result.stdout).toContain("compiled 2 crates");
		expect(result.stdout).toContain("Finished dev");
		expect(result.stdout).not.toContain("Compiling pkg-a");
	});

	it("keeps test results and errors", () => {
		const out = [
			"running 3 tests",
			"test t1 ... ok",
			"test t2 ... FAILED",
			"test t3 ... ok",
			"test result: ok. 3 passed; 0 failed",
		].join("\n");
		const result = compressOutput("cargo test", out, "");
		expect(result.stdout).toContain("running 3 tests");
		expect(result.stdout).toContain("test result: ok");
	});

	it("keeps first error and counts extras", () => {
		const out = [
			"error: unresolved import",
			"error: another issue",
			"error: third issue",
		].join("\n") + "\n" + "\x1b[32mpadding\x1b[0m  \n".repeat(20);
		const result = compressOutput("cargo build", out, "");
		expect(result.stdout).toContain("unresolved import");
		expect(result.stdout).toContain("(+2 more)");
	});

	it("keeps first warning and counts extras", () => {
		const out = [
			"warning: unused variable",
			"warning: dead code",
		].join("\n") + "\n" + "\x1b[32mpadding\x1b[0m  \n".repeat(20);
		const result = compressOutput("cargo build", out, "");
		expect(result.stdout).toContain("unused variable");
		expect(result.stdout).toContain("(+1 more)");
	});

	it("strips Downloading lines", () => {
		const out = [
			"Downloading pkg v1.0.0",
			"Compiling pkg v1.0.0",
			"Finished",
		].join("\n") + "\n" + "\x1b[32mpadding\x1b[0m  \n".repeat(20);
		const result = compressOutput("cargo build", out, "");
		expect(result.stdout).not.toContain("Downloading");
	});
});
