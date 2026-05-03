/**
 * batch — constants and shared types.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024; // 50KB
export const SAFE_FULL_READ_LIMIT = 300;
export const TARGETED_READ_LINE_LIMIT = 1000;
export const MAX_CONTEXT_MAP_ENTRIES = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EditReplacement {
	f: string;
	r: string;
}

export interface FileOpInput {
	o: "read" | "write" | "edit" | "delete";
	p: string;
	c?: string;
	e?: EditReplacement[];
	s?: number;
	l?: number;
}

export interface ContextMapEntry {
	kind: string;
	name: string;
	startLine: number;
	endLine: number;
	parent?: string;
}

export interface OpResult {
	op: "read" | "write" | "edit" | "delete";
	path: string;
	status: "ok" | "error" | "skipped";
	content?: string;
	bytes?: number;
	blocksChanged?: number;
	totalLines?: number;
	contextMap?: boolean;
	language?: string;
	symbols?: ContextMapEntry[];
	symbolsTruncated?: boolean;
	warning?: string;
	truncated?: boolean;
	nextOffset?: number;
	error?: string;
	hint?: string;
}

export interface ReadTruncationResult {
	content: string;
	truncated: boolean;
	nextOffset?: number;
	linesRead: number;
}

export interface ReadOptions {
	/**
	 * When false, readWithOffsetLimit ignores regular batch MAX_LINES and total
	 * MAX_BYTES caps. batch_read applies its own safe full-file and targeted-read
	 * guards before calling this helper.
	 */
	truncate?: boolean;
	toolName?: "batch" | "batch_read";
}

export interface ExecuteOptions {
	readOptions?: ReadOptions;
	includeLimitWarnings?: boolean;
}

export type ContextLanguage =
	| "typescript"
	| "javascript"
	| "python"
	| "terraform"
	| "hcl"
	| "yaml"
	| "dockerfile"
	| "plain";

export interface FileContextMap {
	language: ContextLanguage;
	symbols: ContextMapEntry[];
	symbolsTruncated?: boolean;
}

export type BatchTheme = {
	fg: (color: string, text: string) => string;
	bold: (s: string) => string;
	bg: (color: string, text: string) => string;
};
