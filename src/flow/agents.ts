/**
 * Flow discovery and configuration.
 *
 * Flows are Markdown files with YAML frontmatter that define name, description,
 * optional model/tools, and a system prompt body.
 *
 * Lookup locations:
 *   - User flows:    ~/.pi/agent/agents/*.md by default, or
 *                    $AGENT_DIR/agents/*.md when the env var is set
 *   - Project flows: .pi/agents/*.md  (walks up from cwd)
 */

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logWarn } from "../config/log.js";
import { getAgentDir } from "../config/paths.js";

export type FlowScope = "user" | "project" | "both" | "bundled" | "all";
export type ConventionSource = "user" | "project" | "bundled";

export type FlowTier = "lite" | "flash" | "full";

/** All bundled flow type names. Keep in sync with markdown files in agents/ directory. */
export const BUNDLED_FLOW_TYPES = ["trace", "scout", "build", "craft", "audit", "debug", "ideas"] as const;

export type ToolResultCategory =
	| "error"
	| "stackTrace"
	| "testFailure"
	| "fileContent"
	| "bashSuccess"
	| "grepResult"
	| "gitDiff"
	| "userMessage"
	| "designDecision"
	| "other";

export interface ContextProfile {
	name: string;
	keepCategories: ToolResultCategory[];
	compressCategories: ToolResultCategory[];
}

export interface FlowConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	maxDepth?: number;
	inheritContext?: boolean;
	tier?: FlowTier;
	contextProfile?: ContextProfile;
	systemPrompt: string;
	source: "user" | "project" | "bundled";
	filePath: string;
}

export interface FlowDiscoveryResult {
	flows: FlowConfig[];
	projectFlowsDir: string | null;
	/** Shared prompt conventions resolved with bundled < user < project precedence. */
	conventions?: string;
	/** Provenance for the resolved conventions, used to trust-gate project content. */
	conventionsSource?: ConventionSource;
	conventionsPath?: string;
	/** Lower-precedence conventions to use if project conventions are not approved. */
	fallbackConventions?: string;
	fallbackConventionsSource?: Exclude<ConventionSource, "project">;
	fallbackConventionsPath?: string;
}

/** Determine the model tier for a given flow name. */
export function getFlowTier(flowName: string): FlowTier {
	const normalized = flowName.toLowerCase().trim();
	switch (normalized) {
		case "scout":
		case "debug":
		case "trace":
			return "lite";
		case "build":
		case "audit":
			return "flash";
		case "ideas":
		case "craft":
			return "full";
		default:
			return "flash";
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isDirectory(p: string): boolean {
	try { return fs.statSync(p).isDirectory(); } catch (e) { logWarn(`[pi-agent-flow] isDirectory check failed for ${p}: ${e}`); return false; }
}

function getUserFlowsDir(): string {
	return path.join(getAgentDir(), "agents");
}

/** Get the bundled flows directory from the plugin's location. */
function getBundledFlowsDir(): string {
	// Method 1: import.meta.url (ESM)
	// When source lives in src/, agents/ is one level up at the package root.
	try {
		if (import.meta.url) {
			const pluginDir = path.dirname(new URL(import.meta.url).pathname);
			// Check same directory first, then parent (for src/ layout)
			for (const base of [pluginDir, path.dirname(pluginDir), path.dirname(path.dirname(pluginDir))]) {
				const dir = path.join(base, "agents");
				if (fs.existsSync(dir)) return dir;
			}
		}
	} catch (e) { logWarn(`[pi-agent-flow] Flow discovery via import.meta.url failed: ${e}`); }

	// Method 2: __dirname (CommonJS / jiti)
	try {
		if (typeof __dirname !== "undefined") {
			for (const base of [__dirname, path.dirname(__dirname), path.dirname(path.dirname(__dirname))]) {
				const dir = path.join(base, "agents");
				if (fs.existsSync(dir)) return dir;
			}
		}
	} catch (e) { logWarn(`[pi-agent-flow] Flow discovery via __dirname failed: ${e}`); }

	// Method 3: Find from require.resolve
	try {
		const resolved = require.resolve("pi-agent-flow/package.json");
		const dir = path.join(path.dirname(resolved), "agents");
		if (fs.existsSync(dir)) return dir;
	} catch (e) { logWarn(`[pi-agent-flow] Flow discovery via require.resolve failed: ${e}`); }

	// Fallback: cwd
	return path.join(process.cwd(), "agents");
}

/** Walk up from `cwd` looking for a `.pi/agents` directory. */
function findNearestProjectFlowsDir(cwd: string): string | null {
	let dir = cwd;
	while (true) {
		const candidate = path.join(dir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Parse a single flow markdown file into a FlowConfig. Returns null on skip. */
function parseFlowFile(filePath: string, source: "user" | "project" | "bundled"): FlowConfig | null {
	let content: string;
	try { content = fs.readFileSync(filePath, "utf-8"); } catch (e) { logWarn(`[pi-agent-flow] Failed to read flow file ${filePath}: ${e}`); return null; }

	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(content);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logWarn(`[pi-agent-flow] Skipping invalid flow file "${filePath}": ${message}`);
		return null;
	}

	const frontmatter = parsed.frontmatter ?? {};
	const body = parsed.body ?? "";

	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim().toLowerCase() : "";
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	if (!name || !description) {
		if (!name) logWarn(`[pi-agent-flow] Skipping flow file "${filePath}": missing or empty 'name' field.`);
		if (!description) logWarn(`[pi-agent-flow] Skipping flow file "${filePath}": missing or empty 'description' field.`);
		return null;
	}

	// Warn about unknown frontmatter keys
	const knownKeys = new Set([
		"name", "description", "tools", "model", "thinking",
		"maxDepth", "inheritContext", "tier", "contextProfile",
	]);
	for (const key of Object.keys(frontmatter)) {
		if (!knownKeys.has(key)) {
			logWarn(`[pi-agent-flow] Unknown frontmatter key "${key}" in "${filePath}". This field will be ignored.`);
		}
	}

	let tools: string[] | undefined;
	if (typeof frontmatter.tools === "string") {
		const parsedTools = frontmatter.tools
			.split(",")
			.flatMap((t) => t.trim().split(/\s+/))
			.filter(Boolean);
		if (parsedTools.length > 0) tools = parsedTools;
	} else if (Array.isArray(frontmatter.tools)) {
		const parsedTools = frontmatter.tools
			.filter((t): t is string => typeof t === "string")
			.flatMap((t) => t.trim().split(/\s+/))
			.filter(Boolean);
		if (parsedTools.length > 0) tools = parsedTools;
	} else if (frontmatter.tools !== undefined) {
		logWarn(
			`[pi-agent-flow] Ignoring invalid tools field in "${filePath}". Expected a comma-separated string or string array.`,
		);
	}

	let maxDepth: number | undefined;
	if (typeof frontmatter.maxDepth === "number") {
		maxDepth = frontmatter.maxDepth;
	} else if (typeof frontmatter.maxDepth === "string") {
		const parsed = Number(frontmatter.maxDepth);
		if (Number.isFinite(parsed) && parsed >= 0) maxDepth = parsed;
	}

	let inheritContext: boolean | undefined;
	if (typeof frontmatter.inheritContext === "boolean") {
		inheritContext = frontmatter.inheritContext;
	} else if (typeof frontmatter.inheritContext === "string") {
		const normalized = frontmatter.inheritContext.trim().toLowerCase();
		if (normalized === "true" || normalized === "yes" || normalized === "1") {
			inheritContext = true;
		} else if (normalized === "false" || normalized === "no" || normalized === "0") {
			inheritContext = false;
		} else {
			logWarn(
				`[pi-agent-flow] Ignoring invalid inheritContext value "${frontmatter.inheritContext}" in "${filePath}". Expected true/false.`,
			);
		}
	} else if (frontmatter.inheritContext !== undefined) {
		logWarn(
			`[pi-agent-flow] Ignoring invalid inheritContext field in "${filePath}". Expected boolean or string.`,
		);
	}

	// Tier: prefer explicit frontmatter, fall back to name-based inference
	let tier: FlowTier | undefined;
	if (typeof frontmatter.tier === "string") {
		const normalized = frontmatter.tier.trim().toLowerCase();
		if (normalized === "lite" || normalized === "flash" || normalized === "full") {
			tier = normalized;
		} else {
			logWarn(`[pi-agent-flow] Ignoring invalid tier "${frontmatter.tier}" in "${filePath}". Expected lite, flash, or full.`);
		}
	}

	// Parse contextProfile from frontmatter
	let contextProfile: ContextProfile | undefined;
	if (typeof frontmatter.contextProfile === "string") {
		const profileName = frontmatter.contextProfile.trim().toLowerCase();
		contextProfile = resolveContextProfile(profileName);
		if (!contextProfile) {
			logWarn(`[pi-agent-flow] Ignoring unknown contextProfile "${frontmatter.contextProfile}" in "${filePath}".`);
		}
	}

	return {
		name,
		description,
		tools,
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
		maxDepth,
		inheritContext,
		tier: tier ?? getFlowTier(name),
		contextProfile,
		systemPrompt: body,
		source,
		filePath,
	};
}

/** Resolve a context profile name to its definition. */
function resolveContextProfile(name: string): ContextProfile | undefined {
	switch (name) {
		case "files-first":
			return {
				name: "files-first",
				keepCategories: ["fileContent", "error"],
				compressCategories: ["bashSuccess", "grepResult", "other"],
			};
		case "errors-first":
			return {
				name: "errors-first",
				keepCategories: ["error", "stackTrace", "testFailure"],
				compressCategories: ["bashSuccess", "fileContent", "grepResult", "gitDiff", "other"],
			};
		case "edits-first":
			return {
				name: "edits-first",
				keepCategories: ["fileContent", "gitDiff", "error"],
				compressCategories: ["bashSuccess", "grepResult", "other"],
			};
		case "discovery-first":
			return {
				name: "discovery-first",
				keepCategories: ["grepResult", "fileContent", "error"],
				compressCategories: ["bashSuccess", "other"],
			};
		case "intent-first":
			return {
				name: "intent-first",
				keepCategories: ["userMessage", "designDecision"],
				compressCategories: ["bashSuccess", "fileContent", "grepResult", "gitDiff", "error", "stackTrace", "testFailure", "other"],
			};
		case "code-first":
			return {
				name: "code-first",
				keepCategories: ["fileContent", "error"],
				compressCategories: ["bashSuccess", "grepResult", "stackTrace", "testFailure", "other"],
			};
		default:
			return undefined;
	}
}

/** Load all flow definitions from a directory. */
function loadFlowsFromDir(dir: string, source: "user" | "project" | "bundled"): FlowConfig[] {
	if (!fs.existsSync(dir)) return [];

	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { logWarn(`[pi-agent-flow] Failed to read flows directory ${dir}: ${e}`); return []; }
	entries.sort((a, b) => a.name.localeCompare(b.name));

	const flows: FlowConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		// Underscore-prefixed Markdown files are shared support files, not flows.
		if (path.basename(entry.name).startsWith("_")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const flow = parseFlowFile(path.join(dir, entry.name), source);
		if (flow) flows.push(flow);
	}
	return flows;
}

interface ResolvedConventions {
	content: string;
	source: ConventionSource;
	filePath: string;
}

interface ConventionDirectory {
	dir: string;
	source: ConventionSource;
}

/** Read a plain shared-conventions file. Missing or blank files do not override lower scopes. */
function loadConventionsFromDir({ dir, source }: ConventionDirectory): ResolvedConventions | undefined {
	const filePath = path.join(dir, "_conventions.md");
	try {
		const content = fs.readFileSync(filePath, "utf-8").trim();
		return content ? { content, source, filePath } : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			logWarn(`[pi-agent-flow] Failed to read conventions file ${filePath}: ${error}`);
		}
		return undefined;
	}
}

function resolveConventions(dirs: ConventionDirectory[]): ResolvedConventions | undefined {
	let conventions: ResolvedConventions | undefined;
	for (const dir of dirs) {
		const resolved = loadConventionsFromDir(dir);
		if (resolved) conventions = resolved;
	}
	return conventions;
}

function mergeFlows(...groups: FlowConfig[][]): FlowConfig[] {
	const flowMap = new Map<string, FlowConfig>();
	for (const group of groups) {
		for (const flow of group) flowMap.set(flow.name.toLowerCase(), flow);
	}
	return Array.from(flowMap.values());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover all available flows according to the requested scope.
 *
 * Precedence is: bundled < user < project.
 */
export function discoverFlows(cwd: string, scope: FlowScope): FlowDiscoveryResult {
	const bundledFlowsDir = getBundledFlowsDir();
	const userFlowsDir = getUserFlowsDir();
	const projectFlowsDir = findNearestProjectFlowsDir(cwd);
	const userFlowsDirs = [userFlowsDir, path.join(os.homedir(), ".pi", "agents")];

	const bundledFlows = scope === "user" || scope === "project" ? [] : loadFlowsFromDir(bundledFlowsDir, "bundled");
	const userFlows = scope === "project" || scope === "bundled" ? [] : [
		...loadFlowsFromDir(userFlowsDir, "user"),
		...loadFlowsFromDir(userFlowsDirs[1], "user"),
	];
	const projectFlows = scope === "user" || scope === "bundled" || !projectFlowsDir ? [] : loadFlowsFromDir(projectFlowsDir, "project");
	const bundledConventionDirs: ConventionDirectory[] =
		scope === "user" || scope === "project" ? [] : [{ dir: bundledFlowsDir, source: "bundled" }];
	const userConventionDirs: ConventionDirectory[] =
		scope === "project" || scope === "bundled" ? [] : userFlowsDirs.map((dir) => ({ dir, source: "user" }));
	const projectConventionDirs: ConventionDirectory[] =
		scope === "user" || scope === "bundled" || !projectFlowsDir ? [] : [{ dir: projectFlowsDir, source: "project" }];
	const resolvedConventions = resolveConventions([
		...bundledConventionDirs,
		...userConventionDirs,
		...projectConventionDirs,
	]);
	const fallbackConventions = resolvedConventions?.source === "project"
		? resolveConventions([...bundledConventionDirs, ...userConventionDirs])
		: undefined;
	const conventionResult = {
		...(resolvedConventions ? {
			conventions: resolvedConventions.content,
			conventionsSource: resolvedConventions.source,
			conventionsPath: resolvedConventions.filePath,
		} : {}),
		...(fallbackConventions ? {
			fallbackConventions: fallbackConventions.content,
			fallbackConventionsSource: fallbackConventions.source as Exclude<ConventionSource, "project">,
			fallbackConventionsPath: fallbackConventions.filePath,
		} : {}),
	};

	if (scope === "bundled") {
		return { flows: bundledFlows, projectFlowsDir, ...conventionResult };
	}
	if (scope === "user") {
		return { flows: mergeFlows(bundledFlows, userFlows), projectFlowsDir, ...conventionResult };
	}
	if (scope === "project") {
		return { flows: mergeFlows(projectFlows), projectFlowsDir, ...conventionResult };
	}
	return {
		flows: mergeFlows(bundledFlows, userFlows, projectFlows),
		projectFlowsDir,
		...conventionResult,
	};
}
