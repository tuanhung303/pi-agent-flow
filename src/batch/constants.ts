/**
 * batch — constants and shared types.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_LINES = 3000;
export const MAX_BYTES = 100 * 1024; // 100KB
export const SAFE_FULL_READ_LIMIT = 400;
export const TARGETED_READ_LINE_LIMIT = 500;
export const MAX_CONTEXT_MAP_ENTRIES = 100;
export const MAX_TOTAL_RESULT_LINES = 1500;
export const BATCH_READ_MAX_TOTAL_BYTES = 150 * 1024; // 150KB
export const BASH_SOFT_TIMEOUT_MS = 20_000;
export const BASH_POLL_TAIL_LINES = 50;
export const MAX_BASH_OUTPUT_BYTES = 100 * 1024; // 100KB
export const MAX_BASH_OUTPUT_LINES = 4000;

// ---------------------------------------------------------------------------
// Shell output compression
// ---------------------------------------------------------------------------

export const COMPRESS_TOKEN_FLOOR = 50;
export const COMPRESS_VERBATIM_MAX_TOKENS = 8000;
export const COMPRESS_SAFETY_SCAN_HEAD = 5;
export const COMPRESS_SAFETY_SCAN_TAIL = 5;
export const COMPRESS_SAFETY_SCAN_MAX_NEEDLES = 20;
export const COMPRESS_TERSE_MIN_SAVINGS_PCT = 3;
export const COMPRESS_PASSTHROUGH_PATTERNS: RegExp[] = [
	/\bnpm\s+(run\s+(dev|watch|serve)|start)\b/,
	/\byarn\s+(run\s+(dev|watch|serve)|start)\b/,
	/\bpnpm\s+(run\s+(dev|watch|serve)|start)\b/,
	/\bcargo\s+(watch|run)\b/,
	/\bpython\s+-m\s+http\.server\b/,
	/\blive-server\b/,
	/\bpi\b/,
	/\blean-ctx\b/,
	/\b(az|gcloud|firebase)\s+(login|auth)\b/,
	/\bnext\s+dev\b/,
	/\bnuxt\s+dev\b/,
	/\bsvelte-kit\s+dev\b/,
	/\bastro\s+dev\b/,
	/\bnodemon\b/,
	/\bwebpack-dev-server\b/,
];
export const COMPRESS_VERBATIM_PATTERNS: RegExp[] = [
	/\b(cat|curl|jq|yq|head|tail|less|more)\b/,
	/\bkubectl\s+get\b.*\s+-o\s*(yaml|json)\b/,
	/\bdocker\s+inspect\b/,
	/\bterraform\s+output\b/,
	/\bstripe\s+\S+\s+list\b/,
	/\bgh\s+api\b/,
];
export const COMPRESS_SAFETY_NEEDLES: string[] = [
	"error",
	"failed",
	"fatal",
	"panic",
	"exception",
	"aborted",
	"warning",
	"critical",
	"ERR",
];
export const RG_SIGNATURES_MAX_FILES = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EditReplacement {
	f: string;
	r: string;
}

export interface FileOpInput {
	o: "read" | "write" | "edit" | "delete" | "bash" | "rg";
	p: string;
	c?: string;
	e?: EditReplacement[];
	s?: number;
	l?: number;
	i?: string;
	t?: number;
	h?: string;
	q?: string;
	n?: number;
	u?: number;
}

export interface RgOpInput {
	o: "rg";
	p: string;
	q: string;
	l?: boolean;
	i?: boolean;
	t?: string;
	n?: number;
	u?: number;
}

export interface ContextMapEntry {
	kind: string;
	name: string;
	startLine: number;
	endLine: number;
	parent?: string;
	signature?: string;
}

export interface OpResult {
	op: "read" | "write" | "edit" | "delete" | "bash" | "rg";
	path: string;
	status: "ok" | "error" | "skipped" | "pending";
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
	enclosingSignatures?: Record<string, string>;
	error?: string;
	hint?: string;
	id?: string;
	command?: string;
	exitCode?: number;
	stdout?: string;
	stderr?: string;
	duration?: number;
	timingTier?: string;
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

export interface PendingBashResult {
	id: string;
	command: string;
	status: "pending" | "completed";
	exitCode?: number;
	stdout?: string;
	stderr?: string;
	duration?: number;
	timingTier?: string;
}

export type BashOpResult = OpResult;
