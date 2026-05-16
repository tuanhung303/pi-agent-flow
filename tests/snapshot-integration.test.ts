import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sanitizeForkSnapshot } from "../src/snapshot/snapshot.js";
import type { CompressedFlowResult } from "../src/types/output.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(entries: any[]): string {
	return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function parseSnapshot(snapshot: string): any[] {
	return snapshot
		.trimEnd()
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l));
}

function buildDumpArtifact(
	snapshot: string,
	prompt: string,
	flowName: string,
	tier: string,
	pipelineVersion: string,
): { md: string; txt: string } {
	const lines = snapshot.trimEnd().split("\n");
	const lastLine = lines[lines.length - 1];
	let compressionStats = "";
	let passesApplied: string[] = [];
	try {
		const lastEntry = JSON.parse(lastLine);
		if (lastEntry?.type === "compression-stats") {
			compressionStats =
				`\n\n## Compression Stats\n\n` +
				`- Pre-sanitization: ${lastEntry.preBytes} bytes\n` +
				`- Post-sanitization: ${lastEntry.postBytes} bytes\n` +
				`- Reduction: ${lastEntry.reductionPercent}%`;
			passesApplied = Array.isArray(lastEntry.passesApplied) ? lastEntry.passesApplied : [];
		}
	} catch { /* ignore */ }

	const passesList = passesApplied.length > 0 ? passesApplied.join(", ") : "(none — cold start)";
	const sanitizationHeader =
		`<!-- pi-agent-flow dump | State: post-sanitization | Passes: ${passesList} | Flow: ${flowName} | Tier: ${tier} | Pipeline: ${pipelineVersion} | Generated: ${new Date().toISOString()} -->`;

	const md = [
		sanitizationHeader,
		``,
		`## Session Snapshot (JSONL)`,
		``,
		...snapshot.split("\n"),
		``,
		`## Activation Prompt (-p)`,
		``,
		prompt,
		compressionStats,
	].join("\n");

	return { md, txt: prompt };
}

// ---------------------------------------------------------------------------
// Integration Test — Multi-turn snapshot with realistic batch/web/flow/ask_user
// ---------------------------------------------------------------------------

describe("SNAPSHOT INTEGRATION TEST — depth-aware compression & dump artifacts", () => {
	let tmpDir: string;
	let pipelineVersion: string;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-snapshot-integration-"));
		const pkgPath = path.join(process.cwd(), "package.json");
		pipelineVersion = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function buildComplexSnapshot(): string {
		return makeSnapshot([
			{ type: "session", id: "sess-1", systemPrompt: "You are a helpful coding assistant." },
			{
				type: "message",
				message: {
					role: "user",
					content: "Implement auth middleware",
					id: "u-1",
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					id: "a-1",
					parentId: "u-1",
					content: [
						{ type: "text", text: "I'll examine the codebase and implement auth." },
						{
							type: "toolCall",
							id: "tc-batch-1",
							name: "batch",
							arguments: {
								o: [
									{ o: "read", p: "src/middleware.ts" },
									{ o: "bash", p: ".", c: "grep -r 'auth' src/" },
								],
							},
						},
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					id: "tr-batch-1",
					parentId: "a-1",
					toolCallId: "tc-batch-1",
					content:
						`2 operations: 1 read, 1 bash\n\n` +
						`--- src/middleware.ts (42 lines) ---\n` +
						`export function middleware(req, res, next) {\n` +
						`  // TODO: add auth\n` +
						`  next();\n` +
						`}\n\n` +
						`--- bash [grep-auth] exit 0 ---\n` +
						`[Execution time: 0.3s (normal)]\n` +
						`src/auth.ts\n` +
						`src/routes/login.ts\n`,
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					id: "a-2",
					parentId: "tr-batch-1",
					content: [
						{ type: "text", text: "Found auth files. Let me write the middleware." },
						{
							type: "toolCall",
							id: "tc-batch-2",
							name: "batch",
							arguments: {
								o: [
									{ o: "write", p: "src/middleware.ts", c: "export function authMiddleware..." },
									{ o: "edit", p: "src/routes/login.ts", e: [{ f: "old", r: "new" }] },
									{ o: "bash", p: ".", c: "npm run lint", t: 30000 },
								],
							},
						},
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					id: "tr-batch-2",
					parentId: "a-2",
					toolCallId: "tc-batch-2",
					content:
						`3 operations: 1 write, 1 edit, 1 bash\n\n` +
						`--- write: src/middleware.ts (1234 bytes) ---\n` +
						`export function authMiddleware(req, res, next) {\n` +
						`  if (!req.headers.authorization) return res.status(401).send('Unauthorized');\n` +
						`  next();\n` +
						`}\n\n` +
						`--- edit: src/routes/login.ts (1 block) ---\n` +
						`// patched\n\n` +
						`--- bash [npm-lint] exit 0 ---\n` +
						`[Execution time: 2.1s (normal)]\n` +
						`✓ All files pass linting\n`,
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					id: "a-3",
					parentId: "tr-batch-2",
					content: [
						{ type: "text", text: "Lint passed. Let me search for JWT best practices." },
						{
							type: "toolCall",
							id: "tc-web-1",
							name: "web",
							arguments: { o: [{ o: "search", q: "jwt best practices node.js" }] },
						},
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					id: "tr-web-1",
					parentId: "a-3",
					toolCallId: "tc-web-1",
					content:
						`1. JWT Security Best Practices\n` +
						`   https://auth0.com/blog/jwt-security-best-practices/\n` +
						`   Use strong signing algorithms...\n\n` +
						`2. Node.js jsonwebtoken library\n` +
						`   https://github.com/auth0/node-jsonwebtoken\n` +
						`   Usage examples and API docs`,
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					id: "a-4",
					parentId: "tr-web-1",
					content: [
						{ type: "text", text: "Should I use HS256 or RS256?" },
						{
							type: "toolCall",
							id: "tc-ask-1",
							name: "ask_user",
							arguments: { question: "HS256 or RS256?" },
						},
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					id: "tr-ask-1",
					parentId: "a-4",
					toolCallId: "tc-ask-1",
					content: "User answered: RS256",
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					id: "a-5",
					parentId: "tr-ask-1",
					content: [
						{ type: "text", text: "Proceeding with RS256. Delegating to build flow." },
						{
							type: "toolCall",
							id: "tc-flow-1",
							name: "flow",
							arguments: { flow: [{ type: "build", intent: "Implement JWT middleware with RS256" }] },
						},
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					id: "tr-flow-1",
					parentId: "a-5",
					toolCallId: "tc-flow-1",
					content: "Flow completed: implemented JWT middleware.",
				},
			},
		]);
	}

	it("sanitizes at depth 1 and produces correct X1/W1/E1/Q1 formats", () => {
		const flowCache = new Map<string, CompressedFlowResult[]>();
		flowCache.set("tc-flow-1", [
			{
				type: "build",
				status: "accomplished",
				intent: "Implement JWT middleware with RS256",
				files: [{ path: "src/middleware.ts", role: "modified" }],
				commands: [{ tool: "bash", command: "npm run lint" }],
			},
		]);

		const snapshot = buildComplexSnapshot();
		const { result, passesApplied } = sanitizeForkSnapshot(snapshot, flowCache, { depth: 1 });
		expect(result).toBeDefined();
		const entries = parseSnapshot(result!);
		const toolTexts = entries
			.filter((e) => e?.message?.role === "tool" || e?.message?.role === "toolResult")
			.map((e) => {
				const c = e.message.content;
				if (typeof c === "string") return c;
				if (Array.isArray(c)) return c.map((p: any) => p.text).join("\n");
				return "";
			})
			.join("\n");

		// X1 bash compression at depth 1
		expect(toolTexts).toContain("[bash:ok] grep-auth · exit 0 · 0.3s (normal) · 2 lines");
		expect(toolTexts).toContain("[bash:ok] npm-lint · exit 0 · 2.1s (normal) · 1 line");
		expect(toolTexts).not.toContain("--- bash [grep-auth] exit 0 ---");
		expect(toolTexts).not.toContain("--- bash [npm-lint] exit 0 ---");

		// W1 write compression at depth 1
		expect(toolTexts).toContain("[batch:write] src/middleware.ts (1234 bytes)");
		expect(toolTexts).not.toContain("--- write: src/middleware.ts (1234 bytes) ---");

		// E1 edit compression at depth 1
		expect(toolTexts).toContain("[batch:edit] src/routes/login.ts (1 block)");
		expect(toolTexts).not.toContain("--- edit: src/routes/login.ts (1 block) ---");

		// Read truncation
		expect(toolTexts).toContain("--- src/middleware.ts (42 lines, content truncated) ---");
		expect(toolTexts).not.toContain("export function middleware(req, res, next)");

		// Q1 web compression
		expect(toolTexts).toContain("[web:search] \"jwt best practices node.js\" · 2 results · first: JWT Security Best Practices");
		expect(toolTexts).not.toContain("https://auth0.com/blog/jwt-security-best-practices/");

		// ask_user compression
		expect(toolTexts).toContain('[ask_user] "HS256 or RS256?" → "RS256"');

		// Flow compression
		expect(toolTexts).toContain("[Flow: build accomplished]");
		expect(toolTexts).toContain("Intent: Implement JWT middleware with RS256");

		// Passes applied
		expect(passesApplied).toContain("compressToolResults");
		expect(passesApplied).toContain("reparentOrphans");
		expect(passesApplied).toContain("stripBatchRead");
	});

	it("sanitizes at depth 2 with stricter compression (no previews)", () => {
		const flowCache = new Map<string, CompressedFlowResult[]>();
		flowCache.set("tc-flow-1", [
			{
				type: "build",
				status: "accomplished",
				intent: "Implement JWT middleware with RS256",
				files: [{ path: "src/middleware.ts", role: "modified" }],
			},
		]);

		const snapshot = buildComplexSnapshot();
		const { result } = sanitizeForkSnapshot(snapshot, flowCache, { depth: 2 });
		expect(result).toBeDefined();
		const entries = parseSnapshot(result!);
		const toolTexts = entries
			.filter((e) => e?.message?.role === "tool" || e?.message?.role === "toolResult")
			.map((e) => {
				const c = e.message.content;
				if (typeof c === "string") return c;
				if (Array.isArray(c)) return c.map((p: any) => p.text).join("\n");
				return "";
			})
			.join("\n");

		// X1 bash at depth 2 — no preview, just status
		expect(toolTexts).toContain("[bash:ok] grep-auth · exit 0");
		expect(toolTexts).not.toContain("> head:");

		// W1 write at depth 2 — no byte count
		expect(toolTexts).toContain("[batch:write] src/middleware.ts");
		expect(toolTexts).not.toContain("(1234 bytes)");

		// E1 edit at depth 2 — no block count
		expect(toolTexts).toContain("[batch:edit] src/routes/login.ts");
		expect(toolTexts).not.toContain("(1 block)");

		// Q1 web at depth 2 — same format (web doesn't have depth-specific preview trimming)
		expect(toolTexts).toContain("[web:search]");
	});

	it("writes proper dump artifacts (.md + .txt) with compression stats", () => {
		const flowCache = new Map<string, CompressedFlowResult[]>();
		flowCache.set("tc-flow-1", [
			{
				type: "build",
				status: "accomplished",
				intent: "Implement JWT middleware with RS256",
				files: [{ path: "src/middleware.ts", role: "modified" }],
			},
		]);

		const snapshot = buildComplexSnapshot();
		const { result, passesApplied } = sanitizeForkSnapshot(snapshot, flowCache, { depth: 1 });
		expect(result).toBeDefined();

		const prompt = "spawn build, implement JWT middleware with RS256";
		const { md, txt } = buildDumpArtifact(result!, prompt, "build", "flash", pipelineVersion);

		// Write files
		const mdPath = path.join(tmpDir, "pi-dump.build.test.md");
		const txtPath = path.join(tmpDir, "pi-dump.build.test.txt");
		fs.writeFileSync(mdPath, md, "utf8");
		fs.writeFileSync(txtPath, txt, "utf8");

		// Optional: also write to PI_FLOW_DUMP_SNAPSHOT path for manual inspection
		if (process.env.PI_FLOW_DUMP_SNAPSHOT) {
			const dumpBase = process.env.PI_FLOW_DUMP_SNAPSHOT;
			const ext = path.extname(dumpBase);
			const base = ext ? dumpBase.slice(0, -ext.length) : dumpBase;
			const timestamp = Date.now();
			const realMdPath = `${base}.integration.${timestamp}.md`;
			const realTxtPath = `${base}.integration.${timestamp}.txt`;
			fs.writeFileSync(realMdPath, md, "utf8");
			fs.writeFileSync(realTxtPath, txt, "utf8");
			console.log(`[pi-agent-flow] Integration-test dump written to ${realMdPath}`);
		}

		// Verify files exist
		expect(fs.existsSync(mdPath)).toBe(true);
		expect(fs.existsSync(txtPath)).toBe(true);

		// Verify .md structure
		const mdContent = fs.readFileSync(mdPath, "utf8");
		expect(mdContent).toMatch(/<!-- pi-agent-flow dump \| State: post-sanitization/);
		expect(mdContent).toContain("## Session Snapshot (JSONL)");
		expect(mdContent).toContain("## Activation Prompt (-p)");
		expect(mdContent).toContain("## Compression Stats");
		expect(mdContent).toContain("Pre-sanitization:");
		expect(mdContent).toContain("Post-sanitization:");
		expect(mdContent).toContain("Reduction:");
		expect(mdContent).toContain("Flow: build");
		expect(mdContent).toContain("Tier: flash");
		expect(mdContent).toContain(`Pipeline: ${pipelineVersion}`);

		// Verify passes are in header
		const passesStr = passesApplied.join(", ");
		expect(mdContent).toContain(passesStr);

		// Verify .txt is just the prompt
		const txtContent = fs.readFileSync(txtPath, "utf8");
		expect(txtContent).toBe(prompt);

		// Verify JSONL entries are present
		expect(mdContent).toContain('"type":"session"');
		expect(mdContent).toContain('"type":"compression-stats"');
	});

	it("is orphan-free after full sanitization", () => {
		const flowCache = new Map<string, CompressedFlowResult[]>();
		flowCache.set("tc-flow-1", [
			{
				type: "build",
				status: "accomplished",
				intent: "Implement JWT middleware with RS256",
				files: [{ path: "src/middleware.ts", role: "modified" }],
			},
		]);

		const snapshot = buildComplexSnapshot();
		const { result } = sanitizeForkSnapshot(snapshot, flowCache, { depth: 1 });
		expect(result).toBeDefined();
		const entries = parseSnapshot(result!);

		const survivingIds = new Set<string>();
		for (const entry of entries) {
			const id = entry?.message?.id ?? entry?.message?.messageId ?? entry?.id;
			if (typeof id === "string" && id) survivingIds.add(id);
		}

		for (const entry of entries) {
			// Session-header parentId is lineage metadata, not a message-graph
			// reference — it is intentionally preserved even when no entry has
			// that id (the original session id was renamed to parentId).
			if (entry?.type === "session" || entry?.type === "header") continue;
			const parentId =
				entry?.parentId ??
				entry?.parentMessageId ??
				entry?.message?.parentId ??
				entry?.message?.parentMessageId;
			if (typeof parentId === "string" && parentId) {
				expect(
					survivingIds.has(parentId),
					`orphaned parentId: ${parentId} in entry ${JSON.stringify(entry).slice(0, 200)}`,
				).toBe(true);
			}
		}
	});

	it("has zero batch_read tool calls remaining", () => {
		// Intentionally inject a batch_read call that should be stripped
		const snapshot = makeSnapshot([
			{ type: "session", id: "sess-1", systemPrompt: "You are helpful" },
			{
				type: "message",
				message: {
					role: "assistant",
					id: "a-1",
					content: [
						{ type: "text", text: "Reading files." },
						{
							type: "toolCall",
							id: "tc-br-1",
							name: "batch_read",
							arguments: { o: [{ o: "read", p: "src/a.ts" }] },
						},
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					id: "tr-br-1",
					parentId: "a-1",
					toolCallId: "tc-br-1",
					content: "File content...",
				},
			},
		]);

		const { result, passesApplied } = sanitizeForkSnapshot(snapshot, new Map(), { depth: 1 });
		expect(result).toBeDefined();
		const entries = parseSnapshot(result!);

		for (const entry of entries) {
			const content = entry?.message?.content;
			if (Array.isArray(content)) {
				for (const part of content) {
					expect(part?.name).not.toBe("batch_read");
				}
			}
		}

		expect(passesApplied).toContain("stripBatchRead");
	});
});
