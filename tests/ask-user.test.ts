import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAskUserTool } from "../src/tools/ask-user.js";

vi.mock("../config/config.js", () => ({
  loadFlowSettings: vi.fn(() => ({
    askUser: { enabled: true, timeout: 300 },
  })),
}));

describe("createAskUserTool", () => {
  let tool: ReturnType<typeof createAskUserTool>;

  beforeEach(() => {
    tool = createAskUserTool();
  });

  it("returns correct name and label", () => {
    expect(tool.name).toBe("ask_user");
    expect(tool.label).toBe("Ask User");
  });

  it("has parameter schema with question and required options", () => {
    const params = tool.parameters as any;
    expect(params.kind).toBe("object");
    expect(params.properties.question.kind).toBe("string");
    expect(params.properties.options.kind).toBe("array");
    expect(params.properties.options.minItems).toBe(1);
  });

  it("renderCall shows question and option count", () => {
    const theme = {
      fg: vi.fn((key: string, text: string) => text),
      bold: vi.fn((text: string) => text),
    };
    const result = tool.renderCall(
      { question: "What color?", options: [{ title: "Red" }, { title: "Blue" }] },
      theme,
    );
    const text = result.toString();
    expect(text).toContain("What color?");
    expect(text).toContain("2 option(s)");
  });

  it("renderCall handles missing options gracefully", () => {
    const theme = {
      fg: vi.fn((key: string, text: string) => text),
      bold: vi.fn((text: string) => text),
    };
    const result = tool.renderCall({ question: "What?" }, theme);
    const text = result.toString();
    expect(text).toContain("What?");
    expect(text).not.toContain("option(s)");
  });

  it("renderResult shows cancelled state", () => {
    const theme = {
      fg: vi.fn((key: string, text: string) => text),
      bold: vi.fn((text: string) => text),
    };
    const result = tool.renderResult(
      { details: { cancelled: true, question: "Q", options: [], response: null } },
      {},
      theme,
      {},
    );
    expect(result.toString()).toContain("Cancelled");
  });

  it("renderResult shows selection response", () => {
    const theme = {
      fg: vi.fn((key: string, text: string) => text),
      bold: vi.fn((text: string) => text),
    };
    const result = tool.renderResult(
      {
        details: {
          cancelled: false,
          question: "Q",
          options: [{ title: "A", description: "Desc A" }],
          response: { kind: "selection", selections: ["A"] },
        },
      },
      {},
      theme,
      {},
    );
    const text = result.toString();
    expect(text).toContain("A");
    expect(text).not.toContain("(wrote)");
  });

  it("renderResult shows error when details.error present", () => {
    const theme = {
      fg: vi.fn((key: string, text: string) => text),
      bold: vi.fn((text: string) => text),
    };
    const result = tool.renderResult(
      { details: { error: "Something broke", cancelled: false, question: "Q", options: [], response: null } },
      {},
      theme,
      {},
    );
    expect(result.toString()).toContain("Something broke");
  });

  it("renderResult expanded mode shows options list", () => {
    const theme = {
      fg: vi.fn((key: string, text: string) => text),
      bold: vi.fn((text: string) => text),
    };
    const result = tool.renderResult(
      {
        details: {
          cancelled: false,
          question: "Q",
          options: [
            { title: "A", description: "Desc A" },
            { title: "B", description: "Desc B" },
          ],
          response: { kind: "selection", selections: ["A"] },
        },
      },
      { expanded: true },
      theme,
      {},
    );
    const text = result.toString();
    expect(text).toContain("Q: Q");
    expect(text).toContain("Options:");
  });

  it("execute throws when no UI available", async () => {
    await expect(
      tool.execute("tc1", { question: "What?" }, undefined, undefined, { hasUI: false, ui: null } as any),
    ).rejects.toThrow(/Ask requires interactive mode/);
  });

  it("execute returns cancelled on aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await tool.execute(
      "tc1",
      { question: "What?" },
      controller.signal,
      undefined,
      { hasUI: true, ui: {} } as any,
    );
    expect(result.content[0].text).toBe("Cancelled");
    expect(result.details.cancelled).toBe(true);
  });

  it("execute rejects empty options", async () => {
    const result = await tool.execute(
      "tc1",
      { question: "Name?", options: [] },
      undefined,
      undefined,
      {
        hasUI: true,
        ui: {
          select: vi.fn(async () => "A"),
          custom: vi.fn(async () => undefined),
        },
      } as any,
    );
    expect(result.content[0].text).toBe("Error: options must be a non-empty array");
    expect(result.details.error).toBe("options must be a non-empty array");
  });

  it("execute rejects missing options", async () => {
    const result = await tool.execute(
      "tc1",
      { question: "Name?" },
      undefined,
      undefined,
      {
        hasUI: true,
        ui: {
          select: vi.fn(async () => "A"),
          custom: vi.fn(async () => undefined),
        },
      } as any,
    );
    expect(result.content[0].text).toBe("Error: options must be a non-empty array");
    expect(result.details.error).toBe("options must be a non-empty array");
  });

  it("execute handles selection via dialog", async () => {
    const result = await tool.execute(
      "tc1",
      { question: "Pick?", options: ["A", "B"] },
      undefined,
      undefined,
      {
        hasUI: true,
        ui: {
          select: vi.fn(async () => "B"),
          custom: vi.fn(async () => undefined),
        },
      } as any,
    );
    expect(result.content[0].text).toContain("User answered: B");
    expect(result.details.response).toEqual({ kind: "selection", selections: ["B"] });
  });

  it("execute handles selection cancellation", async () => {
    const result = await tool.execute(
      "tc1",
      { question: "Pick?", options: ["A", "B"] },
      undefined,
      undefined,
      {
        hasUI: true,
        ui: {
          select: vi.fn(async () => undefined),
          custom: vi.fn(async () => undefined),
        },
      } as any,
    );
    expect(result.content[0].text).toBe("User cancelled the question");
    expect(result.details.cancelled).toBe(true);
  });

  it("execute calls onUpdate while waiting", async () => {
    const onUpdate = vi.fn();
    await tool.execute(
      "tc1",
      { question: "Pick?", options: ["A", "B"] },
      undefined,
      onUpdate,
      {
        hasUI: true,
        ui: {
          select: vi.fn(async () => "A"),
          custom: vi.fn(async () => undefined),
        },
      } as any,
    );
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.arrayContaining([
          expect.objectContaining({ text: "Waiting for user input..." }),
        ]),
      }),
    );
  });

  it("uses the supplied resolved ask-user configuration instead of reloading settings", async () => {
    const configuredTool = createAskUserTool(() => ({ enabled: false, timeoutMs: 60_000 }));
    let component: any;
    await configuredTool.execute(
      "tc1",
      { question: "Pick?", options: ["A"] },
      undefined,
      undefined,
      {
        hasUI: true,
        ui: {
          custom: vi.fn(async (factory: any) => {
            component = factory({ requestRender: vi.fn() }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, { getKeys: () => [] }, () => {});
            return undefined;
          }),
          select: vi.fn(async () => "A"),
        },
      } as any,
    );
    expect(component.timerEnabled).toBe(false);
    expect(component.timerSeconds).toBe(60);
    component.destroy();
  });
});

describe("ask-user helpers", () => {
  // Re-import internals by creating the tool and inspecting behavior
  it("StringEnum produces correct schema", () => {
    const tool = createAskUserTool();
    const params = tool.parameters as any;
    // The options property is a required Array(Object) with minItems: 1
    const optionsSchema = params.properties.options;
    expect(optionsSchema.kind).toBe("array");
    expect(optionsSchema.items.kind).toBe("object");
    expect(optionsSchema.items.properties.title.kind).toBe("string");
    expect(optionsSchema.items.properties.description.kind).toBe("string");
  });
});
