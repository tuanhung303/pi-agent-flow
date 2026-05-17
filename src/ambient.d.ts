/** Minimal ambient declarations for peer dependencies */

declare module "@mariozechner/pi-coding-agent" {
	export interface ExtensionAPI {
		registerFlag(name: string, config: { description: string; type: string }): void;
		getFlag(name: string): unknown;
		getActiveTools(): string[];
		on(event: string, callback: (...args: any[]) => any): void;
		emit(event: string, ...args: any[]): void;
		registerTool(tool: {
			name: string;
			label: string;
			description: string;
			promptSnippet?: string;
			promptGuidelines?: string[];
			parameters: any;
			execute: (...args: any[]) => Promise<any>;
			renderCall?: (...args: any[]) => any;
			renderResult?: (...args: any[]) => any;
		}): void;
		setActiveTools(tools: string[]): void;
		registerCommand(name: string, config: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }): void;
		sendUserMessage(content: string, opts?: { deliverAs?: string }): void;
		sendMessage(msg: { content: string; customType?: string; display?: boolean; details?: any }, opts?: { deliverAs?: string; triggerTurn?: boolean }): void;
		appendEntry(customType: string, data?: unknown): void;
		setSessionName(name: string): void;
		getSessionName(): string | undefined;
	}
	export interface SessionManager {
	getSessionDir(): string;
	getSessionFile(): string;
	getHeader(): unknown;
	getBranch(): unknown[];
	getSessionId(): string;
	appendMessage(message: any): string;
	appendSessionInfo(name: string): string;
	appendCustomEntry(customType: string, data?: unknown): string;
}
export interface SessionEntry {
	id: string;
	type: string;
	message?: any;
	customType?: string;
	data?: any;
}
export interface ExtensionContext {
		cwd: string;
		hasUI: boolean;
		ui: {
			confirm: (title: string, body: string) => Promise<boolean>;
			select: (prompt: string, options: string[], opts?: any) => Promise<string | null>;
			input: (prompt: string, placeholder: string, opts?: any) => Promise<string | null>;
			custom: <T>(factory: (tui: any, theme: any, keybindings: any, done: (result: T | null) => void) => any, options?: any) => Promise<T | undefined>;
			onTerminalInput?: (handler: (data: string) => { consume?: boolean } | undefined) => (() => void);
			notify?: (message: string, type: string) => void;
			setEditorText?: (text: string) => void;
			editor: (title: string, text: string) => Promise<string | undefined>;
		};
		sessionManager: SessionManager;
		isIdle(): boolean;
	}
	export interface Theme {
		fg(key: string, text: string): string;
		bold(text: string): string;
	}
	export function parseFrontmatter<T extends Record<string, unknown>>(content: string): { frontmatter: T; body: string };
	export function getMarkdownTheme(): any;
	export const DEFAULT_MAX_BYTES: number;
	export const DEFAULT_MAX_LINES: number;
	export function truncateHead(text: string, options: { maxBytes?: number; maxLines?: number }): { content: string };
	export function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T>;
	export function convertToLlm(branch: unknown[]): any[];
	export function serializeConversation(messages: any[]): string;
	export function createBashToolDefinition(
		cwd: string,
		options?: {
			shellPath?: string;
			commandPrefix?: string;
			operations?: any;
			spawnHook?: any;
		},
	): {
		name: string;
		label: string;
		description: string;
		parameters: any;
		execute: (...args: any[]) => Promise<any>;
		renderCall?: (...args: any[]) => any;
		renderResult?: (...args: any[]) => any;
	};
	export class DynamicBorder {
		constructor(color?: (str: string) => string);
		invalidate(): void;
		render(width: number): string[];
	}
	export class BorderedLoader {
		constructor(tui: any, theme: any, text: string);
		signal: AbortSignal;
		onAbort?: () => void;
		invalidate(): void;
		render(width: number): string[];
		handleInput?(data: string): void;
	}
	export interface WithSessionContext {
		sendUserMessage(content: string, opts?: { deliverAs?: string }): Promise<void>;
		ui?: {
			notify?: (message: string, type: string) => void;
		};
	}

	export interface ExtensionCommandContext {
		cwd: string;
		hasUI: boolean;
		ui: {
			confirm: (title: string, body: string) => Promise<boolean>;
			notify: (message: string, type: string) => void;
			select: (prompt: string, options: string[], opts?: any) => Promise<string | null>;
			input: (prompt: string, placeholder: string, opts?: any) => Promise<string | null>;
			custom: <T>(factory: (...args: any[]) => any, options?: any) => Promise<T | undefined>;
			onTerminalInput?: (handler: (data: string) => { consume?: boolean } | undefined) => (() => void);
			setEditorText: (text: string) => void;
			editor: (title: string, text: string) => Promise<string | undefined>;
		};
		sessionManager: SessionManager;
		newSession(opts?: {
			parentSession?: string;
			setup?: (sessionManager: SessionManager) => Promise<void>;
			withSession?: (ctx: WithSessionContext) => Promise<void>;
		}): Promise<{ cancelled: boolean }>;
		navigateTree(targetId: string, opts?: { label?: string; summarize?: boolean }): Promise<{ cancelled: boolean }>;
		waitForIdle(): Promise<void>;
		reload(): Promise<void>;
		modelRegistry: {
			getAll(): any[];
			getAvailable(): any[];
			find(provider: string, modelId: string): any;
			hasConfiguredAuth(model: any): boolean;
			getApiKeyAndHeaders(model: any): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
		};
		model?: any;
		isIdle(): boolean;
	}

	/** Event payload for pi.on("turn_end", ...) callbacks. */
	export interface TurnEndEvent {
		message: {
			role: string;
			content: string | Array<{ type: string; text?: string }>;
		};
	}

	/** Test-only exports provided by tests/__mocks__/pi-coding-agent.ts. */
	export const bashToolExecuteCalls: any[][];
	export function __setBashToolExecuteImpl(fn: (...args: any[]) => Promise<any>): void;
	export function __resetBashToolMock(): void;
}

declare module "@mariozechner/pi-tui" {
	export interface Component {
		invalidate(): void;
		render(width: number): string[];
		handleInput?(data: string): void;
	}
	export class Text implements Component {
		constructor(text: string, width: number, height: number);
		toString(): string;
		setText(text: string): void;
		invalidate(): void;
		render(width: number): string[];
	}
	export class TruncatedText {
		constructor(text: string, paddingX?: number, paddingY?: number);
		toString(): string;
	}
	export class Container implements Component {
		children: any[];
		addChild(child: any): void;
		clear(): void;
		invalidate(): void;
		render(width: number): string[];
	}
	export class Markdown implements Component {
		constructor(text: string, width: number, height: number, theme?: any);
		setText(text: string): void;
		render(width: number): string[];
		invalidate(): void;
	}
	export class Spacer implements Component {
		constructor(height: number);
		invalidate(): void;
		render(width: number): string[];
	}
	export interface SelectItem {
		value: string;
		label: string;
		description?: string;
	}
	export interface SelectListTheme {
		selectedPrefix: (text: string) => string;
		selectedText: (text: string) => string;
		description: (text: string) => string;
		scrollInfo: (text: string) => string;
		noMatch: (text: string) => string;
	}
	export class SelectList implements Component {
		constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme);
		onSelect?: (item: SelectItem) => void;
		onCancel?: () => void;
		onSelectionChange?: (item: SelectItem) => void;
		setSelectedIndex(index: number): void;
		getSelectedItem(): SelectItem | null;
		handleInput(data: string): void;
		render(width: number): string[];
		invalidate(): void;
	}
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
	export interface SettingsListOptions {
		enableSearch?: boolean;
	}
	export class SettingsList implements Component {
		constructor(
			items: SettingItem[],
			maxVisible: number,
			theme: SettingsListTheme,
			onChange: (id: string, newValue: string) => void,
			onCancel: () => void,
			options?: SettingsListOptions,
		);
		updateValue(id: string, newValue: string): void;
		handleInput(data: string): void;
		render(width: number): string[];
		invalidate(): void;
	}
	export class Input implements Component {
		focused: boolean;
		onSubmit?: (value: string) => void;
		onEscape?: () => void;
		constructor();
		setValue(text: string): void;
		getValue(): string;
		handleInput(data: string): void;
		render(width: number): string[];
		invalidate(): void;
	}
	export interface EditorTheme {
		borderColor: (s: string) => string;
		selectList?: any;
	}
	export class Editor implements Component {
		constructor(tui: TUI, theme: EditorTheme);
		disableSubmit: boolean;
		onSubmit?: (text: string) => void;
		handleInput(data: string): void;
		invalidate(): void;
		render(width: number): string[];
	}
	export interface Keybinding {
		name: string;
	}
	export interface KeybindingsManager {
		matches(data: string, keybinding: Keybinding | string): boolean;
		getKeys(keybinding: Keybinding | string): string[];
	}
	export interface OverlayHandle {
		isHidden(): boolean;
		setHidden(hidden: boolean): void;
	}
	export interface TUI {
		terminal: { rows: number };
		requestRender(): void;
	}
	export interface MarkdownTheme {
		[key: string]: any;
	}
	export namespace Key {
		export function ctrl(key: string): string;
		export function shift(key: string): string;
		export function alt(key: string): string;
		export function super_(key: string): string;
		export const space: string;
		export const escape: string;
		export const backspace: string;
		export const tab: string;
	}
	export function decodeKittyPrintable(data: string): string | undefined;
	export function fuzzyFilter<T>(items: T[], query: string, accessor: (item: T) => string): T[];
	export function matchesKey(data: string, key: string): boolean;
	export function truncateToWidth(text: string, width: number, ellipsis?: string, padRight?: boolean): string;
	export function wrapTextWithAnsi(text: string, width: number): string[];
	export function visibleWidth(text: string): number;
}

declare module "@mariozechner/pi-agent-core" {
	export interface AgentToolResult<T = any> {
		content: any[];
		details?: T;
		failed?: boolean;
		_toolCallId?: string;
	}
}

declare module "@mariozechner/pi-ai" {
	export interface Message {
		role: string;
		content: string | any[];
		usage?: any;
		model?: string;
		stopReason?: string;
		errorMessage?: string;
	}
	export interface AssistantMessage {
		role: string;
		content: { type: string; text?: string }[];
		stopReason: string;
		errorMessage?: string;
	}
	export function complete(model: any, context: { systemPrompt?: string; messages: any[] }, options?: { apiKey?: string; headers?: Record<string, string>; signal?: AbortSignal }): Promise<AssistantMessage>;
}

declare module "@sinclair/typebox" {
	export const Type: {
		Object: (properties: Record<string, any>, options?: any) => any;
		String: (options?: any) => any;
		Number: (options?: any) => any;
		Array: (items: any, options?: any) => any;
		Optional: (schema: any) => any;
		Boolean: (options?: any) => any;
		Union: (variants: any[], options?: any) => any;
		Literal: (value: string) => any;
		Unsafe: <T = any>(schema: any) => any;
	};
	export type Static<T> = any;
	export type TUnsafe<T> = any;
}
