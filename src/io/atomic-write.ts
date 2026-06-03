/**
 * Atomic file write utilities.
 *
 * Uses tmp file + rename pattern for crash-safe writes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { logWarn } from "../config/log.js";

export function atomicWriteFileSync(targetPath: string, data: string | Buffer, options?: { mode?: number }): void {
	const dir = path.dirname(targetPath);
	fs.mkdirSync(dir, { recursive: true });
	const tmpPath = path.join(dir, `.tmp-${path.basename(targetPath)}.${process.pid}.${Date.now()}`);
	try {
		fs.writeFileSync(tmpPath, data, { encoding: "utf-8", mode: options?.mode ?? 0o600 });
		fs.renameSync(tmpPath, targetPath);
	} catch (err) {
		try { fs.unlinkSync(tmpPath); } catch (e) { logWarn(`[pi-agent-flow] Failed to clean up temp file ${tmpPath}: ${e}`); }
		throw err;
	}
}

export function atomicWriteJsonSync(targetPath: string, data: unknown): void {
	atomicWriteFileSync(targetPath, JSON.stringify(data, null, 2) + "\n");
}

export async function atomicWriteFileAsync(targetPath: string, data: string | Buffer, options?: { mode?: number; shouldAbort?: () => boolean }): Promise<void> {
	const dir = path.dirname(targetPath);
	await fs.promises.mkdir(dir, { recursive: true });
	const tmpPath = path.join(dir, `.tmp-${path.basename(targetPath)}.${process.pid}.${Date.now()}`);
	try {
		await fs.promises.writeFile(tmpPath, data, { encoding: "utf-8", mode: options?.mode ?? 0o600 });
		if (options?.shouldAbort?.()) {
			await fs.promises.unlink(tmpPath).catch(() => {});
			return;
		}
		await fs.promises.rename(tmpPath, targetPath);
	} catch (err) {
		try { await fs.promises.unlink(tmpPath); } catch (e) { logWarn(`[pi-agent-flow] Failed to clean up temp file ${tmpPath}: ${e}`); }
		throw err;
	}
}

export async function atomicWriteJsonAsync(targetPath: string, data: unknown, options?: { shouldAbort?: () => boolean }): Promise<void> {
	await atomicWriteFileAsync(targetPath, JSON.stringify(data, null, 2) + "\n", options);
}
