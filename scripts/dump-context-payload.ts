#!/usr/bin/env npx tsx
/**
 * Mechanically generate a realistic child flow payload dump.
 *
 * Creates a mock SessionSnapshotSource, runs the full sanitization pipeline,
 * builds an activation prompt, and writes the result to
 * docs/agent-context-dump.md for documentation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildForkSessionSnapshotJsonl,
  sanitizeForkSnapshot,
} from "../dist/snapshot.js";

// ---------------------------------------------------------------------------
// Types (minimal — derived from src/snapshot.ts and src/types.ts)
// ---------------------------------------------------------------------------

interface SessionSnapshotSource {
  getHeader: () => unknown;
  getBranch: () => unknown[];
}

interface CompressedFlowResult {
  type: string;
  status: "accomplished" | "failed" | "aborted";
  files?: Array<{
    path: string;
    role?: string;
    description?: string;
  }>;
  commands?: Array<{
    tool?: string;
    command: string;
  }>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Realistic mock conversation data
// ---------------------------------------------------------------------------

const systemPromptHeader =
  "You are Pi, an advanced coding assistant. You help users write, review, and debug code. You can spawn specialized sub-agents (flows) for complex tasks.";

const branchEntries: unknown[] = [
  // 1. System prompt
  {
    type: "message",
    message: {
      role: "system",
      content:
        "You are Pi, an advanced coding assistant. You help users write, review, and debug code. You can spawn specialized sub-agents (flows) for complex tasks.",
    },
  },

  // 2. User asks about context sharing
  {
    type: "message",
    message: {
      role: "user",
      content:
        "How does context sharing work between parent and child flows? I'm trying to understand what information gets passed when a flow delegates to a sub-flow.",
    },
  },

  // 3. Assistant responds with reasoning and a flow tool call (scout)
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking:
            "The user wants to understand context sharing mechanics. This is an architecture question about the pi-agent-flow extension. I should spawn a scout flow to explore the relevant source files — snapshot.ts, flow.ts, and types.ts — to map how session snapshots are built, sanitized, and passed to child processes.",
        },
        {
          type: "text",
          text: "Let me explore the flow delegation code to trace how context is inherited. I'll dispatch a scout flow to map the relevant files.",
        },
        {
          type: "toolCall",
          name: "flow",
          id: "flow_scout_001",
          arguments: {
            flow: [
              {
                aim: "Map context sharing architecture",
                intent:
                  "Trace how parent session snapshots are serialized, sanitized, and passed to child flows. Read src/snapshot.ts, src/flow.ts, and src/types.ts. Focus on: buildForkSessionSnapshotJsonl, sanitizeForkSnapshot, compressToolResults, and the activation prompt structure in buildFlowArgs.",
                sessionMode: "fast",
                type: "scout",
              },
            ],
          },
        },
      ],
    },
  },

  // 4. Tool result for the scout flow (bulky — will be compressed from cache)
  {
    type: "message",
    message: {
      role: "tool",
      toolCallId: "flow_scout_001",
      content: [
        {
          type: "text",
          text:
            "## Scout Results\n\n" +
            "**src/snapshot.ts** — Session snapshot building, sanitization, and tool result compression.\n" +
            "Key functions: buildForkSessionSnapshotJsonl, sanitizeForkSnapshot, compressToolResults, stripBatchReadToolCalls.\n\n" +
            "**src/flow.ts** — Flow process runner (fork-only).\n" +
            "Spawns isolated pi processes with forked session context.\n" +
            "Key function: buildFlowArgs constructs the activation prompt with context-seal, activation, directive, and mission phases.\n\n" +
            "**src/types.ts** — Shared type definitions.\n" +
            "Defines CompressedFlowResult, SingleResult, FlowDetails, UsageStats, FileEntry, CommandEntry.\n\n" +
            "The pipeline: parent session → buildForkSessionSnapshotJsonl → sanitizeForkSnapshot (strips reasoning, sliding prompts, batch_read calls, compresses tool results) → written to temp JSONL → child reads via --session.",
        },
      ],
    },
  },

  // 5. Assistant asks user a clarifying question
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "I've mapped the context-sharing pipeline. Should I also inspect the actual snapshot output to show you a concrete example of what a child flow receives?",
        },
        {
          type: "toolCall",
          name: "ask_user",
          id: "ask_user_001",
          arguments: {
            question:
              "Should I also inspect the actual snapshot output to show you a concrete example of what a child flow receives?",
          },
        },
      ],
    },
  },

  // 6. User answers via ask_user tool
  {
    type: "message",
    message: {
      role: "tool",
      toolCallId: "ask_user_001",
      content: "User answered: Yes, check src/snapshot.ts and show me a concrete example of the sanitized output.",
    },
  },

  // 7. User followup (echo of answer)
  {
    type: "message",
    message: {
      role: "user",
      content:
        "Yes, check src/snapshot.ts and show me a concrete example of the sanitized output.",
    },
  },

  // 8. Assistant with thinking + batch tool call
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking:
            "The user wants a concrete example. I'll read src/snapshot.ts to show the actual sanitization code, and also read a few related files to give a complete picture. I'll use batch for targeted reads.",
        },
        {
          type: "text",
          text: "Let me pull the concrete code from snapshot.ts and a couple of related files.",
        },
        {
          type: "toolCall",
          name: "batch",
          id: "batch_001",
          arguments: {
            o: [
              { o: "read", p: "src/snapshot.ts", s: 1, l: 50 },
              { o: "read", p: "src/flow.ts", s: 1, l: 30 },
              { o: "read", p: "src/types.ts", s: 1, l: 30 },
            ],
          },
        },
      ],
    },
  },

  // 9. Batch tool result with file content (will be compressed by compressBatchResult)
  {
    type: "message",
    message: {
      role: "tool",
      toolCallId: "batch_001",
      content: [
        {
          type: "text",
          text:
            "--- src/snapshot.ts (50 lines) ---\n" +
            "/**\n" +
            " * Session snapshot building, sanitization, and tool result compression.\n" +
            " *\n" +
            " * Extracted from index.ts for single-responsibility and testability.\n" +
            " */\n" +
            "\n" +
            "import {\n" +
            "\ttype CompressedFlowResult,\n" +
            "\tisFlowError,\n" +
            "} from \"./types.js\";\n" +
            "import { stripReasoningFromAssistantMessage } from \"./reasoning-strip.js\";\n" +
            "import {\n" +
            "\tstripSteeringHintFromContent,\n" +
            "\tstripSteeringHintText,\n" +
            "\tcontentContainsSteeringHintTag,\n" +
            "\tisJsonEqual,\n" +
            "} from \"./sliding-prompt.js\";\n" +
            "import { stripStrategicHints, stripStrategicHintsFromContent } from \"./tool-utils.js\";\n" +
            "import * as fs from \"node:fs\";\n" +
            "\n" +
            "// ---------------------------------------------------------------------------\n" +
            "// Types\n" +
            "// ---------------------------------------------------------------------------\n" +
            "\n" +
            "export interface SessionSnapshotSource {\n" +
            "\tgetHeader: () => unknown;\n" +
            "\tgetBranch: () => unknown[];\n" +
            "}\n" +
            "\n" +
            "// ---------------------------------------------------------------------------\n" +
            "// Session snapshot serialization\n" +
            "// ---------------------------------------------------------------------------\n" +
            "\n" +
            "export function buildForkSessionSnapshotJsonl(\n" +
            "\tsessionManager: SessionSnapshotSource,\n" +
            "): string | null {\n" +
            "\tconst header = sessionManager.getHeader();\n" +
            "\tif (!header || typeof header !== \"object\") return null;\n" +
            "\n" +
            "\tconst branchEntries = sessionManager.getBranch();\n" +
            "\tconst lines = [JSON.stringify(header)];\n" +
            "\tfor (const entry of branchEntries) lines.push(JSON.stringify(entry));\n" +
            "\treturn `${lines.join(\"\\n\")}\\n`;\n" +
            "}\n" +
            "\n" +
            "// ---------------------------------------------------------------------------\n" +
            "// Flow result compression\n" +
            "// ---------------------------------------------------------------------------\n" +
            "\n" +
            "/**\n" +
            " * Render a compressed flow result as compact text for child context.\n" +
            " */\n" +
            "export function renderCompressedFlowResult(r: CompressedFlowResult): string {\n" +
            "\tconst parts: string[] = [`[Flow: ${r.type} ${r.status}]`];\n" +
            "\tif (r.files?.length) {\n" +
            "\t\tconst fileLines = r.files.map((f) => {\n" +
            "\t\t\tconst role = f.role ? ` (${f.role})` : \"\";\n" +
            "\t\t\tconst desc = f.description ? ` — ${f.description}` : \"\";\n" +
            "\t\t\treturn `  ${f.path}${role}${desc}`;\n" +
            "\t\t});\n" +
            "\t\tparts.push(`Files:\\n${fileLines.join(\"\\n\")}`);\n" +
            "\t}\n" +
            "\tif (r.commands?.length) {\n" +
            "\t\tconst cmdLines = r.commands.map((c) => `  ${c.tool ?? \"cmd\"}: ${c.command}`);\n" +
            "\t\tparts.push(`Commands:\\n${cmdLines.join(\"\\n\")}`);\n" +
            "\t}\n" +
            "\tif (r.error) parts.push(`Error: ${r.error}`);\n" +
            "\treturn parts.join(\"\\n\");\n" +
            "}\n" +
            "\n" +
            "// ---------------------------------------------------------------------------\n" +
            "// batch_read result compression\n" +
            "// ---------------------------------------------------------------------------\n" +
            "\n" +
            "/**\n" +
            " * Extract file paths from a batch_read tool call's arguments.\n" +
            " * Handles both { o: [...] } and bare array argument formats.\n" +
            " */\n" +
            "function extractBatchReadPaths(args: unknown): string[] {\n" +
            "\tif (!args || typeof args !== \"object\") return [];\n" +
            "\n" +
            "--- src/flow.ts (30 lines) ---\n" +
            "/**\n" +
            " * Flow process runner (fork-only).\n" +
            " *\n" +
            " * Spawns isolated pi processes with forked session context\n" +
            " * and streams results back via callbacks.\n" +
            " */\n" +
            "\n" +
            "import { spawn } from \"node:child_process\";\n" +
            "import * as fs from \"node:fs\";\n" +
            "import * as os from \"node:os\";\n" +
            "import * as path from \"node:path\";\n" +
            "import type { AgentToolResult } from \"@mariozechner/pi-agent-core\";\n" +
            "import { type FlowConfig } from \"./agents.js\";\n" +
            "import { getInheritedCliArgs } from \"./cli-args.js\";\n" +
            "import { processFlowJsonLine, drainStreamingText, drainStreamingEstimate, drainCtxEstimate, updateSmoothedTps, drainSmoothedTps } from \"./runner-events.js\";\n" +
            "import {\n" +
            "\ttype SingleResult,\n" +
            "\ttype FlowDetails,\n" +
            "\temptyFlowUsage,\n" +
            "\tgetFlowOutput,\n" +
            "\tnormalizeFlowResult,\n" +
            "} from \"./types.js\";\n" +
            "import { extractStructuredOutput, generateCommandsFromHistory } from \"./structured-output.js\";\n" +
            "import { DEFAULT_AGENT_SESSION_MODE, getAgentSessionTimeoutMs, type AgentSessionMode } from \"./session-mode.js\";\n" +
            "\n" +
            "const isWindows = process.platform === \"win32\";\n" +
            "const SIGKILL_TIMEOUT_MS = 5000;\n" +
            "const FINISH_KILL_GRACE_MS = 5_000;\n" +
            "const AGENT_END_GRACE_MS = 2000;\n" +
            "const FLOW_TIME_BUDGET_WARNING_MS = 2 * 60 * 1000;\n" +
            "const FLOW_FINAL_URGE_MS = 135 * 1000;\n" +
            "const REPORTING_GRACE_MS = 90_000;\n" +
            "const FLOW_TOOL_SUMMARY_GRACE_MS = FLOW_FINAL_URGE_MS;\n" +
            "import {\n" +
            "\tFLOW_DEPTH_ENV,\n" +
            "\tFLOW_MAX_DEPTH_ENV,\n" +
            "\tFLOW_STACK_ENV,\n" +
            "\tFLOW_PREVENT_CYCLES_ENV,\n" +
            "\tFLOW_TOOL_OPTIMIZE_ENV,\n" +
            "} from \"./depth.js\";\n" +
            "\n" +
            "const FLOW_DEADLINE_ENV = \"PI_FLOW_DEADLINE_MS\";\n" +
            "--- src/types.ts (30 lines) ---\n" +
            "/**\n" +
            " * Shared type definitions for the flow-state extension.\n" +
            " */\n" +
            "\n" +
            "import type { Message } from \"@mariozechner/pi-ai\";\n" +
            "import { getFlowFinalText } from \"./runner-events.js\";\n" +
            "\n" +
            "/** Aggregated token usage from a flow run. */\n" +
            "export interface UsageStats {\n" +
            "\tinput: number;\n" +
            "\toutput: number;\n" +
            "\tcacheRead: number;\n" +
            "\tcacheWrite: number;\n" +
            "\tcost: number;\n" +
            "\tcontextTokens: number;\n" +
            "\tturns: number;\n" +
            "\ttoolCalls: number;\n" +
            "\tsmoothedTps?: number;\n" +
            "}\n" +
            "\n" +
            "/** Structured file entry in a flow's output. */\n" +
            "export interface FileEntry {\n" +
            "\t/** Path to the file, relative or absolute. */\n" +
            "\tpath: string;\n" +
            "\t/** Semantic role of this file in the flow's work. */\n" +
            "\trole?: \"reference\" | \"read\" | \"modified\" | \"created\" | \"deleted\" | \"test\";\n" +
            "\t/** Why this file matters (1 sentence). */\n" +
            "\tdescription?: string;\n" +
            "\t/** Short excerpt or snippet (not full content). */\n" +
            "\tsnippet?: string;\n" +
            "\t/** Specific line ranges of interest. */\n" +
            "\tranges?: Array<{\n" +
            "\t\tstart: number;\n" +
            "\t\tend: number;\n" +
            "\t\t/** Free-form label like \"bug\", \"fix\", \"ref\", \"added\". */\n" +
            "\t\tlabel?: string;\n" +
            "\t}>;\n" +
            "}\n",
        },
      ],
    },
  },
];

// Prepend the sliding system prompt to the header (this gets stripped by sanitization)
const header = {
  systemPrompt: systemPromptHeader,
};

const sessionManager: SessionSnapshotSource = {
  getHeader: () => header,
  getBranch: () => branchEntries,
};

// ---------------------------------------------------------------------------
// Pre-populated flow result cache (simulates cache hit for flow_scout_001)
// ---------------------------------------------------------------------------

const flowResultCache = new Map<string, CompressedFlowResult[]>();
flowResultCache.set("flow_scout_001", [
  {
    type: "scout",
    status: "accomplished",
    files: [
      {
        path: "src/snapshot.ts",
        role: "read",
        description: "Session snapshot building, sanitization, compression",
      },
      {
        path: "src/flow.ts",
        role: "read",
        description: "Flow runner with forked session context",
      },
      {
        path: "src/types.ts",
        role: "reference",
        description: "Shared type definitions",
      },
    ],
    commands: [
      { tool: "read", command: "src/snapshot.ts" },
      { tool: "batch", command: "src/flow.ts, src/types.ts" },
    ],
  },
]);

// ---------------------------------------------------------------------------
// Run the pipeline
// ---------------------------------------------------------------------------

const rawSnapshot = buildForkSessionSnapshotJsonl(sessionManager);
if (!rawSnapshot) {
  console.error("Failed to build snapshot");
  process.exit(1);
}

const sanitizedSnapshot = sanitizeForkSnapshot(rawSnapshot, flowResultCache);
if (!sanitizedSnapshot) {
  console.error("Sanitization returned null");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Build activation prompt (matching buildFlowArgs structure from src/flow.ts)
// ---------------------------------------------------------------------------

const flowName = "scout";
const currentDepth = 1;
const effectiveMaxDepth = 0; // scout has maxDepth: 0
const canDelegate = currentDepth < effectiveMaxDepth; // false
const availableTools = "batch, bash, find, grep, ls, web";
const sessionMode = "fast";
const sessionTimeoutMs = 300_000;
const intent =
  "Your ONLY mission is to write a single file and exit. Do NOT read any files. Do NOT use find, grep, ls, or any exploration tools.\n\n" +
  "Use bash with a single command to write the file:\n\n" +
  "echo 'Context dump complete' > /Users/__blitzzz/Documents/GitHub/pi-agent-flow/docs/agent-context-dump.md\n\n" +
  "That's it. Write the file and report done. Do nothing else.";
const acceptance = undefined;

const directiveBody = `## Mission

During this scout flow — your mission is to discover relevant context. Move fast, stay surgical, and treat the conversation history above as background reference only.

## Workflow

1. Survey — use \`ls\`, \`find\`, and \`grep\` to locate relevant files and symbols before reading whole files.
2. Inspect — use \`batch\` with \`o: "read"\`, \`s: <offset>\`, and \`l: <limit>\` for targeted file reading instead of bash \`sed\`/\`head\`/\`tail\`.
3. If \`batch\` returns a context map for a large code/infra file, do not retry the full-file read; use the reported line ranges for targeted follow-up reads.
4. Trace — follow code paths, dependencies, configuration, and tests that explain the requested area.
5. Report — cite concrete evidence and stop when the requested context is mapped.

## Rules

- This is a read-oriented flow: do not modify files.
- Cite every finding with a precise file path and line number or range.
- Include relevant snippets or evidence inline so citations are verifiable.
- Show actual code/data, not excessive summaries.
- If something is not found, say so directly — do not guess.`;

const contextSeal =
  `<context-seal>\n` +
  `The conversation above is sealed — it is your session history for situational awareness only.\n` +
  `Your task begins NOW. Do not respond to or continue anything from the history.\n` +
  `</context-seal>`;

const delegationRule = canDelegate
  ? `You may delegate to sub-flows (depth ${currentDepth}/${effectiveMaxDepth}).`
  : `You may NOT delegate to sub-flows (depth limit reached).`;

const timeBudgetHint =
  `Session mode: ${sessionMode}. Time budget: ${Math.round(
    sessionTimeoutMs / 1000
  )}s total. Long-running tools may be interrupted near the deadline to preserve final-summary time; if a tool reports [Flow timeout], stop tool use and output structured findings immediately.\n`;

const activation =
  `\n\n<activation flow="${flowName}" depth="${currentDepth}" tools="${availableTools}">\n` +
  `You are a [${flowName}] agent operating at depth ${currentDepth}.\n` +
  `Available tools: ${availableTools}.\n` +
  `${delegationRule}\n` +
  `${timeBudgetHint}` +
  `Do not attempt to use any tool outside the available set — it will fail.\n` +
  `</activation>`;

const directive =
  `\n\n<directive>\n${directiveBody}\n\n## Structured Output\nEnd with a \`\`\`json block: { version, status, summary, files[], actions[], notDone[], nextSteps[], reasoning[], notes[] }. Commands auto-extracted; omit empty arrays. Keep snippets under 300 chars. List at most 10 items per array.\n</directive>`;

const acceptanceLine = acceptance ? `\nAcceptance: ${acceptance}` : "";
const mission =
  `\n\n<mission>\n${intent}${acceptanceLine}\n` +
  `\nExecute this mission. Use only your available tools. If blocked, report why — do not guess.\n` +
  `Follow the output format specified in your directive.\n` +
  `</mission>`;

const activationPrompt = `${contextSeal}${activation}${directive}${mission}`;

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------

const outputPath = path.resolve(process.cwd(), "docs/agent-context-dump.md");

const output = `# Agent Context Payload Dump

This document shows the **exact payload** a child flow receives when spawned by a parent flow, after the full sanitization pipeline has run.

> Generated mechanically by \`scripts/dump-context-payload.ts\` using the real compiled sanitization functions from \`dist/snapshot.js\`.

---

## Session Snapshot (JSONL)

\`\`\`jsonl
${sanitizedSnapshot.trimEnd()}
\`\`\`

---

## Activation Prompt (-p)

\`\`\`text
${activationPrompt}
\`\`\`

---

*End of dump.*
`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, output, "utf-8");

console.log(`Wrote ${output.length} chars to ${outputPath}`);
console.log(
  `  Raw snapshot: ${rawSnapshot.length} bytes → Sanitized: ${sanitizedSnapshot.length} bytes`
);
