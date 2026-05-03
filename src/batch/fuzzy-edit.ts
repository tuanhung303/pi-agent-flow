/**
 * batch — fuzzy matching and edit application.
 *
 * Normalises trailing whitespace to allow inexact text matches, then applies
 * one or more edits to a file's content while preserving offsets.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { EditReplacement } from "./constants.js";

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: string): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function detectLineEnding(content: string): string {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF")
		? { bom: "\uFEFF", text: content.slice(1) }
		: { bom: "", text: content };
}

// ---------------------------------------------------------------------------
// Fuzzy matching
// ---------------------------------------------------------------------------

function normalizeForMatch(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n");
}

function buildPositionMap(original: string): number[] {
	const normalized = normalizeForMatch(original);
	const map: number[] = new Array(normalized.length + 1);
	let oi = 0;
	let ni = 0;

	while (oi < original.length && ni < normalized.length) {
		map[ni] = oi;
		if (original[oi] === normalized[ni]) {
			oi++;
			ni++;
		} else {
			oi++;
		}
	}

	while (ni < normalized.length) {
		map[ni] = oi;
		ni++;
	}

	map[normalized.length] = original.length;
	return map;
}

export function fuzzyFindText(
	content: string,
	oldText: string,
): { found: boolean; index: number; matchLength: number; isExact: boolean } {
	// Try exact match first
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return { found: true, index: exactIndex, matchLength: oldText.length, isExact: true };
	}

	// Try trimmed match, returning original indices
	const normalizedContent = normalizeForMatch(content);
	const normalizedOld = normalizeForMatch(oldText);
	const fuzzyIndex = normalizedContent.indexOf(normalizedOld);
	if (fuzzyIndex !== -1) {
		const map = buildPositionMap(content);
		const originalStart = map[fuzzyIndex];
		const originalEnd = map[fuzzyIndex + normalizedOld.length];
		return { found: true, index: originalStart, matchLength: originalEnd - originalStart, isExact: false };
	}

	return { found: false, index: -1, matchLength: 0, isExact: false };
}

function countOccurrences(content: string, oldText: string): number {
	const normalizedContent = normalizeForMatch(content);
	const normalizedOld = normalizeForMatch(oldText);
	let count = 0;
	let pos = 0;
	while (true) {
		const idx = normalizedContent.indexOf(normalizedOld, pos);
		if (idx === -1) break;
		count++;
		pos = idx + normalizedOld.length;
	}
	return count;
}

function countExactOccurrences(content: string, oldText: string): number {
	let count = 0;
	let pos = 0;
	while (true) {
		const idx = content.indexOf(oldText, pos);
		if (idx === -1) break;
		count++;
		pos = idx + oldText.length;
	}
	return count;
}

// ---------------------------------------------------------------------------
// Edit application
// ---------------------------------------------------------------------------

function applyFuzzyEdit(
	content: string,
	matchIndex: number,
	matchLength: number,
	oldText: string,
	newText: string,
): string {
	const before = content.substring(0, matchIndex);
	const after = content.substring(matchIndex + matchLength);
	const matched = content.substring(matchIndex, matchIndex + matchLength);

	const matchedLines = matched.split("\n");
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");

	const resultLines: string[] = [];
	for (let i = 0; i < newLines.length; i++) {
		const newLine = newLines[i];
		const oldLine = oldLines[i] ?? "";
		const matchedLine = matchedLines[i] ?? "";

		const oldTrailing = oldLine.length - oldLine.trimEnd().length;
		const matchedTrailing = matchedLine.length - matchedLine.trimEnd().length;

		if (matchedTrailing > oldTrailing) {
			const extraStart = matchedLine.trimEnd().length + oldTrailing;
			resultLines.push(newLine + matchedLine.slice(extraStart));
		} else {
			resultLines.push(newLine);
		}
	}

	return before + resultLines.join("\n") + after;
}

export function applyEdits(
	content: string,
	edits: EditReplacement[],
	filePath: string,
): { newContent: string; blocksChanged: number } {
	const normalizedEdits = edits.map((e) => ({
		oldText: normalizeToLF(e.f),
		newText: normalizeToLF(e.r),
	}));

	// Validate non-empty
	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw new Error(`edits[${i}].f (oldText) must not be empty in ${filePath}.`);
		}
	}

	const baseContent = content;

	// Match all edits
	interface MatchResult {
		editIndex: number;
		matchIndex: number;
		matchLength: number;
		newText: string;
		oldText: string;
		isExact: boolean;
	}

	const matchedEdits: MatchResult[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(baseContent, edit.oldText);

		if (!matchResult.found) {
			throw new Error(
				edits.length === 1
					? `Could not find the exact text in ${filePath}. The old text must match exactly including all whitespace and newlines.`
					: `Could not find edits[${i}] in ${filePath}. The f (oldText) must match exactly including all whitespace and newlines.`,
			);
		}

		const occurrences = matchResult.isExact
			? countExactOccurrences(baseContent, edit.oldText)
			: countOccurrences(baseContent, edit.oldText);
		if (occurrences > 1) {
			throw new Error(
				edits.length === 1
					? `Found ${occurrences} occurrences of the text in ${filePath}. The text must be unique. Please provide more context to make it unique.`
					: `Found ${occurrences} occurrences of edits[${i}] in ${filePath}. Each f (oldText) must be unique. Please provide more context to make it unique.`,
			);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			newText: edit.newText,
			oldText: edit.oldText,
			isExact: matchResult.isExact,
		});
	}

	// Sort by position (ascending)
	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);

	// Check for overlaps
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${filePath}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	// Apply edits in reverse order to preserve offsets
	let newContent = baseContent;
	for (let i = matchedEdits.length - 1; i >= 0; i--) {
		const edit = matchedEdits[i];
		if (edit.isExact) {
			newContent =
				newContent.substring(0, edit.matchIndex) +
				edit.newText +
				newContent.substring(edit.matchIndex + edit.matchLength);
		} else {
			newContent = applyFuzzyEdit(
				newContent,
				edit.matchIndex,
				edit.matchLength,
				edit.oldText,
				edit.newText,
			);
		}
	}

	if (baseContent === newContent) {
		throw new Error(
			edits.length === 1
				? `No changes made to ${filePath}. The replacement produced identical content.`
				: `No changes made to ${filePath}. The replacements produced identical content.`,
		);
	}

	return {
		newContent,
		blocksChanged: matchedEdits.length,
	};
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

export function expandTilde(inputPath: string): string {
	if (inputPath === "~") return os.homedir();
	if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
	return inputPath;
}

export function isWithinDirectory(child: string, parent: string): boolean {
	if (process.platform === "win32") {
		const childLower = child.toLowerCase();
		const parentLower = parent.toLowerCase();
		if (childLower === parentLower) return true;
		const sep = path.win32.sep;
		const prefix = parentLower.endsWith(sep) ? parentLower : parentLower + sep;
		return childLower.startsWith(prefix);
	}
	if (child === parent) return true;
	if (parent === "/") return child.startsWith("/");
	return child.startsWith(parent + path.sep);
}

export async function validatePath(inputPath: string, cwd: string): Promise<string> {
	const expandedPath = expandTilde(inputPath);
	return path.resolve(cwd, expandedPath);
}

// ---------------------------------------------------------------------------
// Levenshtein distance (used by execute for suggestions)
// ---------------------------------------------------------------------------

export function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
	for (let i = 0; i <= m; i++) dp[i][0] = i;
	for (let j = 0; j <= n; j++) dp[0][j] = j;
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] =
				a[i - 1] === b[j - 1]
					? dp[i - 1][j - 1]
					: 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
		}
	}
	return dp[m][n];
}
