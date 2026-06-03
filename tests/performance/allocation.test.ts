import { describe, it, expect } from "vitest";
import {
  classifyToolResult,
  applyContextCompression,
  type CompressionResult,
  type CompressionLevel,
} from "../../src/core2/snapshot.js";
import type { ContextProfile } from "../../src/flow/agents.js";
import {
  buildContentText,
  countLinesInBuffer,
  extractLinesFromBuffer,
} from "../../src/batch/execute.js";
import type { OpResult } from "../../src/batch/constants.js";

// ---------------------------------------------------------------------------
// P2-1: runner Buffer.concat handles large stdout
// ---------------------------------------------------------------------------
describe("P2-1: Buffer.concat large stdout", () => {
  it("emits 1000 chunks of 1KB and verifies final output correct", () => {
    const chunks: Buffer[] = [];
    const flushedLines: string[] = [];

    const flushLine = (line: string) => {
      if (line.trim()) flushedLines.push(line);
    };

    const onStdoutData = (chunk: Buffer) => {
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      const lines = text.split(/\r?\n/);
      const remainder = lines.pop() || "";
      chunks.length = 0;
      if (remainder) chunks.push(Buffer.from(remainder));
      for (const line of lines) flushLine(line);
    };

    const expectedLines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const line = `line-${i}-${"x".repeat(1000)}`;
      expectedLines.push(line);
      onStdoutData(Buffer.from(line + "\n"));
    }

    // Flush remaining
    if (chunks.length > 0) {
      const text = Buffer.concat(chunks).toString();
      if (text.trim()) {
        for (const line of text.split(/\r?\n/)) flushLine(line);
      }
    }

    expect(flushedLines.length).toBe(1000);
    expect(flushedLines[0]).toBe(expectedLines[0]);
    expect(flushedLines[999]).toBe(expectedLines[999]);
  });
});

// ---------------------------------------------------------------------------
// P6-1: stderr capped at MAX_STDERR_BYTES
// ---------------------------------------------------------------------------
describe("P6-1: stderr cap", () => {
  const MAX_STDERR_BYTES = 100 * 1024;
  const TRUNCATION_MARKER = "\n... [stderr truncated]";

  it("emits 200KB of stderr and verifies truncation", () => {
    let stderr = "";

    const onStderrData = (chunk: Buffer) => {
      const chunkStr = chunk.toString();
      if (stderr.length >= MAX_STDERR_BYTES) return;
      if (stderr.length + chunkStr.length > MAX_STDERR_BYTES) {
        const keepBytes = Math.max(0, MAX_STDERR_BYTES - 1000);
        stderr = stderr.slice(0, keepBytes) + TRUNCATION_MARKER;
      } else {
        stderr += chunkStr;
      }
    };

    // Use 600-byte chunks so 171 * 600 = 102600 > MAX_STDERR_BYTES (102400)
    for (let i = 0; i < 200; i++) {
      onStderrData(Buffer.from("x".repeat(600)));
    }

    expect(stderr.includes(TRUNCATION_MARKER)).toBe(true);
    expect(stderr.length).toBeLessThanOrEqual(MAX_STDERR_BYTES + TRUNCATION_MARKER.length);
  });
});

// ---------------------------------------------------------------------------
// P7-1: applyContextCompression 2-pass result matches old behavior
// ---------------------------------------------------------------------------
describe("P7-1: applyContextCompression 2-pass", () => {
  const filesFirstProfile: ContextProfile = {
    name: "files-first",
    keepCategories: ["fileContent", "error"],
    compressCategories: ["bashSuccess", "grepResult", "other"],
  };

  function makeMessageEntry(role: string, text: string, toolName?: string): unknown {
    return {
      type: "message",
      message: {
        role,
        content: [{ type: "text", text }],
        ...(toolName ? { toolName, name: toolName } : {}),
      },
    };
  }

  it("compresses 100 entries deterministically", () => {
    const entries: unknown[] = [];
    // Header entries (non-messages, should always be kept)
    entries.push({ type: "header", version: 1 });
    entries.push({ type: "session", id: "test" });

    // 50 user messages (high score, should be kept)
    for (let i = 0; i < 50; i++) {
      entries.push(makeMessageEntry("user", `user message ${i}`));
    }

    // 50 bashSuccess tool messages (low score with files-first, should be dropped)
    for (let i = 0; i < 50; i++) {
      entries.push(makeMessageEntry("tool", `--- bash [test-${i}] exit 0 ---\noutput`, "bash"));
    }

    const result = applyContextCompression(entries, "medium", filesFirstProfile);

    // With 100 messages and medium compression, target = max(5, floor(100 * 0.4)) = 40
    // User messages score higher (60 default) than bashSuccess (20)
    // So the top 40 should be user messages, and 60 should be dropped
    expect(result.droppedCount).toBe(60);

    const keptMessages = result.entries.filter(
      (e) => {
        if (!e || typeof e !== "object") return false;
        const msg = (e as Record<string, unknown>).message as Record<string, unknown> | undefined;
        return (e as Record<string, unknown>).type === "message" && msg?.role !== "system";
      }
    );
    expect(keptMessages.length).toBe(40);

    // All kept non-system messages should be user messages (higher score)
    const allKeptAreUser = keptMessages.every((e) => {
      const msg = (e as Record<string, unknown>).message as Record<string, unknown>;
      return msg.role === "user";
    });
    expect(allKeptAreUser).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P10-1: Buffer line splitting matches split('\n')
// ---------------------------------------------------------------------------
describe("P10-1: Buffer line splitting", () => {
  it("matches split('\\n') for empty string", () => {
    const buf = Buffer.from("");
    const viaSplit = "".split("\n");
    const viaBuffer = extractLinesFromBuffer(buf, 0, countLinesInBuffer(buf));
    expect(viaBuffer.length).toBe(viaSplit.length);
    expect(viaBuffer).toEqual(viaSplit);
  });

  it("matches split('\\n') for trailing newlines", () => {
    const text = "a\nb\nc\n";
    const buf = Buffer.from(text);
    const viaSplit = text.split("\n");
    const viaBuffer = extractLinesFromBuffer(buf, 0, countLinesInBuffer(buf));
    expect(viaBuffer.length).toBe(viaSplit.length);
    expect(viaBuffer).toEqual(viaSplit);
  });

  it("matches split('\\n') for UTF-8 multi-byte characters", () => {
    const text = "hello\n世界\n🚀\nend";
    const buf = Buffer.from(text);
    const viaSplit = text.split("\n");
    const viaBuffer = extractLinesFromBuffer(buf, 0, countLinesInBuffer(buf));
    expect(viaBuffer.length).toBe(viaSplit.length);
    expect(viaBuffer).toEqual(viaSplit);
  });

  it("matches split('\\n') for no trailing newline", () => {
    const text = "a\nb\nc";
    const buf = Buffer.from(text);
    const viaSplit = text.split("\n");
    const viaBuffer = extractLinesFromBuffer(buf, 0, countLinesInBuffer(buf));
    expect(viaBuffer.length).toBe(viaSplit.length);
    expect(viaBuffer).toEqual(viaSplit);
  });
});

// ---------------------------------------------------------------------------
// P14-1: buildContentText Buffer path for large batches
// ---------------------------------------------------------------------------
describe("P14-1: buildContentText Buffer path", () => {
  it("handles 200 read results correctly", () => {
    const results: OpResult[] = [];
    for (let i = 0; i < 200; i++) {
      results.push({
        op: "read",
        path: `file-${i}.ts`,
        status: "ok",
        content: `content ${i}`,
        totalLines: 10,
      });
    }

    const summary = "--- batch summary ---";
    const output = buildContentText(summary, results);

    // Verify all files are present in output
    expect(output.startsWith(summary)).toBe(true);
    for (let i = 0; i < 200; i++) {
      expect(output.includes(`file-${i}.ts`)).toBe(true);
      expect(output.includes(`content ${i}`)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// P16-1: classifyToolResult regex matches old includes
// ---------------------------------------------------------------------------
describe("P16-1: classifyToolResult categories", () => {
  function makeEntry(text: string, toolName?: string): unknown {
    return {
      type: "message",
      message: {
        role: "tool",
        content: [{ type: "text", text }],
        ...(toolName ? { toolName, name: toolName } : {}),
      },
    };
  }

  it("classifies error", () => {
    expect(classifyToolResult(makeEntry("Error: something failed"))).toBe("error");
    expect(classifyToolResult(makeEntry("FAIL: test did not pass"))).toBe("error");
  });

  it("classifies stackTrace", () => {
    expect(classifyToolResult(makeEntry("Error: oops\n  at foo (/bar.js:1:1)"))).toBe("stackTrace");
  });

  it("classifies testFailure", () => {
    expect(classifyToolResult(makeEntry("✕ test case did not pass"))).toBe("testFailure");
    expect(classifyToolResult(makeEntry("expected 1 but received 2"))).toBe("testFailure");
  });

  it("classifies gitDiff", () => {
    expect(classifyToolResult(makeEntry("diff --git a/file.ts b/file.ts"))).toBe("gitDiff");
    expect(classifyToolResult(makeEntry("--- a/foo\n+++ b/foo\n@@ -1,2 +1,2 @@"))).toBe("gitDiff");
  });

  it("classifies fileContent", () => {
    expect(classifyToolResult(makeEntry("--- read: src/foo.ts ---\ncontent"))).toBe("fileContent");
    expect(classifyToolResult(makeEntry("✔ read: src/foo.ts"))).toBe("fileContent");
  });

  it("classifies grepResult", () => {
    expect(classifyToolResult(makeEntry("--- rg: src ---\nfoo.ts:1:const x = 1"))).toBe("grepResult");
    expect(classifyToolResult(makeEntry("--- find: src ---\nfoo.ts"))).toBe("grepResult");
  });

  it("classifies bashSuccess", () => {
    expect(classifyToolResult(makeEntry("--- bash [test] exit 0 ---\noutput"))).toBe("bashSuccess");
    expect(classifyToolResult(makeEntry("--- [test] exit 0 ---\noutput"))).toBe("bashSuccess");
    expect(classifyToolResult(makeEntry("anything", "bash"))).toBe("bashSuccess");
  });

  it("classifies other", () => {
    expect(classifyToolResult(makeEntry("random text"))).toBe("other");
    expect(classifyToolResult(makeEntry(""))).toBe("other");
    expect(classifyToolResult(null)).toBe("other");
    expect(classifyToolResult({ type: "foo" })).toBe("other");
  });
});
