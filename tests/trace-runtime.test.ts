import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveTraceRuntime } from "../src/tools/trace.js";
import { _clearSettingsCache } from "../src/config/config.js";
import type { FlowConfig } from "../src/flow/agents.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function makeTraceFlow(model?: string): FlowConfig {
	return {
		name: "trace",
		description: "trace agent",
		tier: "lite",
		model,
		tools: ["batch", "bash", "find", "grep", "ls", "web"],
		source: "bundled",
	};
}

function makeMockCtx(): ExtensionContext {
	return {
		cwd: "/tmp",
		sessionManager: {
			getHeader: () => ({}),
			getBranch: () => [],
			getSessionId: () => "test-session-id",
		},
		hasUI: false,
		ui: { confirm: vi.fn() },
	} as unknown as ExtensionContext;
}

describe("resolveTraceRuntime", () => {
	let tmpDir: string;
	let originalHome: string | undefined;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-trace-runtime-test-"));
		originalHome = process.env.HOME;
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.HOME = tmpDir;
		process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, ".pi", "agent");
		_clearSettingsCache();
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

	function writeModelsJson(content: Record<string, unknown>) {
		const dir = path.join(tmpDir, ".pi", "agent");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify(content, null, 2), "utf-8");
	}

	it("throws a clear bad-settings error when all configured trace models are missing", () => {
		writeModelsJson({
			providers: {
				kimi: {
					models: [{ id: "kimi-k2.7-code", contextWindow: 262144 }],
				},
			},
		});

		expect(() =>
			resolveTraceRuntime(
				{
					getSettings: () => ({ toolOptimize: false, structuredOutput: false, bodyVerbosity: "lite" }),
					getLoadedFlowModelConfigs: () => ({
						configs: {
							default: {
								lite: { primary: "kimi/kimi-for-coding", failover: ["kimi/kimi-old"] },
							},
						},
						selectedName: "default",
					}),
				},
				makeTraceFlow(),
				makeMockCtx(),
				"call-1",
				"test intent",
			),
		).toThrow(/Bad settings: all configured trace models are missing from models\.json/);
	});
});
