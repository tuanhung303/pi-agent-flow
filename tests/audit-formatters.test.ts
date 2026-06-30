import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAuditModel } from "../src/flow/audit-formatters.js";
import { _clearSettingsCache } from "../src/config/config.js";
import type { FlowConfig } from "../src/flow/agents.js";
import type { FlowModelStrategy } from "../src/config/config.js";

describe("resolveAuditModel (effectivePrimary regression)", () => {
	let tmpDir: string;
	let originalHome: string | undefined;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-flow-audit-formatters-test-"));
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

	const makeAuditFlows = (model?: string): FlowConfig[] => [
		{ name: "audit", description: "audit agent", tier: "flash", model, tools: [], source: "bundled" },
	];

	const noopTierOverride = () => undefined;

	it("selects failover when primary is missing from models.json", () => {
		writeModelsJson({
			providers: {
				kimi: {
					models: [{ id: "kimi-k2.7-code", contextWindow: 262144 }],
				},
			},
		});

		const strategy: FlowModelStrategy = {
			flash: { primary: "kimi/kimi-for-coding", failover: ["kimi/kimi-k2.7-code"] },
		};

		const result = resolveAuditModel(makeAuditFlows(), noopTierOverride, strategy);

		// [V] Before fix, candidates[0] was "kimi/kimi-for-coding" (invalid).
		// After fix, effectivePrimary returns "kimi/kimi-k2.7-code" (valid failover).
		expect(result.model).toBe("kimi/kimi-k2.7-code");
	});

	it("returns undefined model when all candidates are missing from models.json", () => {
		writeModelsJson({
			providers: {
				kimi: {
					models: [{ id: "kimi-k2.7-code", contextWindow: 262144 }],
				},
			},
		});

		const strategy: FlowModelStrategy = {
			flash: { primary: "kimi/kimi-for-coding", failover: ["kimi/kimi-old"] },
		};

		const result = resolveAuditModel(makeAuditFlows(), noopTierOverride, strategy);

		// [V] All configured models are invalid → effectivePrimary is undefined.
		expect(result.model).toBeUndefined();
	});
});
