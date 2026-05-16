/**
 * /flow:settings slash command registration.
 *
 * Subcommands: steering, strategic-hint, animation, glitch,
 * tool-optimize, structured-output, session-mode, max-concurrency, reset
 *
 * When called with no arguments, opens an interactive TUI overlay.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { loadFlowSettings, writeFlowSetting, type FlowSettings } from "../config.js";
import { configureSteering } from "../sliding-prompt.js";
import { configureStrategicHint } from "../tool-utils.js";
import { scrambleManager } from "../scramble.js";
import {
	Container,
	type Component,
	Input,
	type KeybindingsManager,
	matchesKey,
	SelectList,
	type SelectItem,
	Key,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// SettingsList component (local implementation matching sub-core pattern)
// ---------------------------------------------------------------------------

export interface SettingItem {
	id: string;
	label: string;
	description?: string;
	currentValue: string;
	values?: string[];
	submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
	editable?: boolean;
}

export interface SettingsListTheme {
	label: (text: string, selected: boolean) => string;
	value: (text: string, selected: boolean) => string;
	description: (text: string) => string;
	cursor: string;
	hint: (text: string) => string;
}

export class SettingsList implements Component {
	private items: SettingItem[];
	private theme: SettingsListTheme;
	private selectedIndex = 0;
	private maxVisible: number;
	private onChange: (id: string, newValue: string) => void;
	private onCancel: () => void;
	private keybindings: KeybindingsManager;
	private submenuComponent: Component | null = null;
	private submenuItemIndex: number | null = null;

	constructor(
		items: SettingItem[],
		maxVisible: number,
		theme: SettingsListTheme,
		keybindings: KeybindingsManager,
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
	) {
		this.items = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.keybindings = keybindings;
		this.onChange = onChange;
		this.onCancel = onCancel;
	}

	updateValue(id: string, newValue: string): void {
		const item = this.items.find((i) => i.id === id);
		if (item) {
			item.currentValue = newValue;
		}
	}

	invalidate(): void {
		this.submenuComponent?.invalidate?.();
	}

	render(width: number): string[] {
		if (this.submenuComponent) {
			return this.submenuComponent.render(width);
		}
		return this.renderMainList(width);
	}

	private renderMainList(width: number): string[] {
		const lines: string[] = [];
		if (this.items.length === 0) {
			lines.push(this.theme.hint("  No settings available"));
			this.addHintLine(lines);
			return lines;
		}

		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.items.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.items.length);

		const maxLabelWidth = Math.min(30, Math.max(...this.items.map((item) => visibleWidth(item.label))));

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.items[i];
			if (!item) continue;
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? this.theme.cursor : "  ";
			const prefixWidth = visibleWidth(prefix);

			const labelPadded = item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
			const labelText = this.theme.label(labelPadded, isSelected);

			const separator = "  ";
			const usedWidth = prefixWidth + maxLabelWidth + visibleWidth(separator);
			const valueMaxWidth = Math.max(1, width - usedWidth - 2);
			const optionLines =
				isSelected && item.values && item.values.length > 0
					? wrapTextWithAnsi(this.formatOptionsInline(item, item.values), valueMaxWidth)
					: null;
			const valueText = optionLines
				? optionLines[0] ?? ""
				: this.theme.value(truncateToWidth(item.currentValue, valueMaxWidth, ""), isSelected);
			const line = prefix + labelText + separator + valueText;
			lines.push(truncateToWidth(line, width, ""));
			if (optionLines && optionLines.length > 1) {
				const indent = " ".repeat(prefixWidth + maxLabelWidth + visibleWidth(separator));
				for (const continuation of optionLines.slice(1)) {
					lines.push(truncateToWidth(indent + continuation, width, ""));
				}
			}
		}

		if (startIndex > 0 || endIndex < this.items.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${this.items.length})`;
			lines.push(this.theme.hint(truncateToWidth(scrollText, width - 2, "")));
		}

		const selectedItem = this.items[this.selectedIndex];
		if (selectedItem?.description) {
			lines.push("");
			const wrapWidth = Math.max(1, width - 4);
			const wrappedDesc = wrapTextWithAnsi(selectedItem.description, wrapWidth);
			for (const line of wrappedDesc) {
				const prefixed = `  ${line}`;
				lines.push(this.theme.description(truncateToWidth(prefixed, width, "")));
			}
		}

		this.addHintLine(lines);
		return lines;
	}

	handleInput(data: string): void {
		if (this.submenuComponent) {
			this.submenuComponent.handleInput?.(data);
			return;
		}

		if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.ctrl("k"))) {
			if (this.items.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
		} else if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.ctrl("j"))) {
			if (this.items.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
		} else if (this.keybindings.matches(data, "tui.editor.cursorLeft") || data === "\u001b[D") {
			this.stepValue(-1);
		} else if (this.keybindings.matches(data, "tui.editor.cursorRight") || data === "\u001b[C") {
			this.stepValue(1);
		} else if (
			this.keybindings.matches(data, "tui.select.confirm") ||
			data === "\r" ||
			data === "\n" ||
			data === " "
		) {
			this.activateItem();
		} else if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
			this.onCancel();
		}
	}

	private stepValue(direction: -1 | 1): void {
		const item = this.items[this.selectedIndex];
		if (!item || !item.values || item.values.length === 0) return;
		const values = item.values;
		let currentIndex = values.indexOf(item.currentValue);
		if (currentIndex === -1) {
			currentIndex = direction > 0 ? 0 : values.length - 1;
		}
		const nextIndex = (currentIndex + direction + values.length) % values.length;
		const newValue = values[nextIndex];
		item.currentValue = newValue;
		this.onChange(item.id, newValue);
	}

	private activateItem(): void {
		const item = this.items[this.selectedIndex];
		if (!item) return;
		if (item.submenu) {
			this.openSubmenu(item);
		}
	}

	private closeSubmenu(): void {
		this.submenuComponent = null;
		if (this.submenuItemIndex !== null) {
			this.selectedIndex = this.submenuItemIndex;
			this.submenuItemIndex = null;
		}
	}

	private formatOptionsInline(item: SettingItem, values: string[]): string {
		const separator = this.theme.description(" • ");
		return values
			.map((value) => {
				const selected = value === item.currentValue;
				return this.theme.value(value, selected);
			})
			.join(separator);
	}

	private openSubmenu(item: SettingItem): void {
		if (!item.submenu) return;
		this.submenuItemIndex = this.selectedIndex;
		this.submenuComponent = item.submenu(item.currentValue, (selectedValue) => {
			if (selectedValue !== undefined) {
				item.currentValue = selectedValue;
				this.onChange(item.id, selectedValue);
			}
			this.closeSubmenu();
		});
	}

	private addHintLine(lines: string[]): void {
		lines.push("");
		lines.push(this.theme.hint("  ←/→ change • Enter/Space edit custom • Esc to cancel"));
	}
}

// ---------------------------------------------------------------------------
// Menu item builders
// ---------------------------------------------------------------------------

type SettingsCategory = "main" | "steering" | "animation" | "tools" | "session";

function getMainMenuItems(settings: FlowSettings): SelectItem[] {
	const steeringEnabled = settings.steering?.enabled ?? true;
	const animationEnabled = settings.animation?.enabled ?? true;
	const toolOptimize = settings.toolOptimize ?? true;
	const structuredOutput = settings.structuredOutput ?? true;
	const sessionMode = settings.sessionMode ?? "default";

	return [
		{
			value: "steering",
			label: "Steering Settings",
			description: steeringEnabled ? "enabled" : "disabled",
		},
		{
			value: "animation",
			label: "Animation Settings",
			description: animationEnabled ? "enabled" : "disabled",
		},
		{
			value: "tools",
			label: "Tool Settings",
			description: `tool-optimize: ${toolOptimize ? "on" : "off"}, structured-output: ${structuredOutput ? "on" : "off"}`,
		},
		{
			value: "session",
			label: "Session Settings",
			description: `mode: ${sessionMode}`,
		},
		{
			value: "reset",
			label: "Reset to Defaults",
			description: "restore all settings",
		},
	];
}

function getSteeringItems(settings: FlowSettings): SettingItem[] {
	const steering = settings.steering ?? {};
	return [
		{
			id: "steering.enabled",
			label: "enabled",
			description: "Toggle steering injection",
			currentValue: (steering.enabled ?? true) ? "on" : "off",
			values: ["on", "off"],
		},
		{
			id: "steering.strategicHint",
			label: "strategic-hint",
			description: "Toggle [Hint: Plan next step...]",
			currentValue: (steering.strategicHint ?? true) ? "on" : "off",
			values: ["on", "off"],
		},
		{
			id: "steering.customPrompt",
			label: "custom-prompt",
			description: "Enter custom steering prompt or type 'default' to reset",
			currentValue: steering.customPrompt ?? "(default)",
			submenu: buildInputSubmenu("Custom prompt (or 'default')", (v) => {
				const trimmed = v.trim();
				if (!trimmed || trimmed.toLowerCase() === "default") return "(default)";
				return trimmed;
			}),
		},
	];
}

function getAnimationItems(settings: FlowSettings): SettingItem[] {
	const animation = settings.animation ?? {};
	return [
		{
			id: "animation.enabled",
			label: "enabled",
			description: "Master animation switch",
			currentValue: (animation.enabled ?? true) ? "on" : "off",
			values: ["on", "off"],
		},
		{
			id: "animation.glitch",
			label: "glitch",
			description: "Glitch/scramble effect",
			currentValue: (animation.glitch ?? true) ? "on" : "off",
			values: ["on", "off"],
		},
	];
}

function getToolItems(settings: FlowSettings): SettingItem[] {
	return [
		{
			id: "toolOptimize",
			label: "tool-optimize",
			description: "Unified batch tool vs separate tools",
			currentValue: (settings.toolOptimize ?? true) ? "on" : "off",
			values: ["on", "off"],
		},
		{
			id: "structuredOutput",
			label: "structured-output",
			description: "Structured JSON output from flows",
			currentValue: (settings.structuredOutput ?? true) ? "on" : "off",
			values: ["on", "off"],
		},
	];
}

function getSessionItems(settings: FlowSettings): SettingItem[] {
	return [
		{
			id: "sessionMode",
			label: "session-mode",
			description: "Session safety mode",
			currentValue: settings.sessionMode ?? "default",
			values: ["fast", "default", "long", "extreme_long"],
		},
		{
			id: "maxConcurrency",
			label: "max-concurrency",
			description: "Maximum concurrent flows",
			currentValue: String(settings.maxConcurrency ?? 4),
			values: ["1", "2", "3", "4", "5", "6", "7", "8"],
			submenu: buildInputSubmenu("Max concurrency (1-20)", (v) => {
				const n = Number(v.trim());
				if (!Number.isSafeInteger(n) || n < 1 || n > 20) return null;
				return String(n);
			}),
		},
	];
}

// ---------------------------------------------------------------------------
// Submenu helpers
// ---------------------------------------------------------------------------

function buildInputSubmenu(
	label: string,
	parseValue: (value: string) => string | null,
): (currentValue: string, done: (selectedValue?: string) => void) => Component {
	return (currentValue, done) => {
		const input = new Input();
		input.focused = true;
		input.setValue(currentValue);
		input.onSubmit = (value) => {
			const parsed = parseValue(value);
			if (parsed === null) return;
			done(parsed);
		};
		input.onEscape = () => {
			done();
		};

		const container = new Container();
		container.addChild(new Text(label, 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(input);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => input.handleInput(data),
		} as Component;
	};
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function setupSettingsCommand(pi: ExtensionAPI, getCwd: () => string | undefined): void {
	pi.registerCommand("flow:settings", {
		description:
			"Manage flow settings. Subcommands: steering <on|off>, strategic-hint <on|off>, animation <on|off>, glitch <on|off>, tool-optimize <on|off>, structured-output <on|off>, session-mode <mode>, max-concurrency <n>, reset. Call with no args for interactive TUI.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const cwd = getCwd() ?? ctx.cwd;
			const trimmed = args.trim().toLowerCase();
			const parts = trimmed.split(/\s+/);
			const sub = parts[0] ?? "";
			const value = parts[1] ?? "";

			if (!sub) {
				const settings = loadFlowSettings(cwd);

				await ctx.ui.custom<FlowSettings>(
					(tui: any, theme: Theme, keybindings: KeybindingsManager, done: (result: FlowSettings | null) => void) => {
						let currentCategory: SettingsCategory = "main";
						let container = new Container();
						let activeList: SelectList | SettingsList | null = null;

						function rebuild(): void {
							container = new Container();
							activeList = null;

							// Header
							container.addChild(new Text(theme.fg("accent", theme.bold("⚙ Flow Settings")), 1, 0));
							container.addChild(new Spacer(1));

							const currentSettings = loadFlowSettings(cwd);

							if (currentCategory === "main") {
								const items = getMainMenuItems(currentSettings);
								const selectList = new SelectList(
									items,
									Math.min(items.length, 10),
									{
										selectedPrefix: (t: string) => theme.fg("accent", t),
										selectedText: (t: string) => theme.fg("accent", t),
										description: (t: string) => theme.fg("muted", t),
										scrollInfo: (t: string) => theme.fg("dim", t),
										noMatch: (t: string) => theme.fg("warning", t),
									},
								);
								selectList.onSelect = (item) => {
									if (item.value === "reset") {
										writeFlowSetting(cwd, "", {});
										configureSteering({ enabled: true, customPrompt: undefined });
										configureStrategicHint(true);
										scrambleManager.setAnimationConfig({ enabled: true, glitch: true });
										ctx.ui.notify?.("Flow settings reset to defaults", "info");
										rebuild();
										tui.requestRender();
									} else {
										currentCategory = item.value as SettingsCategory;
										rebuild();
										tui.requestRender();
									}
								};
								selectList.onCancel = () => {
									done(loadFlowSettings(cwd));
								};
								activeList = selectList;
								container.addChild(selectList);

								container.addChild(new Spacer(1));
								container.addChild(
									new Text(theme.fg("dim", "↑↓ navigate • Enter/Space select • Esc back"), 1, 0),
								);
							} else {
								let items: SettingItem[];
								let handleChange: (id: string, value: string) => void;
								const backCategory: SettingsCategory = "main";

								if (currentCategory === "steering") {
									items = getSteeringItems(currentSettings);
									handleChange = (id, value) => {
										if (id === "steering.enabled") {
											const boolValue = value === "on";
											writeFlowSetting(cwd, "steering.enabled", boolValue);
											configureSteering({
												enabled: boolValue,
												customPrompt: currentSettings.steering?.customPrompt,
											});
										} else if (id === "steering.strategicHint") {
											const boolValue = value === "on";
											writeFlowSetting(cwd, "steering.strategicHint", boolValue);
											configureStrategicHint(boolValue);
										} else if (id === "steering.customPrompt") {
											if (value === "(default)") {
												writeFlowSetting(cwd, "steering.customPrompt", undefined);
												configureSteering({
													enabled: currentSettings.steering?.enabled ?? true,
													customPrompt: undefined,
												});
											} else {
												writeFlowSetting(cwd, "steering.customPrompt", value);
												configureSteering({
													enabled: currentSettings.steering?.enabled ?? true,
													customPrompt: value,
												});
											}
										}
										rebuild();
										tui.requestRender();
									};
								} else if (currentCategory === "animation") {
									items = getAnimationItems(currentSettings);
									handleChange = (id, value) => {
										if (id === "animation.enabled") {
											const boolValue = value === "on";
											writeFlowSetting(cwd, "animation.enabled", boolValue);
											scrambleManager.setAnimationConfig({
												enabled: boolValue,
												glitch: currentSettings.animation?.glitch ?? true,
											});
										} else if (id === "animation.glitch") {
											const boolValue = value === "on";
											writeFlowSetting(cwd, "animation.glitch", boolValue);
											scrambleManager.setAnimationConfig({
												enabled: currentSettings.animation?.enabled ?? true,
												glitch: boolValue,
											});
										}
										rebuild();
										tui.requestRender();
									};
								} else if (currentCategory === "tools") {
									items = getToolItems(currentSettings);
									handleChange = (id, value) => {
										if (id === "toolOptimize") {
											writeFlowSetting(cwd, "toolOptimize", value === "on");
										} else if (id === "structuredOutput") {
											writeFlowSetting(cwd, "structuredOutput", value === "on");
										}
										rebuild();
										tui.requestRender();
									};
								} else if (currentCategory === "session") {
									items = getSessionItems(currentSettings);
									handleChange = (id, value) => {
										if (id === "sessionMode") {
											writeFlowSetting(cwd, "sessionMode", value);
										} else if (id === "maxConcurrency") {
											writeFlowSetting(cwd, "maxConcurrency", Number(value));
										}
										rebuild();
										tui.requestRender();
									};
								} else {
									items = [];
									handleChange = () => {};
								}

								const settingsTheme: SettingsListTheme = {
									label: (text: string, selected: boolean) =>
										selected ? theme.fg("accent", theme.bold(text)) : theme.fg("text", text),
									value: (text: string, selected: boolean) =>
										selected ? theme.fg("accent", text) : theme.fg("muted", text),
									description: (text: string) => theme.fg("muted", text),
									cursor: theme.fg("accent", "▶ "),
									hint: (text: string) => theme.fg("dim", text),
								};

								const settingsList = new SettingsList(
									items,
									Math.min(items.length + 2, 15),
									settingsTheme,
									keybindings,
									handleChange,
									() => {
										currentCategory = backCategory;
										rebuild();
										tui.requestRender();
									},
								);
								activeList = settingsList;
								container.addChild(settingsList);
							}
						}

						rebuild();

						return {
							render(width: number) {
								return container.render(width);
							},
							invalidate() {
								container.invalidate();
							},
							handleInput(data: string) {
								if (activeList?.handleInput) {
									activeList.handleInput(data);
								}
								tui.requestRender();
							},
						};
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "center",
							width: 60,
							minWidth: 40,
							maxHeight: "85%",
							margin: 1,
						},
					},
				);

				return;
			}

			// -----------------------------------------------------------------
			// Text-based fallback for subcommands with arguments
			// -----------------------------------------------------------------
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
					configureSteering({ enabled: parsed, customPrompt: undefined });
					ctx.ui.notify?.(`steering.enabled = ${parsed}`, "info");
					break;
				}
				case "strategic-hint": {
					const parsed = parseOnOff(value);
					if (parsed === null) {
						ctx.ui.notify?.("Usage: /flow:settings strategic-hint <on|off>", "error");
						return;
					}
					writeFlowSetting(cwd, "steering.strategicHint", parsed);
					configureStrategicHint(parsed);
					ctx.ui.notify?.(`steering.strategicHint = ${parsed}`, "info");
					break;
				}
				case "animation": {
					const parsed = parseOnOff(value);
					if (parsed === null) {
						ctx.ui.notify?.("Usage: /flow:settings animation <on|off>", "error");
						return;
					}
					writeFlowSetting(cwd, "animation.enabled", parsed);
					scrambleManager.setAnimationConfig({ enabled: parsed, glitch: true });
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
					scrambleManager.setAnimationConfig({ enabled: true, glitch: parsed });
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
				case "session-mode": {
					const validModes = ["fast", "default", "long", "extreme_long"] as const;
					if (!validModes.includes(value as any)) {
						ctx.ui.notify?.(
							"Usage: /flow:settings session-mode <fast|default|long|extreme_long>",
							"error",
						);
						return;
					}
					writeFlowSetting(cwd, "sessionMode", value);
					ctx.ui.notify?.(`sessionMode = ${value}`, "info");
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
				case "reset": {
					writeFlowSetting(cwd, "", {});
					ctx.ui.notify?.("Flow settings reset to defaults", "info");
					break;
				}
				default: {
					ctx.ui.notify?.(
						"Unknown subcommand. Usage: /flow:settings {steering|strategic-hint|animation|glitch|tool-optimize|structured-output|session-mode|max-concurrency|reset}",
						"error",
					);
				}
			}
		},
	});
}
