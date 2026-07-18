/**
 * /flow:settings slash command registration.
 *
 * Subcommands: steering, animation, glitch,
 * tool-optimize, structured-output, complexity, max-concurrency, reset
 *
 * When called with no arguments, opens an interactive TUI overlay.
 */
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { loadFlowSettings, writeFlowSetting, type FlowSettings } from "../config/config.js";
import {
	Container,
	type Component,
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
} from "@earendil-works/pi-tui";
import {
	SettingItem,
	SettingsListTheme,
	TooltipSelectItem,
	SettingsCategory,
	getMainMenuItems,
	getSteeringItems,
	getAnimationItems,
	getToolItems,
	getDebugItems,
	getSessionItems,
	getAskUserItems,
	getLoopItems,
	getModelConfigItems,
	getCompressionItems,
	buildInputSubmenu,
	buildModelPickerSubmenu,
	_moduleRefs,
} from "./settings-items.js";
import { getCategoryHandler, handleTextCommand } from "./settings-handler.js";

export {
	getMainMenuItems,
	getSteeringItems,
	getAnimationItems,
	getToolItems,
	getDebugItems,
	getSessionItems,
	getAskUserItems,
	getLoopItems,
	getModelConfigItems,
	getCompressionItems,
	buildInputSubmenu,
	buildModelPickerSubmenu,
	type TooltipSelectItem,
	type SettingsCategory,
} from "./settings-items.js";

// ---------------------------------------------------------------------------
// SettingsList component (local implementation matching sub-core pattern)
// ---------------------------------------------------------------------------
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
// Command registration
// ---------------------------------------------------------------------------
export function setupSettingsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("flow:settings", {
		description:
			"Manage flow settings. Subcommands: steering <on|off>, animation <on|off>, glitch <on|off>, tool-optimize <on|off>, structured-output <on|off>, trace <on|off>, batch-read <on|off>, complexity <mode>, context-compression <auto|light|medium|aggressive>, max-concurrency <n>, ask-user {enabled <on|off> | timeout <seconds>}, debug <on|off>, reset. Call with no args for interactive TUI.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.ui) {
				return;
			}
			const trimmed = args.trim().toLowerCase();
			const parts = trimmed.split(/\s+/);
			const sub = parts[0] ?? "";
			if (!sub) {
				const cwd = ctx.cwd;
				const settings = loadFlowSettings(cwd);
				_moduleRefs.modelRegistry = (ctx as any).modelRegistry;
				await ctx.ui.custom<FlowSettings>(
					(tui: any, theme: Theme, keybindings: KeybindingsManager, done: (result: FlowSettings | null) => void) => {
						_moduleRefs.theme = theme;
						_moduleRefs.keybindings = keybindings;
						let currentCategory: SettingsCategory = "main";
						let container = new Container();
						let activeList: SelectList | SettingsList | null = null;
						function rebuild(): void {
							container = new Container();
							activeList = null;
							container.addChild(new DynamicBorder());
							container.addChild(new Text(theme.fg("accent", theme.bold("Flow Settings")), 1, 0));
							container.addChild(new Spacer(1));
							const currentSettings = loadFlowSettings(cwd);
							if (currentCategory === "main") {
								const items = getMainMenuItems(currentSettings, cwd);
								const selectList = new SelectList(
									items as SelectItem[],
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
								const tooltipText = new Text("", 1, 0);
								selectList.onSelectionChange = (item) => {
									tooltipText.setText(theme.fg("dim", (item as TooltipSelectItem).tooltip ?? ""));
								};
								const initialItem = selectList.getSelectedItem();
								if (initialItem) {
									tooltipText.setText(
										theme.fg("dim", (initialItem as TooltipSelectItem).tooltip ?? ""),
									);
								}
								container.addChild(new Spacer(1));
								container.addChild(tooltipText);
								container.addChild(new Spacer(1));
								container.addChild(
									new Text(theme.fg("dim", "▲▼ navigate • Enter/Space select • Esc back"), 1, 0),
								);
								container.addChild(new DynamicBorder());
							} else {
								let items: SettingItem[];
								const backCategory: SettingsCategory = "main";
								if (currentCategory === "steering") {
									items = getSteeringItems(currentSettings);
								} else if (currentCategory === "animation") {
									items = getAnimationItems(currentSettings);
								} else if (currentCategory === "tools") {
									items = getToolItems(currentSettings);
								} else if (currentCategory === "session") {
									items = getSessionItems(currentSettings);
								} else if (currentCategory === "ask-user") {
									items = getAskUserItems(currentSettings);
								} else if (currentCategory === "model-config") {
									items = getModelConfigItems(currentSettings, cwd);
								} else if (currentCategory === "loop") {
									items = getLoopItems(currentSettings, cwd);
								} else if (currentCategory === "debug") {
									items = getDebugItems(currentSettings);
								} else if (currentCategory === "compression") {
									items = getCompressionItems(currentSettings);
								} else {
									items = [];
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
									getCategoryHandler(currentCategory, cwd, rebuild, tui, ctx),
									() => {
										currentCategory = backCategory;
										rebuild();
										tui.requestRender();
									},
								);
								activeList = settingsList;
								container.addChild(settingsList);
								container.addChild(new DynamicBorder());
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
					}
				);
				return;
			}
			await handleTextCommand(args, ctx);
		},
	});
}
