import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _clearSettingsCache } from "../src/config/config.js";
import { resolveSettings } from "../src/config/settings-resolver.js";

describe("context compression resolution", () => {
  let cwd: string;
  let previousEnv: string | undefined;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-flow-context-resolution-"));
    previousEnv = process.env.PI_FLOW_CONTEXT_COMPRESSION;
    delete process.env.PI_FLOW_CONTEXT_COMPRESSION;
    _clearSettingsCache();
    fs.mkdirSync(path.join(cwd, ".pi"));
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({
      flowSettings: { contextCompression: "medium" },
    }));
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.PI_FLOW_CONTEXT_COMPRESSION;
    else process.env.PI_FLOW_CONTEXT_COMPRESSION = previousEnv;
    _clearSettingsCache();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function resolve(flag?: string) {
    return resolveSettings({ getFlag: (name: string) => name === "flow-context-compression" ? flag : undefined } as any, cwd);
  }

  it("uses explicit CLI over environment and persistent settings", () => {
    process.env.PI_FLOW_CONTEXT_COMPRESSION = "light";
    expect(resolve("aggressive").contextCompression).toEqual({ value: "aggressive", source: "cli" });
  });

  it("keeps explicit CLI auto above an aggressive environment override", () => {
    process.env.PI_FLOW_CONTEXT_COMPRESSION = "aggressive";
    expect(resolve("auto").contextCompression).toEqual({ value: "auto", source: "cli" });
  });

  it("uses environment over persistent settings", () => {
    process.env.PI_FLOW_CONTEXT_COMPRESSION = "light";
    expect(resolve().contextCompression).toEqual({ value: "light", source: "env" });
  });

  it("uses persistent settings before automatic default", () => {
    expect(resolve().contextCompression).toEqual({ value: "medium", source: "settings" });
  });
});


describe("runtime flow model strategy resolution", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-flow-runtime-strategy-"));
    fs.mkdirSync(path.join(cwd, ".pi"));
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({
      flowModelConfig: "project-small",
      flowModelConfigs: {
        "project-small": { flash: { primary: "provider/large", failover: ["provider/small"] } },
        explicit: { flash: { primary: "provider/explicit" } },
      },
    }));
    _clearSettingsCache();
  });

  afterEach(() => {
    _clearSettingsCache();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function resolve(flowMode?: string, flowModelConfig?: string) {
    return resolveSettings({ getFlag: (name: string) => name === "flow-mode" ? flowMode : name === "flow-model-config" ? flowModelConfig : undefined } as any, cwd);
  }

  it("uses the same project strategy when the CLI mode is absent or invalid", () => {
    expect(resolve().loadedFlowModelConfigs.selectedName).toBe("project-small");
    expect(resolve("missing-mode").loadedFlowModelConfigs.selectedName).toBe("project-small");
  });

  it("uses a valid explicit CLI strategy as the resolved runtime strategy", () => {
    expect(resolve(undefined, "explicit").loadedFlowModelConfigs.selectedName).toBe("explicit");
  });
});
