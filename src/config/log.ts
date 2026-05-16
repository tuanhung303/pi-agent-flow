/**
 * TUI-safe logging for pi-agent-flow.
 *
 * During flow execution, the TUI redraws the entire screen on every frame.
 * Any console.warn/console.error output to stderr briefly flashes on-screen
 * before being overwritten, causing the "text appears then disappears" glitch.
 *
 * This module provides a `logWarn` / `logError` pair that:
 *   - Writes to a file when the TUI is active (env PI_TUI_MODE=1 or when
 *     the process is a child flow at depth > 0).
 *   - Falls back to console.warn/console.error when not in a TUI context
 *     (e.g. test runners, direct CLI invocations).
 *
 * The log file path is `PI_FLOW_LOG_FILE` or `${TMPDIR}/pi-agent-flow.log`
 * by default. Set `PI_FLOW_LOG_FILE=/dev/null` to suppress entirely.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TUI_MODE_ENV = "PI_TUI_MODE";
const LOG_FILE_ENV = "PI_FLOW_LOG_FILE";


function getLogFilePath(): string {
	const env = process.env[LOG_FILE_ENV];
	if (env) return env;
	return path.join(os.tmpdir(), "pi-agent-flow.log");
}

/**
 * Determine whether the process is running inside a TUI that would be
 * disrupted by stderr output. We consider it TUI-active when:
 *   1. The PI_TUI_MODE env var is set to "1"
 *   2. OR the process is a child flow (depth > 0) — child flows always run
 *      under the parent's TUI, so stderr would flash.
 *   3. OR stdout is a TTY (heuristic — terminal apps usually are TUIs).
 */
function isTuiActive(): boolean {
	const envMode = process.env[TUI_MODE_ENV];
	if (envMode === "1" || envMode === "true") return true;

	const flowDepth = process.env.PI_FLOW_DEPTH;
	if (flowDepth && parseInt(flowDepth, 10) > 0) return true;

	if (process.stdout.isTTY) return true;

	return false;
}

// Cache the TUI check and log path for the process lifetime
let _isTui: boolean | undefined;
let _logPath: string | undefined;

function initLogging(): void {
	_isTui = isTuiActive();
	if (_logPath === undefined) {
		_logPath = getLogFilePath();
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Log a warning message. When TUI is active, writes to the log file
 * instead of stderr to avoid on-screen flashing.
 */
export function logWarn(message: string): void {
	initLogging();
	if (_isTui) {
		writeToLogFile("WARN", message);
	} else {
		console.warn(message);
	}
}

/**
 * Log an error message. When TUI is active, writes to the log file
 * instead of stderr to avoid on-screen flashing.
 */
export function logError(message: string): void {
	initLogging();
	if (_isTui) {
		writeToLogFile("ERROR", message);
	} else {
		console.error(message);
	}
}

// ---------------------------------------------------------------------------
// File writer
// ---------------------------------------------------------------------------

function writeToLogFile(level: string, message: string): void {
	if (!_logPath || _logPath === "/dev/null") return;
	try {
		const ts = new Date().toISOString();
		const line = `[${ts}] [${level}] ${message}\n`;
		fs.appendFileSync(_logPath, line, { encoding: "utf-8" });
	} catch {
		// Best-effort: if we can't write to the log, silently drop it.
		// Do NOT fall back to console.error — that would re-introduce the flash.
	}
}
