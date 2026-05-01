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

  it("extracts --flow-model-config", () => {
    const result = parseFlowCliArgs(["node", "script", "--flow-model-config", "balanced"]);
    expect(result.flowModelConfig).toBe("balanced");
  });

  it("extracts --flow-lite-model", () => {
    const result = parseFlowCliArgs(["node", "script", "--flow-lite-model", "gemini-flash"]);
    expect(result.tieredModels.lite).toBe("gemini-flash");
  });

  it("extracts --flow-flash-model", () => {
    const result = parseFlowCliArgs(["node", "script", "--flow-flash-model", "claude-sonnet"]);
    expect(result.tieredModels.flash).toBe("claude-sonnet");
  });

  it("extracts --flow-full-model", () => {
    const result = parseFlowCliArgs(["node", "script", "--flow-full-model", "claude-opus"]);
    expect(result.tieredModels.full).toBe("claude-opus");
  });

  it("extracts --flow-model-config with equals syntax", () => {
    const result = parseFlowCliArgs(["node", "script", "--flow-model-config=balanced"]);
    expect(result.flowModelConfig).toBe("balanced");
  });

  it("extracts tiered models with equals syntax", () => {
    const result = parseFlowCliArgs([
      "node", "script",
      "--flow-lite-model=gemini-flash",
      "--flow-flash-model=claude-sonnet",
      "--flow-full-model=claude-opus",
    ]);
    expect(result.tieredModels.lite).toBe("gemini-flash");
    expect(result.tieredModels.flash).toBe("claude-sonnet");
    expect(result.tieredModels.full).toBe("claude-opus");
  });

  it("tieredModels defaults are undefined when not provided", () => {
    const result = parseFlowCliArgs(["node", "script"]);
    expect(result.tieredModels.lite).toBeUndefined();
    expect(result.tieredModels.flash).toBeUndefined();
    expect(result.tieredModels.full).toBeUndefined();
  });

  it("handles all tiered model flags together with other flags", () => {
    const result = parseFlowCliArgs([
      "node", "script",
      "--model", "gpt-4o",
      "--flow-lite-model", "gemini-flash",
      "--flow-flash-model", "claude-sonnet",
      "--flow-full-model", "claude-opus",
      "--thinking", "medium",
    ]);
    expect(result.fallbackModel).toBe("gpt-4o");
    expect(result.tieredModels.lite).toBe("gemini-flash");
    expect(result.tieredModels.flash).toBe("claude-sonnet");
    expect(result.tieredModels.full).toBe("claude-opus");
    expect(result.fallbackThinking).toBe("medium");
  });
});
