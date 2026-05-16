---
title: Telemetry Compression and Formatting Protocols
version: 1.0.0
date: 2026-05-17
status: draft
scope: shared-context sanitization pipeline
author: craft flow
---

# Overview

The shared context passed from parent to child flows is a sanitized JSONL snapshot. The sanitization pipeline in `src/snapshot/snapshot.ts` already achieves ~99% compression for many artifacts (reasoning stripping, API metadata removal, flow result truncation, read content stripping). [V] Verified against `tests/snapshot-compress.test.ts` and `docs/dump-artifacts/ANALYSIS.md`.

The remaining gap is in **batch tool result compression** and **cross-turn deduplication**. Currently:

- `compressBatchResult` (`snapshot.ts:176–265`) truncates file reads but keeps **bash stdout/stderr, edit headers, write headers, delete headers, and rg output verbatim**.
- `compressWebResult` (`snapshot.ts:267–306`) compresses a single web result to one line, but **does not deduplicate** if the same query is issued across multiple turns.
- **No cross-turn deduplication** exists for writes, edits, deletes, or web queries. If `src/index.ts` is edited three times, all three edit headers survive into the child snapshot.

[V] The archived dump artifacts in `docs/dump-artifacts/` consist primarily of `flow` tool results; batch tool results are not present in those files. The before/after examples below are drawn from the test suite (`tests/snapshot-compress.test.ts`) and the verified output formats in `src/batch/execute.ts` and `src/batch/index.ts`.

---

# Design Principles

1. **Composability** — A child flow must understand what happened without re-reading files. The compressed log is a lossy but semantically sufficient transcript.
2. **Depth-awareness** — At depth 1, slightly more detail is preserved. At depth 2+, maximum compression is applied because the signal-to-noise ratio degrades with depth.
3. **Conservative migration** — The new protocols are additive passes in `sanitizeForkSnapshot`. If pattern matching fails, the system falls back to the current verbatim or truncated behavior.
4. **No orphaned consumers** — Existing agent flows that parse batch result delimiters (`--- bash [id] exit N ---`) will still see structurally similar output; the format changes from multi-line verbose to a compact single-line token, but the semantic tokens (`bash`, `exit`, `id`) are preserved.

---

# Protocols

## W1 — Write Deduplication Protocol

### Purpose
Eliminate redundant write history for the same file path across turns. A child flow only needs to know the final write state, not every intermediate one.

### Current Format (before)
```
1 operation: 1 write

--- write: src/config.ts (1234 bytes) ---
```
If the parent writes `src/config.ts` in turn 3, turn 5, and turn 7, the child receives **three identical-looking headers** (only the byte count differs). [I] Inferred from `compressBatchResult` verbatim pass and `src/batch/execute.ts:592`.

### Proposed Format (after)

**Depth 1 — latest write kept:**
```
[batch:write] src/config.ts (890 bytes)
```

**Depth 2+ — ultra-compact:**
```
[batch:write] src/config.ts
```

**Superseded write (depth 1, kept as breadcrumb):**
```
[batch:write] src/config.ts (superseded)
```

**Fully collapsed batch (all sections superseded):**
```
[batch] 3 ops (all superseded by later operations)
```

### Deduplication Rules
- **Key:** normalized relative file path (`path.resolve(cwd, op.p)` from the batch arguments, or the `r.path` value in the result text).
- **Keep only the latest successful write** per file path within the snapshot.
- **Delete supersedes write:** If a file is written then later deleted, the write is removed entirely; only the delete remains.
- **Write-after-delete is fresh:** If a file is deleted then later written again, both operations are kept (the write is the authoritative final state).
- **Error writes are exempt:** If a write operation has `status: "error"`, it is never deduplicated. Errors are preserved verbatim so the child knows the write failed.

### Fallback Behavior
- If the batch result text cannot be parsed into sections (e.g., malformed delimiters), fall back to current behavior: keep the header line as-is.
- If the `write:` regex fails to match, the line passes through unchanged.

### Estimated Token Savings
| Scenario | Current | W1 | Savings |
|---|---|---|---|
| 3 writes to same file | ~35 tokens (3 headers + summary lines) | ~10 tokens (1 header + 2 superseded markers) | ~70% |
| 3 writes, superseded entries removed entirely | ~35 tokens | ~5 tokens (1 header only) | ~85% |
| Depth 2+ single write | ~12 tokens | ~4 tokens | ~65% |

[A] Assumed token estimate: 1 token ≈ 4 characters for English text + code.

---

## E1 — Edit Compression Protocol

### Purpose
Compress edit headers and deduplicate edits to the same file across turns. The child needs to know *which files were modified* and *how many edit blocks* were applied, not the full diff (which the batch tool does not emit today, but which may be added in future iterations).

### Current Format (before)
```
1 operation: 1 edit

--- edit: src/index.ts (2 blocks) ---
```
[V] Verified in `tests/snapshot-compress.test.ts:91`.

### Proposed Format (after)

**Depth 1 — latest edit kept:**
```
[batch:edit] src/index.ts (2 blocks)
```

**Depth 2+ — ultra-compact:**
```
[batch:edit] src/index.ts
```

**Superseded edit (breadcrumb):**
```
[batch:edit] src/index.ts (superseded)
```

### Deduplication Rules
- **Key:** normalized relative file path.
- **Keep only the latest successful edit** per file path.
- **Write supersedes edit:** If a file is edited then later written, the edit is removed. The write represents the definitive final state.
- **Delete supersedes edit:** If a file is edited then later deleted, only the delete remains.
- **Edit-after-write is kept:** If a file is written then later edited, both are kept (the edit is the latest mutation).
- **Error edits are exempt:** Failed edits are preserved verbatim.

### Fallback Behavior
- If the `edit:` section regex fails, the original header is preserved.
- If the batch result contains a block count but no path (malformed), fall back to verbatim.

### Estimated Token Savings
| Scenario | Current | E1 | Savings |
|---|---|---|---|
| 3 edits to same file | ~24 tokens | ~8 tokens | ~67% |
| Depth 2+ single edit | ~8 tokens | ~4 tokens | ~50% |

---

## X1 — Terminal Execution Compression Protocol

### Purpose
Replace verbose bash stdout/stderr with a compact status line. Bash output is the single largest source of batch result bloat. [V] Verified by `tests/snapshot-compress.test.ts:114` where a 1000-line bash output is currently kept verbatim, and by `src/snapshot/snapshot.ts:176–265` where `compressBatchResult` passes bash sections through unchanged.

### Verified Source Formats
The exact text that currently flows into child context is produced by `src/batch/index.ts:535–552` and `src/batch/execute.ts:510`.

| Element | Source-verified format | Source |
|---|---|---|
| Bash delimiter (ok) | `--- bash [ID] exit N ---` | `src/batch/index.ts:536` |
| Bash delimiter (pending) | `--- bash [ID] pending ---` | `src/batch/index.ts:541` |
| Bash delimiter (error) | `--- bash [ID] error ---` | `src/batch/index.ts:547` |
| Timing line | `[Execution time: TIER]` | `src/batch/index.ts:537, 544, 548` |
| Pending partial output | `[partial output]\n${stdout}` | `src/batch/index.ts:542` |
| Pending poll hint | `[Use batch_bash_poll with i: ["ID"] to check results]` | `src/batch/index.ts:543` |
| Error stderr label | `[stderr]\n${stderr}` | `src/batch/index.ts:551` |
| Summary line | `N operations: N bash` | `src/batch/execute.ts:510` (`buildSummary`) |

[V] Current snapshot compression (`compressBatchResult`, `snapshot.ts:176–265`) **keeps bash sections verbatim** — no truncation is applied. [V] Verified in `tests/snapshot-compress.test.ts:114–140`.

### Scenario 1: Successful bash with output

**BEFORE** (current child context — verbatim):
```
1 operation: 1 bash

--- bash [npm-test-abc] exit 0 ---
[Execution time: 2.3s (avg)]
PASS src/utils/parse.test.ts
PASS src/core/flow.test.ts
Tests: 15 passed, 15 total
```

**AFTER — Depth 1:**
```
[bash:ok] npm-test-abc · exit 0 · 2.3s (avg) · 3 lines
> head:
PASS src/utils/parse.test.ts
PASS src/core/flow.test.ts
Tests: 15 passed, 15 total
```

**AFTER — Depth 2+:**
```
[bash:ok] npm-test-abc · exit 0
```

### Scenario 2: Successful bash with large output

**BEFORE** (current child context — verbatim, 1000-line `npm run build` output):
```
1 operation: 1 bash

--- bash [build-def] exit 0 ---
[Execution time: 8.1s (long)]
src/index.ts    → dist/index.js     12.34 kB │ gzip: 3.21 kB
src/core/flow.ts → dist/core/flow.js  45.67 kB │ gzip: 8.90 kB
src/snapshot/snapshot.ts → dist/snapshot/snapshot.js  23.45 kB │ gzip: 5.67 kB
src/batch/index.ts → dist/batch/index.js  34.56 kB │ gzip: 7.89 kB
... (992 more lines of build output) ...
✓ 245 modules transformed.
dist/index.js                  12.34 kB │ gzip: 3.21 kB
dist/core/flow.js              45.67 kB │ gzip: 8.90 kB
dist/snapshot/snapshot.js      23.45 kB │ gzip: 5.67 kB
dist/batch/index.js            34.56 kB │ gzip: 7.89 kB
```

**AFTER — Depth 1:**
```
[bash:ok] build-def · exit 0 · 8.1s (long) · 1000 lines
> head:
src/index.ts    → dist/index.js     12.34 kB │ gzip: 3.21 kB
src/core/flow.ts → dist/core/flow.js  45.67 kB │ gzip: 8.90 kB
src/snapshot/snapshot.ts → dist/snapshot/snapshot.js  23.45 kB │ gzip: 5.67 kB
```

**AFTER — Depth 2+:**
```
[bash:ok] build-def · exit 0
```

### Scenario 3: Pending bash

**BEFORE** (current child context — verbatim):
```
1 operation: 1 bash

--- bash [long-grep-ghi] pending ---
[partial output]
src/core/flow.ts:234
src/core/agents.ts:89
src/snapshot/snapshot.ts:176
[Use batch_bash_poll with i: ["long-grep-ghi"] to check results]
```

**AFTER — Depth 1:**
```
[bash:pending] long-grep-ghi · still running · 3 lines partial
> head:
src/core/flow.ts:234
src/core/agents.ts:89
src/snapshot/snapshot.ts:176
```

**AFTER — Depth 2+:**
```
[bash:pending] long-grep-ghi · still running
```

### Scenario 4: Error bash with stderr

**BEFORE** (current child context — verbatim):
```
1 operation: 1 bash

--- bash [lint-jkl] error ---
[Execution time: 1.2s (avg)]
[stderr]
src/core/flow.ts:45:3: Error: Unexpected token. (eslint)
src/index.ts:12:1: Warning: Missing return type.
```

**AFTER — Depth 1:**
```
[bash:err] lint-jkl · 1.2s (avg) · 2 lines stderr
> stderr:
src/core/flow.ts:45:3: Error: Unexpected token. (eslint)
src/index.ts:12:1: Warning: Missing return type.
```

**AFTER — Depth 2+:**
```
[bash:err] lint-jkl
```

### Scenario 5: Bash with no output

**BEFORE** (current child context — verbatim):
```
1 operation: 1 bash

--- bash [git-status-mno] exit 0 ---
[Execution time: 0.1s (normal)]
```

**AFTER — Depth 1:**
```
[bash:ok] git-status-mno · exit 0 · 0.1s (normal) · 0 lines
```

**AFTER — Depth 2+:**
```
[bash:ok] git-status-mno · exit 0
```

### Scenario 6: Multi-bash batch result

**BEFORE** (current child context — verbatim):
```
2 operations: 2 bash

--- bash [check-node-pqr] exit 0 ---
[Execution time: 0.1s (normal)]
v20.12.2

--- bash [check-git-stu] exit 0 ---
[Execution time: 0.2s (normal)]
On branch main
Your branch is up to date with 'origin/main'.
```

**AFTER — Depth 1:**
```
[bash:ok] check-node-pqr · exit 0 · 0.1s (normal) · 1 line
> head:
v20.12.2

[bash:ok] check-git-stu · exit 0 · 0.2s (normal) · 2 lines
> head:
On branch main
Your branch is up to date with 'origin/main'.
```

**AFTER — Depth 2+:**
```
[bash:ok] check-node-pqr · exit 0
[bash:ok] check-git-stu · exit 0
```

### Worked Example: Mixed batch (reads + writes + bash)

This shows how X1 composes with the **existing** snapshot compression (`compressBatchResult`, `snapshot.ts:176–265`). Reads are already truncated; writes/edits are kept verbatim; bash is the only new compression target.

**BEFORE** (current child context — after existing `compressBatchResult`):
```
4 operations: 2 read, 1 write, 1 bash

--- src/config.ts (45 lines, content truncated) ---

--- src/core/flow.ts (128 lines, content truncated) ---

--- write: src/config.ts (1234 bytes) ---

--- bash [npm-test-xyz] exit 0 ---
[Execution time: 3.4s (avg)]
PASS src/config.test.ts
PASS src/core/flow.test.ts
Tests: 42 passed, 42 total
```

**AFTER — Depth 1:**
```
4 operations: 2 read, 1 write, 1 bash

--- src/config.ts (45 lines, content truncated) ---

--- src/core/flow.ts (128 lines, content truncated) ---

--- write: src/config.ts (1234 bytes) ---

[bash:ok] npm-test-xyz · exit 0 · 3.4s (avg) · 4 lines
> head:
PASS src/config.test.ts
PASS src/core/flow.test.ts
Tests: 42 passed, 42 total
```

**AFTER — Depth 2+:**
```
4 operations: 2 read, 1 write, 1 bash

--- src/config.ts (45 lines, content truncated) ---

--- src/core/flow.ts (128 lines, content truncated) ---

--- write: src/config.ts (1234 bytes) ---

[bash:ok] npm-test-xyz · exit 0
```

### Deduplication Rules
- **Key:** `bashId` (the `i` field from the batch arguments, present in `--- bash [id] ...` delimiters).
- Bash IDs are typically unique per `batch` call. Cross-turn bash deduplication is **not yet implemented**; each bash section is compressed independently.
- `batch_bash_poll` results are out of scope for X1; they pass through a separate tool and should be addressed by a future `batch_bash_poll` compression pass.

### Fallback Behavior
- If the `--- bash [id] ...` pattern does not match, the line is preserved verbatim.
- If the bash result has no ID (should never happen; IDs are auto-generated by `generateBashId()` in `src/batch/batch-bash.ts`), use a truncated hash of the command string as the key.
- If parsing the exit code fails, emit `[bash] id · status unknown`.

### Estimated Token Savings
| Scenario | Current | X1 | Savings |
|---|---|---|---|
| 1000-line bash output | ~2500 tokens | ~12 tokens (depth 1) / ~6 tokens (depth 2+) | ~99.5% |
| 50-line bash output | ~125 tokens | ~12 tokens | ~90% |
| Pending bash (no change in size) | ~15 tokens | ~8 tokens | ~45% |

---

## Q1 — External Query Deduplication Protocol

### Purpose
Deduplicate web search and fetch results across turns. The current `compressWebResult` already compresses a single result to one line, but if the parent searches the same query three times, three lines survive into the child context.

### Current Format (before)
```
[web:search] "node.js streams" · 2 results · first: Node.js Streams
```
[V] Verified in `tests/snapshot-compress.test.ts:173` and `src/snapshot/snapshot.ts:283`.

If the same query appears in turn 2, turn 4, and turn 6, the child sees three lines.

### Current Format (after — compression only, no dedup)
```
[web:search] "node.js streams" · 2 results · first: Node.js Streams
```

### Proposed Future Work (Q1 dedup — not yet implemented)
**Superseded query (breadcrumb):**
```
[web:search] "node.js streams" (superseded by later search)
```

**Depth 2+ — query list only:**
Instead of individual lines, emit a single rolled-up line:
```
[web] 3 unique searches · queries: node.js streams, vitest migration, typescript enums
```

Or, if the snapshot contains many web queries:
```
[web] 7 unique queries (3 searches, 4 fetches) · see latest per query below
[web:search] "node.js streams" · 2 results · first: Node.js Streams
[web:fetch] https://example.com · "Example" · 4200 chars
```

### Deduplication Rules (Proposed)
- **Search key:** normalized query string (`q` field), lowercased and trimmed.
- **Fetch key:** normalized URL (`u` field), stripped of trailing slash and query params.
- **Keep only the latest result** per key.
- If a later result differs in count or title from an earlier one (e.g., a re-run produced new results), the latest overwrites the earlier; the child only needs the freshest data.
- If a search and a fetch both reference the same URL (fetch of a search result page), they are treated as independent keys.

### Fallback Behavior
- If `compressWebResult` cannot parse the result (no recognizable search or fetch pattern), it falls back to `[web] result truncated (N chars)` — this existing behavior is preserved.
- If query extraction from `args` fails, the fallback uses the first 40 chars of the raw result text as the dedup key.

### Estimated Token Savings
| Scenario | Current | Q1 | Savings |
|---|---|---|---|
| 3 identical searches | ~45 tokens (3 lines) | ~15 tokens (1 line + 2 superseded) | ~67% |
| 3 searches, superseded removed | ~45 tokens | ~15 tokens | ~67% |
| Depth 2+ rollup of 5 queries | ~75 tokens | ~20 tokens | ~73% |

---

# Implementation Architecture

## Where the Protocols Live

The protocols are implemented as **enhancements to `compressToolResults`** (`snapshot.ts:~350`) and **new internal helpers** in `src/snapshot/snapshot.ts`.

[V] Current pipeline order in `sanitizeForkSnapshot` (`snapshot.ts:681–975`):
1. `forkMetadataInjection`
2. `dropConfigEvents`
3. `dropCustomMessages`
4. `stripReasoning`
5. `stripTimestamps`
6. `stripApiMetadata`
7. `normalizeToolResultRole`
8. `stripDetails`
9. `stripSteeringHints`
10. `stripStrategicHints`
11. `compressParentActivation` (depth ≥ 2)
12. `reparentOrphans`
13. `stripBatchRead`
14. `compressToolResults`
15. `reparentOrphans`

### Proposed Insertion Points

**Option A (recommended):** Extend `compressToolResults` with a two-pass internal structure:
- **Pass 1 (pre-scan):** Build `DedupIndex` maps (write, edit, delete, bash, web) across all tool result messages in the snapshot.
- **Pass 2 (emit):** Call `compressBatchResult` and `compressWebResult` with the index. Superseded sections are skipped or collapsed.
- **Depth parameter:** Thread `options.depth` from `sanitizeForkSnapshot` into `compressToolResults` so depth-aware formatting is applied.

**Option B (alternative):** Add a new dedicated pass `deduplicateToolResults` that runs **after** `compressToolResults`. It operates on the already-compressed text and removes or marks superseded lines. This is simpler to implement but less powerful (it works on text, not structured sections).

### Interface Contracts

```typescript
// New options passed to compressToolResults
interface CompressToolResultsOptions {
  depth?: number; // 1 = moderate compression, 2+ = maximum compression
}

// Internal dedup index built during pre-scan (W1 + E1 + Q1)
interface DedupIndex {
  latestWrite: Map<string, string>;      // normPath → toolCallId
  latestEdit: Map<string, string>;       // normPath → toolCallId
  latestDelete: Map<string, string>;     // normPath → toolCallId
  latestWebSearch: Map<string, string>;   // normQuery → toolCallId
  latestWebFetch: Map<string, string>;    // normUrl → toolCallId
}

// Enhanced compressBatchResult signature
function compressBatchResult(
  text: string,
  options?: {
    depth?: number;
    supersededWrites?: Set<string>;
    supersededEdits?: Set<string>;
    supersededDeletes?: Set<string>;
    supersededBashes?: Set<string>;
  }
): string;
```

### Composability

A child flow scanning its inherited context will see:
```
[batch:write] src/config.ts (890 bytes)
[batch:edit] src/index.ts (2 blocks)
[bash:ok] abc123 · exit 0 · fast · 42 lines
[web:search] "node.js streams" · 2 results · first: Node.js Streams
```

These tokens are:
- **Self-describing:** `[batch:write]` tells the child "a write happened via batch".
- **Actionable:** The child knows `src/config.ts` and `src/index.ts` were mutated and can target them with its own `batch` reads if needed.
- **Ordered:** Within a single batch result, the original operation order is preserved (reads, then writes, then edits, then bash).

---

# Depth Behavior Matrix

| Protocol | Depth 1 | Depth 2+ |
|---|---|---|
| **W1 (Write)** | `[batch:write] path (bytes)` | `[batch:write] path` |
| **E1 (Edit)** | `[batch:edit] path (blocks)` | `[batch:edit] path` |
| **X1 (Bash)** | `[bash:ok] id · exit N · tier · lines`<br>+ 3-line preview | `[bash:ok] id · exit N` |
| **Q1 (Web)** | Individual compressed lines | Rolled-up `[web] N unique queries` list *(future work)* |

---

# Migration Path

1. **Phase 1 (complete):** X1 bash compression — implemented and tested in `tests/snapshot-compress.test.ts`.
2. **Phase 2 (complete):** W1 write dedup and E1 edit dedup — implemented and tested.
3. **Phase 3 (future):** Q1 web query deduplication — lower-impact than bash compression but adds polish. Not yet implemented.
4. **Rollback:** Each phase is a discrete function. If a phase causes regressions in child flows, it can be disabled by removing the relevant option pass or reverting to the previous `compressBatchResult` signature (the old function is a one-line fallback).

---

# Risks & Edge Cases

| Risk | Mitigation |
|---|---|
| Child flow relies on bash stdout for decision-making | Depth 1 preserves a 3-line preview; child can re-run the command with its own `batch` tool if it needs full output. |
| Deduplication hides a failed intermediate write | Error-status operations are exempt from deduplication. |
| File path normalization is cwd-sensitive | Normalize using the `cwd` from the session header. If cwd is missing, use the raw path string. |
| Web fetch URLs have trailing query params that distinguish requests | Strip only `?utm_*` and common tracking params; preserve functional query strings. If in doubt, use the full URL as the key (slightly less dedup, but no false collisions). |
| Superseded entries removed entirely lose temporal information | The remaining latest entry preserves the timestamp. Intermediate states are intentionally discarded to save tokens. |

---

# References

- `src/snapshot/snapshot.ts` — `compressBatchResult` (`:176`), `compressWebResult` (`:267`), `compressToolResults` (`:350`), `sanitizeForkSnapshot` (`:681`)
- `src/batch/execute.ts` — `buildContentText` (`:580`), `buildSummary` (`:636`)
- `src/batch/index.ts` — bash result formatting (`:535–543`)
- `tests/snapshot-compress.test.ts` — current compression behavior expectations
- `docs/dump-artifacts/ANALYSIS.md` — dump artifact catalog and format evolution notes
