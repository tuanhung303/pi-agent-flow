import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { cleanupStaleDumps } from "../../src/flow/dump-io.js";
import * as atomicWrite from "../../src/io/atomic-write.js";
import {
  writeState,
  readState,
  flushAllStoreCachesSync,
  flushAllStoreCaches,
  _clearStoreCache,
} from "../../src/flow/store.js";
import {
  writeFlowSetting,
  flushAllSettingsCachesSync,
  _clearSettingsCache,
} from "../../src/config/config.js";

function createTempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function createOldDumpFile(dir: string, baseName: string, ageMs: number): string {
  const filePath = path.join(dir, `${baseName}.${Date.now()}.md`);
  writeFileSync(filePath, "old dump", "utf-8");
  const past = new Date(Date.now() - ageMs);
  utimesSync(filePath, past, past);
  return filePath;
}

function createManyOldDumpFiles(dir: string, baseName: string, count: number, ageMs: number): string[] {
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const filePath = path.join(dir, `${baseName}.${i}.${Date.now()}.md`);
    writeFileSync(filePath, "old dump", "utf-8");
    const past = new Date(Date.now() - ageMs);
    utimesSync(filePath, past, past);
    paths.push(filePath);
  }
  return paths;
}

describe("cleanupStaleDumps async behavior", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir("pi-dump-cleanup-test-");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("P5-1: cleanupStaleDumps is async — returns a Promise", async () => {
    const dumpPath = path.join(tmpDir, "pi-dump.md");
    const result = cleanupStaleDumps(dumpPath, 24);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });

  it("P5-2: cleanupStaleDumps does not block the event loop with many files", async () => {
    const dumpPath = path.join(tmpDir, "pi-dump.md");
    const baseName = "pi-dump";
    const maxAgeHours = 24;
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    const count = 200;

    // Create 200 stale dump files
    const createdPaths = createManyOldDumpFiles(tmpDir, baseName, count, maxAgeMs + 1000);

    // Verify all files exist before cleanup
    for (const p of createdPaths) {
      expect(existsSync(p)).toBe(true);
    }

    // Track event loop responsiveness: set a timeout that should fire during cleanup
    let timeoutFired = false;
    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        timeoutFired = true;
        resolve();
      }, 10);
    });

    // Start cleanup and wait for the timeout
    const cleanupPromise = cleanupStaleDumps(dumpPath, maxAgeHours);
    await timeoutPromise;
    expect(timeoutFired).toBe(true);

    // Wait for cleanup to complete
    await cleanupPromise;

    // Verify all stale files were deleted
    for (const p of createdPaths) {
      expect(existsSync(p)).toBe(false);
    }
  });
});

describe("store async behavior", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir("pi-store-async-test-");
    _clearStoreCache();
  });

  afterEach(() => {
    _clearStoreCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("P9-1: writeState uses async flush — file not immediately on disk, flush persists", async () => {
    const state = { history: [], current: { objective: "test", status: "active" as const } };
    writeState(tmpDir, state);

    const filePath = path.join(tmpDir, ".pi", "flow.json");
    // Immediately after writeState, the file should NOT be on disk (async flush)
    expect(existsSync(filePath)).toBe(false);

    // After flushing, the file should exist
    await flushAllStoreCaches();
    expect(existsSync(filePath)).toBe(true);
  });

  it("P9-2: readState returns cached value immediately after writeState", () => {
    const state = {
      history: [],
      current: {
        id: "goal-1",
        objective: "cached objective",
        status: "active" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedFlows: [],
        totalTokens: 0,
      },
    };
    writeState(tmpDir, state);

    // Read immediately — should return the cached value, not hit disk
    const read = readState(tmpDir);
    expect(read.current).toBeDefined();
    expect(read.current?.objective).toBe("cached objective");
  });

  it("P9-3: flushAllStoreCachesSync persists all pending writes", () => {
    const dir1 = createTempDir("pi-store-sync-test-1-");
    const dir2 = createTempDir("pi-store-sync-test-2-");
    const dir3 = createTempDir("pi-store-sync-test-3-");

    try {
      _clearStoreCache();

      const state1 = { history: [], current: { objective: "one", status: "active" as const } };
      const state2 = { history: [], current: { objective: "two", status: "active" as const } };
      const state3 = { history: [], current: { objective: "three", status: "active" as const } };

      writeState(dir1, state1);
      writeState(dir2, state2);
      writeState(dir3, state3);

      // Before sync flush, no files should be on disk
      expect(existsSync(path.join(dir1, ".pi", "flow.json"))).toBe(false);
      expect(existsSync(path.join(dir2, ".pi", "flow.json"))).toBe(false);
      expect(existsSync(path.join(dir3, ".pi", "flow.json"))).toBe(false);

      // Sync flush all
      flushAllStoreCachesSync();

      // After sync flush, all files should exist
      expect(existsSync(path.join(dir1, ".pi", "flow.json"))).toBe(true);
      expect(existsSync(path.join(dir2, ".pi", "flow.json"))).toBe(true);
      expect(existsSync(path.join(dir3, ".pi", "flow.json"))).toBe(true);

      // Verify content
      const parsed1 = JSON.parse(require("node:fs").readFileSync(path.join(dir1, ".pi", "flow.json"), "utf-8"));
      expect(parsed1.current.objective).toBe("one");

      const parsed2 = JSON.parse(require("node:fs").readFileSync(path.join(dir2, ".pi", "flow.json"), "utf-8"));
      expect(parsed2.current.objective).toBe("two");

      const parsed3 = JSON.parse(require("node:fs").readFileSync(path.join(dir3, ".pi", "flow.json"), "utf-8"));
      expect(parsed3.current.objective).toBe("three");
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
      rmSync(dir3, { recursive: true, force: true });
      _clearStoreCache();
    }
  });

  it("P1-race: generation counter aborts stale async rename during sync flush", async () => {
    const dir = createTempDir("pi-store-race-gen-test-");
    try {
      _clearStoreCache();

      // Slow down atomicWriteJsonAsync to create a wide race window
      const original = atomicWrite.atomicWriteJsonAsync;
      let shouldAbortFn: (() => boolean) | undefined;
      const spy = vi.spyOn(atomicWrite, "atomicWriteJsonAsync").mockImplementation(async (targetPath, data, options) => {
        shouldAbortFn = options?.shouldAbort;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return original(targetPath, data, options);
      });

      const state1 = { history: [], current: { objective: "first", status: "active" as const } };
      writeState(dir, state1);

      // Yield so the async flush starts (and hits the 50ms delay)
      await new Promise((resolve) => setImmediate(resolve));

      // While the async flush is in-flight, write a new state and sync flush
      const state2 = { history: [], current: { objective: "second", status: "active" as const } };
      writeState(dir, state2);
      flushAllStoreCachesSync();

      // The shouldAbort closure should detect the generation change caused by the sync flush
      expect(shouldAbortFn).toBeDefined();
      expect(shouldAbortFn!()).toBe(true);

      // Wait for the async flush to complete (it will abort its rename)
      await flushAllStoreCaches();

      const filePath = path.join(dir, ".pi", "flow.json");
      const parsed = JSON.parse(require("node:fs").readFileSync(filePath, "utf-8"));
      // The sync flush should have persisted the latest state
      expect(parsed.current.objective).toBe("second");

      spy.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      _clearStoreCache();
    }
  });

  it("P1: flushAllStoreCaches waits for in-flight async flushes", async () => {
    const dir = createTempDir("pi-store-race-test-");
    try {
      _clearStoreCache();

      // Slow down atomicWriteJsonAsync so the race window is wide
      const original = atomicWrite.atomicWriteJsonAsync;
      const spy = vi.spyOn(atomicWrite, "atomicWriteJsonAsync").mockImplementation(async (targetPath, data) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return original(targetPath, data);
      });

      const state1 = { history: [], current: { objective: "first", status: "active" as const } };
      writeState(dir, state1);

      // Yield to event loop so the setImmediate flush starts (and hits the 30ms delay)
      await new Promise((resolve) => setImmediate(resolve));

      // While the first flush is still in-flight, write a new state
      const state2 = { history: [], current: { objective: "second", status: "active" as const } };
      writeState(dir, state2);

      // flushAllStoreCaches must wait for BOTH the in-flight flush and the newly scheduled one
      await flushAllStoreCaches();

      const filePath = path.join(dir, ".pi", "flow.json");
      const parsed = JSON.parse(require("node:fs").readFileSync(filePath, "utf-8"));
      expect(parsed.current.objective).toBe("second");

      spy.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      _clearStoreCache();
    }
  });
});

describe("settings async behavior", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = createTempDir("pi-settings-async-test-");
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    _clearSettingsCache();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    _clearSettingsCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("P9-4: settings async flush — cached after write, persisted after flush", async () => {
    const projectDir = createTempDir("pi-settings-project-");
    mkdirSync(path.join(projectDir, ".pi"), { recursive: true });

    try {
      _clearSettingsCache();

      const result = writeFlowSetting(projectDir, "toolOptimize", true);
      const settingsPath = result.path;

      // Immediately after writeFlowSetting, the file should NOT be on disk (async flush)
      expect(existsSync(settingsPath)).toBe(false);

      // After sync flush, the file should exist
      flushAllSettingsCachesSync();
      expect(existsSync(settingsPath)).toBe(true);

      // Verify content
      const raw = require("node:fs").readFileSync(settingsPath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.flowSettings.toolOptimize).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
