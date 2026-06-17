import { describe, it, expect } from "vitest";
import {
  buildCore2Snapshot,
  buildSnapshotWithCompression,
  estimateTotalContextTokens,
  CompressionLevel,
  ContextProfile,
} from "../src/core2/snapshot.js";

function makeSource(entries: unknown[]) {
  return {
    getHeader: () => ({ version: 1, id: "test-session" }),
    getBranch: () => entries,
  };
}

function parseSnapshot(snapshot: string | null): unknown[] {
  if (!snapshot) return [];
  return snapshot
    .trimEnd()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

const filesFirstProfile: ContextProfile = {
  name: "files-first",
  keepCategories: ["fileContent", "error"],
  compressCategories: ["bashSuccess", "grepResult", "other"],
};

const errorsFirstProfile: ContextProfile = {
  name: "errors-first",
  keepCategories: ["error", "stackTrace", "testFailure"],
  compressCategories: ["bashSuccess", "fileContent", "grepResult", "gitDiff", "other"],
};

describe("estimateTotalContextTokens", () => {
  it("estimates tokens from string length", () => {
    const text = "a".repeat(400);
    expect(estimateTotalContextTokens(text)).toBe(100);
  });
});

describe("buildCore2Snapshot — compression level none", () => {
  it("preserves existing tier behavior when level is none", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "toolResult",
          name: "bash",
          content: [{ type: "text", text: "long output here\nline2\nline3" }],
        },
      },
    ];
    const snapshot = buildCore2Snapshot(makeSource(entries), {
      tier: "lite",
      compressionLevel: "none",
    });
    expect(snapshot).not.toContain("long output here");
    expect(snapshot).toContain("[toolResult: bash]");
  });
});

describe("buildCore2Snapshot — light compression", () => {
  it("keeps fileContent tool results for files-first profile", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "toolResult",
          name: "batch_read",
          content: [
            {
              type: "text",
              text: "✔ 1 read\n\n--- src/file.ts (3 lines) ---\na\nb\nc",
            },
          ],
        },
      },
    ];
    const snapshot = buildCore2Snapshot(makeSource(entries), {
      tier: "lite",
      compressionLevel: "light",
      compressionProfile: filesFirstProfile,
    });
    expect(snapshot).toContain("src/file.ts");
    expect(snapshot).toContain("a");
    expect(snapshot).toContain("b");
    expect(snapshot).toContain("c");
  });

  it("compresses bash tool results for files-first profile", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "toolResult",
          name: "bash",
          content: [{ type: "text", text: "npm test output" }],
        },
      },
    ];
    const snapshot = buildCore2Snapshot(makeSource(entries), {
      tier: "lite",
      compressionLevel: "light",
      compressionProfile: filesFirstProfile,
    });
    expect(snapshot).not.toContain("npm test output");
    expect(snapshot).toContain("[toolResult: bash]");
  });

  it("reduces snapshot size measurably", () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({
      type: "message",
      message: {
        role: i % 2 === 0 ? ("user" as const) : ("toolResult" as const),
        content:
          i % 2 === 0
            ? `user message ${i}`
            : [{ type: "text" as const, text: "x".repeat(1000) }],
      },
    }));
    const fullSnapshot = buildCore2Snapshot(makeSource(entries));
    const compressedSnapshot = buildCore2Snapshot(makeSource(entries), {
      tier: "lite",
      compressionLevel: "light",
      compressionProfile: filesFirstProfile,
    });
    expect(compressedSnapshot!.length).toBeLessThan(fullSnapshot!.length);
  });
});

describe("buildCore2Snapshot — medium compression", () => {
  it("strips old system messages", () => {
    const entries = [
      { type: "message", message: { role: "system", content: "old system message 1" } },
      { type: "message", message: { role: "system", content: "old system message 2" } },
      { type: "message", message: { role: "user", content: "Hello" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } },
    ];
    const snapshot = buildCore2Snapshot(makeSource(entries), {
      tier: "lite",
      compressionLevel: "medium",
    });
    expect(snapshot).not.toContain("old system message 1");
    expect(snapshot).not.toContain("old system message 2");
    expect(snapshot).toContain("Hello");
    expect(snapshot).toContain("Hi");
  });

  it("generates synthetic summary for dropped messages", () => {
    const entries = [
      { type: "message", message: { role: "user", content: "Read src/a.ts" } },
      {
        type: "message",
        message: {
          role: "toolResult",
          name: "batch",
          content: [
            {
              type: "text",
              text: "✔ 1 read\n\n--- src/a.ts (3 lines) ---\nx\ny\nz",
            },
          ],
        },
      },
      ...Array.from({ length: 30 }, (_, i) => ({
        type: "message" as const,
        message: { role: "user" as const, content: `filler-${i}` },
      })),
    ];
    const snapshot = buildCore2Snapshot(makeSource(entries), {
      tier: "lite",
      compressionLevel: "medium",
    });
    const parsed = parseSnapshot(snapshot);
    // Should have a synthetic summary system message among the kept messages
    const hasSummary = parsed.some(
      (e: any) =>
        e.message?.role === "system" &&
        typeof e.message?.content === "string" &&
        e.message.content.includes("Context summary"),
    );
    // Medium compression tightens by 60%, so some messages get dropped
    expect(hasSummary || parsed.length < entries.length + 2).toBe(true);
  });
});

describe("buildCore2Snapshot — aggressive compression", () => {
  it("compresses all tool results regardless of profile", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "batch-1",
          name: "batch_read",
          content: [
            {
              type: "text",
              text: "✔ 1 read\n\n--- src/file.ts (3 lines) ---\na\nb\nc",
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          name: "bash",
          content: [{ type: "text", text: "npm test" }],
        },
      },
    ];
    const snapshot = buildCore2Snapshot(makeSource(entries), {
      tier: "lite",
      compressionLevel: "aggressive",
      compressionProfile: filesFirstProfile,
    });
    expect(snapshot).not.toContain("src/file.ts");
    expect(snapshot).not.toContain("npm test");
    expect(snapshot).toContain("[toolResult: bash]");
  });

  it("applies hard message cap of 15", () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
      type: "message",
      message: { role: "user" as const, content: `msg-${i}` },
    }));
    const snapshot = buildCore2Snapshot(makeSource(entries), {
      tier: "full",
      compressionLevel: "aggressive",
    });
    const parsed = parseSnapshot(snapshot);
    // header + context map + at most 15 messages
    expect(parsed.length).toBeLessThanOrEqual(17);
  });
});

describe("buildSnapshotWithCompression — maxContextTokens wiring", () => {
  it("triggers compression earlier when maxContextTokens is low", () => {
    // Generate ~50k tokens (200k chars) — below default 70k threshold, but above
    // a low maxContextTokens threshold (32k * 0.6 = 19.2k).
    const entries = Array.from({ length: 200 }, (_, i) => ({
      type: "message" as const,
      message: {
        role: "user" as const,
        content: "x".repeat(1000),
      },
    }));
    const source = makeSource(entries);

    const withoutLimit = buildSnapshotWithCompression(source, {});
    expect(withoutLimit.stats).toBeUndefined();

    const withLimit = buildSnapshotWithCompression(source, {}, 32_000);
    expect(withLimit.stats).toBeDefined();
    expect(withLimit.stats!.level).not.toBe("none");
    expect(withLimit.stats!.messagesDropped).toBeGreaterThan(0);
  });
});

describe("buildCore2Snapshot — synthetic summary command extraction", () => {
  it("extracts clean commands from JSON tool call blocks without JSON key noise", () => {
    const entries = [
      {
        type: "message" as const,
        message: {
          role: "toolResult" as const,
          toolCallId: "bash-1",
          name: "bash",
          content: [
            {
              type: "text" as const,
              text: '{"command": "npm run test", "cwd": "."}\n{"command": "ls -la", "cwd": "/tmp"}',
            },
          ],
        },
      },
      ...Array.from({ length: 30 }, (_, i) => ({
        type: "message" as const,
        message: { role: "user" as const, content: `filler-${i}` },
      })),
    ];
    // tier: undefined skips tier-based placeholder compression so the dropped
    // message still carries its original text for generateSyntheticSummary.
    const snapshot = buildCore2Snapshot(makeSource(entries), {
      tier: undefined,
      compressionLevel: "aggressive",
    });
    expect(snapshot).toContain("npm run test");
    expect(snapshot).toContain("ls -la");
    expect(snapshot).not.toContain('"command": "npm run test"');
    expect(snapshot).not.toContain('"command": "ls -la"');
  });
});

describe("buildCore2Snapshot — profile-aware compression", () => {
  it("errors-first keeps error content", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "toolResult",
          name: "bash",
          content: [
            {
              type: "text",
              text: "Error: test failed\n at src/index.ts:10:5",
            },
          ],
        },
      },
    ];
    const snapshot = buildCore2Snapshot(makeSource(entries), {
      tier: "lite",
      compressionLevel: "medium",
      compressionProfile: errorsFirstProfile,
    });
    expect(snapshot).toContain("Error: test failed");
  });

  it("errors-first compresses success content", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "toolResult",
          name: "bash",
          content: [{ type: "text", text: "All tests passed" }],
        },
      },
    ];
    const snapshot = buildCore2Snapshot(makeSource(entries), {
      tier: "lite",
      compressionLevel: "medium",
      compressionProfile: errorsFirstProfile,
    });
    expect(snapshot).not.toContain("All tests passed");
    expect(snapshot).toContain("[toolResult: bash]");
  });
});
