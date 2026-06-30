import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return { ...actual, spawn: vi.fn() };
});

import extDefault from "../src/index.js";

const SESSION =
	process.env.PI_REPRO_SESSION ||
	"/Users/__blitzzz/.pi/agent/sessions/--Users-__blitzzz-Documents-GitHub-pi-agent-flow--/2026-06-19T03-30-34-480Z_019eddee-2d70-71a0-9a21-cdc21b692771.jsonl";

function loadSession(p: string) {
	return fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => {
		try { return JSON.parse(l); } catch { return null; }
	}).filter(Boolean);
}

function createDefaultSession(): unknown[] {
	return [
		{
			type: "session",
			version: 1,
			id: "repro-session-id",
			model: "default",
			createdAt: new Date().toISOString(),
		},
		{
			type: "message",
			message: {
				role: "user",
				content: [{ type: "text", text: "map files" }],
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "I'll map the files for you." }],
			},
		},
	];
}

function loadSessionForRepro(p: string): unknown[] {
	if (fs.existsSync(p)) {
		return loadSession(p);
	}
	return createDefaultSession();
}

function makeMockProcess() {
	const proc = new EventEmitter() as any;
	proc.stdin = new EventEmitter();
	proc.stdin.end = vi.fn();
	proc.stdin.write = vi.fn();
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.pid = 4242;
	proc.kill = vi.fn();
	proc.unref = vi.fn();
	return proc;
}

function makeFakePi(cwd: string, entries: unknown[]) {
	const handlers = new Map<string, ((...a: any[]) => any)[]>();
	const tools = new Map<string, any>();
	const flags = new Map<string, unknown>();
	const sessionManager = {
		getHeader: () => entries.find((e) => e.type === "session") ?? { version: 1, id: "s", cwd },
		getBranch: () => entries,
		getSessionDir: () => cwd,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionId: () => "repro-session-id",
		appendMessage: () => "id",
		appendSessionInfo: () => "id",
		appendCustomEntry: () => "id",
	};
	const ctx: ExtensionContext = {
		cwd, hasUI: false,
		ui: { confirm: async () => true, select: async () => null, input: async () => null,
			custom: async () => undefined, editor: async () => undefined, setEditorText: () => {}, notify: () => {} },
		sessionManager: sessionManager as any,
		isIdle: () => false, model: undefined,
	} as any;
	const api: ExtensionAPI = {
		on: (e, cb) => { const l = handlers.get(e) ?? []; l.push(cb); handlers.set(e, l); },
		emit: () => {}, registerTool: (t) => { tools.set(t.name, t); }, registerCommand: () => {},
		registerFlag: (n, o) => { if (o && (o as any).default !== undefined) flags.set(n, (o as any).default); },
		registerShortcut: () => {}, registerMessageRenderer: () => {},
		getFlag: (n) => flags.get(n), setActiveTools: () => {}, getActiveTools: () => [], getAllTools: () => [],
		sendMessage: () => {}, sendUserMessage: () => {}, appendEntry: () => {},
		setSessionName: () => {}, getSessionName: () => undefined,
	} as any;
	const fire = async (event: string, ...args: any[]) => { for (const h of handlers.get(event) ?? []) await h(...args); };
	return { api, ctx, tools, fire };
}

describe("repro flow execute", () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(() => vi.restoreAllMocks());

	it("bare scout (no dispatch) does not throw 'length'", async () => {
		const cwd = process.cwd();
		const entries = loadSessionForRepro(SESSION);
		const { api, ctx, tools, fire } = makeFakePi(cwd, entries);
		extDefault(api as any);
		await fire("session_start", { type: "session_start" }, ctx);

		const flowTool = tools.get("flow");
		expect(flowTool).toBeTruthy();

		const rawParams = { flow: [{ type: "scout", intent: "map files", aim: "Map files", concern: "none", complexity: "simple" }] };
		const params = flowTool.prepareArguments ? flowTool.prepareArguments(rawParams) : rawParams;

		const proc = makeMockProcess();
		vi.mocked(childProcess.spawn).mockImplementation((() => {
			// Emit completion AFTER listeners attach.
			setTimeout(() => {
				proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }) + "\n"));
				proc.emit("close", 0);
			}, 50);
			return proc;
		}) as any);

		const ac = new AbortController();
		const timeout = setTimeout(() => ac.abort(), 15000);
		let err: any;
		try {
			console.log("[repro] calling flow.execute (bare scout)...");
			await flowTool.execute("tc-1", params, ac.signal, () => {}, ctx);
			console.log("[repro] execute returned without throwing");
		} catch (e) {
			err = e;
			console.log("[repro] THREW:", e?.message);
			console.log(e?.stack?.split("\n").slice(0, 12).join("\n"));
		}
		clearTimeout(timeout);
		expect(err).toBeUndefined();
	}, 30000);
});
