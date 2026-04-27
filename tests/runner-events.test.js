import { describe, it, expect } from "vitest";
import {
  processFlowJsonLine,
  drainStreamingText,
  getFlowFinalText,
  getFlowSummaryText,
} from "../runner-events.js";

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

  it("handles text_delta message_update — accumulates streaming buffer", () => {
    const r = makeResult();
    const event = {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "some text" },
    };
    const result = processFlowJsonLine(JSON.stringify(event), r);
    // Under 40 chars threshold — returns false
    expect(result).toBe(false);
    // Buffer should have the text
    expect(r.__streamingTextBuffer).toBe("some text");
  });

  it("handles thinking_delta — accumulates streaming buffer", () => {
    const r = makeResult();
    const event = {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "thinking..." },
    };
    const result = processFlowJsonLine(JSON.stringify(event), r);
    expect(result).toBe(false);
    expect(r.__streamingTextBuffer).toBe("thinking...");
  });

  it("text_delta triggers emit at 40 chars", () => {
    const r = makeResult();
    const longText = "a".repeat(45);
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
    expect(r.__lastEmittedWordCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// accumulateStreamingDelta (tested indirectly via processFlowJsonLine)
// ---------------------------------------------------------------------------

describe("accumulateStreamingDelta (via processFlowJsonLine)", () => {
  it("returns false under 40 chars", () => {
    const r = makeResult();
    const result = processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "short" } }),
      r,
    );
    expect(result).toBe(false);
  });

  it("returns true at exactly 40 chars", () => {
    const r = makeResult();
    const result = processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a".repeat(40) } }),
      r,
    );
    expect(result).toBe(true);
  });

  it("accumulates across multiple deltas", () => {
    const r = makeResult();
    // Send 30 chars — under threshold
    processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a".repeat(30) } }),
      r,
    );
    // Send 20 more — now at 50, should trigger
    const result = processFlowJsonLine(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "b".repeat(20) } }),
      r,
    );
    expect(result).toBe(true);
    expect(drainStreamingText(r)).toBe("a".repeat(30) + "b".repeat(20));
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

  it("returns (no output) as fallback", () => {
    const result = { messages: [], exitCode: 0, stderr: "" };
    expect(getFlowSummaryText(result)).toBe("(no output)");
  });

  it("handles null/undefined gracefully", () => {
    expect(getFlowSummaryText(null)).toBe("(no output)");
    expect(getFlowSummaryText(undefined)).toBe("(no output)");
  });
});
