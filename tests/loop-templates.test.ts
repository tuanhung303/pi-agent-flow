import { describe, it, expect } from "vitest";
import {
  autoWarpTriggerTemplate,
  loopContinuationPromptTemplate,
  loopWakeupTemplate,
} from "../src/flow/loop-templates.js";

describe("loop templates placeholder coverage", () => {
  it("autoWarpTriggerTemplate covers all required placeholders", () => {
    const placeholders = [
      "{{objective}}",
      "{{sessionCount}}",
      "{{totalTokensAcrossSessions}}",
      "{{maxTokens}}",
      "{{totalFlowsAcrossSessions}}",
      "{{acceptanceClause}}",
    ];
    for (const p of placeholders) {
      expect(autoWarpTriggerTemplate).toContain(p);
    }
  });

  it("loopContinuationPromptTemplate covers all required placeholders", () => {
    const placeholders = [
      "{{objective}}",
      "{{acceptanceClause}}",
      "{{flowCount}}",
      "{{maxFlowsClause}}",
      "{{tokenInfo}}",
      "{{userMessage}}",
      "{{sessionCount}}",
      "{{totalTokensAcrossSessions}}",
    ];
    for (const p of placeholders) {
      expect(loopContinuationPromptTemplate).toContain(p);
    }
  });

  it("autoWarpTriggerTemplate mentions the warp tool", () => {
    expect(autoWarpTriggerTemplate).toContain("warp tool");
  });

  it("loopWakeupTemplate covers all required placeholders", () => {
    const placeholders = [
      "{{objective}}",
      "{{acceptanceClause}}",
      "{{flowCount}}",
      "{{maxFlows}}",
      "{{totalTokens}}",
      "{{sessionCount}}",
      "{{totalTokensAcrossSessions}}",
    ];
    for (const p of placeholders) {
      expect(loopWakeupTemplate).toContain(p);
    }
  });
});
