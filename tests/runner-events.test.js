import { describe, it, expect } from "vitest";
import {
  processFlowJsonLine,
  drainStreamingText,
  drainStreamingEstimate,
  drainCtxEstimate,
  updateSmoothedTps,
  drainSmoothedTps,
  getFlowFinalText,
  getFlowSummaryText,
  stableStringify,
} from "../src/runner-events.js";

function makeResult() {
  return {
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, toolCalls: 0 },
    sawAgentEnd: false,
  };
}

function makeAssistantMessage(text, extra = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// processFlowJsonLine
// ---------------------------------------------------------------------------

describe("processFlowJsonLine", () => {
  it("returns false for empty/blank lines", () => {
    const r = makeResult();
    expect(processFlowJsonLine("", r)).toBe(false);
    expect(processFlowJsonLine("   ", r)).toBe(false);
  });

  it("returns false for invalid JSON", () => {
    const r = makeResult();
    expect(processFlowJsonLine("not json", r)).toBe(false);
  });

  it("handles message_end event — accumulates message", () => {
    const r = makeResult();
    const event = { type: "message_end", message: makeAssistantMessage("hello") };
    const result = processFlowJsonLine(JSON.stringify(event), r);
    expect(result).toBe(true);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].content[0].text).toBe("hello");
  });

  it("handles turn_end event — accumulates message", () => {
    const r = makeResult();
    const event = { type: "turn_end", message: makeAssistantMessage("turn done") };
    processFlowJsonLine(JSON.stringify(event), r);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].content[0].text).toBe("turn done");
  });

  it("handles agent_end event — sets sawAgentEnd", () => {
    const r = makeResult();
    const event = { type: "agent_end", messages: [makeAssistantMessage("final")] };
    processFlowJsonLine(JSON.stringify(event), r);
    expect(r.sawAgentEnd).toBe(true);
    expect(r.messages).toHaveLength(1);
  });

  it("handles agent_end event — stores tool messages alongside assistant", () => {
    const r = makeResult();
    const toolMsg = {
      role: "toolResult",
      toolCallId: "tc1",
      content: [{ type: "text", text: "bash output here" }],
    };
    const event = {
      type: "agent_end",
      messages: [makeAssistantMessage("running..."), toolMsg],
    };
    processFlowJsonLine(JSON.stringify(event), r);
    expect(r.sawAgentEnd).toBe(true);
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0].role).toBe("assistant");
    expect(r.messages[1].role).toBe("toolResult");
    expect(r.messages[1].content[0].text).toBe("bash output here");
  });

  it("handles agent_end event — deduplicates tool messages", () => {
    const r = makeResult();
    const toolMsg = {
      role: "toolResult",
      toolCallId: "tc1",
      content: [{ type: "text", text: "same output" }],
    };
    processFlowJsonLine(JSON.stringify({ type: "agent_end", messages: [toolMsg] }), r);
    processFlowJsonLine(JSON.stringify({ type: "agent_end", messages: [toolMsg] }), r);
    expect(r.messages).toHaveLength(1);
  });

  it("getFlowFinalText still skips tool messages", () => {
    const r = makeResult();
    const toolMsg = {
      role: "toolResult",
      toolCallId: "tc1",
      content: [{ type: "text", text: "tool output" }],
    };
    processFlowJsonLine(JSON.stringify({ type: "agent_end", messages: [toolMsg, makeAssistantMessage("final text")] }), r);
    expect(getFlowFinalText(r.messages)).toBe("final text");
  });

  it("handles text_delta message_update — accumulates streaming buffer", () => {
    const r = makeResult();
    const event = {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "some text" },
    };
    const result = processFlowJsonLine(JSON.stringify(event), r);
    // Non-empty text deltas emit immediately for real-time status streaming.
    expect(result).toBe(true);
    // Buffer should have the text
    expect(drainStreamingText(r)).toBe("some text");
  });

  it("handles thinking_delta — does not accumulate (reasoning stripped)", () => {
    const r = makeResult();
    const event = {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "thinking..." },
    };
    const result = processFlowJsonLine(JSON.stringify(event), r);
    expect(result).toBe(false);
    // Thinking is stripped, so streaming buffer should be empty
    expect(drainStreamingText(r)).toBe("");
  });

  it("text_delta triggers emit immediately", () => {
    const r = makeResult();
    const longText = "a";
    const event = {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: longText },
    };
    const result = processFlowJsonLine(JSON.stringify(event), r);
    expect(result).toBe(true);
  });

  it("deduplicates identical messages", () => {
    const r = makeResult();
    const msg = makeAssistantMessage("dup");
    processFlowJsonLine(JSON.stringify({ type: "message_end", message: msg }), r);
    processFlowJsonLine(JSON.stringify({ type: "message_end", message: msg }), r);
    expect(r.messages).toHaveLength(1);
  });

  it("accumulates usage from messages", () => {
    const r = makeResult();
    const msg = makeAssistantMessage("usage test", {
      usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 10, cost: { total: 0.05 }, totalTokens: 500 },
    });
    processFlowJsonLine(JSON.stringify({ type: "message_end", message: msg }), r);
    expect(r.usage.input).toBe(100);
    expect(r.usage.output).toBe(50);
    expect(r.usage.cacheRead).toBe(200);
    expect(r.usage.cacheWrite).toBe(10);
    expect(r.usage.cost).toBeCloseTo(0.05);
    expect(r.usage.contextTokens).toBe(500);
    expect(r.usage.turns).toBe(1);
  });

  it("counts toolCall parts", () => {
    const r = makeResult();
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "calling tool" },
        { type: "toolCall", toolCallId: "1", toolName: "bash", input: {} },
        { type: "toolCall", toolCallId: "2", toolName: "read", input: {} },
      ],
    };
    processFlowJsonLine(JSON.stringify({ type: "message_end", message: msg }), r);
    expect(r.usage.toolCalls).toBe(2);
  });

  it("estimates toolCall tokens and pauses TPS timer", () => {
    const r = makeResult();
    const msg = {
      role: "assistant",
      content: [
        { type: "toolCall", toolCallId: "1", toolName: "bash", input: { command: "ls" } },
      ],
    };
    processFlowJsonLine(JSON.stringify({ type: "message_end", message: msg }), r);
    expect(r.usage.toolCalls).toBe(1);
    // Tool call JSON should be estimated and available for draining
    expect(drainStreamingEstimate(r)).toBeGreaterThan(0);
  });

  it("returns false for unknown event types", () => {
    const r = makeResult();
    expect(processFlowJsonLine(JSON.stringify({ type: "unknown_event" }), r)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// drainStreamingText
// ---------------------------------------------------------------------------

describe("drainStreamingText", () => {
  it("returns empty string on fresh result", () => {
    const r = makeResult();
    expect(drainStreamingText(r)).toBe("");
  });

  it("returns accumulated text and resets buffer", () => {
    const r = makeResult();
    // Accumulate some text
    processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello world" } }),
      r,
    );
    const drained = drainStreamingText(r);
    expect(drained).toBe("hello world");
    // Second drain should be empty
    expect(drainStreamingText(r)).toBe("");
  });

  it("resets lastEmittedWordCount on drain", () => {
    const r = makeResult();
    processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a".repeat(50) } }),
      r,
    );
    drainStreamingText(r);
    // After drain, a new 45-char delta should trigger emit because counter was reset
    const result = processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "b".repeat(45) } }),
      r,
    );
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// accumulateStreamingDelta (tested indirectly via processFlowJsonLine)
// ---------------------------------------------------------------------------

describe("accumulateStreamingDelta (via processFlowJsonLine)", () => {
  it("returns true for any non-empty text delta", () => {
    const r = makeResult();
    const result = processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "s" } }),
      r,
    );
    expect(result).toBe(true);
  });

  it("accumulates across multiple deltas until drained", () => {
    const r = makeResult();
    processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "aaa" } }),
      r,
    );
    const result = processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "bb" } }),
      r,
    );
    expect(result).toBe(true);
    expect(drainStreamingText(r)).toBe("aaabb");
  });

  it("ignores empty deltas", () => {
    const r = makeResult();
    expect(
      processFlowJsonLine(
        JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "" } }),
        r,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getFlowFinalText
// ---------------------------------------------------------------------------

describe("getFlowFinalText", () => {
  it("returns empty for no messages", () => {
    expect(getFlowFinalText([])).toBe("");
  });

  it("returns empty for null/undefined", () => {
    expect(getFlowFinalText(null)).toBe("");
    expect(getFlowFinalText(undefined)).toBe("");
  });

  it("returns last assistant text", () => {
    const messages = [
      makeAssistantMessage("first"),
      makeAssistantMessage("second"),
    ];
    expect(getFlowFinalText(messages)).toBe("second");
  });

  it("skips non-assistant messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "user msg" }] },
      makeAssistantMessage("assistant reply"),
    ];
    expect(getFlowFinalText(messages)).toBe("assistant reply");
  });

  it("returns empty when no text parts exist", () => {
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", toolCallId: "1", toolName: "bash", input: {} }] },
    ];
    expect(getFlowFinalText(messages)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// getFlowSummaryText
// ---------------------------------------------------------------------------

describe("getFlowSummaryText", () => {
  it("returns final text when available", () => {
    const result = { messages: [makeAssistantMessage("all done")] };
    expect(getFlowSummaryText(result)).toBe("all done");
  });

  it("returns errorMessage when no messages", () => {
    const result = { messages: [], errorMessage: "something broke", exitCode: 1 };
    expect(getFlowSummaryText(result)).toBe("something broke");
  });

  it("returns stderr for error results", () => {
    const result = { messages: [], exitCode: 1, stderr: "stderr output", stopReason: "error" };
    expect(getFlowSummaryText(result)).toBe("stderr output");
  });

  it("returns (no output) as fallback for success", () => {
    const result = { messages: [], exitCode: 0, stderr: "" };
    expect(getFlowSummaryText(result)).toBe("(no output)");
  });

  it("handles null/undefined gracefully", () => {
    expect(getFlowSummaryText(null)).toBe("(no output)");
    expect(getFlowSummaryText(undefined)).toBe("(no output)");
  });

  it("aborted flow with tool calls includes partial work", () => {
    const result = {
      messages: [{
        role: "assistant",
        content: [
          { type: "toolCall", name: "edit", toolCallId: "1", arguments: { file_path: "src/foo.ts" } },
          { type: "toolCall", name: "bash", toolCallId: "2", arguments: { command: "npm test" } },
        ],
      }],
      exitCode: 130,
      stopReason: "aborted",
      errorMessage: "Flow was aborted.",
    };
    const summary = getFlowSummaryText(result);
    expect(summary).toContain("Flow was aborted.");
    expect(summary).toContain("Partial work:");
    expect(summary).toContain("edit foo.ts");
    expect(summary).toContain("bash npm test");
  });

  it("aborted flow with only read calls has no partial work line", () => {
    const result = {
      messages: [{
        role: "assistant",
        content: [
          { type: "toolCall", name: "read", toolCallId: "1", arguments: { file_path: "src/foo.ts" } },
          { type: "toolCall", name: "read", toolCallId: "2", arguments: { file_path: "src/bar.ts" } },
        ],
      }],
      exitCode: 130,
      stopReason: "aborted",
      errorMessage: "Flow was aborted.",
    };
    const summary = getFlowSummaryText(result);
    expect(summary).toBe("Flow was aborted.");
    expect(summary).not.toContain("Partial work");
  });

  it("aborted flow with no messages returns base error", () => {
    const result = { messages: [], exitCode: 130, stopReason: "aborted", errorMessage: "Flow was aborted." };
    expect(getFlowSummaryText(result)).toBe("Flow was aborted.");
  });

  it("failed flow with tool calls includes partial work", () => {
    const result = {
      messages: [{
        role: "assistant",
        content: [
          { type: "toolCall", name: "edit", toolCallId: "1", arguments: { file_path: "src/render.ts" } },
          { type: "toolCall", name: "bash", toolCallId: "2", arguments: { command: "npm test" } },
        ],
      }],
      exitCode: 1,
      stderr: "Build failed",
      stopReason: "error",
    };
    const summary = getFlowSummaryText(result);
    expect(summary).toContain("Build failed");
    expect(summary).toContain("Partial work:");
    expect(summary).toContain("edit render.ts");
  });

  it("successful flow with text ignores tool calls (happy path)", () => {
    const result = {
      messages: [{
        role: "assistant",
        content: [
          { type: "toolCall", name: "edit", toolCallId: "1", arguments: { file_path: "src/foo.ts" } },
          { type: "text", text: "All changes applied successfully." },
        ],
      }],
      exitCode: 0,
    };
    expect(getFlowSummaryText(result)).toBe("All changes applied successfully.");
  });
});

// ---------------------------------------------------------------------------
// drainStreamingEstimate
// ---------------------------------------------------------------------------

describe("drainStreamingEstimate", () => {
  it("returns 0 on fresh result", () => {
    const r = makeResult();
    expect(drainStreamingEstimate(r)).toBe(0);
  });

  it("estimates output tokens from streaming chars (4 chars/token)", () => {
    const r = makeResult();
    // 400 chars = 100 tokens
    processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a".repeat(400) } }),
      r,
    );
    expect(drainStreamingEstimate(r)).toBe(100);
  });

  it("estimates accumulates across multiple deltas", () => {
    const r = makeResult();
    // 200 chars + 200 chars = 400 chars = 100 tokens
    processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a".repeat(200) } }),
      r,
    );
    processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "b".repeat(200) } }),
      r,
    );
    expect(drainStreamingEstimate(r)).toBe(100);
  });

  it("keeps sub-token remainder on drain", () => {
    const r = makeResult();
    processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a".repeat(402) } }),
      r,
    );
    expect(drainStreamingEstimate(r)).toBe(100);
    processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "bb" } }),
      r,
    );
    expect(drainStreamingEstimate(r)).toBe(1);
  });

  it("resets estimate when message completes", () => {
    const r = makeResult();
    // Stream 400 chars = 100 estimated tokens
    processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a".repeat(400) } }),
      r,
    );
    expect(drainStreamingEstimate(r)).toBe(100);
    // Message completes with actual usage
    const msg = makeAssistantMessage("done", {
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 200 },
    });
    processFlowJsonLine(JSON.stringify({ type: "message_end", message: msg }), r);
    // Estimate should be reset
    expect(drainStreamingEstimate(r)).toBe(0);
    // Actual usage should be tracked
    expect(r.usage.output).toBe(50);
  });

  it("does not estimate tokens for thinking_delta (reasoning stripped)", () => {
    const r = makeResult();
    processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "c".repeat(800) } }),
      r,
    );
    // Thinking is stripped, so estimate should be 0
    expect(drainStreamingEstimate(r)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// drainCtxEstimate — smooth context token streaming
// ---------------------------------------------------------------------------

describe("drainCtxEstimate", () => {
  it("returns 0 on fresh result (no baseline yet)", () => {
    const r = makeResult();
    expect(drainCtxEstimate(r)).toBe(0);
  });

  it("returns baseline after message_end, no streaming since", () => {
    const r = makeResult();
    const msg = makeAssistantMessage("done", {
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 500 },
    });
    processFlowJsonLine(JSON.stringify({ type: "message_end", message: msg }), r);
    expect(drainCtxEstimate(r)).toBe(500);
  });

  it("increments smoothly during streaming after a baseline", () => {
    const r = makeResult();
    // First turn completes with totalTokens = 500
    const msg = makeAssistantMessage("turn 1", {
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 500 },
    });
    processFlowJsonLine(JSON.stringify({ type: "message_end", message: msg }), r);
    expect(drainCtxEstimate(r)).toBe(500);

    // Now stream 400 chars = 100 estimated tokens
    processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a".repeat(400) } }),
      r,
    );
    expect(drainCtxEstimate(r)).toBe(600); // 500 baseline + 100 estimated

    // Stream more — ctx keeps climbing
    processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "b".repeat(200) } }),
      r,
    );
    expect(drainCtxEstimate(r)).toBe(650); // 500 baseline + 150 estimated
  });

  it("resets baseline on next message_end with new totalTokens", () => {
    const r = makeResult();
    // Turn 1: totalTokens = 500
    const msg1 = makeAssistantMessage("turn 1", {
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 500 },
    });
    processFlowJsonLine(JSON.stringify({ type: "message_end", message: msg1 }), r);

    // Stream 400 chars = 100 tokens
    processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a".repeat(400) } }),
      r,
    );
    expect(drainCtxEstimate(r)).toBe(600);

    // Turn 2: totalTokens = 700 (real value overwrites estimate)
    const msg2 = makeAssistantMessage("turn 2", {
      usage: { input: 150, output: 80, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 700 },
    });
    processFlowJsonLine(JSON.stringify({ type: "message_end", message: msg2 }), r);
    expect(drainCtxEstimate(r)).toBe(700);
  });

  it("ctx estimate does not go below real totalTokens", () => {
    const r = makeResult();
    // message_end sets real totalTokens = 1000
    const msg = makeAssistantMessage("done", {
      usage: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 1000 },
    });
    processFlowJsonLine(JSON.stringify({ type: "message_end", message: msg }), r);
    // No streaming yet — baseline is the floor
    expect(drainCtxEstimate(r)).toBe(1000);
  });

  it("first-turn cold start: climbs from 0 with streaming estimate", () => {
    const r = makeResult();
    // No message_end yet — baseline is 0
    expect(drainCtxEstimate(r)).toBe(0);

    // Stream 800 chars = 200 tokens
    processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x".repeat(800) } }),
      r,
    );
    expect(drainCtxEstimate(r)).toBe(200); // 0 baseline + 200 estimated
  });

  it("ctx streaming chars accumulate independently of drainStreamingEstimate", () => {
    const r = makeResult();
    // Set baseline
    const msg = makeAssistantMessage("done", {
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 500 },
    });
    processFlowJsonLine(JSON.stringify({ type: "message_end", message: msg }), r);

    // Stream 400 chars
    processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a".repeat(400) } }),
      r,
    );

    // Drain the output estimate (resets est.chars to 0)
    expect(drainStreamingEstimate(r)).toBe(100);

    // ctx estimate should still be 600 — it uses its own char counter
    expect(drainCtxEstimate(r)).toBe(600);

    // Drain output again — returns 0 since already drained
    expect(drainStreamingEstimate(r)).toBe(0);
    // ctx still 600
    expect(drainCtxEstimate(r)).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// updateSmoothedTps / drainSmoothedTps — EMA smoothing
// ---------------------------------------------------------------------------

describe("updateSmoothedTps / drainSmoothedTps", () => {
  it("returns 0 on fresh result", () => {
    const r = makeResult();
    expect(drainSmoothedTps(r)).toBe(0);
  });

  it("seeds the value on first emit (skips update, sets timestamp)", () => {
    const r = makeResult();
    updateSmoothedTps(r, 100);
    // First emit seeds __lastEmitTime but does not compute a rate
    expect(drainSmoothedTps(r)).toBe(0);
  });

  it("computes EMA on second emit with enough time delta", async () => {
    const r = makeResult();
    // Seed the tracker
    updateSmoothedTps(r, 100);
    // Wait for MIN_TPS_SAMPLE_MS gate
    await new Promise((res) => setTimeout(res, 150));
    updateSmoothedTps(r, 50);
    const tps = drainSmoothedTps(r);
    // Should be a positive rate
    expect(tps).toBeGreaterThan(0);
  });

  it("uses responsive EMA smoothing for averaging", async () => {
    const r = makeResult();
    // Seed — first call with non-zero tokens sets __lastEmitTime but doesn't compute rate
    updateSmoothedTps(r, 100);
    const seeded = drainSmoothedTps(r);
    expect(seeded).toBe(0); // seeded, no rate yet

    await new Promise((res) => setTimeout(res, 60));
    // First real sample is capped after calibration.
    updateSmoothedTps(r, 100);
    const first = drainSmoothedTps(r);
    expect(first).toBeGreaterThan(0);

    await new Promise((res) => setTimeout(res, 60));
    // A lower second sample should pull the displayed value down smoothly, not freeze.
    updateSmoothedTps(r, 10);
    const second = drainSmoothedTps(r);
    expect(second).toBeLessThan(first);
    expect(second).toBeGreaterThan(first * 0.5);
  });

  it("ignores zero estimated tokens", () => {
    const r = makeResult();
    updateSmoothedTps(r, 0);
    expect(drainSmoothedTps(r)).toBe(0);
  });

  it("drainSmoothedTps returns the value without resetting it", async () => {
    const r = makeResult();
    updateSmoothedTps(r, 0);
    await new Promise((res) => setTimeout(res, 110));
    updateSmoothedTps(r, 100);
    const first = drainSmoothedTps(r);
    const second = drainSmoothedTps(r);
    expect(second).toBe(first);
  });

  it("accumulates tokens and gates samples to MIN_TPS_SAMPLE_MS", async () => {
    const r = makeResult();
    updateSmoothedTps(r, 100); // seed
    await new Promise((res) => setTimeout(res, 60));
    updateSmoothedTps(r, 5); // first compute
    const tps1 = drainSmoothedTps(r);
    expect(tps1).toBeGreaterThan(0);

    // Call again before the 50ms sample window — should buffer, not compute
    await new Promise((res) => setTimeout(res, 25));
    updateSmoothedTps(r, 10);
    const tps2 = drainSmoothedTps(r);
    expect(tps2).toBe(tps1);

    // Wait another 35ms (total ~60ms from last compute)
    await new Promise((res) => setTimeout(res, 35));
    updateSmoothedTps(r, 1);
    const tps3 = drainSmoothedTps(r);
    // Should now reflect the accumulated burst
    expect(tps3).not.toBe(tps1);
  });

  it("reports unscaled heuristic TPS before burst capping", async () => {
    const r = makeResult();
    updateSmoothedTps(r, 10); // seed
    await new Promise((res) => setTimeout(res, 60));
    // 10 tokens in ~60ms is ~166 TPS; this should no longer be suppressed by 0.1x calibration.
    updateSmoothedTps(r, 10);
    const tps = drainSmoothedTps(r);
    expect(tps).toBeGreaterThan(100);
    expect(tps).toBeLessThanOrEqual(300);
  });

  it("caps instant rate at MAX_INSTANT_TPS", async () => {
    const r = makeResult();
    updateSmoothedTps(r, 100); // seed
    await new Promise((res) => setTimeout(res, 60));
    // 5000 tokens in ~60ms is capped to 300
    updateSmoothedTps(r, 5000);
    const tps = drainSmoothedTps(r);
    expect(tps).toBeGreaterThan(0);
    expect(tps).toBeLessThanOrEqual(300);
  });

  it("pauses TPS timer when pauseAfterNextEmit is set", async () => {
    const r = makeResult();
    updateSmoothedTps(r, 100); // seed
    await new Promise((res) => setTimeout(res, 110));
    updateSmoothedTps(r, 100); // first compute
    const tpsBefore = drainSmoothedTps(r);
    expect(tpsBefore).toBeGreaterThan(0);

    // Simulate a long gap with tool execution by setting pause flag and waiting
    const tracker = { __proto__: null };
    // We can't access the WeakMap directly, so use the tool-call path:
    const msg = {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "1", toolName: "bash", input: { command: "ls" } }],
    };
    processFlowJsonLine(JSON.stringify({ type: "message_end", message: msg }), r);
    // The tool call chars were estimated and the pause flag was set.
    // Drain those estimated tokens and update TPS — this should compute the rate then reset the timer.
    const toolTokens = drainStreamingEstimate(r);
    expect(toolTokens).toBeGreaterThan(0);
    updateSmoothedTps(r, toolTokens);

    // Wait a long time (simulating tool execution)
    await new Promise((res) => setTimeout(res, 500));

    const tpsAfterToolCall = drainSmoothedTps(r);

    // Next update should seed the timer instead of counting the gap
    updateSmoothedTps(r, 100);
    // Smoothed TPS should stay at the post-tool-call value, not be dragged down by the 500ms gap
    expect(drainSmoothedTps(r)).toBe(tpsAfterToolCall);
  });

  it("resumes TPS correctly after a pause", async () => {
    const r = makeResult();
    updateSmoothedTps(r, 100); // seed
    await new Promise((res) => setTimeout(res, 110));
    updateSmoothedTps(r, 100); // first compute
    const tpsBefore = drainSmoothedTps(r);

    // Trigger pause via tool call message
    const msg = {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "1", toolName: "read", input: { path: "x" } }],
    };
    processFlowJsonLine(JSON.stringify({ type: "message_end", message: msg }), r);
    const toolTokens = drainStreamingEstimate(r);
    updateSmoothedTps(r, toolTokens);

    // After pause, wait then emit — should seed
    await new Promise((res) => setTimeout(res, 200));
    updateSmoothedTps(r, 100);

    // Now wait again and emit — should compute a normal rate (not dragged down by 200ms gap)
    await new Promise((res) => setTimeout(res, 110));
    updateSmoothedTps(r, 100);
    const tpsAfter = drainSmoothedTps(r);
    // Should be back in a reasonable range, not near zero
    expect(tpsAfter).toBeGreaterThan(tpsBefore * 0.1);
  });
});

describe("getFlowSummaryText — batch", () => {
  function makeToolCallMessage(name, args) {
    return {
      role: "assistant",
      content: [{ type: "toolCall", name, arguments: args }],
    };
  }

  it("includes batch in partial work for failed flows", () => {
    const r = makeResult();
    r.exitCode = 1;
    r.stderr = "Flow failed";
    r.messages = [
      makeToolCallMessage("batch", {
        o: [
          { op: "read", path: "src/index.ts" },
          { op: "edit", path: "src/utils.ts", edits: [{ oldText: "a", newText: "b" }] },
        ],
      }),
    ];
    const summary = getFlowSummaryText(r);
    expect(summary).toContain("Flow failed");
    expect(summary).toContain("Partial work:");
    expect(summary).toContain("batch");
  });

  it("formats single batch operation in summary", () => {
    const r = makeResult();
    r.exitCode = 1;
    r.stderr = "Error";
    r.messages = [
      makeToolCallMessage("batch", {
        o: [{ op: "write", path: "src/new.ts", content: "export {};" }],
      }),
    ];
    const summary = getFlowSummaryText(r);
    expect(summary).toContain("batch write src/new.ts");
  });

  it("formats multiple batch operations in summary", () => {
    const r = makeResult();
    r.exitCode = 1;
    r.stderr = "Error";
    r.messages = [
      makeToolCallMessage("batch", {
        o: [
          { op: "read", path: "a.ts" },
          { op: "read", path: "b.ts" },
        ],
      }),
    ];
    const summary = getFlowSummaryText(r);
    expect(summary).toContain("batch read a.ts, read b.ts");
  });

  it("truncates batch operations when more than 3", () => {
    const r = makeResult();
    r.exitCode = 1;
    r.stderr = "Error";
    r.messages = [
      makeToolCallMessage("batch", {
        o: [
          { op: "read", path: "a.ts" },
          { op: "read", path: "b.ts" },
          { op: "edit", path: "c.ts", edits: [{ oldText: "a", newText: "b" }] },
          { op: "write", path: "d.ts", content: "export {};" },
        ],
      }),
    ];
    const summary = getFlowSummaryText(r);
    expect(summary).toContain("batch read a.ts, read b.ts +2 more");
  });

  it("formats batch bash operation as bash: <cmd> not bash bash", () => {
    const r = makeResult();
    r.exitCode = 1;
    r.stderr = "Error";
    r.messages = [
      makeToolCallMessage("batch", {
        o: [
          { o: "bash", c: "npm test", p: "bash" },
        ],
      }),
    ];
    const summary = getFlowSummaryText(r);
    expect(summary).toContain("batch bash: npm test");
    expect(summary).not.toContain("bash bash");
  });

  it("deduplicates consecutive identical batch operations in summary", () => {
    const r = makeResult();
    r.exitCode = 1;
    r.stderr = "Error";
    r.messages = [
      makeToolCallMessage("batch", {
        o: [
          { op: "read", path: "a.ts" },
          { op: "read", path: "a.ts" },
          { op: "read", path: "a.ts" },
          { op: "edit", path: "b.ts", edits: [{ oldText: "a", newText: "b" }] },
        ],
      }),
    ];
    const summary = getFlowSummaryText(r);
    expect(summary).toContain("read a.ts×3");
  });

  it("formats empty batch operations in summary", () => {
    const r = makeResult();
    r.exitCode = 1;
    r.stderr = "Error";
    r.messages = [
      makeToolCallMessage("batch", { o: [] }),
    ];
    const summary = getFlowSummaryText(r);
    expect(summary).toContain("batch (empty)");
  });

  it("includes batch alongside other tool calls", () => {
    const r = makeResult();
    r.exitCode = 1;
    r.stderr = "Error";
    r.messages = [
      makeToolCallMessage("bash", { command: "npm test" }),
      makeToolCallMessage("batch", {
        o: [{ op: "edit", path: "src/foo.ts", edits: [{ oldText: "a", newText: "b" }] }],
      }),
    ];
    const summary = getFlowSummaryText(r);
    expect(summary).toContain("bash npm test");
    expect(summary).toContain("batch");
  });
});

// ---------------------------------------------------------------------------
// getFlowSummaryText — tool result pairing
// ---------------------------------------------------------------------------

describe("getFlowSummaryText — tool result pairing", () => {
  it("includes bash output from paired tool result in summary", () => {
    const result = {
      exitCode: 0,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check the files." },
            { type: "toolCall", name: "bash", toolCallId: "tc1", arguments: { command: "ls -la" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tc1",
          content: [{ type: "text", text: "total 48\ndrwxr-xr-x  8 user staff  256 Apr 30 03:20 .\n-rw-r--r--  1 user staff 1141 Apr 30 02:02 index.ts" }],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "All done." },
          ],
        },
      ],
    };
    const summary = getFlowSummaryText(result);
    expect(summary).toContain("All done.");
    expect(summary).toContain("[Tool Results]");
    expect(summary).toContain("bash ls -la:");
    expect(summary).toContain("drwxr-xr-x");
  });

  it("includes batch read output in summary", () => {
    const result = {
      exitCode: 0,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", name: "batch", toolCallId: "tc2", arguments: { o: [{ o: "read", p: "src/index.ts" }] } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tc2",
          content: [{ type: "text", text: "export default function main() { return 42; }" }],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Found the entry point." },
          ],
        },
      ],
    };
    const summary = getFlowSummaryText(result);
    expect(summary).toContain("Found the entry point.");
    expect(summary).toContain("[Tool Results]");
    expect(summary).toContain("batch read src/index.ts:");
    expect(summary).toContain("export default function main");
  });

  it("truncates large tool outputs at 2000 chars", () => {
    const bigOutput = "x".repeat(5000);
    const result = {
      exitCode: 0,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", name: "bash", toolCallId: "tc3", arguments: { command: "cat bigfile.txt" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tc3",
          content: [{ type: "text", text: bigOutput }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Read the file." }],
        },
      ],
    };
    const summary = getFlowSummaryText(result);
    expect(summary).toContain("Read the file.");
    expect(summary).toContain("[Tool Results]");
    expect(summary).toContain("... (truncated)");
    expect(summary.length).toBeLessThan(bigOutput.length);
  });

  it("does not show tool results section when no paired results exist", () => {
    const result = {
      exitCode: 0,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", name: "bash", toolCallId: "tc4", arguments: { command: "echo hi" } },
          ],
        },
        // No tool result message — tool call without result
        {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
        },
      ],
    };
    const summary = getFlowSummaryText(result);
    expect(summary).toBe("Done.");
    expect(summary).not.toContain("[Tool Results]");
  });

  it("shows tool results even without final text on success", () => {
    const result = {
      exitCode: 0,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", name: "bash", toolCallId: "tc5", arguments: { command: "echo hello" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tc5",
          content: [{ type: "text", text: "hello" }],
        },
        // No final assistant text
      ],
    };
    const summary = getFlowSummaryText(result);
    expect(summary).toContain("bash echo hello:");
    expect(summary).toContain("hello");
  });

  it("pairs multiple tool calls with their results in order", () => {
    const result = {
      exitCode: 0,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", name: "bash", toolCallId: "tc6", arguments: { command: "git log --oneline -3" } },
            { type: "toolCall", name: "bash", toolCallId: "tc7", arguments: { command: "git diff HEAD" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tc6",
          content: [{ type: "text", text: "abc1234 fix: something\ndef5678 feat: other" }],
        },
        {
          role: "toolResult",
          toolCallId: "tc7",
          content: [{ type: "text", text: "diff --git a/foo.ts b/foo.ts" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Both commands checked." }],
        },
      ],
    };
    const summary = getFlowSummaryText(result);
    expect(summary).toContain("Both commands checked.");
    expect(summary).toContain("abc1234");
    expect(summary).toContain("diff --git");
  });
});

// ---------------------------------------------------------------------------
// stableStringify — circular reference guard
// ---------------------------------------------------------------------------

describe("stableStringify", () => {
  it("handles circular references without throwing", () => {
    const obj = { a: 1, b: { c: 2 } };
    obj.b.self = obj;
    expect(() => stableStringify(obj)).not.toThrow();
    const result = stableStringify(obj);
    expect(result).toContain('"[Circular]"');
  });

  it("handles nested circular arrays", () => {
    const arr = [1, 2];
    arr.push(arr);
    expect(() => stableStringify(arr)).not.toThrow();
    const result = stableStringify(arr);
    expect(result).toContain('"[Circular]"');
  });
});

// ---------------------------------------------------------------------------
// WeakMap hidden state — frozen objects
// ---------------------------------------------------------------------------

describe("WeakMap hidden state — frozen objects", () => {
  it("updateSmoothedTps does not throw on frozen result", async () => {
    const r = Object.freeze(makeResult());
    updateSmoothedTps(r, 100);
    await new Promise((res) => setTimeout(res, 150));
    updateSmoothedTps(r, 50);
    expect(drainSmoothedTps(r)).toBeGreaterThan(0);
  });

  it("drainStreamingText does not throw on frozen result", () => {
    const r = Object.freeze(makeResult());
    processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello world" } }),
      r,
    );
    expect(drainStreamingText(r)).toBe("hello world");
  });

  it("drainCtxEstimate does not throw on frozen result", () => {
    const r = Object.freeze(makeResult());
    const msg = makeAssistantMessage("done", {
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 500 },
    });
    processFlowJsonLine(JSON.stringify({ type: "message_end", message: msg }), r);
    expect(drainCtxEstimate(r)).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Empty path coercion
// ---------------------------------------------------------------------------

describe("formatToolCallShort — empty path", () => {
  it("preserves explicit empty string path in batch summary", () => {
    const result = {
      exitCode: 0,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", name: "batch", toolCallId: "tc1", arguments: { o: [{ o: "read", p: "" }] } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tc1",
          content: [{ type: "text", text: "content" }],
        },
      ],
    };
    const summary = getFlowSummaryText(result);
    expect(summary).toContain("batch read ");
    expect(summary).not.toContain("batch read ?");
  });
});
