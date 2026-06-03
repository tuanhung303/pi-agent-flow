import { vi } from "vitest";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Create a mock ChildProcess with EventEmitter behavior, mock stdio streams,
 * and vi.fn()-based kill().
 */
export function makeMockProcess(pid = 12345): ChildProcess {
	const proc = new EventEmitter() as ChildProcess;

	// Writable stubs that extend EventEmitter so they can emit data/close
	const stdin = new Writable({ write() {} });
	const stdout = new Writable({ write() {} });
	const stderr = new Writable({ write() {} });

	// @ts-ignore — attach streams to mock process
	proc.stdin = stdin;
	// @ts-ignore
	proc.stdout = stdout;
	// @ts-ignore
	proc.stderr = stderr;
	// @ts-ignore
	proc.pid = pid;
	// @ts-ignore
	proc.kill = vi.fn<ChildProcess["kill"]>(() => true);
	// @ts-ignore
	proc.connected = false;
	// @ts-ignore
	proc.exitCode = null;
	// @ts-ignore
	proc.signalCode = null;

	return proc;
}

/**
 * Create a mock ExtensionAPI with real event registration and vi.fn()
 * for all other methods.
 */
export function makeMockPi(): ExtensionAPI & {
	trigger: (event: string, ...args: any[]) => Promise<any[]>;
	getTool: (name: string) => any;
	getHandlers: (event: string) => Function[];
} {
	const handlers: Record<string, Function[]> = {};
	const tools: any[] = [];

	const pi = {
		registerFlag: vi.fn(),
		getFlag: vi.fn(),
		getActiveTools: vi.fn(() => []),
		on: vi.fn((event: string, callback: (...args: any[]) => any) => {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(callback);
		}),
		emit: vi.fn((event: string, ...args: any[]) => {
			if (handlers[event]) {
				for (const h of handlers[event]) {
					h(...args);
				}
			}
		}),
		registerTool: vi.fn((tool: any) => {
			tools.push(tool);
		}),
		setActiveTools: vi.fn(),
		registerCommand: vi.fn(),
		sendUserMessage: vi.fn(),
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		setSessionName: vi.fn(),
		getSessionName: vi.fn(),
		trigger: (event: string, ...args: any[]) =>
			Promise.all((handlers[event] || []).map((h) => h(...args))),
		getTool: (name: string) => tools.find((t) => t.name === name),
		getHandlers: (event: string) => handlers[event] || [],
	} as unknown as ExtensionAPI & {
		trigger: (event: string, ...args: any[]) => Promise<any[]>;
		getTool: (name: string) => any;
		getHandlers: (event: string) => Function[];
	};

	return pi;
}

/**
 * Trigger global.gc() if available, then wait 50 ms.
 */
export async function forceGC(): Promise<void> {
	if (typeof global.gc === "function") {
		global.gc();
	}
	await new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * Return a snapshot of a Map's current size.
 */
export function trackMapSize(map: Map<unknown, unknown>): { size: number } {
	return { size: map.size };
}

/**
 * Create a temporary directory, run the callback, then clean up.
 */
export async function withTmpDir<T>(
	prefix: string,
	fn: (dir: string) => Promise<T>,
): Promise<T> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		return await fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
