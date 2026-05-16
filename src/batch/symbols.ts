/**
 * batch — symbol extraction and context-map building.
 *
 * Parses source files to produce a navigable symbol map for context-aware
 * reading of large files.
 */

import * as path from "node:path";
import {
	type ContextLanguage,
	type ContextMapEntry,
	type FileContextMap,
	MAX_CONTEXT_MAP_ENTRIES,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------

function countLeadingWhitespace(line: string): number {
	return line.match(/^\s*/)?.[0].length ?? 0;
}

function findBraceBlockEnd(lines: string[], startIndex: number): number {
	let depth = 0;
	let sawOpenBrace = false;

	for (let i = startIndex; i < lines.length; i++) {
		for (const char of lines[i]) {
			if (char === "{") {
				depth++;
				sawOpenBrace = true;
			} else if (char === "}") {
				depth--;
			}
		}
		if (sawOpenBrace && depth <= 0) return i + 1;
	}

	return sawOpenBrace ? lines.length : startIndex + 1;
}

function findStatementEnd(lines: string[], startIndex: number): number {
	for (let i = startIndex; i < lines.length; i++) {
		if (lines[i].includes(";")) return i + 1;
	}
	return startIndex + 1;
}

function findIndentedBlockEnd(lines: string[], startIndex: number, indent: number): number {
	for (let i = startIndex + 1; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		if (countLeadingWhitespace(lines[i]) <= indent) return i;
	}
	return lines.length;
}

function findYamlBlockEnd(lines: string[], startIndex: number, indent: number): number {
	for (let i = startIndex + 1; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		if (trimmed === "---" || countLeadingWhitespace(lines[i]) <= indent) return i;
	}
	return lines.length;
}

function extractTsJsSymbols(lines: string[]): ContextMapEntry[] {
	const entries: ContextMapEntry[] = [];
	const classes: ContextMapEntry[] = [];

	function makeSignature(line: string): string {
		return line.trim().replace(/\s*\{\s*$/, "").trim();
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		let match = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
		if (match) {
			entries.push({ kind: "function", name: match[1], startLine: i + 1, endLine: findBraceBlockEnd(lines, i), signature: makeSignature(line) });
			continue;
		}

		match = line.match(/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)\b/);
		if (match) {
			const entry = { kind: "class", name: match[1], startLine: i + 1, endLine: findBraceBlockEnd(lines, i), signature: makeSignature(line) };
			entries.push(entry);
			classes.push(entry);
			continue;
		}

		match = line.match(/^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/);
		if (match) {
			entries.push({ kind: "interface", name: match[1], startLine: i + 1, endLine: findBraceBlockEnd(lines, i), signature: makeSignature(line) });
			continue;
		}

		match = line.match(/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/);
		if (match) {
			entries.push({ kind: "type", name: match[1], startLine: i + 1, endLine: line.includes("{") ? findBraceBlockEnd(lines, i) : findStatementEnd(lines, i), signature: line.trim() });
			continue;
		}

		match = line.match(/^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/);
		if (match) {
			entries.push({ kind: "enum", name: match[1], startLine: i + 1, endLine: findBraceBlockEnd(lines, i), signature: makeSignature(line) });
			continue;
		}

		match = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/);
		if (match) {
			entries.push({ kind: "function", name: match[1], startLine: i + 1, endLine: line.includes("{") ? findBraceBlockEnd(lines, i) : findStatementEnd(lines, i), signature: line.trim() });
		}
	}

	const methodNameBlacklist = new Set(["if", "for", "while", "switch", "catch", "function"]);
	for (const classEntry of classes) {
		for (let i = classEntry.startLine; i < classEntry.endLine - 1 && i < lines.length; i++) {
			const match = lines[i].match(/^\s*(?:(?:public|private|protected|static|async|override|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]+>)?\s*\([^)]*\)\s*(?::\s*[^={]+)?\s*\{/);
			if (!match || methodNameBlacklist.has(match[1])) continue;
			entries.push({
				kind: "method",
				name: `${classEntry.name}.${match[1]}`,
				parent: classEntry.name,
				startLine: i + 1,
				endLine: findBraceBlockEnd(lines, i),
				signature: makeSignature(lines[i]),
			});
		}
	}

	return entries;
}

function extractPythonSymbols(lines: string[]): ContextMapEntry[] {
	const entries: ContextMapEntry[] = [];
	const classes: Array<ContextMapEntry & { indent: number }> = [];

	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(/^(\s*)class\s+([A-Za-z_]\w*)\b/);
		if (!match) continue;
		const indent = match[1].length;
		const entry = { kind: "class", name: match[2], startLine: i + 1, endLine: findIndentedBlockEnd(lines, i, indent), indent, signature: lines[i].trim() };
		classes.push(entry);
		entries.push(entry);
	}

	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
		if (!match) continue;
		const indent = match[1].length;
		const parent = classes.find((cls) => i + 1 > cls.startLine && i + 1 < cls.endLine && indent > cls.indent);
		entries.push({
			kind: parent ? "method" : "function",
			name: parent ? `${parent.name}.${match[2]}` : match[2],
			parent: parent?.name,
			startLine: i + 1,
			endLine: findIndentedBlockEnd(lines, i, indent),
			signature: lines[i].trim(),
		});
	}

	return entries;
}

function extractTerraformSymbols(lines: string[]): ContextMapEntry[] {
	const entries: ContextMapEntry[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		let match = line.match(/^\s*(resource|data)\s+"([^"]+)"\s+"([^"]+)"\s*\{/);
		if (match) {
			entries.push({ kind: match[1], name: `${match[2]}.${match[3]}`, startLine: i + 1, endLine: findBraceBlockEnd(lines, i) });
			continue;
		}

		match = line.match(/^\s*(module|variable|output|provider)\s+"([^"]+)"\s*\{/);
		if (match) {
			entries.push({ kind: match[1], name: match[2], startLine: i + 1, endLine: findBraceBlockEnd(lines, i) });
			continue;
		}

		match = line.match(/^\s*(locals|terraform)\s*\{/);
		if (match) {
			entries.push({ kind: match[1], name: match[1], startLine: i + 1, endLine: findBraceBlockEnd(lines, i) });
			continue;
		}

		match = line.match(/^([A-Za-z_][\w-]*)\s*=/);
		if (match) {
			entries.push({ kind: "assignment", name: match[1], startLine: i + 1, endLine: i + 1 });
		}
	}

	return entries;
}

function extractYamlSymbols(lines: string[]): ContextMapEntry[] {
	const entries: ContextMapEntry[] = [];

	let docStart = 0;
	for (let i = 0; i <= lines.length; i++) {
		if (i < lines.length && lines[i].trim() !== "---") continue;
		const docEnd = i === lines.length ? lines.length : i;
		const docLines = lines.slice(docStart, docEnd);
		const kindLine = docLines.findIndex((line) => /^kind:\s*\S+/.test(line));
		const nameLine = docLines.findIndex((line) => /^\s{2}name:\s*\S+/.test(line));
		if (kindLine >= 0 && nameLine >= 0) {
			const kind = docLines[kindLine].replace(/^kind:\s*/, "").trim();
			const name = docLines[nameLine].replace(/^\s{2}name:\s*/, "").trim();
			entries.push({ kind, name, startLine: docStart + 1, endLine: Math.max(docStart + 1, docEnd) });
		}
		docStart = i + 1;
	}

	for (let i = 0; i < lines.length; i++) {
		const topLevel = lines[i].match(/^([A-Za-z_][\w.-]*):\s*/);
		if (topLevel) {
			const key = topLevel[1];
			entries.push({ kind: "section", name: key, startLine: i + 1, endLine: findYamlBlockEnd(lines, i, 0) });

			if (["jobs", "services", "volumes", "networks"].includes(key)) {
				for (let j = i + 1; j < lines.length; j++) {
					const trimmed = lines[j].trim();
					if (!trimmed || trimmed.startsWith("#")) continue;
					const indent = countLeadingWhitespace(lines[j]);
					if (indent <= 0) break;
					const child = lines[j].match(/^\s{2}([A-Za-z0-9_.-]+):\s*/);
					if (!child) continue;
					const childKind = key === "jobs" ? "job" : key.slice(0, -1);
					entries.push({ kind: childKind, name: child[1], startLine: j + 1, endLine: findYamlBlockEnd(lines, j, 2) });
				}
			}
		}

		const step = lines[i].match(/^\s*-\s+(?:name:\s*(.+)|uses:\s*(.+)|run:\s*(.+))/);
		if (step) {
			const name = (step[1] ?? step[2] ?? step[3] ?? "step").trim();
			entries.push({ kind: "step", name: name.slice(0, 120), startLine: i + 1, endLine: i + 1 });
		}
	}

	return entries;
}

function findDockerInstructionEnd(lines: string[], startIndex: number): number {
	let endIndex = startIndex;
	while (endIndex + 1 < lines.length && lines[endIndex].trimEnd().endsWith("\\")) {
		endIndex++;
	}
	return endIndex + 1;
}

function extractDockerfileSymbols(lines: string[]): ContextMapEntry[] {
	const entries: ContextMapEntry[] = [];
	const fromLines: number[] = [];

	for (let i = 0; i < lines.length; i++) {
		if (/^\s*FROM\s+/i.test(lines[i])) fromLines.push(i);
	}

	for (let idx = 0; idx < fromLines.length; idx++) {
		const i = fromLines[idx];
		const nextFrom = fromLines[idx + 1] ?? lines.length;
		const match = lines[i].match(/^\s*FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i);
		const image = match?.[1] ?? "unknown";
		const alias = match?.[2];
		entries.push({ kind: "stage", name: alias ? `${alias} FROM ${image}` : image, startLine: i + 1, endLine: nextFrom });
	}

	const important = /^(RUN|COPY|ADD|ENTRYPOINT|CMD|EXPOSE|ENV|ARG|WORKDIR)\b\s*(.*)/i;
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].trim().match(important);
		if (!match) continue;
		entries.push({ kind: match[1].toUpperCase(), name: (match[2] || match[1]).slice(0, 120), startLine: i + 1, endLine: findDockerInstructionEnd(lines, i) });
	}

	return entries;
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

function detectContextLanguage(filePath: string): ContextLanguage {
	const base = path.basename(filePath);
	const lowerBase = base.toLowerCase();
	const ext = path.extname(lowerBase);

	if (
		lowerBase === "dockerfile" ||
		lowerBase.startsWith("dockerfile.") ||
		lowerBase === ".dockerfile" ||
		lowerBase.endsWith(".dockerfile")
	) {
		return "dockerfile";
	}

	if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) return "typescript";
	if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "javascript";
	if ([".py", ".pyw"].includes(ext)) return "python";
	if ([".tf", ".tfvars"].includes(ext)) return "terraform";
	if (ext === ".hcl") return "hcl";
	if ([".yml", ".yaml"].includes(ext)) return "yaml";
	return "plain";
}

export function buildFileContextMap(filePath: string, lines: string[]): FileContextMap {
	const language = detectContextLanguage(filePath);
	let symbols: ContextMapEntry[] = [];

	try {
		switch (language) {
			case "typescript":
			case "javascript":
				symbols = extractTsJsSymbols(lines);
				break;
			case "python":
				symbols = extractPythonSymbols(lines);
				break;
			case "terraform":
			case "hcl":
				symbols = extractTerraformSymbols(lines);
				break;
			case "yaml":
				symbols = extractYamlSymbols(lines);
				break;
			case "dockerfile":
				symbols = extractDockerfileSymbols(lines);
				break;
			default:
				symbols = [];
		}
	} catch {
		symbols = [];
	}

	const sorted = symbols
		.filter((entry) => entry.startLine > 0 && entry.endLine >= entry.startLine)
		.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

	return {
		language,
		symbols: sorted.slice(0, MAX_CONTEXT_MAP_ENTRIES),
		symbolsTruncated: sorted.length > MAX_CONTEXT_MAP_ENTRIES || undefined,
	};
}
