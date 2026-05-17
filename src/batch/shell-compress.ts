/**
 * Shell output compression pipeline for batch bash tool.
 *
 * Classifies commands by output policy, applies specific compressors for
 * known tools (git, npm, cargo), and falls back through a tiered cleanup
 * chain. Compression runs BEFORE truncation; truncation remains the safety net.
 */

import {
	COMPRESS_TOKEN_FLOOR,
	COMPRESS_VERBATIM_MAX_TOKENS,
	COMPRESS_SAFETY_SCAN_HEAD,
	COMPRESS_SAFETY_SCAN_TAIL,
	COMPRESS_SAFETY_SCAN_MAX_NEEDLES,
	COMPRESS_TERSE_MIN_SAVINGS_PCT,
	COMPRESS_PASSTHROUGH_PATTERNS,
	COMPRESS_VERBATIM_PATTERNS,
	COMPRESS_SAFETY_NEEDLES,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Output policy
// ---------------------------------------------------------------------------

export enum OutputPolicy {
	Passthrough = 0,
	Verbatim = 1,
	Compressible = 2,
}

export function classify(command: string): OutputPolicy {
	if (isPassthroughCommand(command)) return OutputPolicy.Passthrough;
	if (isVerbatimCommand(command)) return OutputPolicy.Verbatim;
	return OutputPolicy.Compressible;
}

function isPassthroughCommand(cmd: string): boolean {
	const lower = cmd.toLowerCase();
	if (COMPRESS_PASSTHROUGH_PATTERNS.some((p) => p.test(lower))) return true;

	const tokens = lower.trim().split(/\s+/);
	const base = tokens[0] ?? "";

	// Base commands that are always passthrough
	const alwaysPassthrough = new Set(["pi", "lean-ctx", "live-server", "nodemon", "webpack-dev-server", "watch"]);
	if (alwaysPassthrough.has(base)) return true;

	// CLI auth tools — only login/auth subcommands
	if (base === "az" || base === "gcloud" || base === "firebase") {
		return tokens.slice(1).some((t) => t === "login" || t === "auth");
	}

	// Package managers — specific subcommands only
	if (base === "npm" || base === "yarn" || base === "pnpm") {
		for (let i = 1; i < tokens.length; i++) {
			if (tokens[i] === "start") return true;
			if (tokens[i] === "run" && ["dev", "watch", "serve"].includes(tokens[i + 1])) return true;
		}
		return false;
	}

	// Cargo
	if (base === "cargo") {
		return tokens.slice(1).some((t) => t === "watch" || t === "run");
	}

	// Python http.server
	if (base === "python" || base === "python3") {
		return tokens.includes("-m") && tokens.includes("http.server");
	}

	// Vite — dev server when invoked as 'vite' or 'vite dev'
	if (base === "vite") {
		return tokens.length === 1 || tokens[1] === "dev";
	}

	return false;
}

function isVerbatimCommand(cmd: string): boolean {
	const lower = cmd.toLowerCase();
	if (COMPRESS_VERBATIM_PATTERNS.some((p) => p.test(lower))) return true;
	return false;
}

// ---------------------------------------------------------------------------
// Public pipeline
// ---------------------------------------------------------------------------

export interface CompressionResult {
	stdout: string;
	stderr: string;
	savingsPct: number;
}

export function compressOutput(
	command: string,
	stdout: string,
	stderr: string,
): CompressionResult {
	const original = stdout + stderr;
	if (estimateTokens(original) < COMPRESS_TOKEN_FLOOR) {
		return { stdout, stderr, savingsPct: 0 };
	}

	const policy = classify(command);

	if (policy === OutputPolicy.Passthrough) {
		return { stdout, stderr, savingsPct: 0 };
	}

	if (policy === OutputPolicy.Verbatim) {
		const cOut = truncateVerbatim(stdout);
		const cErr = truncateVerbatim(stderr);
		const compressed = cOut + cErr;
		return {
			stdout: cOut,
			stderr: cErr,
			savingsPct: calcSavings(original, compressed),
		};
	}

	// Compressible pipeline
	const patternStdout = trySpecificPattern(command, stdout) ?? stdout;
	const patternStderr = trySpecificPattern(command, stderr) ?? stderr;

	// Tier 1: terse filter on pattern result (or raw if no pattern matched)
	const tOut = terseFilter(patternStdout);
	const tErr = terseFilter(patternStderr);
	if (shorterThan(tOut + tErr, original, COMPRESS_TERSE_MIN_SAVINGS_PCT)) {
		return {
			stdout: tOut,
			stderr: tErr,
			savingsPct: calcSavings(original, tOut + tErr),
		};
	}

	// Tier 2: lightweight cleanup on original
	const lOut = lightweightCleanup(stdout);
	const lErr = lightweightCleanup(stderr);
	if (shorterThan(lOut + lErr, original, 0)) {
		return {
			stdout: lOut,
			stderr: lErr,
			savingsPct: calcSavings(original, lOut + lErr),
		};
	}

	// Tier 3: safety-scan truncation on lightweight-cleanup result
	const sOut = truncateWithSafetyScan(lOut.split("\n")) ?? lOut;
	const sErr = truncateWithSafetyScan(lErr.split("\n")) ?? lErr;
	if (shorterThan(sOut + sErr, original, 0)) {
		return {
			stdout: sOut,
			stderr: sErr,
			savingsPct: calcSavings(original, sOut + sErr),
		};
	}

	// Nothing helped — return original
	return { stdout, stderr, savingsPct: 0 };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function calcSavings(original: string, compressed: string): number {
	if (!original) return 0;
	return Math.max(0, Math.round(((original.length - compressed.length) / original.length) * 100));
}

function shorterThan(candidate: string, baseline: string, minPct: number): boolean {
	if (!baseline) return false;
	const saved = ((baseline.length - candidate.length) / baseline.length) * 100;
	return saved > minPct;
}

function truncateVerbatim(text: string): string {
	if (!text) return text;
	if (estimateTokens(text) <= COMPRESS_VERBATIM_MAX_TOKENS) return text;
	const lines = text.split("\n");
	const head = 30;
	const tail = 20;
	if (lines.length <= head + tail) return text;
	const kept = [...lines.slice(0, head), `[${lines.length - head - tail} lines omitted]`, ...lines.slice(-tail)];
	return kept.join("\n");
}

// ---------------------------------------------------------------------------
// Terse filter
// ---------------------------------------------------------------------------

export function terseFilter(output: string): string {
	if (!output) return output;
	let result = output;

	// 1. Strip ANSI escape codes
	result = stripAnsi(result);

	// 2. Strip \r progress lines (lines that start with \r)
	let lines = result.split("\n");
	lines = lines.filter((line) => !line.startsWith("\r"));

	// 3. Collapse runs of 3+ blank lines to 1 blank line
	lines = collapseBlankLines(lines, 3);

	// 4. Strip pure decoration lines
	const decorationRe = /^[\s\u2500\u2550\u2502\u258C\u2504\u2508\u256D\u2570\u2503\u2523\u2517\u2533\u253B\u252B\u2554\u2557\u255A\u255D\u2551\u250C\u2510\u2518\u2524\u251C\u2534\u252C]+$/;
	lines = lines.filter((line) => !decorationRe.test(line));

	// 5. Strip trailing whitespace per line
	lines = lines.map((line) => line.trimEnd());

	result = lines.join("\n");

	// Quality gate: if result is <3% shorter, return original
	if (!shorterThan(result, output, COMPRESS_TERSE_MIN_SAVINGS_PCT)) {
		return output;
	}
	return result;
}

function collapseBlankLines(lines: string[], threshold: number): string[] {
	const result: string[] = [];
	let blankRun = 0;
	for (const line of lines) {
		if (line.trim() === "") {
			blankRun++;
		} else {
			if (blankRun >= threshold) {
				result.push("");
			} else {
				for (let i = 0; i < blankRun; i++) {
					result.push("");
				}
			}
			result.push(line);
			blankRun = 0;
		}
	}
	if (blankRun >= threshold) {
		result.push("");
	} else {
		for (let i = 0; i < blankRun; i++) {
			result.push("");
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Lightweight cleanup
// ---------------------------------------------------------------------------

export function lightweightCleanup(output: string): string {
	if (!output) return output;
	let result = stripAnsi(output);
	let lines = result.split("\n");
	lines = lines.map((line) => line.trimEnd());
	lines = collapseBlankLines(lines, 3);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Safety-scan truncation
// ---------------------------------------------------------------------------

export function truncateWithSafetyScan(lines: string[]): string | null {
	if (lines.length <= COMPRESS_SAFETY_SCAN_HEAD + COMPRESS_SAFETY_SCAN_TAIL) {
		return null;
	}

	const head = lines.slice(0, COMPRESS_SAFETY_SCAN_HEAD);
	const tail = lines.slice(-COMPRESS_SAFETY_SCAN_TAIL);
	const middle = lines.slice(COMPRESS_SAFETY_SCAN_HEAD, -COMPRESS_SAFETY_SCAN_TAIL);

	const safetyRe = new RegExp(
		"\\b(" + COMPRESS_SAFETY_NEEDLES.map((n) => escapeRegex(n)).join("|") + ")\\b",
		"i",
	);

	const safetyLines = middle.filter((line) => safetyRe.test(line));
	const keptSafety = safetyLines.slice(0, COMPRESS_SAFETY_SCAN_MAX_NEEDLES);

	const kept = [...head];
	if (keptSafety.length > 0) {
		kept.push(`[${middle.length} lines omitted, ${keptSafety.length} safety-relevant lines preserved]`);
		kept.push(...keptSafety);
	} else {
		kept.push(`[${middle.length} lines omitted]`);
	}
	kept.push(...tail);

	const result = kept.join("\n");
	const original = lines.join("\n");
	if (!shorterThan(result, original, 0)) return null;
	return result;
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Specific pattern dispatch
// ---------------------------------------------------------------------------

function trySpecificPattern(command: string, output: string): string | null {
	const lower = command.toLowerCase();
	if (lower.startsWith("git ")) {
		if (lower.includes(" log")) return gitLogCompress(command, output);
		if (lower.includes(" commit")) return gitCommitCompress(command, output);
		if (lower.includes(" push")) return gitPushCompress(command, output);
	}
	if (lower.startsWith("npm ") || lower.startsWith("pnpm ") || lower.startsWith("yarn ")) {
		if (lower.includes(" install") || lower.includes(" ci") || lower.includes(" add ")) return npmInstallCompress(command, output);
		if (lower.includes(" test") || lower.includes(" run test")) return npmTestCompress(command, output);
	}
	if (lower.startsWith("cargo ")) {
		return cargoCompress(command, output);
	}
	return null;
}

// ---------------------------------------------------------------------------
// Git log compressor
// ---------------------------------------------------------------------------

function gitLogCompress(command: string, output: string): string {
	if (!output.trim()) return output;
	const lines = output.split("\n");
	const lower = command.toLowerCase();

	// --oneline variant
	if (lower.includes("--oneline") || lines[0]?.match(/^[a-f0-9]{7,}\s/)) {
		return gitOnelineCompress(lines);
	}

	// --stat variant: keep stat lines, strip Author/Date/Merge headers
	if (lower.includes("--stat")) {
		return gitStatCompress(lines);
	}

	// Full log with diffs
	return gitFullLogCompress(output);
}

function gitOnelineCompress(lines: string[]): string {
	const nonEmpty = lines.filter((l) => l.trim());
	if (nonEmpty.length <= 100) return lines.join("\n");
	const kept = nonEmpty.slice(0, 100);
	return kept.join("\n") + `\n...(${nonEmpty.length - 100} more)`;
}

function gitStatCompress(lines: string[]): string {
	const out: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (/^(Author|Date|Merge):/.test(trimmed)) continue;
		if (/^commit\s+[a-f0-9]+/.test(trimmed)) {
			out.push(trimmed.split(" ")[1].slice(0, 7));
			continue;
		}
		// Keep stat and summary lines
		if (/\d+ files? changed/.test(trimmed) || /^.+\|\s*\d+\s*[+-]*$/.test(trimmed)) {
			out.push(trimmed);
		}
	}
	return out.join("\n");
}

interface CommitBlock {
	hash: string;
	message: string;
	diff: string;
	stat: string;
}

function gitFullLogCompress(output: string): string {
	const blocks = parseCommitBlocks(output);
	if (blocks.length === 0) return output;

	let totalAdd = 0;
	let totalDel = 0;

	if (blocks.length <= 3) {
		return blocks
			.map((b) => formatCommitBlock(b, true))
			.join("\n");
	}

	if (blocks.length <= 20) {
		const parts: string[] = [];
		blocks.forEach((b, i) => {
			const full = i === 0;
			parts.push(formatCommitBlock(b, full));
			const s = parseDiffStat(b.stat || b.diff);
			totalAdd += s.add;
			totalDel += s.del;
		});
		return parts.join("\n");
	}

	// >20 commits
	const lines: string[] = [];
	blocks.forEach((b) => {
		lines.push(`${b.hash} ${b.message}`);
		const s = parseDiffStat(b.stat || b.diff);
		totalAdd += s.add;
		totalDel += s.del;
	});
	lines.push(`[${blocks.length} commits, +${totalAdd}/-${totalDel}]`);
	return lines.join("\n");
}

function parseCommitBlocks(output: string): CommitBlock[] {
	const rawBlocks = output.split(/^commit ([a-f0-9]{7,})/m).slice(1);
	const blocks: CommitBlock[] = [];
	for (let i = 0; i < rawBlocks.length; i += 2) {
		const hash = rawBlocks[i]?.trim().slice(0, 7) ?? "";
		const body = rawBlocks[i + 1] ?? "";
		const lines = body.split("\n");

		let message = "";
		let inDiff = false;
		let inMessage = false;
		const diffLines: string[] = [];
		let statLine = "";

		for (const line of lines) {
			if (line.startsWith("diff --git")) {
				inDiff = true;
				inMessage = false;
			}
			if (inDiff) {
				diffLines.push(line);
				if (/\d+ files? changed/.test(line)) {
					statLine = line.trim();
				}
				continue;
			}
			if (!inDiff && /\d+ files? changed/.test(line)) {
				statLine = line.trim();
				continue;
			}
			if (line.trim() === "") {
				if (inMessage) inMessage = false;
				continue;
			}
			if (line.match(/^(Author|Date|Merge):/)) continue;
			if (!inMessage && line.startsWith("    ")) {
				inMessage = true;
				message = line.trim();
			}
		}

		blocks.push({
			hash,
			message,
			diff: diffLines.join("\n"),
			stat: statLine,
		});
	}
	return blocks;
}

function formatCommitBlock(block: CommitBlock, fullDiff: boolean): string {
	if (fullDiff && block.diff) {
		const lines = block.diff.split("\n").filter((l) => l.trim());
		return `${block.hash} ${block.message}\n${lines.slice(0, 30).join("\n")}`;
	}
	const s = parseDiffStat(block.stat || block.diff);
	return `${block.hash} ${block.message} [${s.files} files] +${s.add}/-${s.del}`;
}

function parseDiffStat(text: string): { files: number; add: number; del: number } {
	const m = text.match(/(\d+) files? changed(?:,?\s*(\d+) insertions?\(\+\))?(?:,?\s*(\d+) deletions?\(-\))?/);
	if (m) {
		return { files: parseInt(m[1], 10), add: parseInt(m[2] ?? "0", 10), del: parseInt(m[3] ?? "0", 10) };
	}
	return { files: 0, add: 0, del: 0 };
}

// ---------------------------------------------------------------------------
// Git commit compressor
// ---------------------------------------------------------------------------

function gitCommitCompress(_command: string, output: string): string {
	const lines = output.split("\n");
	let commitIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/^\[[^\]]+\s+[a-f0-9]+\]/.test(lines[i]!)) {
			commitIdx = i;
			break;
		}
	}

	if (commitIdx === -1) {
		// No recognisable commit line — fall back to terse filter behaviour later
		return output;
	}

	const hookLines = lines.slice(0, commitIdx).filter((l) => l.trim());
	const commitAndAfter = lines.slice(commitIdx);

	// Hook summary
	const failedLines = hookLines.filter((l) => /(fail|error)/i.test(l));
	const passed = hookLines.length - failedLines.length;
	const hookSummary = failedLines.length === 0
		? `${passed} hooks passed`
		: `${passed} passed, ${failedLines.length} failed`;

	const failedDetail = failedLines.length > 0
		? "\n" + failedLines.slice(0, 5).join("\n")
		: "";

	// Commit line + stats
	const commitLine = commitAndAfter[0] ?? "";
	const match = commitLine.match(/^\[([^\]]+)\s+([a-f0-9]+)\]\s*(.*)$/);
	let commitSummary = commitLine;
	if (match) {
		const branch = match[1]!;
		const hash = match[2]!.slice(0, 7);
		const message = match[3]!;
		const statText = commitAndAfter.slice(1).join("\n");
		const s = parseDiffStat(statText);
		commitSummary = `${hash} (${branch}) ${message} [${s.files} files, +${s.add}/-${s.del}]`;
	}

	return hookSummary + failedDetail + "\n" + commitSummary;
}

// ---------------------------------------------------------------------------
// Git push compressor
// ---------------------------------------------------------------------------

function gitPushCompress(_command: string, output: string): string {
	const lines = output.split("\n").filter((l) => l.trim());
	if (lines.some((l) => l.includes("Everything up-to-date"))) {
		return "ok (up-to-date)";
	}

	const kept: string[] = [];
	for (const line of lines) {
		if (line.includes("->")) {
			kept.push(line);
			continue;
		}
		if (/\brejected\b/i.test(line)) {
			kept.push(line);
			continue;
		}
		if (line.startsWith("remote:")) continue;
		// Keep other non-empty lines as "key lines"
		if (line.trim()) kept.push(line);
	}

	if (kept.length === 0) return output.trim();
	return kept.join("\n");
}

// ---------------------------------------------------------------------------
// npm install compressor
// ---------------------------------------------------------------------------

function npmInstallCompress(_command: string, output: string): string {
	const lines = output.split("\n");
	const treeLineRe = /^\+\s+.*@\d/;
	const summaryRe = /added\s+\d+\s+packages?\s+in/;

	const nonTree = lines.filter((l) => !treeLineRe.test(l));
	const summary = nonTree.find((l) => summaryRe.test(l));
	if (summary) {
		return summary.trim();
	}

	// No summary — keep last 3 non-tree lines
	const last = nonTree.filter((l) => l.trim()).slice(-3);
	if (last.length) return last.join("\n");
	return output.trim();
}

// ---------------------------------------------------------------------------
// npm test compressor
// ---------------------------------------------------------------------------

function npmTestCompress(_command: string, output: string): string {
	const keepRe = /^(PASS|FAIL|Test Suites:|Tests:|Snapshots:|Time:)/;
	const errorBlockRe = /\b(error|failed|fail)\b|ERR!/i;

	const lines = output.split("\n");
	const kept: string[] = [];
	let inErrorBlock = false;
	let errorBlockIndent: number | null = null;

	for (const line of lines) {
		if (keepRe.test(line)) {
			kept.push(line);
			continue;
		}

		// Start of error/failure detail block
		if (errorBlockRe.test(line) && !inErrorBlock) {
			inErrorBlock = true;
			errorBlockIndent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
			kept.push(line);
			continue;
		}

		if (inErrorBlock) {
			const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
			// Continue block while indented or blank
			if (line.trim() === "" || indent > (errorBlockIndent ?? 0)) {
				kept.push(line);
				continue;
			}
			inErrorBlock = false;
			errorBlockIndent = null;
		}
	}

	if (kept.length === 0) return output.trim();
	return kept.join("\n");
}

// ---------------------------------------------------------------------------
// Cargo compressor
// ---------------------------------------------------------------------------

function cargoCompress(_command: string, output: string): string {
	const lines = output.split("\n");
	let compilingCount = 0;
	let errorCount = 0;
	let warningCount = 0;
	let firstError: string | null = null;
	let firstWarning: string | null = null;
	const kept: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		if (/^Compiling\s+\S+\s+v\d/.test(trimmed)) {
			compilingCount++;
			continue;
		}
		if (/^Downloading\s+/.test(trimmed)) {
			continue;
		}
		if (/^test result:/.test(trimmed) || /^running\s+\d+\s+tests?/.test(trimmed)) {
			kept.push(trimmed);
			continue;
		}
		if (/^Finished/.test(trimmed) || /^Release/.test(trimmed)) {
			kept.push(trimmed);
			continue;
		}
		if (/\berror\b/i.test(trimmed) && !firstError) {
			firstError = trimmed;
		}
		if (/\berror\b/i.test(trimmed)) {
			errorCount++;
			continue;
		}
		if (/\bwarning\b/i.test(trimmed) && !firstWarning) {
			firstWarning = trimmed;
		}
		if (/\bwarning\b/i.test(trimmed)) {
			warningCount++;
			continue;
		}
		// Keep lines that don't match any stripping rule
		kept.push(trimmed);
	}

	const summary: string[] = [];
	if (compilingCount > 0) summary.push(`compiled ${compilingCount} crates`);
	if (firstError) summary.push(firstError + (errorCount > 1 ? ` (+${errorCount - 1} more)` : ""));
	if (firstWarning) summary.push(firstWarning + (warningCount > 1 ? ` (+${warningCount - 1} more)` : ""));

	return [...summary, ...kept].join("\n");
}
