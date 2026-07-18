/**
 * Settings command handler logic — extracted from settings-command.ts.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadFlowSettings, writeFlowSetting, loadFlowModelConfigs, writeGlobalFlowMode, writeFlowModelConfig } from "../config/config.js";
import { logWarn } from "../config/log.js";
import { getLoop } from "./loop.js";
import type { SettingsCategory } from "./settings-items.js";

export function getCategoryHandler(
	category: SettingsCategory,
	cwd: string,
	rebuild: () => void,
	tui: any,
	ctx: ExtensionCommandContext,
): (id: string, value: string) => void {
	switch (category) {
		case "steering": {
			return (id, value) => {
				if (id === "steering.enabled") {
					writeFlowSetting(cwd, "steering.enabled", value === "on");
				} else if (id === "steering.customPrompt") {
					if (value === "(default)") {
						writeFlowSetting(cwd, "steering.customPrompt", undefined);
					} else {
						writeFlowSetting(cwd, "steering.customPrompt", value);
					}
				}
				rebuild();
				tui.requestRender();
			};
		}
		case "animation": {
			return (id, value) => {
				if (id === "animation.enabled") {
					writeFlowSetting(cwd, "animation.enabled", value === "on");
				} else if (id === "animation.glitch") {
					writeFlowSetting(cwd, "animation.glitch", value === "on");
				}
				rebuild();
				tui.requestRender();
			};
		}
		case "tools": {
			return (id, value) => {
				if (id === "toolOptimize") {
					writeFlowSetting(cwd, "toolOptimize", value === "on");
				} else if (id === "structuredOutput") {
					writeFlowSetting(cwd, "structuredOutput", value === "on");
				} else if (id === "tools.trace") {
					writeFlowSetting(cwd, "tools.trace", value === "on");
				} else if (id === "tools.batchRead") {
					writeFlowSetting(cwd, "tools.batchRead", value === "on");
				}
				rebuild();
				tui.requestRender();
			};
		}
		case "session": {
			return (id, value) => {
				if (id === "bodyVerbosity") {
					writeFlowSetting(cwd, "bodyVerbosity", value);
				} else if (id === "complexity") {
					writeFlowSetting(cwd, "complexity", value);
				} else if (id === "maxConcurrency") {
					writeFlowSetting(cwd, "maxConcurrency", Number(value));
				}
				rebuild();
				tui.requestRender();
			};
		}
		case "ask-user": {
			return (id, value) => {
				if (id === "askUser.enabled") {
					writeFlowSetting(cwd, "askUser.enabled", value === "on");
				} else if (id === "askUser.timeout") {
					writeFlowSetting(cwd, "askUser.timeout", Number(value));
				}
				rebuild();
				tui.requestRender();
			};
		}
		case "model-config": {
			return (id, value) => {
				if (id === "modelConfig.strategy") {
					try {
						writeGlobalFlowMode(value);
					} catch (e) {
						logWarn(`[pi-agent-flow] writeGlobalFlowMode failed in settings UI: ${e}`);
					}
				} else if (id.startsWith("modelConfig.")) {
					const match = id.match(/^modelConfig\.(lite|flash|full)\.(primary|failover)$/);
					if (match) {
						const tier = match[1] as "lite" | "flash" | "full";
						const slot = match[2] as "primary" | "failover";
						const loaded = loadFlowModelConfigs(cwd);
						const strategyName = loaded.selectedName;
						if (slot === "primary") {
							if (value === "(default)") {
								writeFlowModelConfig(cwd, strategyName, tier, { primary: null, failover: null });
							} else {
								writeFlowModelConfig(cwd, strategyName, tier, { primary: value });
							}
						} else {
							if (value === "(default)") {
								writeFlowModelConfig(cwd, strategyName, tier, { failover: [] });
							} else {
								writeFlowModelConfig(cwd, strategyName, tier, { failover: [value] });
							}
						}
					}
				}
				rebuild();
				tui.requestRender();
			};
		}
		case "loop": {
			return () => {};
		}
		case "debug": {
			return (id, value) => {
				if (id === "debugMode") {
					writeFlowSetting(cwd, "debugMode", value === "on");
				}
				rebuild();
				tui.requestRender();
			};
		}
		case "compression": {
			return (id, value) => {
				if (id === "contextCompression") {
					writeFlowSetting(cwd, "contextCompression", value);
				}
				rebuild();
				tui.requestRender();
			};
		}
		default: {
			return () => {};
		}
	}
}

export async function handleTextCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.ui) return;
	const cwd = ctx.cwd;
	const trimmed = args.trim().toLowerCase();
	const parts = trimmed.split(/\s+/);
	const sub = parts[0] ?? "";
	const value = parts[1] ?? "";

	const parseOnOff = (v: string): boolean | null => {
		if (v === "on" || v === "true" || v === "1") return true;
		if (v === "off" || v === "false" || v === "0") return false;
		return null;
	};

	switch (sub) {
		case "steering": {
			const parsed = parseOnOff(value);
			if (parsed === null) {
				ctx.ui.notify?.("Usage: /flow:settings steering <on|off>", "error");
				return;
			}
			writeFlowSetting(cwd, "steering.enabled", parsed);
			ctx.ui.notify?.(`steering.enabled = ${parsed}`, "info");
			break;
		}
		case "animation": {
			const parsed = parseOnOff(value);
			if (parsed === null) {
				ctx.ui.notify?.("Usage: /flow:settings animation <on|off>", "error");
				return;
			}
			writeFlowSetting(cwd, "animation.enabled", parsed);
			ctx.ui.notify?.(`animation.enabled = ${parsed}`, "info");
			break;
		}
		case "glitch": {
			const parsed = parseOnOff(value);
			if (parsed === null) {
				ctx.ui.notify?.("Usage: /flow:settings glitch <on|off>", "error");
				return;
			}
			writeFlowSetting(cwd, "animation.glitch", parsed);
			ctx.ui.notify?.(`animation.glitch = ${parsed}`, "info");
			break;
		}
		case "tool-optimize": {
			const parsed = parseOnOff(value);
			if (parsed === null) {
				ctx.ui.notify?.("Usage: /flow:settings tool-optimize <on|off>", "error");
				return;
			}
			writeFlowSetting(cwd, "toolOptimize", parsed);
			ctx.ui.notify?.(`toolOptimize = ${parsed}`, "info");
			break;
		}
		case "structured-output": {
			const parsed = parseOnOff(value);
			if (parsed === null) {
				ctx.ui.notify?.("Usage: /flow:settings structured-output <on|off>", "error");
				return;
			}
			writeFlowSetting(cwd, "structuredOutput", parsed);
			ctx.ui.notify?.(`structuredOutput = ${parsed}`, "info");
			break;
		}
		case "trace": {
			const parsed = parseOnOff(value);
			if (parsed === null) {
				ctx.ui.notify?.("Usage: /flow:settings trace <on|off>", "error");
				return;
			}
			writeFlowSetting(cwd, "tools.trace", parsed);
			ctx.ui.notify?.(`tools.trace = ${parsed}`, "info");
			break;
		}
		case "batch-read": {
			const parsed = parseOnOff(value);
			if (parsed === null) {
				ctx.ui.notify?.("Usage: /flow:settings batch-read <on|off>", "error");
				return;
			}
			writeFlowSetting(cwd, "tools.batchRead", parsed);
			ctx.ui.notify?.(`tools.batchRead = ${parsed}`, "info");
			break;
		}
		case "body": {
			if (value === "lite" || value === "full") {
				writeFlowSetting(cwd, "bodyVerbosity", value);
				ctx.ui.notify?.(`bodyVerbosity = ${value}`, "info");
			} else {
				ctx.ui.notify?.("Usage: /flow:settings body <lite|full>", "error");
			}
			break;
		}
		case "debug":
		case "emit-flow-content": {
			const parsed = parseOnOff(value);
			if (parsed === null) {
				ctx.ui.notify?.("Usage: /flow:settings debug <on|off>", "error");
				return;
			}
			writeFlowSetting(cwd, "debugMode", parsed);
			ctx.ui.notify?.(`debugMode = ${parsed}`, "info");
			break;
		}
		case "complexity": {
			const validModes = ["snap", "simple", "moderate", "complex", "intricate"] as const;
			if (!validModes.includes(value as any)) {
				ctx.ui.notify?.(
					"Usage: /flow:settings complexity <snap|simple|moderate|complex|intricate>",
					"error",
				);
				return;
			}
			writeFlowSetting(cwd, "complexity", value);
			ctx.ui.notify?.(`complexity = ${value}`, "info");
			break;
		}
		case "max-concurrency": {
			const n = Number(value);
			if (!Number.isSafeInteger(n) || n < 1) {
				ctx.ui.notify?.("Usage: /flow:settings max-concurrency <n>", "error");
				return;
			}
			writeFlowSetting(cwd, "maxConcurrency", n);
			ctx.ui.notify?.(`maxConcurrency = ${n}`, "info");
			break;
		}
		case "ask-user": {
			const askParts = trimmed.split(/\s+/);
			const askSub = askParts[1] ?? "";
			const askValue = askParts[2] ?? "";
			if (askSub === "enabled") {
				const parsed = parseOnOff(askValue);
				if (parsed === null) {
					ctx.ui.notify?.("Usage: /flow:settings ask-user enabled <on|off>", "error");
					return;
				}
				writeFlowSetting(cwd, "askUser.enabled", parsed);
				ctx.ui.notify?.(`askUser.enabled = ${parsed}`, "info");
			} else if (askSub === "timeout") {
				const n = Number(askValue);
				if (!Number.isSafeInteger(n) || n < 10) {
					ctx.ui.notify?.("Usage: /flow:settings ask-user timeout <seconds>", "error");
					return;
				}
				writeFlowSetting(cwd, "askUser.timeout", n);
				ctx.ui.notify?.(`askUser.timeout = ${n}`, "info");
			} else {
				ctx.ui.notify?.("Usage: /flow:settings ask-user {enabled <on|off> | timeout <seconds>}", "error");
			}
			break;
		}
		case "context-compression": {
			const validModes = ["auto", "light", "medium", "aggressive"] as const;
			if (!validModes.includes(value as any)) {
				ctx.ui.notify?.("Usage: /flow:settings context-compression <auto|light|medium|aggressive>", "error");
				return;
			}
			writeFlowSetting(cwd, "contextCompression", value);
			ctx.ui.notify?.(`contextCompression = ${value}`, "info");
			break;
		}
		case "reset": {
			writeFlowSetting(cwd, "", {});
			ctx.ui.notify?.("Flow settings reset to defaults", "info");
			break;
		}
		case "show": {	
			const currentSettings = loadFlowSettings(cwd);
			const loop = getLoop(cwd);
			const lines = [
				`bodyVerbosity: ${currentSettings.bodyVerbosity ?? "lite"}`,
				`toolOptimize: ${currentSettings.toolOptimize ?? true}`,
				`structuredOutput: ${currentSettings.structuredOutput ?? true}`,
				`complexity: ${currentSettings.complexity ?? "moderate"}`,
				`maxConcurrency: ${currentSettings.maxConcurrency ?? 4}`,
				`contextCompression: ${currentSettings.contextCompression ?? "auto"}`,
				`steering.enabled: ${currentSettings.steering?.enabled ?? true}`,
				`animation.enabled: ${currentSettings.animation?.enabled ?? true}`,
				`animation.glitch: ${currentSettings.animation?.glitch ?? true}`,
				`askUser.enabled: ${currentSettings.askUser?.enabled ?? false}`,
				`askUser.timeout: ${currentSettings.askUser?.timeout ?? 300}`,
				`debugMode: ${currentSettings.debugMode ?? false}`,
				`tools.trace: ${currentSettings.tools?.trace ?? true}`,
				`tools.batchRead: ${currentSettings.tools?.batchRead ?? currentSettings.toolOptimize ?? true}`,
			];
			if (loop) {
				lines.push("");
				lines.push(`loop.status: ${loop.status}`);
				lines.push(`loop.objective: ${loop.objective}`);
				lines.push(`loop.sessions: ${loop.sessionCount}`);
				lines.push(`loop.flows: ${loop.totalFlowsAcrossSessions}`);
				lines.push(`loop.tokens: ${loop.totalTokensAcrossSessions}`);
				if (loop.terminationReason) lines.push(`loop.terminationReason: ${loop.terminationReason}`);
			}
			ctx.ui.notify?.(lines.join("\n"), "info");
			break;
		}
		default: {
			ctx.ui.notify?.(
				"Unknown subcommand. Usage: /flow:settings {steering|animation|glitch|tool-optimize|structured-output|body|complexity|context-compression|max-concurrency|ask-user|debug|trace|batch-read|reset|show}",
				"error",
			);
		}
	}
}
