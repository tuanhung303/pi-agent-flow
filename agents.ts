/**
 * Flow discovery and configuration.
 *
 * Flows are Markdown files with YAML frontmatter that define name, description,
 * optional model/tools, and a system prompt body.
 *
 * Lookup locations:
 *   - User flows:    ~/.pi/agent/agents/*.md by default, or
 *                    $PI_CODING_AGENT_DIR/agents/*.md when the env var is set
 *   - Project flows: .pi/agents/*.md  (walks up from cwd)
 */

import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type FlowScope = "user" | "project" | "both" | "bundled" | "all";

export type FlowTier = "lite" | "flash" | "full";

export interface FlowConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	maxDepth?: number;
	inheritContext?: boolean;
	tier?: FlowTier;
	systemPrompt: string;
	source: "user" | "project" | "bundled";
	filePath: string;
}

export interface FlowDiscoveryResult {
	flows: FlowConfig[];
	projectFlowsDir: string | null;
}

/** Determine the model tier for a given flow name. */
export function getFlowTier(flowName: string): FlowTier {
	const normalized = flowName.toLowerCase().trim();
	switch (normalized) {
		case "explore":
		case "debug":
			return "lite";
		case "code":
		case "review":
			return "flash";
		case "brainstorm":
		case "architect":
			return "full";
		default:
			return "flash";
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isDirectory(p: string): boolean {
	try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function getUserFlowsDir(): string {
	const configDir = process.env["PI_CODING_AGENT_DIR"]?.trim() || path.join(os.homedir(), ".pi", "agent");
	return path.join(configDir, "agents");
}

/** Get the bundled flows directory from the plugin's location. */
function getBundledFlowsDir(): string {
	// Method 1: import.meta.url (ESM)
	try {
		// @ts-expect-error — import.meta.url may not exist in all contexts
		if (import.meta.url) {
			// @ts-expect-error
			const pluginDir = path.dirname(new URL(import.meta.url).pathname);
			const dir = path.join(pluginDir, "agents");
			if (fs.existsSync(dir)) return dir;
		}
	} catch {}

	// Method 2: __dirname (CommonJS / jiti)
	try {
		// @ts-expect-error — __dirname may not exist in ESM
		if (typeof __dirname !== "undefined") {
			const dir = path.join(__dirname, "agents");
			if (fs.existsSync(dir)) return dir;
		}
	} catch {}

	// Method 3: Find from require.resolve
	try {
		const resolved = require.resolve("pi-agent-flow/package.json");
		const dir = path.join(path.dirname(resolved), "agents");
		if (fs.existsSync(dir)) return dir;
	} catch {}

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
	try { content = fs.readFileSync(filePath, "utf-8"); } catch { return null; }

	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(content);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[pi-agent-flow] Skipping invalid flow file "${filePath}": ${message}`);
		return null;
	}

	const frontmatter = parsed.frontmatter ?? {};
	const body = parsed.body ?? "";

	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim().toLowerCase() : "";
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	if (!name || !description) return null;

	let tools: string[] | undefined;
	if (typeof frontmatter.tools === "string") {
		const parsedTools = frontmatter.tools
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		if (parsedTools.length > 0) tools = parsedTools;
	} else if (Array.isArray(frontmatter.tools)) {
		const parsedTools = frontmatter.tools
			.filter((t): t is string => typeof t === "string")
			.map((t) => t.trim())
			.filter(Boolean);
		if (parsedTools.length > 0) tools = parsedTools;
	} else if (frontmatter.tools !== undefined) {
		console.warn(
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
			console.warn(
				`[pi-agent-flow] Ignoring invalid inheritContext value "${frontmatter.inheritContext}" in "${filePath}". Expected true/false.`,
			);
		}
	} else if (frontmatter.inheritContext !== undefined) {
		console.warn(
			`[pi-agent-flow] Ignoring invalid inheritContext field in "${filePath}". Expected boolean or string.`,
		);
	}

	return {
		name,
		description,
		tools,
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
		maxDepth,
		inheritContext,
		tier: getFlowTier(name),
		systemPrompt: body,
		source,
		filePath,
	};
}

/** Load all flow definitions from a directory. */
function loadFlowsFromDir(dir: string, source: "user" | "project" | "bundled"): FlowConfig[] {
	if (!fs.existsSync(dir)) return [];

	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
	entries.sort((a, b) => a.name.localeCompare(b.name));

	const flows: FlowConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const flow = parseFlowFile(path.join(dir, entry.name), source);
		if (flow) flows.push(flow);
	}
	return flows;
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

	const bundledFlows = scope === "user" || scope === "project" ? [] : loadFlowsFromDir(bundledFlowsDir, "bundled");
	const userFlows = scope === "project" || scope === "bundled" ? [] : loadFlowsFromDir(userFlowsDir, "user");
	const projectFlows = scope === "user" || scope === "bundled" || !projectFlowsDir ? [] : loadFlowsFromDir(projectFlowsDir, "project");

	if (scope === "bundled") {
		return { flows: bundledFlows, projectFlowsDir };
	}
	if (scope === "user") {
		return { flows: mergeFlows(bundledFlows, userFlows), projectFlowsDir };
	}
	if (scope === "project") {
		return { flows: mergeFlows(projectFlows), projectFlowsDir };
	}
	return {
		flows: mergeFlows(bundledFlows, userFlows, projectFlows),
		projectFlowsDir,
	};
}
