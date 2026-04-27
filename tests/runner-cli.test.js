import { describe, it, expect } from "vitest";
import { parseFlowCliArgs } from "../runner-cli.js";

// ---------------------------------------------------------------------------
// parseFlowCliArgs
// ---------------------------------------------------------------------------

describe("parseFlowCliArgs", () => {
  it("extracts --model", () => {
    const result = parseFlowCliArgs(["node", "script", "--model", "gpt-4o"]);
    expect(result.fallbackModel).toBe("gpt-4o");
  });

  it("extracts --thinking", () => {
    const result = parseFlowCliArgs(["node", "script", "--thinking", "high"]);
    expect(result.fallbackThinking).toBe("high");
  });

  it("extracts --tools", () => {
    const result = parseFlowCliArgs(["node", "script", "--tools", "bash,read"]);
    expect(result.fallbackTools).toBe("bash,read");
  });

  it("extracts --model with equals syntax", () => {
    const result = parseFlowCliArgs(["node", "script", "--model=claude-3"]);
    expect(result.fallbackModel).toBe("claude-3");
  });

  it("skips unknown flags", () => {
    const result = parseFlowCliArgs(["node", "script", "--unknown-flag", "value"]);
    expect(result.fallbackModel).toBeUndefined();
    expect(result.fallbackThinking).toBeUndefined();
    expect(result.fallbackTools).toBeUndefined();
  });

  it("empty argv → all defaults", () => {
    const result = parseFlowCliArgs(["node", "script"]);
    expect(result.fallbackModel).toBeUndefined();
    expect(result.fallbackThinking).toBeUndefined();
    expect(result.fallbackTools).toBeUndefined();
    expect(result.fallbackNoTools).toBe(false);
    expect(result.extensionArgs).toEqual([]);
    expect(result.alwaysProxy).toEqual([]);
  });

  it("handles --no-tools flag", () => {
    const result = parseFlowCliArgs(["node", "script", "--no-tools"]);
    expect(result.fallbackNoTools).toBe(true);
  });

  it("handles multiple flags together", () => {
    const result = parseFlowCliArgs([
      "node", "script",
      "--model", "gpt-4o",
      "--thinking", "medium",
      "--tools", "bash,read,write",
    ]);
    expect(result.fallbackModel).toBe("gpt-4o");
    expect(result.fallbackThinking).toBe("medium");
    expect(result.fallbackTools).toBe("bash,read,write");
  });

  it("skips --mode and --session flags", () => {
    const result = parseFlowCliArgs([
      "node", "script",
      "--mode", "json",
      "--session", "/tmp/test.jsonl",
      "--model", "gpt-4o",
    ]);
    expect(result.fallbackModel).toBe("gpt-4o");
  });

  it("forwards --provider to alwaysProxy", () => {
    const result = parseFlowCliArgs(["node", "script", "--provider", "openai"]);
    expect(result.alwaysProxy).toContain("--provider");
    expect(result.alwaysProxy).toContain("openai");
  });
});
