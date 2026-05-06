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
			parameters: any;
			execute: (...args: any[]) => Promise<any>;
			renderCall?: (...args: any[]) => any;
			renderResult?: (...args: any[]) => any;
		}): void;
		setActiveTools(tools: string[]): void;
	}
	export interface ExtensionContext {
		cwd: string;
		hasUI: boolean;
		ui: { confirm: (title: string, body: string) => Promise<boolean> };
		sessionManager: { getSessionDir(): string; getHeader(): unknown; getBranch(): unknown[] };
	}
	export function parseFrontmatter<T extends Record<string, unknown>>(content: string): { frontmatter: T; body: string };
	export function getMarkdownTheme(): any;
	export const DEFAULT_MAX_BYTES: number;
	export const DEFAULT_MAX_LINES: number;
	export function truncateHead(text: string, options: { maxBytes?: number; maxLines?: number }): { content: string };
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
	/** Test-only exports provided by tests/__mocks__/pi-coding-agent.ts. */
	export const bashToolExecuteCalls: any[][];
	export function __setBashToolExecuteImpl(fn: (...args: any[]) => Promise<any>): void;
	export function __resetBashToolMock(): void;
}

declare module "@mariozechner/pi-tui" {
	export class Text {
		constructor(text: string, width: number, height: number);
		toString(): string;
	}
	export class TruncatedText {
		constructor(text: string, paddingX?: number, paddingY?: number);
		toString(): string;
	}
	export class Container {
		children: any[];
		addChild(child: any): void;
	}
	export class Markdown {
		constructor(text: string, width: number, height: number, theme?: any);
	}
	export class Spacer {
		constructor(height: number);
	}
}

declare module "@mariozechner/pi-agent-core" {
	export interface AgentToolResult<T = any> {
		content: any[];
		details?: T;
		isError?: boolean;
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
	};
	export type Static<T> = any;
}
