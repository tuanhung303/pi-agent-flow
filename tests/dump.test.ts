import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runFlow, type RunFlowOptions } from "../src/flow/runner.js";
import { cleanupStaleDebugDumps } from "../src/flow/dump-io.js";
import type { FlowConfig } from "../src/flow/agents.js";
import type { FlowDetails } from "../src/types/flow.js";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Mock spawn to avoid real process execution
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return {
		...actual,
		spawn: vi.fn(),
	};
});

const mockFlow: FlowConfig = {
	name: "scout",
	description: "Discovery flow",
	systemPrompt: "You are scout.",
	source: "bundled",
	filePath: "/agents/scout.md",
};

function makeMockProcess() {
	const proc = new EventEmitter() as any;
	proc.stdin = new EventEmitter();
	proc.stdin.end = vi.fn();
	proc.stdin.write = vi.fn();
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.pid = 12345;
	proc.kill = vi.fn();
	return proc;
}

function makeDetails(results: any[]): FlowDetails {
	return {
		mode: "flow",
		flowStyle: "fork",
		projectAgentsDir: null,
		results,
	};
}

// ---------------------------------------------------------------------------
// 4A. End-to-end dump test
// ---------------------------------------------------------------------------

describe("dump mechanism — end-to-end", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("creates .md and .txt dump files with correct naming pattern", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const baseDumpPath = path.join(os.tmpdir(), `pi-e2e-dump-${Date.now()}`);
		const dumpEnv = `${baseDumpPath}.md`;
		const prev = process.env.PI_FLOW_DUMP_SNAPSHOT;
		process.env.PI_FLOW_DUMP_SNAPSHOT = dumpEnv;

		const jsonl =
			'{"type":"session","systemPrompt":"test"}\n' +
			'{"type":"model_change","model":"test-model"}\n' +
			'{"type":"thinking_level_change","level":"medium"}\n' +
			'{"type":"system","content":"test system"}\n' +
			'{"type":"message","message":{"role":"user","content":"hello"}}\n';

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [mockFlow],
			flowName: "scout",
			intent: "Test intent",
			aim: "Test aim",
			forkSessionSnapshotJsonl: jsonl,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			makeDetails,
		};

		const promise = runFlow(opts);
		setTimeout(() => {
			mockProc.stdout.emit(
				"data",
				Buffer.from(
					'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n',
				),
			);
			mockProc.emit("close", 0);
		}, 10);

		await promise;

		// Find the actual dump files (unique suffix prevents collisions).
		const baseName = path.basename(baseDumpPath);
		const tmpFiles = fs.readdirSync(os.tmpdir());
		const mdFiles = tmpFiles.filter(
			(f) => f.startsWith(baseName) && f.endsWith(".md"),
		);
		expect(mdFiles.length).toBe(1);

		const actualMd = path.join(os.tmpdir(), mdFiles[0]);
		const actualTxt = actualMd.replace(/\.md$/, ".txt");

		// Verify naming pattern: <base>.<flowName>.<timestamp>.md
		const mdName = path.basename(actualMd);
		const pattern = new RegExp(`^${baseName}\\.scout\\.\\d+\\.md$`);
		expect(mdName).toMatch(pattern);
		expect(fs.existsSync(actualTxt)).toBe(true);

		// Verify .md content sections.
		const mdContent = fs.readFileSync(actualMd, "utf-8");
		expect(mdContent).toContain("<!-- pi-agent-flow dump");
		expect(mdContent).toContain("Flow: scout");
		expect(mdContent).toContain("## Session Snapshot (JSONL)");
		expect(mdContent).toContain("## Activation Prompt (-p)");
		// Compression Stats section removed from dumps

		expect(mdContent).toContain('"type":"session"');
		expect(mdContent).toContain("<activation flow=\"scout\"");

		// Verify .txt companion is just the prompt.
		const txtContent = fs.readFileSync(actualTxt, "utf-8");
		expect(txtContent).toContain("<activation flow=\"scout\"");
		expect(txtContent).not.toContain("## Session Snapshot");

		// Cleanup.
		try { fs.unlinkSync(actualMd); } catch { /* ignore */ }
		try { fs.unlinkSync(actualTxt); } catch { /* ignore */ }

		if (prev === undefined) delete process.env.PI_FLOW_DUMP_SNAPSHOT;
		else process.env.PI_FLOW_DUMP_SNAPSHOT = prev;
	});

	it("cleans up temp dump files after test (idempotent)", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const baseDumpPath = path.join(os.tmpdir(), `pi-e2e-dump-cleanup-${Date.now()}`);
		const prev = process.env.PI_FLOW_DUMP_SNAPSHOT;
		process.env.PI_FLOW_DUMP_SNAPSHOT = `${baseDumpPath}.md`;

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [mockFlow],
			flowName: "scout",
			intent: "Test intent",
			aim: "Test aim",
			forkSessionSnapshotJsonl: '{"type":"session"}\n',
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			makeDetails,
		};

		const promise = runFlow(opts);
		setTimeout(() => {
			mockProc.stdout.emit(
				"data",
				Buffer.from(
					'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n',
				),
			);
			mockProc.emit("close", 0);
		}, 10);

		await promise;

		const baseName = path.basename(baseDumpPath);
		const tmpFiles = fs.readdirSync(os.tmpdir());
		const mdFiles = tmpFiles.filter(
			(f) => f.startsWith(baseName) && f.endsWith(".md"),
		);
		expect(mdFiles.length).toBe(1);
		const actualMd = path.join(os.tmpdir(), mdFiles[0]);
		const actualTxt = actualMd.replace(/\.md$/, ".txt");

		expect(fs.existsSync(actualMd)).toBe(true);
		expect(fs.existsSync(actualTxt)).toBe(true);

		fs.unlinkSync(actualMd);
		fs.unlinkSync(actualTxt);

		expect(fs.existsSync(actualMd)).toBe(false);
		expect(fs.existsSync(actualTxt)).toBe(false);

		if (prev === undefined) delete process.env.PI_FLOW_DUMP_SNAPSHOT;
		else process.env.PI_FLOW_DUMP_SNAPSHOT = prev;
	});
});

// ---------------------------------------------------------------------------
// 4B. Error reporting test
// ---------------------------------------------------------------------------

describe("dump mechanism — error handling", () => {
	let originalIsTTY: boolean | undefined;
	let originalFlowDepth: string | undefined;

	beforeEach(() => {
		originalIsTTY = process.stdout.isTTY;
		originalFlowDepth = process.env.PI_FLOW_DEPTH;
		// @ts-ignore
		process.stdout.isTTY = false;
		delete process.env.PI_FLOW_DEPTH;
		vi.clearAllMocks();
	});

	afterEach(() => {
		// @ts-ignore
		process.stdout.isTTY = originalIsTTY;
		if (originalFlowDepth !== undefined) {
			process.env.PI_FLOW_DEPTH = originalFlowDepth;
		} else {
			delete process.env.PI_FLOW_DEPTH;
		}
		vi.restoreAllMocks();
	});

	it("logs dump failure to stderr when path is unwritable", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		// Use a path whose parent is not a directory — atomic write will fail.
		const invalidDumpPath = "/dev/null/dump.md";
		const prev = process.env.PI_FLOW_DUMP_SNAPSHOT;
		process.env.PI_FLOW_DUMP_SNAPSHOT = invalidDumpPath;

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			flows: [mockFlow],
			flowName: "scout",
			intent: "Test intent",
			aim: "Test aim",
			forkSessionSnapshotJsonl: '{"type":"session"}\n',
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			makeDetails,
		};

		const promise = runFlow(opts);
		setTimeout(() => {
			mockProc.stdout.emit(
				"data",
				Buffer.from(
					'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n',
				),
			);
			mockProc.emit("close", 0);
		}, 10);

		const result = await promise;

		// Flow must still complete successfully (best-effort).
		expect(result.exitCode).toBe(0);

		// Failure must be logged to stderr, not swallowed.
		expect(consoleSpy).toHaveBeenCalled();
		const failureCall = consoleSpy.mock.calls.find(
			(call) =>
				typeof call[0] === "string" && call[0].includes("Snapshot dump FAILED"),
		);
		expect(failureCall).toBeTruthy();

		consoleSpy.mockRestore();
		if (prev === undefined) delete process.env.PI_FLOW_DUMP_SNAPSHOT;
		else process.env.PI_FLOW_DUMP_SNAPSHOT = prev;
	});
});

// ---------------------------------------------------------------------------
// 4C. Protocol schema validation
// ---------------------------------------------------------------------------

const FORK_SNAPSHOT_CANONICAL_TYPES = new Set([
	"session",
	"model_change",
	"thinking_level_change",
	"system",
	"message",
]);

const STREAMING_STDOUT_ALLOWED_TYPES = new Set([
	"session",
	"agent_start",
	"turn_start",
	"message_start",
	"message_end",
	"turn_end",
	"agent_end",
	"message_update",
]);

const STREAMING_STDOUT_ALLOWED_SUB_TYPES = new Set([
	"thinking_start",
	"thinking_delta",
	"text_delta",
]);

function validateSnapshotJsonl(jsonl: string): string[] {
	const unknowns: string[] = [];
	for (const line of jsonl.trim().split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (
				entry &&
				typeof entry.type === "string" &&
				!FORK_SNAPSHOT_CANONICAL_TYPES.has(entry.type)
			) {
				unknowns.push(entry.type);
			}
		} catch {
			/* ignore non-JSON lines */
		}
	}
	return unknowns;
}

function validateStreamingStdout(lines: string[]): string[] {
	const unknowns: string[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (!entry || typeof entry.type !== "string") continue;

			if (!STREAMING_STDOUT_ALLOWED_TYPES.has(entry.type)) {
				unknowns.push(entry.type);
				continue;
			}

			if (entry.type === "message_update") {
				const sub = entry.assistantMessageEvent?.type;
				if (
					typeof sub === "string" &&
					!STREAMING_STDOUT_ALLOWED_SUB_TYPES.has(sub)
				) {
					unknowns.push(`message_update.${sub}`);
				}
			}
		} catch {
			/* ignore non-JSON lines */
		}
	}
	return unknowns;
}

describe("protocol schema validation", () => {
	it("accepts all 5 canonical fork snapshot types", () => {
		const jsonl = [
			{ type: "session", systemPrompt: "test" },
			{ type: "model_change", model: "m" },
			{ type: "thinking_level_change", level: "low" },
			{ type: "system", content: "sys" },
			{ type: "message", message: { role: "user", content: "hi" } },
		]
			.map((o) => JSON.stringify(o))
			.join("\n") + "\n";

		expect(validateSnapshotJsonl(jsonl)).toEqual([]);
	});

	it("catches unknown fork snapshot types", () => {
		const jsonl = [
			{ type: "session" },
			{ type: "message" },
			{ type: "custom_event" },
			{ type: "unknown_type" },
		]
			.map((o) => JSON.stringify(o))
			.join("\n") + "\n";

		expect(validateSnapshotJsonl(jsonl)).toEqual([
			"custom_event",
			"unknown_type",
		]);
	});

	it("accepts all expected streaming stdout types", () => {
		const lines = [
			{ type: "session" },
			{ type: "agent_start" },
			{ type: "turn_start" },
			{ type: "message_start" },
			{ type: "message_end", message: { role: "assistant", content: "hi" } },
			{ type: "turn_end", message: { role: "assistant", content: "hi" } },
			{ type: "agent_end", messages: [{ role: "assistant", content: "hi" }] },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_start" } },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "d" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "d" } },
		].map((o) => JSON.stringify(o));

		expect(validateStreamingStdout(lines)).toEqual([]);
	});

	it("catches unknown streaming stdout types", () => {
		const lines = [
			{ type: "message_end" },
			{ type: "heartbeat" },
			{ type: "message_update", assistantMessageEvent: { type: "image_delta" } },
			{ type: "custom_event" },
		].map((o) => JSON.stringify(o));

		expect(validateStreamingStdout(lines)).toEqual([
			"heartbeat",
			"message_update.image_delta",
			"custom_event",
		]);
	});

	it("ignores non-JSON lines in both validators", () => {
		expect(validateSnapshotJsonl("not json\n")).toEqual([]);
		expect(validateStreamingStdout(["not json"])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 4D. Debug mode tests
// ---------------------------------------------------------------------------

describe("debug mode — end-to-end", () => {
	const debugDir = path.join("/tmp", "tmp", "session-unknown-unknown");

	beforeEach(() => {
		vi.clearAllMocks();
		// Scrub pre-existing scout debug files from session directory to prevent flaky assertions.
		if (fs.existsSync(debugDir)) {
			for (const f of fs.readdirSync(debugDir).filter((f) => f.startsWith("pi-flow-debug-scout-"))) {
				try { fs.unlinkSync(path.join(debugDir, f)); } catch { /* ignore */ }
			}
		}
	});

	afterEach(() => {
		// Scrub any scout debug files left behind.
		if (fs.existsSync(debugDir)) {
			for (const f of fs.readdirSync(debugDir).filter((f) => f.startsWith("pi-flow-debug-scout-"))) {
				try { fs.unlinkSync(path.join(debugDir, f)); } catch { /* ignore */ }
			}
		}
		vi.restoreAllMocks();
	});

	it("writes activation prompt and session snapshot to a temp file when debugMode is enabled", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const snapshotJsonl = '{"type":"session"}\n{"type":"message"}\n';
		const opts: RunFlowOptions = {
			cwd: "/tmp",
			complexity: "moderate",
			flows: [mockFlow],
			flowName: "scout",
			intent: "Test intent",
			aim: "Test aim",
			forkSessionSnapshotJsonl: snapshotJsonl,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			makeDetails,
			debugMode: true,
		};

		const promise = runFlow(opts);
		setTimeout(() => {
			mockProc.stdout.emit(
				"data",
				Buffer.from(
					'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n',
				),
			);
			mockProc.emit("close", 0);
		}, 10);

		await promise;

		const debugFiles = fs.readdirSync(debugDir).filter((f) => f.startsWith("pi-flow-debug-scout-"));
		expect(debugFiles.length).toBe(1);

		const debugPath = path.join(debugDir, debugFiles[0]);
		const content = fs.readFileSync(debugPath, "utf-8");
		expect(content).toContain("## Session Snapshot (JSONL)");
		expect(content).toContain(snapshotJsonl);
		expect(content).toContain("## Activation Prompt (-p)");
		expect(content).toContain("<activation flow=\"scout\"");

		// Cleanup.
		try { fs.unlinkSync(debugPath); } catch { /* ignore */ }
	});

	it("does not write a debug file when debugMode is disabled", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		const beforeFiles = fs.existsSync(debugDir)
			? fs.readdirSync(debugDir).filter((f) => f.startsWith("pi-flow-debug-scout-"))
			: [];

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			complexity: "moderate",
			flows: [mockFlow],
			flowName: "scout",
			intent: "Test intent",
			aim: "Test aim",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			makeDetails,
			debugMode: false,
		};

		const promise = runFlow(opts);
		setTimeout(() => {
			mockProc.stdout.emit(
				"data",
				Buffer.from(
					'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n',
				),
			);
			mockProc.emit("close", 0);
		}, 10);

		await promise;

		const afterFiles = fs.existsSync(debugDir)
			? fs.readdirSync(debugDir).filter((f) => f.startsWith("pi-flow-debug-scout-"))
			: [];
		expect(afterFiles.length).toBe(beforeFiles.length);
	});

	it("uses a unique filename to avoid race conditions under concurrency", async () => {
		const mockProc1 = makeMockProcess();
		const mockProc2 = makeMockProcess();
		let spawnCall = 0;
		vi.mocked(childProcess.spawn).mockImplementation(() => {
			spawnCall++;
			return spawnCall === 1 ? mockProc1 : mockProc2;
		});

		const snapshotJsonl = '{"type":"session"}\n{"type":"message"}\n';
		const opts: RunFlowOptions = {
			cwd: "/tmp",
			complexity: "moderate",
			flows: [mockFlow],
			flowName: "scout",
			intent: "Test intent",
			aim: "Test aim",
			forkSessionSnapshotJsonl: snapshotJsonl,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			makeDetails,
			debugMode: true,
		};

		const promise1 = runFlow(opts);
		const promise2 = runFlow(opts);

		setTimeout(() => {
			mockProc1.stdout.emit(
				"data",
				Buffer.from(
					'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n',
				),
			);
			mockProc1.emit("close", 0);
		}, 10);

		setTimeout(() => {
			mockProc2.stdout.emit(
				"data",
				Buffer.from(
					'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n',
				),
			);
			mockProc2.emit("close", 0);
		}, 15);

		await Promise.all([promise1, promise2]);

		const debugFiles = fs.readdirSync(debugDir).filter((f) => f.startsWith("pi-flow-debug-scout-"));
		expect(debugFiles.length).toBe(2);

		for (const f of debugFiles) {
			const content = fs.readFileSync(path.join(debugDir, f), "utf-8");
			expect(content).toContain("## Session Snapshot (JSONL)");
			expect(content).toContain(snapshotJsonl);
			expect(content).toContain("## Activation Prompt (-p)");
			expect(content).toContain("<activation flow=\"scout\"");
		}

		// Cleanup.
		for (const f of debugFiles) {
			try { fs.unlinkSync(path.join(debugDir, f)); } catch { /* ignore */ }
		}
	});

	it("cleans up stale debug files older than max age", async () => {
		const mockProc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockProc);

		// Create a stale debug file manually in the session directory.
		fs.mkdirSync(debugDir, { recursive: true });
		const staleFile = path.join(debugDir, `pi-flow-debug-scout-0.abc123.txt`);
		fs.writeFileSync(staleFile, "stale", { encoding: "utf-8" });
		// Force mtime to be 8 days ago.
		const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		fs.utimesSync(staleFile, eightDaysAgo, eightDaysAgo);

		const prevMaxAge = process.env.PI_FLOW_DUMP_MAX_AGE_HOURS;
		process.env.PI_FLOW_DUMP_MAX_AGE_HOURS = "168";

		const opts: RunFlowOptions = {
			cwd: "/tmp",
			complexity: "moderate",
			flows: [mockFlow],
			flowName: "scout",
			intent: "Test intent",
			aim: "Test aim",
			forkSessionSnapshotJsonl: null,
			parentDepth: 0,
			parentFlowStack: [],
			maxDepth: 3,
			preventCycles: true,
			makeDetails,
			debugMode: true,
		};

		const promise = runFlow(opts);
		setTimeout(() => {
			mockProc.stdout.emit(
				"data",
				Buffer.from(
					'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n',
				),
			);
			mockProc.emit("close", 0);
		}, 10);

		await promise;
		// runFlow fires cleanupStaleDebugDumps in the background; await it directly
		// to eliminate the race between the assertion and the async cleanup.
		await cleanupStaleDebugDumps(opts.cwd, 168);

		expect(fs.existsSync(staleFile)).toBe(false);

		// Cleanup any newly created debug file.
		if (fs.existsSync(debugDir)) {
			const debugFiles = fs.readdirSync(debugDir).filter((f) => f.startsWith("pi-flow-debug-scout-"));
			for (const f of debugFiles) {
				try { fs.unlinkSync(path.join(debugDir, f)); } catch { /* ignore */ }
			}
		}

		if (prevMaxAge === undefined) delete process.env.PI_FLOW_DUMP_MAX_AGE_HOURS;
		else process.env.PI_FLOW_DUMP_MAX_AGE_HOURS = prevMaxAge;
	});
});
