import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadFlowModels, loadFlowSettings } from "../config.js";

describe("loadFlowModels", () => {
	let tmpDir: string;
	let originalHome: string | undefined;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-config-test-"));
		originalHome = process.env.HOME;
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.HOME = tmpDir;
		delete process.env.PI_CODING_AGENT_DIR;
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		if (originalAgentDir !== undefined) {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		} else {
			delete process.env.PI_CODING_AGENT_DIR;
		}
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeGlobalSettings(content: Record<string, unknown>) {
		const dir = path.join(tmpDir, ".pi", "agent");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(content, null, 2), "utf-8");
	}

	function writeProjectSettings(cwd: string, content: Record<string, unknown>) {
		const dir = path.join(cwd, ".pi");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(content, null, 2), "utf-8");
	}

	it("returns empty object when no settings files exist", () => {
		const result = loadFlowModels(tmpDir);
		expect(result).toEqual({});
	});

	it("reads global settings.json only", () => {
		writeGlobalSettings({
			flowModels: {
				lite: "gemini-3.0-flash",
				flash: "claude-sonnet-4",
				full: "claude-opus-4",
			},
		});
		const result = loadFlowModels(tmpDir);
		expect(result).toEqual({
			lite: "gemini-3.0-flash",
			flash: "claude-sonnet-4",
			full: "claude-opus-4",
		});
	});

	it("project overrides global", () => {
		writeGlobalSettings({
			flowModels: {
				lite: "gemini-3.0-flash",
				flash: "claude-sonnet-4",
				full: "claude-opus-4",
			},
		});
		writeProjectSettings(tmpDir, {
			flowModels: {
				flash: "gpt-4o",
			},
		});
		const result = loadFlowModels(tmpDir);
		expect(result).toEqual({
			lite: "gemini-3.0-flash",
			flash: "gpt-4o",
			full: "claude-opus-4",
		});
	});

	it("ignores non-string values in flowModels", () => {
		writeGlobalSettings({
			flowModels: {
				lite: "gemini-3.0-flash",
				flash: 123,
				full: true,
			},
		});
		const result = loadFlowModels(tmpDir);
		expect(result).toEqual({
			lite: "gemini-3.0-flash",
		});
	});

	it("gracefully handles invalid JSON", () => {
		const dir = path.join(tmpDir, ".pi", "agent");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "settings.json"), "not json", "utf-8");
		const result = loadFlowModels(tmpDir);
		expect(result).toEqual({});
	});

	it("gracefully handles missing flowModels key", () => {
		writeGlobalSettings({
			defaultModel: "claude-sonnet-4",
		});
		const result = loadFlowModels(tmpDir);
		expect(result).toEqual({});
	});

	it("uses PI_CODING_AGENT_DIR for global settings location", () => {
		const customDir = path.join(tmpDir, "custom-agent");
		fs.mkdirSync(customDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = customDir;
		fs.writeFileSync(
			path.join(customDir, "settings.json"),
			JSON.stringify({ flowModels: { lite: "custom-model" } }),
			"utf-8",
		);
		const result = loadFlowModels(tmpDir);
		expect(result).toEqual({ lite: "custom-model" });
	});
});

describe("loadFlowSettings", () => {
	let tmpDir: string;
	let originalHome: string | undefined;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-config-test-"));
		originalHome = process.env.HOME;
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.HOME = tmpDir;
		delete process.env.PI_CODING_AGENT_DIR;
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		if (originalAgentDir !== undefined) {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		} else {
			delete process.env.PI_CODING_AGENT_DIR;
		}
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeGlobalSettings(content: Record<string, unknown>) {
		const dir = path.join(tmpDir, ".pi", "agent");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(content, null, 2), "utf-8");
	}

	function writeProjectSettings(cwd: string, content: Record<string, unknown>) {
		const dir = path.join(cwd, ".pi");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(content, null, 2), "utf-8");
	}

	it("returns empty object when no settings files exist", () => {
		const result = loadFlowSettings(tmpDir);
		expect(result).toEqual({});
	});

	it("reads global toolOptimize setting", () => {
		writeGlobalSettings({
			flowSettings: {
				toolOptimize: true,
			},
		});
		const result = loadFlowSettings(tmpDir);
		expect(result).toEqual({ toolOptimize: true });
	});

	it("reads project toolOptimize setting", () => {
		writeProjectSettings(tmpDir, {
			flowSettings: {
				toolOptimize: false,
			},
		});
		const result = loadFlowSettings(tmpDir);
		expect(result).toEqual({ toolOptimize: false });
	});

	it("project overrides global toolOptimize", () => {
		writeGlobalSettings({
			flowSettings: {
				toolOptimize: true,
			},
		});
		writeProjectSettings(tmpDir, {
			flowSettings: {
				toolOptimize: false,
			},
		});
		const result = loadFlowSettings(tmpDir);
		expect(result).toEqual({ toolOptimize: false });
	});

	it("ignores non-boolean toolOptimize", () => {
		writeGlobalSettings({
			flowSettings: {
				toolOptimize: "yes",
			},
		});
		const result = loadFlowSettings(tmpDir);
		expect(result).toEqual({});
	});

	it("gracefully handles invalid JSON", () => {
		const dir = path.join(tmpDir, ".pi", "agent");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "settings.json"), "not json", "utf-8");
		const result = loadFlowSettings(tmpDir);
		expect(result).toEqual({});
	});

	it("gracefully handles missing flowSettings key", () => {
		writeGlobalSettings({
			defaultModel: "claude-sonnet-4",
		});
		const result = loadFlowSettings(tmpDir);
		expect(result).toEqual({});
	});
});
