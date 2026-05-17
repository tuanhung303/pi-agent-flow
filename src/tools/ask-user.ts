/**
 * Ask Tool Extension - Interactive question UI for pi-coding-agent
 *
 * Split-pane-only layout: options list (left) + description preview (right).
 * Minimal schema: question + options[{title, description}].
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Type, type TUnsafe } from "@sinclair/typebox";
import { appendDirectiveOnce } from "../steering/tool-utils.js";
import { setPendingDecision } from "../notify/notify-state.js";
import { scrambleManager, runScrambleTimer } from "../tui/scramble/index.js";
import { stripAnsi } from "../tui/render-utils.js";
import {
	Container,
	type Component,
	decodeKittyPrintable,
	fuzzyFilter,
	type KeybindingsManager,
	Key,
	matchesKey,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { renderSingleSelectRows, type QuestionOption } from "../tui/single-select-layout.js";
import { loadFlowSettings } from "../config/config.js";

const ASK_USER_VERSION = "1.8.40";

/**
 * Emit a flat `{ type: "string", enum: [...] }` JSON Schema instead of the
 * `anyOf`/`oneOf` shape that `Type.Union([Type.Literal()])` produces. Google's
 * function-calling API rejects the union form. Local copy of pi-ai's StringEnum
 * to avoid a peer dependency for one helper.
 */
function StringEnum<const T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: [...values],
		...(options?.description ? { description: options.description } : {}),
		...(options?.default !== undefined ? { default: options.default } : {}),
	});
}

type AskOptionInput = QuestionOption | string;

interface AskParams {
	question: string;
	options?: AskOptionInput[];
}

type AskResponse =
	| { kind: "selection"; selections: string[] }
	| { kind: "freeform"; text: string };

interface AskToolDetails {
	question: string;
	options: QuestionOption[];
	response: AskResponse | null;
	cancelled: boolean;
}

type AskUIResult = AskResponse;

function normalizeOptions(options: AskOptionInput[]): QuestionOption[] {
	return options
		.map((option) => {
			if (typeof option === "string") {
				return { title: option, description: option };
			}
			if (option && typeof option === "object" && typeof option.title === "string") {
				return {
					title: option.title,
					description: option.description || option.title,
				};
			}
			return null;
		})
		.filter((option): option is QuestionOption => option !== null);
}

function formatOptionsForMessage(options: QuestionOption[]): string {
	return options
		.map((option, index) => {
			return `${index + 1}. ${option.title} — ${option.description}`;
		})
		.join("\n");
}

function createFreeformResponse(text: string | null | undefined): AskResponse | null {
	const trimmed = text?.trim();
	return trimmed ? { kind: "freeform", text: trimmed } : null;
}

function createSelectionResponse(selections: string[]): AskResponse | null {
	const normalizedSelections = selections.map((selection) => selection.trim()).filter(Boolean);
	if (normalizedSelections.length === 0) return null;
	return { kind: "selection", selections: normalizedSelections };
}

function formatResponseSummary(response: AskResponse): string {
	if (response.kind === "freeform") return response.text;
	return response.selections.join(", ");
}

function isCancelledInput(value: unknown): value is null | undefined {
	return value === null || value === undefined;
}

function isSelectionResponse(response: AskResponse): response is Extract<AskResponse, { kind: "selection" }> {
	return response.kind === "selection";
}

function createSelectListTheme(theme: Theme) {
	return {
		selectedPrefix: (t: string) => theme.fg("accent", t),
		selectedText: (t: string) => theme.fg("accent", t),
		description: (t: string) => theme.fg("muted", t),
		scrollInfo: (t: string) => theme.fg("dim", t),
		noMatch: (t: string) => theme.fg("warning", t),
	};
}

const BOX_BORDER_LEFT = "│ ";
const BOX_BORDER_RIGHT = " │";
const BOX_BORDER_OVERHEAD = BOX_BORDER_LEFT.length + BOX_BORDER_RIGHT.length;

class BoxBorderTop implements Component {
	private color: (s: string) => string;
	private title?: string;
	private titleColor?: (s: string) => string;
	constructor(color: (s: string) => string, title?: string, titleColor?: (s: string) => string) {
		this.color = color;
		this.title = title;
		this.titleColor = titleColor;
	}
	invalidate(): void { }
	render(width: number): string[] {
		const paddedWidth = Math.max(0, width - 2);
		let line = this.color("┌" + "─".repeat(paddedWidth) + "┐");
		if (this.title && this.titleColor) {
			const titleWidth = stripAnsi(this.title).length;
			const start = 2;
			const end = start + titleWidth;
			if (end < width - 1) {
				line =
					this.color("┌─") +
					this.titleColor(this.title) +
					this.color("─".repeat(Math.max(0, paddedWidth - titleWidth - 1)) + "┐");
			}
		}
		return [line];
	}
}

class BoxBorderBottom implements Component {
	private color: (s: string) => string;
	private title?: string;
	private titleColor?: (s: string) => string;
	constructor(color: (s: string) => string, title?: string, titleColor?: (s: string) => string) {
		this.color = color;
		this.title = title;
		this.titleColor = titleColor;
	}
	invalidate(): void { }
	render(width: number): string[] {
		const paddedWidth = Math.max(0, width - 2);
		let line = this.color("└" + "─".repeat(paddedWidth) + "┘");
		if (this.title && this.titleColor) {
			const titleWidth = stripAnsi(this.title).length;
			const start = 2;
			const end = start + titleWidth;
			if (end < width - 1) {
				line =
					this.color("└" + "─".repeat(Math.max(0, paddedWidth - titleWidth - 1))) +
					this.titleColor(this.title) +
					this.color("─┘");
			}
		}
		return [line];
	}
}

// ---------------------------------------------------------------------------
// Vim-style aliases for navigating option lists.
// ---------------------------------------------------------------------------
const VIM_SELECT_UP_KEY = Key.ctrl("k");
const VIM_SELECT_DOWN_KEY = Key.ctrl("j");

function matchesSelectUp(data: string, keybindings: KeybindingsManager): boolean {
	return (
		keybindings.matches(data, "tui.select.up") ||
		matchesKey(data, Key.shift("tab")) ||
		matchesKey(data, VIM_SELECT_UP_KEY)
	);
}

function matchesSelectDown(data: string, keybindings: KeybindingsManager): boolean {
	return (
		keybindings.matches(data, "tui.select.down") ||
		matchesKey(data, Key.tab) ||
		matchesKey(data, VIM_SELECT_DOWN_KEY)
	);
}

// ---------------------------------------------------------------------------
// Split-pane constants
// ---------------------------------------------------------------------------
const ASK_OVERLAY_MAX_HEIGHT_RATIO = 0.85;
// Split-pane layout always renders left list + right preview regardless of terminal width
const SINGLE_SELECT_SPLIT_PANE_SEPARATOR = " │ ";

// ---------------------------------------------------------------------------
// WrappedSingleSelectList — fuzzy-searchable single-select with split-pane preview
// ---------------------------------------------------------------------------
class WrappedSingleSelectList implements Component {
	private options: QuestionOption[];
	private theme: Theme;
	private keybindings: KeybindingsManager;
	private selectedIndex = 0;
	private searchQuery = "";
	private maxVisibleRows = 12;
	private cachedWidth?: number;
	private cachedLines?: string[];

	public onCancel?: () => void;
	public onSubmit?: (result: string) => void;

	constructor(
		options: QuestionOption[],
		theme: Theme,
		keybindings: KeybindingsManager,
	) {
		this.options = options;
		this.theme = theme;
		this.keybindings = keybindings;
	}

	setMaxVisibleRows(rows: number): void {
		const next = Math.max(1, Math.floor(rows));
		if (next !== this.maxVisibleRows) {
			this.maxVisibleRows = next;
			this.invalidate();
		}
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private getFilteredOptions(): QuestionOption[] {
		return fuzzyFilter(this.options, this.searchQuery, (option) => `${option.title} ${option.description}`);
	}

	private getItemCount(filteredOptions: QuestionOption[]): number {
		return filteredOptions.length;
	}

	private setSearchQuery(query: string): void {
		this.searchQuery = query;
		this.selectedIndex = 0;
		this.invalidate();
	}

	private popSearchCharacter(): void {
		if (!this.searchQuery) return;
		const characters = [...this.searchQuery];
		characters.pop();
		this.setSearchQuery(characters.join(""));
	}

	private getPrintableInput(data: string): string | null {
		const kittyPrintable = decodeKittyPrintable(data);
		if (kittyPrintable !== undefined) return kittyPrintable;

		const characters = [...data];
		if (characters.length !== 1) return null;

		const [character] = characters;
		if (!character) return null;

		const code = character.charCodeAt(0);
		if (code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
			return null;
		}

		return character;
	}

	private styleListLine(line: string, width: number, isSelected: boolean): string {
		const trimmed = line.trim();

		if (trimmed.startsWith("(")) {
			return truncateToWidth(this.theme.fg("dim", line), width, "");
		}

		if (isSelected) {
			return truncateToWidth(this.theme.fg("accent", this.theme.bold(line)), width, "");
		}

		if (line.startsWith("      ")) {
			return truncateToWidth(this.theme.fg("muted", line), width, "");
		}

		if (line.startsWith("▶")) {
			return truncateToWidth(this.theme.fg("accent", this.theme.bold(line)), width, "");
		}

		return truncateToWidth(this.theme.fg("text", line), width, "");
	}

	private getSplitPaneWidths(width: number): { left: number; right: number } {
		const availableWidth = Math.max(1, width - SINGLE_SELECT_SPLIT_PANE_SEPARATOR.length);
		const preferredLeftWidth = Math.floor(availableWidth * 0.42);
		const left = Math.max(
			1,
			Math.min(preferredLeftWidth, availableWidth - 1),
		);
		const right = Math.max(1, availableWidth - left);
		return { left, right };
	}

	private buildListLines(width: number, filteredOptions: QuestionOption[]): string[] {
		const lines: string[] = [];
		const count = this.getItemCount(filteredOptions);
		const searchValue = this.searchQuery ? this.theme.fg("text", this.searchQuery) : this.theme.fg("dim", "type to filter");
		lines.push(truncateToWidth(`${this.theme.fg("accent", "Filter:")} ${searchValue}`, width, ""));

		if (this.searchQuery && filteredOptions.length === 0) {
			lines.push(truncateToWidth(this.theme.fg("warning", "No matching options"), width, ""));
		}

		if (count === 0) {
			if (!this.searchQuery) {
				lines.push(truncateToWidth(this.theme.fg("warning", "No options"), width, ""));
			}
			return lines.slice(0, this.maxVisibleRows);
		}

		const maxRows = Math.max(1, this.maxVisibleRows - lines.length);
		const optionRows = renderSingleSelectRows({
			options: filteredOptions,
			selectedIndex: this.selectedIndex,
			width,
			maxRows,
		});
		const optionLines = optionRows.map((row) => this.styleListLine(row.line, width, row.selected));

		lines.push(...optionLines);
		return lines.slice(0, this.maxVisibleRows);
	}

	private buildPreviewLines(width: number, filteredOptions: QuestionOption[], maxLines: number): string[] {
		if (maxLines <= 0) return [];

		let text = "";
		const selected = filteredOptions[this.selectedIndex];
		if (!selected) {
			text += "*No option selected*\n";
		} else {
			text += `## ${selected.title}\n\n`;
			if (selected.description?.trim()) {
				text += `${selected.description}\n`;
			} else {
				text += "*No additional details provided for this option.*\n";
			}
			text += `\n---\n\nPress Enter to select this option.\n`;
			if (this.searchQuery) {
				text += `\n> Filter: ${this.searchQuery}\n`;
			}
		}

		const lines: string[] = [];
		for (const line of wrapTextWithAnsi(text.trim(), Math.max(10, width))) {
			lines.push(truncateToWidth(line, width, ""));
		}

		while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
			lines.pop();
		}

		if (lines.length <= maxLines) return lines;
		if (maxLines === 1) return [truncateToWidth(this.theme.fg("dim", "…"), width, "")];

		const visibleLines = lines.slice(0, maxLines - 1);
		visibleLines.push(truncateToWidth(this.theme.fg("dim", "…"), width, ""));
		return visibleLines;
	}

	handleInput(data: string): void {
		if (this.searchQuery && matchesKey(data, Key.escape)) {
			this.setSearchQuery("");
			return;
		}

		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
			return;
		}

		const filteredOptions = this.getFilteredOptions();
		const count = this.getItemCount(filteredOptions);

		if (matchesSelectUp(data, this.keybindings) && count > 0) {
			this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
			this.invalidate();
			return;
		}

		if (matchesSelectDown(data, this.keybindings) && count > 0) {
			this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
			this.invalidate();
			return;
		}

		const numMatch = data.match(/^[1-9]$/);
		if (numMatch && filteredOptions.length > 0) {
			const idx = Number.parseInt(numMatch[0], 10) - 1;
			if (idx >= 0 && idx < filteredOptions.length) {
				this.selectedIndex = idx;
				this.invalidate();
				return;
			}
		}

		if (this.keybindings.matches(data, "tui.select.confirm") && count > 0) {
			const result = filteredOptions[this.selectedIndex]?.title;
			if (result) this.onSubmit?.(result);
			else this.onCancel?.();
			return;
		}

		if (this.keybindings.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, Key.backspace)) {
			this.popSearchCharacter();
			return;
		}

		const printableInput = this.getPrintableInput(data);
		if (printableInput) {
			this.setSearchQuery(this.searchQuery + printableInput);
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const filteredOptions = this.getFilteredOptions();
		const count = this.getItemCount(filteredOptions);
		this.selectedIndex = count > 0 ? Math.max(0, Math.min(this.selectedIndex, count - 1)) : 0;

		const splitPane = this.getSplitPaneWidths(width);
		const listLines = this.buildListLines(splitPane.left, filteredOptions);
		const previewLines = this.buildPreviewLines(splitPane.right, filteredOptions, this.maxVisibleRows);
		const rowCount = Math.min(this.maxVisibleRows, Math.max(listLines.length, previewLines.length));
		const separator = this.theme.fg("dim", SINGLE_SELECT_SPLIT_PANE_SEPARATOR);
		const lines = Array.from({ length: rowCount }, (_, index) => {
			const left = truncateToWidth(listLines[index] ?? "", splitPane.left, "", true);
			const right = truncateToWidth(previewLines[index] ?? "", splitPane.right, "");
			return `${left}${separator}${right}`;
		});

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

// ---------------------------------------------------------------------------
// AskComponent — root container with box border and single-select split-pane
// ---------------------------------------------------------------------------
class AskComponent extends Container {
	private question: string;
	private options: QuestionOption[];
	private tui: TUI;
	private theme: Theme;
	private keybindings: KeybindingsManager;
	private onDone: (result: AskUIResult | null) => void;

	// Static layout components
	private titleText: Text;
	private questionText: Text;
	private modeContainer: Container;
	private helpText: Text;

	// Mode component
	private singleSelectList?: WrappedSingleSelectList;

	// Countdown timer
	private timerEnabled: boolean;
	private timerSeconds: number;
	private timerInterval: ReturnType<typeof setInterval> | undefined;
	private timerStartMs: number;

	constructor(
		question: string,
		options: QuestionOption[],
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		onDone: (result: AskUIResult | null) => void,
	) {
		super();

		this.question = question;
		this.options = options;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.onDone = onDone;

		const settings = loadFlowSettings(process.cwd());
		this.timerEnabled = settings.askUser?.enabled ?? true;
		this.timerSeconds = settings.askUser?.timeout ?? 300;
		this.timerInterval = undefined;
		this.timerStartMs = Date.now();

		if (this.timerEnabled && this.timerSeconds > 0) {
			this.timerInterval = setInterval(() => {
				this.timerSeconds--;
				if (this.timerSeconds <= 0) {
					this.finish(null);
				} else {
					this.tui.requestRender();
				}
			}, 1000);
		}

		this.addChild(new BoxBorderTop(
			(s: string) => theme.fg("accent", s),
			"ask_user",
			(s: string) => theme.fg("dim", theme.bold(s)),
		));
		this.addChild(new Spacer(1));

		this.titleText = new Text("", 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));

		this.questionText = new Text("", 1, 0);
		this.addChild(this.questionText);

		this.addChild(new Spacer(1));

		this.modeContainer = new Container();
		this.addChild(this.modeContainer);

		this.addChild(new Spacer(1));
		this.helpText = new Text("", 1, 0);
		this.addChild(this.helpText);

		this.addChild(new Spacer(1));
		this.addChild(new BoxBorderBottom(
			(s: string) => theme.fg("accent", s),
			`v${ASK_USER_VERSION}`,
			(s: string) => theme.fg("dim", s),
		));

		this.updateStaticText();
		this.showSelectMode();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateStaticText();
		this.updateHelpText();
	}

	override render(width: number): string[] {
		const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);

		const overlayMaxHeight = Math.max(12, Math.floor(this.tui.terminal.rows * ASK_OVERLAY_MAX_HEIGHT_RATIO));
		const staticLines = this.countStaticLines(innerWidth);
		const availableOptionRows = Math.max(4, overlayMaxHeight - staticLines);
		this.ensureSingleSelectList().setMaxVisibleRows(availableOptionRows);

		const rawLines = super.render(innerWidth);

		const borderColor = (s: string) => this.theme.fg("accent", s);
		const titleColor = (s: string) => this.theme.fg("dim", this.theme.bold(s));
		return rawLines.map((line, index) => {
			if (index === 0 || index === rawLines.length - 1) {
				if (index === 0) {
					return new BoxBorderTop(borderColor, "ask_user", titleColor).render(width)[0];
				}
				return new BoxBorderBottom(borderColor, this.getBottomTitle(), (s: string) => this.theme.fg("dim", s)).render(width)[0];
			}
			const padded = truncateToWidth(line, innerWidth, "", true);
			return `${borderColor(BOX_BORDER_LEFT)}${padded}${borderColor(BOX_BORDER_RIGHT)}`;
		});
	}

	private countWrappedLines(text: string, width: number): number {
		return Math.max(1, wrapTextWithAnsi(text, Math.max(10, width - 2)).length);
	}

	private countStaticLines(width: number): number {
		const titleLines = 1;
		const questionLines = this.countWrappedLines(this.question, width);
		const helpLines = 1;
		const borderLines = 2;
		const spacerLines = 5;
		return borderLines + spacerLines + titleLines + questionLines + helpLines;
	}

	private finish(result: AskUIResult | null): void {
		this.onDone(result);
	}

	private updateStaticText(): void {
		const theme = this.theme;
		this.titleText.setText(theme.fg("accent", theme.bold("Question")));
		this.questionText.setText(theme.fg("text", theme.bold(this.question)));
	}

	private updateHelpText(): void {
		const theme = this.theme;
		const alternateCancelKeys = this.keybindings
			.getKeys("tui.select.cancel")
			.filter((key) => key !== "escape" && key !== "esc");
		const hints = [
			literalHint(theme, "type", "filter"),
			keybindingHint(theme, this.keybindings, "tui.editor.deleteCharBackward", "erase"),
			literalHint(theme, "▲▼", "navigate"),
			keybindingHint(theme, this.keybindings, "tui.select.confirm", "select"),
			literalHint(theme, "esc", "clear/cancel"),
			alternateCancelKeys.length > 0
				? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel")
				: null,
		]
			.filter((hint): hint is string => !!hint)
			.join(" • ");
		this.helpText.setText(theme.fg("dim", hints));
	}

	private ensureSingleSelectList(): WrappedSingleSelectList {
		if (this.singleSelectList) return this.singleSelectList;

		const list = new WrappedSingleSelectList(
			this.options,
			this.theme,
			this.keybindings,
		);
		list.onSubmit = (result) => this.finish(createSelectionResponse([result]));
		list.onCancel = () => this.finish(null);

		this.singleSelectList = list;
		return list;
	}

	private showSelectMode(): void {
		this.modeContainer.clear();
		this.modeContainer.addChild(this.ensureSingleSelectList());
		this.updateHelpText();
		this.invalidate();
		this.tui.requestRender();
	}

	destroy(): void {
		if (this.timerInterval !== undefined) {
			clearInterval(this.timerInterval);
			this.timerInterval = undefined;
		}
	}

	private getBottomTitle(): string {
		if (this.timerEnabled && this.timerSeconds > 0) {
			const mins = Math.floor(this.timerSeconds / 60);
			const secs = this.timerSeconds % 60;
			return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")} · v${ASK_USER_VERSION}`;
		}
		return `v${ASK_USER_VERSION}`;
	}

	handleInput(data: string): void {
		this.ensureSingleSelectList().handleInput?.(data);
		this.tui.requestRender();
	}
}

// ---------------------------------------------------------------------------
// RPC/headless fallback: use dialog methods (select/input) instead of the rich TUI overlay.
// ctx.ui.custom() returns undefined in RPC mode, so we degrade gracefully.
// ---------------------------------------------------------------------------
async function askViaDialogs(
	ui: { select: Function; input: Function },
	question: string,
	options: QuestionOption[],
	signal?: AbortSignal,
): Promise<AskUIResult | null> {
	if (signal?.aborted) return null;

	if (options.length === 0) {
		const answer = await ui.input(question, "Type your answer...", { signal }) as string | undefined;
		if (isCancelledInput(answer)) return null;
		return createFreeformResponse(answer);
	}

	const selectOptions = options.map((o) => o.title);
	const selected = await ui.select(question, selectOptions, { signal }) as string | undefined;
	if (isCancelledInput(selected)) return null;
	return createSelectionResponse([selected]);
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------
export function createAskUserTool() {
	return {
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user a focused question with optional multiple-choice answers. Use this to gather information interactively. Ask exactly one focused question per call. When presenting options, mark your recommended choice with [preferred] and place it first.",
		promptSnippet:
			"Ask the user one focused question with optional multiple-choice answers to gather information interactively",
		promptGuidelines: [
			"Use `ask_user` when the user's intent is ambiguous, when a decision requires explicit user input, or when multiple valid options exist.",
			"Ask exactly one focused question per `ask_user` call.",
			"Do not combine multiple numbered, multipart, or unrelated questions into one `ask_user` prompt.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "The question to ask the user" }),
			options: Type.Optional(
				Type.Array(
					Type.Object({
						title: Type.String({ description: "Short title for this option" }),
						description: Type.String({ description: "Longer description explaining this option" }),
					}),
					{ description: "List of options for the user to choose from" },
				),
			),
		}),

		async execute(_toolCallId: string, params: AskParams, signal: AbortSignal | undefined, onUpdate: ((result: any) => void) | undefined, ctx: ExtensionContext) {
			setPendingDecision();

			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "Cancelled" }],
					details: { question: params.question, options: [], response: null, cancelled: true } as AskToolDetails,
				};
			}

			const { question, options: rawOptions = [] } = params as AskParams;
			const options = normalizeOptions(rawOptions);

			if (!ctx.hasUI || !ctx.ui) {
				const optionText = options.length > 0 ? `\n\nOptions:\n${formatOptionsForMessage(options)}` : "";
				throw new Error(`Ask requires interactive mode. Please answer:\n\n${question}${optionText}`);
			}

			if (options.length === 0) {
				const answer = await ctx.ui.input(question, "Type your answer...");
				const response = createFreeformResponse(answer);

				if (!response) {
					return {
						content: [{ type: "text", text: "User cancelled the question" }],
						details: { question, options, response: null, cancelled: true } as AskToolDetails,
					};
				}

				const _result0 = {
					content: [{ type: "text", text: `User answered: ${formatResponseSummary(response)}` }],
					details: { question, options, response, cancelled: false } as AskToolDetails,
				};
				appendDirectiveOnce(_result0);
				return _result0;
			}

			onUpdate?.({
				content: [{ type: "text", text: "Waiting for user input..." }],
				details: { question, options, response: null, cancelled: false },
			});

			let result: AskUIResult | null;
			try {
				const customFactory = (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: AskUIResult | null) => void) => {
					let abortListener: (() => void) | undefined;
					let component: AskComponent | undefined;
					let doneCalled = false;

					const cleanup = () => {
						if (signal && abortListener) {
							signal.removeEventListener("abort", abortListener);
							abortListener = undefined;
						}
						component?.destroy?.();
					};

					const wrappedDone = (result: AskUIResult | null) => {
						if (doneCalled) return;
						doneCalled = true;
						cleanup();
						done(result);
					};

					if (signal) {
						abortListener = () => wrappedDone(null);
						signal.addEventListener("abort", abortListener, { once: true });
					}

					component = new AskComponent(
						question,
						options,
						tui,
						theme,
						keybindings,
						wrappedDone,
					);

					return component;
				};

				const customResult = await ctx.ui.custom<AskUIResult | null>(
					customFactory,
					{
						overlay: true,
						overlayOptions: {
							anchor: "center" as const,
							width: "92%",
							minWidth: 40,
							maxHeight: "85%",
							margin: 1,
						},
					},
				);

				if (customResult !== undefined) {
					result = customResult;
				} else {
					result = await askViaDialogs(ctx.ui, question, options, signal);
				}
			} catch (error) {
				const message =
					error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
				throw new Error(`Ask tool failed: ${message}`);
			}

			if (result === null) {
				return {
					content: [{ type: "text", text: "User cancelled the question" }],
					details: { question, options, response: null, cancelled: true } as AskToolDetails,
				};
			}

			return {
				content: [{ type: "text", text: `User answered: ${formatResponseSummary(result)}` }],
				details: {
					question,
					options,
					response: result,
					cancelled: false,
				} as AskToolDetails,
			};
		},

		renderCall(args: any, theme: any) {
			const question = (args.question as string) || "";
			const rawOptions = Array.isArray(args.options) ? args.options : [];
			let text = theme.fg("toolTitle", theme.bold("ask_user "));
			text += theme.fg("muted", question);
			if (rawOptions.length > 0) {
				const labels = rawOptions.map((o: unknown) =>
					typeof o === "string" ? o : (o as QuestionOption)?.title ?? "",
				);
				text += "\n" + theme.fg("dim", `  ${rawOptions.length} option(s): ${labels.join(", ")}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result: any, options: any, theme: any, args?: Record<string, unknown>) {
			const details = result.details as (AskToolDetails & { error?: string }) | undefined;
			const canAnimate = !!(args as any)?.invalidate && !!(args as any)?.state;
			const now = Date.now();
			const id = (args as any)?.toolCallId || (args as any)?.id || "ask_user";

			if (details?.error) {
				const line = theme.fg("error", `✖ ${details.error}`);
				if (!canAnimate) return new Text(scrambleManager.renderStatic(line), 0, 0);
				const scrambled = scrambleManager.updateText(id, "result", stripAnsi(line), now, false).content;
				runScrambleTimer(args as Record<string, any> | undefined, id);
				return new Text(scrambled, 0, 0);
			}

			if (!details || details.cancelled || !details.response) {
				const line = theme.fg("warning", "Cancelled");
				if (!canAnimate) return new Text(scrambleManager.renderStatic(line), 0, 0);
				const scrambled = scrambleManager.updateText(id, "result", stripAnsi(line), now, false).content;
				runScrambleTimer(args as Record<string, any> | undefined, id);
				return new Text(scrambled, 0, 0);
			}

			const response = details.response;
			let text = theme.fg("success", "✔ ");
			if (response.kind === "freeform") {
				text += theme.fg("muted", "(wrote) ");
			}
			text += theme.fg("accent", formatResponseSummary(response));

			if (options.expanded) {
				text += "\n" + theme.fg("dim", `Q: ${details.question}`);

				if (isSelectionResponse(response) && details.options.length > 0) {
					const selectedTitles = new Set(response.selections);
					text += "\n" + theme.fg("dim", "Options:");
					for (const opt of details.options) {
						const marker = selectedTitles.has(opt.title) ? theme.fg("success", "●") : theme.fg("dim", "○");
						text += `\n  ${marker} ${theme.fg("dim", opt.title)}${theme.fg("dim", ` — ${opt.description}`)}`;
					}
				}
			}

			if (!canAnimate) return new Text(scrambleManager.renderStatic(text), 0, 0);
			const scrambled = scrambleManager.updateText(id, "result", stripAnsi(text), now, false).content;
			runScrambleTimer(args as Record<string, any> | undefined, id);
			return new Text(scrambled, 0, 0);
		},
	};
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------
function keybindingHint(theme: Theme, keybindings: KeybindingsManager, id: string, label: string): string | null {
	const keys = keybindings.getKeys(id);
	if (!keys || keys.length === 0) return null;
	return `${theme.fg("accent", formatKeyList(keys))} ${theme.fg("dim", label)}`;
}

function literalHint(theme: Theme, keys: string, label: string): string {
	return `${theme.fg("accent", keys)} ${theme.fg("dim", label)}`;
}

function formatKeyList(keys: string[]): string {
	if (keys.length === 0) return "";
	if (keys.length === 1) return keys[0]!;
	return `${keys.slice(0, -1).join(", ")} or ${keys[keys.length - 1]}`;
}
