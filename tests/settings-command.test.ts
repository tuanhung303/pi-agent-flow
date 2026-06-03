import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SettingsList } from "../src/flow/settings-command.js";
import { handleTextCommand, getCategoryHandler } from "../src/flow/settings-handler.js";
import { loadFlowSettings, writeFlowSetting } from "../src/config/config.js";
import { clearGoal, _clearStoreCache } from "../src/flow/store.js";
import { clearLoop } from "../src/flow/loop.js";

describe("SettingsList", () => {
  let items: any[];
  let theme: any;
  let keybindings: any;
  let changes: Array<{ id: string; value: string }>;
  let cancelCount: number;

  beforeEach(() => {
    changes = [];
    cancelCount = 0;
    items = [
      { id: "a", label: "Setting A", currentValue: "on", values: ["on", "off"], description: "Desc A" },
      { id: "b", label: "Setting B", currentValue: "lite", values: ["lite", "full"], description: "Desc B" },
    ];
    theme = {
      label: (text: string, _sel: boolean) => text,
      value: (text: string, _sel: boolean) => text,
      description: (text: string) => text,
      cursor: "> ",
      hint: (text: string) => text,
    };
    keybindings = {
      matches: vi.fn(() => false),
    };
  });

  function makeList(maxVisible = 10) {
    return new SettingsList(items, maxVisible, theme, keybindings, (id, value) => changes.push({ id, value }), () => cancelCount++);
  }

  it("initializes with selectedIndex 0", () => {
    const list = makeList();
    const rendered = list.render(80);
    expect(rendered.some((line) => line.includes("Setting A"))).toBe(true);
  });

  it("renders empty items message", () => {
    const list = new SettingsList([], 10, theme, keybindings, () => {}, () => {});
    const rendered = list.render(80);
    expect(rendered.some((line) => line.includes("No settings available"))).toBe(true);
  });

  it("updateValue changes currentValue", () => {
    const list = makeList();
    list.updateValue("a", "off");
    expect(items[0].currentValue).toBe("off");
  });

  it("stepValue cycles forward through values", () => {
    const list = makeList();
    list.handleInput("\u001b[C");
    expect(changes).toEqual([{ id: "a", value: "off" }]);
  });

  it("stepValue cycles backward through values", () => {
    const list = makeList();
    items[0].currentValue = "off";
    list.handleInput("\u001b[D");
    expect(changes).toEqual([{ id: "a", value: "on" }]);
  });

  it("handleInput down moves selection", () => {
    const list = makeList();
    keybindings.matches = vi.fn((_data: string, id: string) => id === "tui.select.down");
    list.handleInput("down");
    const rendered = list.render(80);
    // Second item should now be selected (cursor on it)
    expect(rendered.some((line) => line.includes("Setting B"))).toBe(true);
  });

  it("handleInput up wraps to last item", () => {
    const list = makeList();
    keybindings.matches = vi.fn((_data: string, id: string) => id === "tui.select.up");
    list.handleInput("up");
    const rendered = list.render(80);
    expect(rendered.some((line) => line.includes("Setting B"))).toBe(true);
  });

  it("handleInput cancel calls onCancel", () => {
    const list = makeList();
    keybindings.matches = vi.fn((_data: string, id: string) => id === "tui.select.cancel");
    list.handleInput("esc");
    expect(cancelCount).toBe(1);
  });

  it("handleInput confirm with submenu opens submenu", () => {
    let submenuOpened = false;
    items[0].submenu = () => {
      submenuOpened = true;
      return { render: () => ["submenu"], invalidate: () => {}, handleInput: () => {} } as any;
    };
    const list = makeList();
    keybindings.matches = vi.fn((_data: string, id: string) => id === "tui.select.confirm");
    list.handleInput("enter");
    expect(submenuOpened).toBe(true);
    expect(list.render(80)[0]).toBe("submenu");
  });

  it("closeSubmenu restores selected index", () => {
    let doneCb: ((v?: string) => void) | undefined;
    items[0].submenu = (_: string, done: any) => {
      doneCb = done;
      return { render: () => ["submenu"], invalidate: () => {}, handleInput: () => {} } as any;
    };
    const list = makeList();
    keybindings.matches = vi.fn((_data: string, id: string) => id === "tui.select.confirm");
    list.handleInput("enter");
    keybindings.matches = vi.fn(() => false);
    // simulate selecting a value in submenu
    doneCb!("new-val");
    expect(items[0].currentValue).toBe("new-val");
    expect(changes).toContainEqual({ id: "a", value: "new-val" });
  });

  it("render shows scroll info when items exceed maxVisible", () => {
    const manyItems = Array.from({ length: 20 }, (_, i) => ({
      id: `i${i}`,
      label: `Item ${i}`,
      currentValue: "on",
      values: ["on", "off"],
    }));
    const list = new SettingsList(manyItems, 5, theme, keybindings, () => {}, () => {});
    const rendered = list.render(80);
    expect(rendered.some((line) => line.includes("/20"))).toBe(true);
  });

  it("render shows description of selected item", () => {
    const list = makeList();
    const rendered = list.render(80);
    expect(rendered.some((line) => line.includes("Desc A"))).toBe(true);
  });
});

describe("handleTextCommand", () => {
  let tmpDir: string;
  let notifyCalls: Array<{ msg: string; type: string }>;
  let ctx: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-handler-test-"));
    notifyCalls = [];
    ctx = {
      cwd: tmpDir,
      ui: {
        notify: (msg: string, type: string) => notifyCalls.push({ msg, type }),
      },
    };
  });

  afterEach(() => {
    clearGoal(tmpDir);
    clearLoop(tmpDir);
    _clearStoreCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("steering on updates setting", async () => {
    await handleTextCommand("steering on", ctx);
    expect(notifyCalls).toContainEqual({ msg: "steering.enabled = true", type: "info" });
    const settings = loadFlowSettings(tmpDir);
    expect(settings.steering?.enabled).toBe(true);
  });

  it("steering off updates setting", async () => {
    await handleTextCommand("steering off", ctx);
    expect(notifyCalls).toContainEqual({ msg: "steering.enabled = false", type: "info" });
    const settings = loadFlowSettings(tmpDir);
    expect(settings.steering?.enabled).toBe(false);
  });

  it("steering invalid shows error", async () => {
    await handleTextCommand("steering maybe", ctx);
    expect(notifyCalls).toContainEqual({ msg: "Usage: /flow:settings steering <on|off>", type: "error" });
  });

  it("animation on updates setting", async () => {
    await handleTextCommand("animation on", ctx);
    expect(notifyCalls).toContainEqual({ msg: "animation.enabled = true", type: "info" });
  });

  it("glitch off updates setting", async () => {
    await handleTextCommand("glitch off", ctx);
    expect(notifyCalls).toContainEqual({ msg: "animation.glitch = false", type: "info" });
  });

  it("tool-optimize toggles", async () => {
    await handleTextCommand("tool-optimize off", ctx);
    expect(notifyCalls).toContainEqual({ msg: "toolOptimize = false", type: "info" });
    const settings = loadFlowSettings(tmpDir);
    expect(settings.toolOptimize).toBe(false);
  });

  it("structured-output toggles", async () => {
    await handleTextCommand("structured-output on", ctx);
    const settings = loadFlowSettings(tmpDir);
    expect(settings.structuredOutput).toBe(true);
  });

  it("trace toggles", async () => {
    await handleTextCommand("trace off", ctx);
    const settings = loadFlowSettings(tmpDir);
    expect(settings.tools?.trace).toBe(false);
  });

  it("batch-read toggles", async () => {
    await handleTextCommand("batch-read on", ctx);
    const settings = loadFlowSettings(tmpDir);
    expect(settings.tools?.batchRead).toBe(true);
  });

  it("complexity sets valid mode", async () => {
    await handleTextCommand("complexity snap", ctx);
    expect(notifyCalls).toContainEqual({ msg: "complexity = snap", type: "info" });
    const settings = loadFlowSettings(tmpDir);
    expect(settings.complexity).toBe("snap");
  });

  it("complexity invalid shows error", async () => {
    await handleTextCommand("complexity extreme", ctx);
    expect(notifyCalls).toContainEqual({
      msg: "Usage: /flow:settings complexity <snap|simple|moderate|complex|intricate>",
      type: "error",
    });
  });

  it("max-concurrency sets value", async () => {
    await handleTextCommand("max-concurrency 6", ctx);
    expect(notifyCalls).toContainEqual({ msg: "maxConcurrency = 6", type: "info" });
    const settings = loadFlowSettings(tmpDir);
    expect(settings.maxConcurrency).toBe(6);
  });

  it("max-concurrency invalid shows error", async () => {
    await handleTextCommand("max-concurrency 0", ctx);
    expect(notifyCalls).toContainEqual({ msg: "Usage: /flow:settings max-concurrency <n>", type: "error" });
  });

  it("ask-user enabled toggles", async () => {
    await handleTextCommand("ask-user enabled on", ctx);
    expect(notifyCalls).toContainEqual({ msg: "askUser.enabled = true", type: "info" });
    const settings = loadFlowSettings(tmpDir);
    expect(settings.askUser?.enabled).toBe(true);
  });

  it("ask-user timeout sets value", async () => {
    await handleTextCommand("ask-user timeout 120", ctx);
    expect(notifyCalls).toContainEqual({ msg: "askUser.timeout = 120", type: "info" });
    const settings = loadFlowSettings(tmpDir);
    expect(settings.askUser?.timeout).toBe(120);
  });

  it("ask-user invalid subcommand shows error", async () => {
    await handleTextCommand("ask-user invalid", ctx);
    expect(notifyCalls).toContainEqual({
      msg: "Usage: /flow:settings ask-user {enabled <on|off> | timeout <seconds>}",
      type: "error",
    });
  });

  it("reset clears settings", async () => {
    writeFlowSetting(tmpDir, "complexity", "intricate");
    await handleTextCommand("reset", ctx);
    expect(notifyCalls).toContainEqual({ msg: "Flow settings reset to defaults", type: "info" });
    const settings = loadFlowSettings(tmpDir);
    expect(settings).toEqual({});
  });

  it("show displays current settings", async () => {
    await handleTextCommand("show", ctx);
    const showCall = notifyCalls.find((n) => n.type === "info" && n.msg.includes("bodyVerbosity"));
    expect(showCall).toBeDefined();
    expect(showCall!.msg).toContain("toolOptimize");
    expect(showCall!.msg).toContain("steering.enabled");
  });

  it("debug toggles", async () => {
    await handleTextCommand("debug on", ctx);
    expect(notifyCalls).toContainEqual({ msg: "debugMode = true", type: "info" });
    const settings = loadFlowSettings(tmpDir);
    expect(settings.debugMode).toBe(true);
  });

  it("unknown subcommand shows error", async () => {
    await handleTextCommand("unknown", ctx);
    expect(notifyCalls).toContainEqual({
      msg: "Unknown subcommand. Usage: /flow:settings {steering|animation|glitch|tool-optimize|structured-output|body|complexity|context-compression|max-concurrency|ask-user|debug|trace|batch-read|reset|show}",
      type: "error",
    });
  });


});

describe("getCategoryHandler", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-cat-test-"));
  });

  afterEach(() => {
    _clearStoreCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockTui() {
    return { requestRender: vi.fn() };
  }

  it("steering handler writes enabled setting", () => {
    const handler = getCategoryHandler("steering", tmpDir, {}, () => {}, mockTui(), {} as any);
    handler("steering.enabled", "off");
    const settings = loadFlowSettings(tmpDir);
    expect(settings.steering?.enabled).toBe(false);
  });

  it("animation handler writes glitch setting", () => {
    const handler = getCategoryHandler("animation", tmpDir, {}, () => {}, mockTui(), {} as any);
    handler("animation.glitch", "off");
    const settings = loadFlowSettings(tmpDir);
    expect(settings.animation?.glitch).toBe(false);
  });

  it("tools handler writes trace setting", () => {
    const handler = getCategoryHandler("tools", tmpDir, {}, () => {}, mockTui(), {} as any);
    handler("tools.trace", "off");
    const settings = loadFlowSettings(tmpDir);
    expect(settings.tools?.trace).toBe(false);
  });

  it("session handler writes complexity", () => {
    const handler = getCategoryHandler("session", tmpDir, {}, () => {}, mockTui(), {} as any);
    handler("complexity", "snap");
    const settings = loadFlowSettings(tmpDir);
    expect(settings.complexity).toBe("snap");
  });

  it("ask-user handler writes timeout", () => {
    const handler = getCategoryHandler("ask-user", tmpDir, {}, () => {}, mockTui(), {} as any);
    handler("askUser.timeout", "60");
    const settings = loadFlowSettings(tmpDir);
    expect(settings.askUser?.timeout).toBe(60);
  });

  it("loop handler is no-op", () => {
    const handler = getCategoryHandler("loop", tmpDir, {}, () => {}, mockTui(), {} as any);
    handler("loop.status", "active");
    const settings = loadFlowSettings(tmpDir);
    expect(settings).toEqual({});
  });

  it("debug handler writes debugMode", () => {
    const handler = getCategoryHandler("debug", tmpDir, {}, () => {}, mockTui(), {} as any);
    handler("debugMode", "on");
    const settings = loadFlowSettings(tmpDir);
    expect(settings.debugMode).toBe(true);
  });
});
