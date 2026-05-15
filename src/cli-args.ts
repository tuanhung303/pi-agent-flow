/**
 * Helpers for inheriting selected parent CLI flags in child flow processes.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseAgentSessionMode, type AgentSessionMode } from "./session-mode.js";

function looksLikeExplicitRelativePath(value: string): boolean {
	return (
		value.startsWith("./") ||
		value.startsWith("../") ||
		value.startsWith(".\\") ||
		value.startsWith("..\\")
	);
}

interface ResolvePathOptions {
	allowPackageSource?: boolean;
	alwaysResolveRelative?: boolean;
}

function resolvePathArg(value: string, options: ResolvePathOptions = {}): string {
	const { allowPackageSource = false, alwaysResolveRelative = false } = options;
	if (!value) return value;
	if (allowPackageSource && (value.startsWith("npm:") || value.startsWith("git:"))) return value;
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	if (path.isAbsolute(value)) return value;

	const resolved = path.resolve(process.cwd(), value);
	if (
		alwaysResolveRelative ||
		looksLikeExplicitRelativePath(value) ||
		path.extname(value) !== "" ||
		fs.existsSync(resolved)
	) {
		return resolved;
	}
	return value;
}

export interface ParsedFlowCliArgs {
	extensionArgs: string[];
	alwaysProxy: string[];
	fallbackModel?: string;
	fallbackThinking?: string;
	fallbackTools?: string;
	fallbackNoTools: boolean;
	flowModelConfig?: string;
	flowMode?: string;
	flowSessionMode?: AgentSessionMode;
	tieredModels: {
		lite?: string;
		flash?: string;
		full?: string;
	};
	dumpPath?: string;
}

/**
 * Parse process.argv into groups used for child flow invocations.
 *
 * - extensionArgs: forwarded with path resolution
 * - alwaysProxy: forwarded verbatim to every child
 * - fallbackModel / fallbackTools: used when the flow file does not set them
 * - fallbackThinking: parsed from argv; not forwarded to child flows (see flow.ts)
 */
let _cachedArgs: ParsedFlowCliArgs | undefined;

/**
 * Lazily parse process.argv once and cache the result.
 * Avoids module-level side effects at import time.
 */
export function getInheritedCliArgs(): ParsedFlowCliArgs {
	if (!_cachedArgs) _cachedArgs = parseFlowCliArgs(process.argv);
	return _cachedArgs;
}

export function parseFlowCliArgs(argv: string[]): ParsedFlowCliArgs {
	const extensionArgs: string[] = [];
	const alwaysProxy: string[] = [];
	let fallbackModel: string | undefined;
	let fallbackThinking: string | undefined;
	let fallbackTools: string | undefined;
	let fallbackNoTools = false;
	let flowModelConfig: string | undefined;
	let flowMode: string | undefined;
	let flowSessionMode: AgentSessionMode | undefined;
	let tieredLiteModel: string | undefined;
	let tieredFlashModel: string | undefined;
	let tieredFullModel: string | undefined;
	let dumpPath: string | undefined;

	let i = 2; // skip executable + script name
	while (i < argv.length) {
		const raw = argv[i];
		if (!raw.startsWith("-")) {
			i++;
			continue;
		}

		const eqIdx = raw.indexOf("=");
		const flagName = eqIdx !== -1 ? raw.slice(0, eqIdx) : raw;
		const inlineValue = eqIdx !== -1 ? raw.slice(eqIdx + 1) : undefined;

		const nextToken = argv[i + 1];
		const nextIsValue = nextToken !== undefined && !nextToken.startsWith("-");

		const getValue = (): [string | undefined, number] => {
			if (inlineValue !== undefined) return [inlineValue, 1];
			if (nextIsValue) return [nextToken, 2];
			return [undefined, 1];
		};

		if (flagName === "--flow-model-config") {
			const [value, skip] = getValue();
			if (value !== undefined) flowModelConfig = value;
			i += skip;
			continue;
		}

		if (flagName === "--flow-mode") {
			const [value, skip] = getValue();
			if (value !== undefined) flowMode = value;
			i += skip;
			continue;
		}

		if (flagName === "--flow-session-mode") {
			const [value, skip] = getValue();
			flowSessionMode = parseAgentSessionMode(value);
			i += skip;
			continue;
		}

		if (
			[
				"--mode",
				"--session",
				"--append-system-prompt",
				"--export",
				"--flow-max-depth",
			].includes(flagName)
		) {
			const [, skip] = getValue();
			i += skip;
			continue;
		}

		if (["--flow-prevent-cycles", "--list-models"].includes(flagName)) {
			const [, skip] = getValue();
			i += skip;
			continue;
		}

		if (
			[
				"--print",
				"-p",
				"--no-session",
				"--continue",
				"-c",
				"--resume",
				"-r",
				"--offline",
				"--help",
				"-h",
				"--version",
				"-v",
				"--no-flow-prevent-cycles",
			].includes(flagName)
		) {
			i++;
			continue;
		}

		if (flagName === "--no-extensions" || flagName === "-ne") {
			extensionArgs.push(flagName);
			i++;
			continue;
		}

		if (flagName === "--extension" || flagName === "-e") {
			const [value, skip] = getValue();
			if (value !== undefined) {
				extensionArgs.push(flagName, resolvePathArg(value, { allowPackageSource: true }));
			}
			i += skip;
			continue;
		}

		if (["--skill", "--prompt-template", "--theme"].includes(flagName)) {
			const [value, skip] = getValue();
			if (value !== undefined) alwaysProxy.push(flagName, resolvePathArg(value));
			i += skip;
			continue;
		}

		if (flagName === "--session-dir") {
			const [value, skip] = getValue();
			if (value !== undefined) {
				alwaysProxy.push(flagName, resolvePathArg(value, { alwaysResolveRelative: true }));
			}
			i += skip;
			continue;
		}

		if (
			[
				"--provider",
				"--api-key",
				"--system-prompt",
				"--models",
			].includes(flagName)
		) {
			const [value, skip] = getValue();
			if (value !== undefined) alwaysProxy.push(flagName, value);
			i += skip;
			continue;
		}

		if (
			[
				"--no-skills",
				"-ns",
				"--no-prompt-templates",
				"-np",
				"--no-themes",
				"--verbose",
			].includes(flagName)
		) {
			alwaysProxy.push(flagName);
			i++;
			continue;
		}

		if (flagName === "--model") {
			const [value, skip] = getValue();
			if (value !== undefined) fallbackModel = value;
			i += skip;
			continue;
		}

		if (flagName === "--thinking") {
			const [value, skip] = getValue();
			if (value !== undefined) fallbackThinking = value;
			i += skip;
			continue;
		}

		if (flagName === "--tools") {
			const [value, skip] = getValue();
			if (value !== undefined) fallbackTools = value;
			i += skip;
			continue;
		}

		if (flagName === "--no-tools") {
			fallbackNoTools = true;
			i++;
			continue;
		}

		if (flagName === "--flow-lite-model") {
			const [value, skip] = getValue();
			if (value !== undefined) tieredLiteModel = value;
			i += skip;
			continue;
		}

		if (flagName === "--flow-flash-model") {
			const [value, skip] = getValue();
			if (value !== undefined) tieredFlashModel = value;
			i += skip;
			continue;
		}

		if (flagName === "--flow-full-model") {
			const [value, skip] = getValue();
			if (value !== undefined) tieredFullModel = value;
			i += skip;
			continue;
		}

		if (flagName === "--dump") {
			const [value, skip] = getValue();
			if (value !== undefined) dumpPath = value;
			i += skip;
			continue;
		}

		if (inlineValue !== undefined) {
			alwaysProxy.push(flagName, inlineValue);
			i++;
			continue;
		}

		if (nextIsValue) {
			alwaysProxy.push(flagName, nextToken);
			i += 2;
			continue;
		}

		alwaysProxy.push(flagName);
		i++;
	}

	return {
		extensionArgs,
		alwaysProxy,
		fallbackModel,
		fallbackThinking,
		fallbackTools,
		fallbackNoTools,
		flowModelConfig,
		flowMode,
		flowSessionMode,
		tieredModels: {
			lite: tieredLiteModel,
			flash: tieredFlashModel,
			full: tieredFullModel,
		},
		dumpPath,
	};
}
