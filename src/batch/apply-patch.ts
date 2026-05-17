/**
 * apply-patch — 1:1 port of OpenAI Codex CLI apply_patch tool.
 *
 * Parses patch text into hunks, locates context via 4-stage fuzzy matching,
 * computes replacements, and applies them to the filesystem.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Parser constants
// ---------------------------------------------------------------------------

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ENVIRONMENT_ID_MARKER = "*** Environment ID: ";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpdateFileChunk {
	changeContext?: string;
	oldLines: string[];
	newLines: string[];
	isEndOfFile: boolean;
}

export type Hunk =
	| { type: "add"; path: string; contents: string }
	| { type: "delete"; path: string }
	| { type: "update"; path: string; movePath?: string; chunks: UpdateFileChunk[] };

export interface ApplyPatchArgs {
	patch: string;
	hunks: Hunk[];
	environmentId?: string;
}

export class ParseError extends Error {
	constructor(
		public readonly kind: "invalid-patch" | "invalid-hunk",
		message: string,
		public readonly lineNumber?: number,
	) {
		super(message);
		this.name = "ParseError";
	}
}

export class ComputeReplacementsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ComputeReplacementsError";
	}
}

// ---------------------------------------------------------------------------
// Patch parser
// ---------------------------------------------------------------------------

function checkPatchBoundariesStrict(lines: string[]): { patchLines: string[]; hunkLines: string[] } {
	if (lines.length === 0) {
		throw new ParseError("invalid-patch", "The first line of the patch must be '*** Begin Patch'");
	}
	const first = lines[0].trim();
	const last = lines[lines.length - 1].trim();
	if (first !== BEGIN_PATCH_MARKER) {
		throw new ParseError("invalid-patch", "The first line of the patch must be '*** Begin Patch'");
	}
	if (last !== END_PATCH_MARKER) {
		throw new ParseError("invalid-patch", "The last line of the patch must be '*** End Patch'");
	}
	return { patchLines: lines, hunkLines: lines.slice(1, -1) };
}

function checkPatchBoundariesLenient(lines: string[]): { patchLines: string[]; hunkLines: string[] } {
	try {
		return checkPatchBoundariesStrict(lines);
	} catch (strictErr) {
		if (lines.length >= 4) {
			const first = lines[0].trim();
			const last = lines[lines.length - 1].trim();
			if (
				(first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') &&
				last.endsWith("EOF")
			) {
				const inner = lines.slice(1, -1);
				try {
					return checkPatchBoundariesStrict(inner);
				} catch {
					/* fall through to return original error */
				}
			}
		}
		throw strictErr;
	}
}

function parseEnvironmentIdPreamble(
	lines: string[],
): { environmentId?: string; remaining: string[]; lineNumber: number } {
	if (lines.length === 0) {
		return { remaining: lines, lineNumber: 2 };
	}
	const first = lines[0].trimStart();
	if (first.startsWith(ENVIRONMENT_ID_MARKER)) {
		const id = first.slice(ENVIRONMENT_ID_MARKER.length).trim();
		if (id === "") {
			throw new ParseError("invalid-patch", "apply_patch environment_id cannot be empty");
		}
		return { environmentId: id, remaining: lines.slice(1), lineNumber: 3 };
	}
	return { remaining: lines, lineNumber: 2 };
}

function parseUpdateFileChunk(
	lines: string[],
	lineNumber: number,
	allowMissingContext: boolean,
): { chunk: UpdateFileChunk; parsedLines: number } {
	if (lines.length === 0) {
		throw new ParseError("invalid-hunk", "Update hunk does not contain any lines", lineNumber);
	}

	let changeContext: string | undefined;
	let startIndex = 0;

	if (lines[0] === EMPTY_CHANGE_CONTEXT_MARKER) {
		changeContext = undefined;
		startIndex = 1;
	} else if (lines[0].startsWith(CHANGE_CONTEXT_MARKER)) {
		changeContext = lines[0].slice(CHANGE_CONTEXT_MARKER.length);
		startIndex = 1;
	} else {
		if (!allowMissingContext) {
			throw new ParseError(
				"invalid-hunk",
				`Expected update hunk to start with a @@ context marker, got: '${lines[0]}'`,
				lineNumber,
			);
		}
		changeContext = undefined;
		startIndex = 0;
	}

	if (startIndex >= lines.length) {
		throw new ParseError("invalid-hunk", "Update hunk does not contain any lines", lineNumber + 1);
	}

	const oldLines: string[] = [];
	const newLines: string[] = [];
	let isEndOfFile = false;
	let parsedLines = 0;

	for (let i = startIndex; i < lines.length; i++) {
		const line = lines[i];
		if (line === EOF_MARKER) {
			if (parsedLines === 0) {
				throw new ParseError(
					"invalid-hunk",
					"Update hunk does not contain any lines",
					lineNumber + 1,
				);
			}
			isEndOfFile = true;
			parsedLines += 1;
			break;
		}

		const firstChar = line.charAt(0);
		if (firstChar === "") {
			oldLines.push("");
			newLines.push("");
		} else if (firstChar === " ") {
			oldLines.push(line.slice(1));
			newLines.push(line.slice(1));
		} else if (firstChar === "+") {
			newLines.push(line.slice(1));
		} else if (firstChar === "-") {
			oldLines.push(line.slice(1));
		} else {
			if (parsedLines === 0) {
				throw new ParseError(
					"invalid-hunk",
					`Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
					lineNumber + 1,
				);
			}
			// Assume start of next hunk.
			break;
		}
		parsedLines += 1;
	}

	return {
		chunk: { changeContext, oldLines, newLines, isEndOfFile },
		parsedLines: parsedLines + startIndex,
	};
}

function parseOneHunk(lines: string[], lineNumber: number): { hunk: Hunk; parsedLines: number } {
	const firstLine = lines[0].trim();

	if (firstLine.startsWith(ADD_FILE_MARKER)) {
		const filePath = firstLine.slice(ADD_FILE_MARKER.length);
		let contents = "";
		let parsedLines = 1;
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i];
			if (line.startsWith("+")) {
				contents += line.slice(1) + "\n";
				parsedLines += 1;
			} else {
				break;
			}
		}
		return { hunk: { type: "add", path: filePath, contents }, parsedLines };
	}

	if (firstLine.startsWith(DELETE_FILE_MARKER)) {
		const filePath = firstLine.slice(DELETE_FILE_MARKER.length);
		return { hunk: { type: "delete", path: filePath }, parsedLines: 1 };
	}

	if (firstLine.startsWith(UPDATE_FILE_MARKER)) {
		const filePath = firstLine.slice(UPDATE_FILE_MARKER.length);
		let remaining = lines.slice(1);
		let parsedLines = 1;

		let movePath: string | undefined;
		if (remaining.length > 0 && remaining[0].startsWith(MOVE_TO_MARKER)) {
			movePath = remaining[0].slice(MOVE_TO_MARKER.length);
			remaining = remaining.slice(1);
			parsedLines += 1;
		}

		const chunks: UpdateFileChunk[] = [];
		while (remaining.length > 0) {
			if (remaining[0].trim() === "") {
				parsedLines += 1;
				remaining = remaining.slice(1);
				continue;
			}
			if (remaining[0].startsWith("*")) {
				break;
			}

			const { chunk, parsedLines: chunkLines } = parseUpdateFileChunk(
				remaining,
				lineNumber + parsedLines,
				chunks.length === 0,
			);
			chunks.push(chunk);
			parsedLines += chunkLines;
			remaining = remaining.slice(chunkLines);
		}

		if (chunks.length === 0) {
			throw new ParseError(
				"invalid-hunk",
				`Update file hunk for path '${filePath}' is empty`,
				lineNumber,
			);
		}

		return { hunk: { type: "update", path: filePath, movePath, chunks }, parsedLines };
	}

	throw new ParseError(
		"invalid-hunk",
		`'${firstLine}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
		lineNumber,
	);
}

export function parsePatch(patch: string): ApplyPatchArgs {
	const trimmed = patch.trim();
	const lines = trimmed.split("\n");
	const { patchLines, hunkLines } = checkPatchBoundariesLenient(lines);

	const { environmentId, remaining, lineNumber } = parseEnvironmentIdPreamble(hunkLines);
	let remainingLines = remaining;
	let currentLine = lineNumber;
	const hunks: Hunk[] = [];

	while (remainingLines.length > 0) {
		const { hunk, parsedLines } = parseOneHunk(remainingLines, currentLine);
		hunks.push(hunk);
		currentLine += parsedLines;
		remainingLines = remainingLines.slice(parsedLines);
	}

	return {
		patch: patchLines.join("\n"),
		hunks,
		environmentId,
	};
}

// ---------------------------------------------------------------------------
// seek_sequence — 4-stage fuzzy matching
// ---------------------------------------------------------------------------

export function seekSequence(
	lines: string[],
	pattern: string[],
	start: number,
	eof: boolean,
): number | undefined {
	if (pattern.length === 0) {
		return start;
	}
	if (pattern.length > lines.length) {
		return undefined;
	}

	const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;

	// Stage 1: exact match
	for (let i = searchStart; i <= lines.length - pattern.length; i++) {
		let ok = true;
		for (let j = 0; j < pattern.length; j++) {
			if (lines[i + j] !== pattern[j]) {
				ok = false;
				break;
			}
		}
		if (ok) return i;
	}

	// Stage 2: rstrip match (ignore trailing whitespace)
	for (let i = searchStart; i <= lines.length - pattern.length; i++) {
		let ok = true;
		for (let j = 0; j < pattern.length; j++) {
			if (lines[i + j].trimEnd() !== pattern[j].trimEnd()) {
				ok = false;
				break;
			}
		}
		if (ok) return i;
	}

	// Stage 3: trim match (ignore leading and trailing whitespace)
	for (let i = searchStart; i <= lines.length - pattern.length; i++) {
		let ok = true;
		for (let j = 0; j < pattern.length; j++) {
			if (lines[i + j].trim() !== pattern[j].trim()) {
				ok = false;
				break;
			}
		}
		if (ok) return i;
	}

	// Stage 4: Unicode normalisation
	function normalise(s: string): string {
		return s
			.trim()
			.split("")
			.map((c) => {
				switch (c) {
					// Dashes / hyphens → ASCII '-'
					case "\u2010":
					case "\u2011":
					case "\u2012":
					case "\u2013":
					case "\u2014":
					case "\u2015":
					case "\u2212":
						return "-";
					// Fancy single quotes → '\''
					case "\u2018":
					case "\u2019":
					case "\u201A":
					case "\u201B":
						return "'";
					// Fancy double quotes → '"'
					case "\u201C":
					case "\u201D":
					case "\u201E":
					case "\u201F":
						return '"';
					// Odd spaces → normal space
					case "\u00A0":
					case "\u2002":
					case "\u2003":
					case "\u2004":
					case "\u2005":
					case "\u2006":
					case "\u2007":
					case "\u2008":
					case "\u2009":
					case "\u200A":
					case "\u202F":
					case "\u205F":
					case "\u3000":
						return " ";
					default:
						return c;
					}
				})
				.join("");
		}

	for (let i = searchStart; i <= lines.length - pattern.length; i++) {
		let ok = true;
		for (let j = 0; j < pattern.length; j++) {
			if (normalise(lines[i + j]) !== normalise(pattern[j])) {
				ok = false;
				break;
			}
		}
		if (ok) return i;
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// compute_replacements + apply_replacements
// ---------------------------------------------------------------------------

export function computeReplacements(
	originalLines: string[],
	filePath: string,
	chunks: UpdateFileChunk[],
): Array<{ startIdx: number; oldLen: number; newLines: string[] }> {
	const replacements: Array<{ startIdx: number; oldLen: number; newLines: string[] }> = [];
	let lineIndex = 0;

	for (const chunk of chunks) {
		if (chunk.changeContext) {
			const idx = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
			if (idx === undefined) {
				throw new ComputeReplacementsError(
					`Failed to find context '${chunk.changeContext}' in ${filePath}`,
				);
			}
			lineIndex = idx + 1;
		}

		if (chunk.oldLines.length === 0) {
			// Pure addition — insert at end (or just before the trailing empty line).
			const insertionIdx =
				originalLines.length > 0 && originalLines[originalLines.length - 1] === ""
					? originalLines.length - 1
					: originalLines.length;
			replacements.push({ startIdx: insertionIdx, oldLen: 0, newLines: chunk.newLines });
			continue;
		}

		let pattern = chunk.oldLines;
		let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		let newSlice = chunk.newLines;

		if (found === undefined && pattern.length > 0 && pattern[pattern.length - 1] === "") {
			// Retry without the trailing empty sentinel.
			pattern = pattern.slice(0, -1);
			if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") {
				newSlice = newSlice.slice(0, -1);
			}
			found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		}

		if (found === undefined) {
			throw new ComputeReplacementsError(
				`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`,
			);
		}

		replacements.push({ startIdx: found, oldLen: pattern.length, newLines: newSlice });
		lineIndex = found + pattern.length;
	}

	replacements.sort((a, b) => a.startIdx - b.startIdx);
	return replacements;
}

export function applyReplacements(
	lines: string[],
	replacements: Array<{ startIdx: number; oldLen: number; newLines: string[] }>,
): string[] {
	const result = [...lines];
	for (let i = replacements.length - 1; i >= 0; i--) {
		const { startIdx, oldLen, newLines } = replacements[i];
		result.splice(startIdx, oldLen, ...newLines);
	}
	return result;
}

function deriveNewContentsFromChunks(
	originalContent: string,
	chunks: UpdateFileChunk[],
	filePath: string,
): string {
	let originalLines = originalContent.split("\n").map((l) => l);

	// Drop the trailing empty element that results from the final newline
	// so that line counts match the behaviour of standard diff.
	if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
		originalLines.pop();
	}

	const replacements = computeReplacements(originalLines, filePath, chunks);
	let newLines = applyReplacements(originalLines, replacements);

	// Ensure file terminates with a newline.
	if (newLines.length === 0 || newLines[newLines.length - 1] !== "") {
		newLines.push("");
	}

	return newLines.join("\n");
}

// ---------------------------------------------------------------------------
// Apply engine
// ---------------------------------------------------------------------------

export interface AffectedPaths {
	added: string[];
	modified: string[];
	deleted: string[];
}

export async function applyPatch(
	patchText: string,
	cwd: string,
): Promise<{ affected: AffectedPaths; exact: boolean }> {
	const args = parsePatch(patchText);
	const added: string[] = [];
	const modified: string[] = [];
	const deleted: string[] = [];
	let exact = true;

	for (const hunk of args.hunks) {
		switch (hunk.type) {
			case "add": {
				const targetPath = path.resolve(cwd, hunk.path);
				await fs.mkdir(path.dirname(targetPath), { recursive: true });
				await fs.writeFile(targetPath, hunk.contents, "utf-8");
				added.push(hunk.path);
				break;
			}
			case "delete": {
				const targetPath = path.resolve(cwd, hunk.path);
				try {
					await fs.unlink(targetPath);
				} catch (err: any) {
					if (err.code === "ENOENT") {
						exact = false;
					} else {
						throw err;
					}
				}
				deleted.push(hunk.path);
				break;
			}
			case "update": {
				const targetPath = path.resolve(cwd, hunk.path);
				let originalContent: string;
				try {
					originalContent = await fs.readFile(targetPath, "utf-8");
				} catch (err: any) {
					if (err.code === "ENOENT") {
						throw new Error(`File not found: ${hunk.path}`);
					}
					throw err;
				}
				const newContent = deriveNewContentsFromChunks(originalContent, hunk.chunks, hunk.path);

				if (hunk.movePath) {
					const destPath = path.resolve(cwd, hunk.movePath);
					await fs.mkdir(path.dirname(destPath), { recursive: true });
					await fs.writeFile(destPath, newContent, "utf-8");
					try {
						await fs.unlink(targetPath);
					} catch (err: any) {
						if (err.code === "ENOENT") {
							exact = false;
						} else {
							throw err;
						}
					}
					modified.push(hunk.movePath);
				} else {
					await fs.writeFile(targetPath, newContent, "utf-8");
					modified.push(hunk.path);
				}
				break;
			}
		}
	}

	return { affected: { added, modified, deleted }, exact };
}
