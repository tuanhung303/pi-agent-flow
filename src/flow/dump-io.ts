/**
 * Dump I/O utilities — extracted from runner.ts.
 *
 * Snapshot dump path generation, TTL cleanup, reminder files,
 * and debug directory resolution.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { logWarn, logError } from "../config/log.js";
import { atomicWriteFileSync } from "../io/atomic-write.js";

export const FLOW_DUMP_SNAPSHOT_ENV = "PI_FLOW_DUMP_SNAPSHOT";
const DEFAULT_DUMP_MAX_AGE_HOURS = 168;

export function resolveDumpMaxAgeHours(): number {
	const raw = process.env.PI_FLOW_DUMP_MAX_AGE_HOURS;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_DUMP_MAX_AGE_HOURS;
}

export function makeUniqueDumpPath(basePath: string, flowName: string): string {
	const ext = path.extname(basePath);
	const base = ext ? basePath.slice(0, -ext.length) : basePath;
	const timestamp = Date.now();
	const safeFlowName = flowName.replace(/[^\w.-]+/g, "_");
	return `${base}.${safeFlowName}.${timestamp}.md`;
}

export function makeUniqueDumpTxtPath(mdPath: string): string {
	return mdPath.replace(/\.md$/, ".txt");
}

function parseSessionSnapshotInfo(jsonl: string | null): { sessionId?: string; firstUserText?: string } {
	const result: { sessionId?: string; firstUserText?: string } = {};
	if (!jsonl) return result;
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as Record<string, unknown>;
			if (entry.type === "session" && entry.id && typeof entry.id === "string") {
				result.sessionId = entry.id;
			}
			if (
				entry.type === "message" &&
				entry.message &&
				typeof entry.message === "object" &&
				!result.firstUserText
			) {
				const msg = entry.message as Record<string, unknown>;
				if (msg.role === "user" && msg.content) {
					let text = "";
					if (typeof msg.content === "string") {
						text = msg.content;
					} else if (Array.isArray(msg.content)) {
						const firstText = msg.content.find(
							(c: unknown) =>
								c && typeof c === "object" && (c as Record<string, unknown>).type === "text",
						) as Record<string, unknown> | undefined;
						text = typeof firstText?.text === "string" ? firstText.text : "";
					}
					if (text.trim()) {
						result.firstUserText = text.trim();
					}
				}
			}
		} catch (e) {
			logWarn(`[pi-agent-flow] Failed to parse JSON line in session snapshot: ${e}`);
		}
	}
	return result;
}

function sanitizeForFilesystem(text: string, maxLength: number): string {
	const safe = text
		.slice(0, maxLength)
		.replace(/[^a-zA-Z0-9_-]/g, "_")
		.replace(/^_+|_+$/g, "");
	return safe || "unknown";
}

export function getDebugDir(cwd: string, jsonl: string | null): string {
	const { sessionId, firstUserText } = parseSessionSnapshotInfo(jsonl);
	const safeText = sanitizeForFilesystem(firstUserText ?? "", 20);
	const idShort = sanitizeForFilesystem((sessionId ?? "unknown").slice(0, 8), 8);
	return path.join(cwd, "tmp", `session-${safeText}-${idShort}`);
}

export async function cleanupStaleDumps(dumpPath: string, maxAgeHours = DEFAULT_DUMP_MAX_AGE_HOURS): Promise<void> {
	// Fix P5: Convert sync fs operations to async to avoid blocking the event loop
	try {
		const dir = path.dirname(dumpPath);
		const baseName = path.basename(dumpPath);
		const ext = path.extname(baseName);
		const base = ext ? baseName.slice(0, -ext.length) : baseName;
		const entries = await fsp.readdir(dir);
		const nowMs = Date.now();
		const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
		let deleted = 0;
		for (const entry of entries) {
			const isLegacyDump = entry.startsWith("snapshot-dump");
			if (!entry.startsWith(base) && !isLegacyDump) continue;
			const entryPath = path.join(dir, entry);
			try {
				const stats = await fsp.stat(entryPath);
				if (nowMs - stats.mtimeMs > maxAgeMs) {
					await fsp.unlink(entryPath);
					deleted++;
				}
			} catch (e) { logWarn(`[pi-agent-flow] Failed to delete stale dump ${entryPath}: ${e}`); }
		}
		if (deleted > 0) {
			logError(`[pi-agent-flow] Cleaned ${deleted} stale dump file(s) from ${dir}`);
		}
	} catch (err) {
		logWarn(`[pi-agent-flow] cleanupStaleDumps failed: ${err}`);
	}
}

export async function cleanupStaleDebugDumps(cwd: string, maxAgeHours = DEFAULT_DUMP_MAX_AGE_HOURS): Promise<void> {
	// Fix P5: Convert sync fs operations to async to avoid blocking the event loop
	try {
		const baseDir = path.join(cwd, "tmp");
		if (!fs.existsSync(baseDir)) return;
		const entries = await fsp.readdir(baseDir);
		const nowMs = Date.now();
		const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
		let deleted = 0;
		for (const entry of entries) {
			if (!entry.startsWith("session-")) continue;
			const sessionDir = path.join(baseDir, entry);
			try {
				const stat = await fsp.stat(sessionDir);
				if (!stat.isDirectory()) continue;
				const files = await fsp.readdir(sessionDir);
				for (const file of files) {
					const filePath = path.join(sessionDir, file);
					try {
						const stats = await fsp.stat(filePath);
						if (nowMs - stats.mtimeMs > maxAgeMs) {
							await fsp.unlink(filePath);
							deleted++;
						}
					} catch (e) { logWarn(`[pi-agent-flow] Failed to delete stale debug file ${filePath}: ${e}`); }
				}
				const remaining = await fsp.readdir(sessionDir);
				if (remaining.length === 0) {
					await fsp.rmdir(sessionDir);
				}
			} catch (e) { logWarn(`[pi-agent-flow] Failed to clean stale debug dir ${sessionDir}: ${e}`); }
		}
		if (deleted > 0) {
			logWarn(`[pi-agent-flow] Cleaned ${deleted} stale debug file(s) from ${baseDir}`);
		}
	} catch (err) {
		logWarn(`[pi-agent-flow] cleanupStaleDebugDumps failed: ${err}`);
	}
}

export function writeReminderFile(reminderFilePath: string | null, message: string): void {
	if (!reminderFilePath) return;
	try {
		fs.writeFileSync(reminderFilePath, message + "\n", { encoding: "utf-8", flag: "a" });
	} catch (err) {
		logWarn(`[pi-agent-flow] Failed to write reminder file: ${err}`);
	}
}
