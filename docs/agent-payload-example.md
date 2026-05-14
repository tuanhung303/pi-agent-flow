# Agent Payload — What a Child Flow Actually Receives

This document shows the **exact payload** passed to a child flow when the orchestrator delegates. Every byte, every tag, every compression artifact is reproduced from the actual code.

> Generated from: `src/flow.ts` (`buildFlowArgs`, `runFlow`), `src/snapshot.ts` (`buildForkSessionSnapshotJsonl`, `sanitizeForkSnapshot`), `agents/scout.md`

---

## 1. CLI Invocation

The parent spawns the child as a **separate `pi` process** with no IPC. The child is completely isolated except for the arguments and the temp session file.

```bash
pi \
  --mode json \
  --session /tmp/pi-agent-flow-abc123/flow-scout.jsonl \
  --tools batch,bash,find,grep,ls,web \
  --thinking low \
  -p "<context-seal>...<activation>...<directive>...<mission>..."
```

Key flags:
- `--mode json` → child streams NDJSON lines back to parent
- `--session <path>` → the **forked conversation history** (JSONL file)
- `--tools` → exactly what this flow is allowed to call
- `--thinking low` → from the flow's frontmatter (not inherited from parent)
- `-p "..."` → the activation prompt **concatenated after** the session file contents

---

## 2. The `-p` Prompt (Activation Prompt)

This is built by `buildFlowArgs()` in `src/flow.ts:281-401`. It is **not** the system prompt — it is a special message that appears **after** all session history, sealed off by `<context-seal>`.

```
<context-seal>
The conversation above is sealed — it is your session history for situational awareness only.
Your task begins NOW. Do not respond to or continue anything from the history.
</context-seal>

<activation flow="scout" depth="1" tools="batch, bash, find, grep, ls, web">
You are a [scout] agent operating at depth 1.
Available tools: batch, bash, find, grep, ls, web.
You may NOT delegate to sub-flows (depth limit reached).
Session mode: long. Time budget: 900s total. Long-running tools may be interrupted near the deadline to preserve final-summary time; if a tool reports [Flow timeout], stop tool use and output structured findings immediately.
Do not attempt to use any tool outside the available set — it will fail.
</activation>

<directive>
## Mission

During this scout flow — your mission is to discover relevant context. Move fast, stay surgical, and treat the conversation history above as background reference only.

## Workflow

1. Survey — use `ls`, `find`, and `grep` to locate relevant files and symbols before reading whole files.
2. Inspect — use `batch` with `o: "read"`, `s: <offset>`, and `l: <limit>` for targeted file reading instead of bash `sed`/`head`/`tail`.
3. If `batch` returns a context map for a large code/infra file, do not retry the full-file read; use the reported line ranges for targeted follow-up reads.
4. Trace — follow code paths, dependencies, configuration, and tests that explain the requested area.
5. Report — cite concrete evidence and stop when the requested context is mapped.

## Rules

- This is a read-oriented flow: do not modify files.
- Cite every finding with a precise file path and line number or range.
- Include relevant snippets or evidence inline so citations are verifiable.
- Show actual code/data, not excessive summaries.
- If something is not found, say so directly — do not guess.

## Structured Output
End with a ```json block: { version, status, summary, files[], actions[], notDone[], nextSteps[], reasoning[], notes[] }. Commands auto-extracted; omit empty arrays. Keep snippets under 300 chars. List at most 10 items per array.
</directive>

<mission>
Map the shared context mechanism end-to-end. Trace how a parent session is serialized, sanitized, compressed, and passed to child flows. Focus on the compression of tool results (flow, batch_read, batch, web, ask_user) and the inheritance chain.

Execute this mission. Use only your available tools. If blocked, report why — do not guess.
Follow the output format specified in your directive.
</mission>
```

---

## 3. The Session Snapshot (JSONL File)

This is the **forked parent conversation history**. It lives at `/tmp/pi-agent-flow-abc123/flow-scout.jsonl` (temp dir, `0o600` perms, deleted on child exit).

The file is built by `buildForkSessionSnapshotJsonl()` then run through `sanitizeForkSnapshot()`. Below is a **realistic before/after** showing every sanitization pass.

### 3a. Raw Snapshot (before sanitization)

This is what `sessionManager.getHeader()` + `sessionManager.getBranch()` produces:

```jsonl
{"systemPrompt":"You are pi, an orchestrator...","model":"..."}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Review the shared context and tell me how it works"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"I'll delegate this to a scout flow."},{"type":"toolCall","type":"toolCall","name":"flow","id":"call_001","arguments":{"flow":[{"type":"scout","intent":"Map the shared context mechanism..."}]}}]}}
{"type":"message","message":{"role":"tool","toolCallId":"call_001","content":[{"type":"text","text":"[Flow: scout accomplished]\\n  Files: src/snapshot.ts\\n  Commands: grep -r 'compress' src/\\n  Summary: Full compression pipeline mapped."}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Now let me build the fix."},{"type":"toolCall","type":"toolCall","name":"flow","id":"call_002","arguments":{"flow":[{"type":"build","intent":"Fix the cache miss placeholder..."}]}}]}}
{"type":"message","message":{"role":"tool","toolCallId":"call_002","content":[{"type":"text","text":"[Flow: build accomplished]\\n  Files: src/snapshot.ts (modified)\\n  Commands: npm test\\n  Summary: All 971 tests pass."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"how do we handle sessions of multiple flows?"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"<thinking>\\nThe user is asking about sequential flows...\\n</thinking>\\nWhen scout runs first, then build runs in a separate turn, the build sees the scout's compressed result via the flow result cache."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"for edge case do we need to fix anything"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Let me audit the edge cases."},{"type":"toolCall","type":"toolCall","name":"batch_read","id":"call_003","arguments":{"o":[{"p":"src/snapshot.ts","s":1,"l":100},{"p":"src/executor.ts","s":150,"l":50}]}}]}}
{"type":"message","message":{"role":"tool","toolCallId":"call_003","content":[{"type":"text","text":"--- src/snapshot.ts (100 lines) ---\\nexport function buildForkSession...\\n--- src/executor.ts (50 lines) ---\\nconst FLOW_RESULT_CACHE_MAX_ENTRIES = 100;\\n"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"The edge cases look manageable. The cache overflow at 100 entries is handled with a placeholder."}]}}
```

### 3b. Sanitized Snapshot (after `sanitizeForkSnapshot`)

This is what actually gets written to the temp file and loaded by the child.

```jsonl
{"systemPrompt":"You are pi, an orchestrator..."}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Review the shared context and tell me how it works"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"I'll delegate this to a scout flow."},{"type":"toolCall","type":"toolCall","name":"flow","id":"call_001","arguments":{"flow":[{"type":"scout","intent":"Map the shared context mechanism..."}]}}]}}
{"type":"message","message":{"role":"tool","toolCallId":"call_001","content":[{"type":"text","text":"[Flow: scout accomplished]\\nFiles:\\n  src/snapshot.ts\\nCommands:\\n  grep: grep -r 'compress' src/\\n\\nSummary: Full compression pipeline mapped."}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Now let me build the fix."},{"type":"toolCall","type":"toolCall","name":"flow","id":"call_002","arguments":{"flow":[{"type":"build","intent":"Fix the cache miss placeholder..."}]}}]}}
{"type":"message","message":{"role":"tool","toolCallId":"call_002","content":[{"type":"text","text":"[Flow: build accomplished]\\nFiles:\\n  src/snapshot.ts (modified)\\nCommands:\\n  cmd: npm test\\n\\nSummary: All 971 tests pass."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"how do we handle sessions of multiple flows?"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"When scout runs first, then build runs in a separate turn, the build sees the scout's compressed result via the flow result cache."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"for edge case do we need to fix anything"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Let me audit the edge cases."}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"The edge cases look manageable. The cache overflow at 100 entries is handled with a placeholder."}]}}
```

### 3c. Key Sanitizations Applied

| Pass | What Changed | Why |
|------|-------------|-----|
| **Sliding prompts stripped** | Header `systemPrompt` cleaned of steering hints | Children don't need parent's steering |
| **System messages dropped** | Any `role: "system"` with steering hints → removed entirely | Prevents child from inheriting parent's dynamic prompts |
| **Reasoning stripped** | `<thinking>...</thinking>` removed from assistant message | Reduces tokens, removes internal deliberation |
| **`toolResult` → `tool`** | `role: "toolResult"` normalized to `role: "tool"` | API compatibility |
| **Strategic hints stripped** | Hidden steering tags removed from tool result content | Children shouldn't see parent's hidden instructions |
| **`batch_read` stripped** | ToolCall + toolResult for `batch_read` completely removed | Children don't have `batch_read` tool — would confuse API |
| **Flow results compressed** | Raw flow output replaced with `[Flow: X accomplished] Files... Commands...` | Cuts megabytes to ~200 bytes via cache |
| **Batch results compressed** | File read content truncated, bash kept verbatim | Reconstructable by child with `batch` tool |
| **Cache miss placeholder** | If flow result not in cache: `[flow] prior result · N chars (cache expired — output unavailable)` | Prevents token explosion from raw output |

---

## 4. Full Child Session Assembly

The child `pi` process assembles its session like this:

```
┌─────────────────────────────────────────────────────────────────────┐
│  SYSTEM PROMPT  (from --session file, line 1: header.systemPrompt)   │
├─────────────────────────────────────────────────────────────────────┤
│  MESSAGE 1  (user)     "Review the shared context..."               │
│  MESSAGE 2  (assistant) "I'll delegate this..." + flow toolCall   │
│  MESSAGE 3  (tool)      [Flow: scout accomplished] (compressed)     │
│  MESSAGE 4  (assistant) "Now let me build..." + flow toolCall       │
│  MESSAGE 5  (tool)      [Flow: build accomplished] (compressed)   │
│  MESSAGE 6  (user)      "how do we handle sessions..."              │
│  MESSAGE 7  (assistant) "When scout runs first..." (no thinking)   │
│  MESSAGE 8  (user)      "for edge case do we need to fix..."       │
│  MESSAGE 9  (assistant) "Let me audit the edge cases."            │
│  MESSAGE 10 (assistant) "The edge cases look manageable..."        │
├─────────────────────────────────────────────────────────────────────┤
│  -p PROMPT  (appended as the final user message):                  │
│    <context-seal>                                                    │
│    <activation flow="scout" depth="1" ...>                           │
│    <directive> ...system prompt body... </directive>                 │
│    <mission> ...intent... </mission>                                 │
└─────────────────────────────────────────────────────────────────────┘
```

The `-p` content is **not a system prompt** — it's injected as a user-like message at the end of the conversation, after the `<context-seal>` boundary. The child LLM sees the entire history but is instructed to treat it as sealed background.

---

## 5. What the Child DOES NOT See

| Parent Artifact | In Child Snapshot? | Why |
|-----------------|-------------------|-----|
| Parent's `<thinking>` blocks | ❌ Stripped | Internal reasoning, not for children |
| Parent's sliding system prompts | ❌ Stripped | Dynamic steering, child has its own directive |
| `batch_read` tool calls + results | ❌ Stripped | Child doesn't have `batch_read` tool |
| Raw flow tool results (megabytes) | ❌ Compressed | Replaced with compact cache summary |
| Raw batch file read content | ❌ Truncated | Child can re-read with `batch` |
| Parent's `--thinking` level | ❌ Not inherited | Child uses flow's own `thinking` frontmatter |
| Parent's orchestrator identity | ✅ Partially | Child knows parent called `flow` tools, but not that parent is "orchestrator" |

---

## 6. What the Child DOES See (and why it matters)

| Parent Artifact | In Child Snapshot? | Why It Matters |
|-----------------|-------------------|--------------|
| `flow` toolCalls + compressed results | ✅ Kept | **Delegation history** — child knows what work was already done |
| `ask_user` toolCalls + compressed results | ✅ Kept | **User decisions** — child knows what the user already chose |
| `bash` tool results | ✅ Kept verbatim | **Execution evidence** — child sees exact command output |
| `web` tool results | ✅ Compressed to metadata | **Research history** — child knows what was searched/fetched |
| `batch` tool results | ✅ Selectively kept | **Bash output kept**, file reads truncated — child can reconstruct |
| User messages | ✅ Kept | **Task context** — what the user actually asked |
| Assistant messages (no reasoning) | ✅ Kept | **Intent chain** — what the parent decided to do |

---

## 7. Debugging: Inspecting Real Payloads

To capture the **actual** payload sent to a child:

```bash
# Set this before running pi — it dumps per-tool compression stats to stderr
PI_FLOW_DEBUG_CONTEXT=1 pi

# Example output:
# [context-compress] flow: 142387 → 87 bytes (100% reduction)
# [context-compress] batch_read: 2048 → 42 bytes (98% reduction)
# [context-snapshot] pre: 184320 → 2450 bytes (99% reduction)
```

Note: The temp JSONL file is **deleted** in a `finally` block after the child exits. To capture it, you would need to add `PI_FLOW_DUMP_SNAPSHOT=/path` support (not currently implemented).

---

## 8. Flow Result Cache — How Compression Works Cross-Turn

When `build` runs in **Turn 2** after `scout` in **Turn 1**:

```
Turn 1 (scout):
  1. Snapshot built → only parent history, no prior flow results
  2. scout runs → returns raw result (megabytes)
  3. Parent writes raw result to its own session as tool result
  4. Parent writes to cache: flowResultCache.set("call_001", [compressedScout])

Turn 2 (build):
  1. Snapshot built → includes parent history + Turn 1's bulky scout result
  2. sanitizeForkSnapshot → compressToolResults scans, finds "call_001"
  3. cache.get("call_001") → HIT → replaces 142KB with 87 bytes
  4. build runs with compressed snapshot
```

The cache is keyed by `toolCallId` (e.g. `call_001`). It is a **module-level singleton Map** that survives across all turns until process restart. Max 100 entries, FIFO eviction, configurable via `PI_FLOW_CACHE_MAX_ENTRIES`.

---

*End of document. This matches the actual implementation in `src/flow.ts`, `src/snapshot.ts`, and `src/executor.ts` as of the current codebase.*
