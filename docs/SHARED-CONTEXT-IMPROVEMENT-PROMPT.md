# Shared Context Compression Pipeline — Living Improvement Prompt

> **Version:** 1.0.0  
> **Scope:** `src/snapshot/snapshot.ts` sanitization pipeline  
> **Goal:** Continuously improve the shared context passed from parent → child flows while maintaining zero regression risk.  
> **Target audience:** Any future agent (craft / build / audit) tasked with compression pipeline work.

---

## Context Foundation: What This System IS

When the orchestrator delegates to a child flow (e.g. `scout`, `build`), it forks the current conversation history into a temp JSONL file (`--session <path>`). Before writing that file, the parent runs `sanitizeForkSnapshot()` which strips ~99% of bloat so the child receives only actionable signal.

### Key Files

| File | Role | Key Symbols (line numbers) |
|------|------|---------------------------|
| `src/snapshot/snapshot.ts` | Pipeline core | `sanitizeForkSnapshot` (~900), `compressToolResults` (~350), `compressBatchResult` (~420), `compressWebResult` (~267), `compressAskUserResult` (~305), `buildDedupIndex` (~380), `compressBashSection` (~200), `renderCompressedFlowResult` (~93), `stripBatchReadToolCalls` (~600) |
| `src/snapshot/reasoning-strip.ts` | Thinking block removal | `stripReasoningFromAssistantMessage` |
| `src/steering/sliding-prompt.ts` | Steering hint removal | `stripSteeringHintFromContent`, `contentContainsSteeringHintTag` |
| `src/steering/tool-utils.ts` | Strategic hint removal | `stripStrategicHintsFromContent` |
| `src/core/executor.ts` | Flow result cache | `evictCacheOverflow`, `flowResultCache` (Map keyed by `toolCallId`) |
| `tests/snapshot-compress.test.ts` | Unit tests for compression | 1435 lines — covers `compressToolResults`, `stripStrategicHints`, `compressBashSection`, `compressBatchResult` |
| `tests/snapshot-integration.test.ts` | Integration tests for full pipeline | 530 lines — covers `sanitizeForkSnapshot` end-to-end, dump artifacts, orphan freedom, `batch_read` stripping |
| `docs/telemetry-compression-protocols.md` | Spec for W1/E1/X1/Q1 protocols | 575 lines |
| `docs/CONTEXT-DIAGNOSTICS.md` | Diagnostic runbook for bloat | 116 lines |
| `docs/agent-payload-example.md` | Exact child payload anatomy | 243 lines |

### How the Pipeline Works (High-Level)

1. `buildForkSessionSnapshotJsonl()` serializes parent session → raw JSONL.
2. `sanitizeForkSnapshot()` runs 15+ ordered passes (see Current State below).
3. `compressToolResults()` does a two-pass scan: pre-scan builds `DedupIndex`, second pass emits compact text.
4. Result is written to `/tmp/pi-agent-flow-<id>/flow-<name>.jsonl` and passed to child via `--session`.
5. The child also receives an activation prompt (`-p`) with `<context-seal>`, `<activation>`, `<directive>`, `<mission>`.

---

## Current State: What's Implemented vs Pending

### Implemented Protocols

| Protocol | Description | Status | Depth 1 Format | Depth 2+ Format |
|----------|-------------|--------|----------------|-----------------|
| **X1** | Bash stdout/stderr compression | ✅ Complete | `[bash:ok] id · exit 0 · 0.5s (avg) · 3 lines\n> head:\n...` | `[bash:ok] id · exit 0` |
| **W1** | Write deduplication (cross-turn) | ✅ Complete | `[batch:write] src/config.ts (1234 bytes)` | `[batch:write] src/config.ts` |
| **E1** | Edit deduplication (cross-turn) | ✅ Complete | `[batch:edit] src/index.ts (2 blocks)` | `[batch:edit] src/index.ts` |
| **Q1** | Web query deduplication | ✅ Basic compression only | `[web:search] "query" · 2 results · first: Title` | Same (no depth-specific trimming yet) |

### Pending / Future Work

| Item | Why It Matters | File Hint |
|------|--------------|-----------|
| **Q1 cross-turn dedup** | Same search issued 3× = 3 lines in child context. Should collapse to 1 latest + superseded breadcrumbs. | `src/snapshot/snapshot.ts:~283` `compressWebResult` — add `buildWebDedupIndex` pre-scan analogous to `buildDedupIndex` for batch. |
| **Cross-turn bash dedup** | If parent runs `npm test` every turn, child sees N bash results. Low ROI because bash IDs are unique per batch call. | `compressBatchResult` already handles intra-batch dedup; cross-turn would require new `DedupIndex` category. |
| **Read content truncation tuning** | Currently truncates to header only. Could preserve first/last N lines for context. | `compressBatchResult` read section handling (~line 480). |
| **rg output compression** | `rg` results currently pass through verbatim. Could compress to `[rg] N matches in M files`. | `KNOWN_SECTION_HEADERS` in `snapshot.ts:~181`. |
| **Structured output validation** | `renderCompressedFlowResult` returns `undefined` if >50% file entries lack `path`. This safety net could be tightened. | `src/snapshot/snapshot.ts:~93-170`. |
| **Cache miss placeholder** | `[flow] prior result · N chars — full context unavailable` is conservative. Could include a one-line summary if structured output failed but raw text is short. | `compressToolResults` cache-miss branch (~line 780). |

### Sanitization Passes (Exact Order)

From `sanitizeForkSnapshot` (`snapshot.ts:~900-1345`):

1. `forkMetadataInjection` — inject `forkedFrom`, `forkedAt`, `parentFlow`, `depth` into header.
2. `stripSystemPrompt` — replace parent system prompt with placeholder.
3. `stripSessionId` — rename `id` → `parentId`.
4. `dropSystemEvents` — drop standalone `type: "system"` entries.
5. `dropCustomMessages` — drop `type: "custom_message"`.
6. `dropConfigEvents` — drop `model_change`, `thinking_level_change`.
7. `dropUnknownTypes` — defense-in-depth for non-protocol types.
8. `dropMalformedMessages` — drop `message` entries without payload.
9. `dropSlidingSystemPrompts` — drop `role: "system"` containing steering tags.
10. `normalizeToolResultRole` — `toolResult` → `tool`.
11. `stripReasoning` — remove `<thinking>` blocks.
12. `stripTimestamps` — remove inner `message.timestamp`.
13. `stripApiMetadata` — remove `api`, `provider`, `model`, `stopReason`, `responseId`, `responseModel`, `cost` (preserve `usage.totalTokens`).
14. `stripDetails` — remove `details` from tool/toolResult messages.
15. `stripSteeringHints` — remove `<pi-flow-steering-hint>` blocks.
16. `stripStrategicHints` — remove `[Hint: Plan next step...]` blocks.
17. `compressParentActivation` — at depth ≥ 2, collapse parent `<context-seal>...<mission>` to one-line preview.
18. `reparentOrphans` — fix `parentId` references to dropped messages.
19. `stripBatchRead` — remove `batch_read` tool calls + results (children don't have this tool).
20. `compressToolResults` — compress flow/batch/web/ask_user results (includes W1/E1/X1/Q1).
21. `reparentOrphans` — second pass after message drops.

---

## Verification Protocol: What "Pristine" Means

"Pristine context feed to flow" means **all** of the following assertions pass. Run them in order. Do not skip steps.

### Step 1 — Unit Tests

```bash
npm test -- --run tests/snapshot-compress.test.ts
```

**Assertion:** `Tests: N passed` with **zero failures**. If any test fails, the compression pipeline is producing unexpected output.

### Step 2 — Integration Tests

```bash
npm test -- --run tests/snapshot-integration.test.ts
```

**Assertion:** All of the following must pass:
- `sanitizes at depth 1 and produces correct X1/W1/E1/Q1 formats`
- `sanitizes at depth 2 with stricter compression (no previews)`
- `writes proper dump artifacts (.md + .txt) with compression stats`
- `is orphan-free after full sanitization`
- `has zero batch_read tool calls remaining`

### Step 3 — Full Suite Regression

```bash
npm test -- --run
```

**Assertion:** `971 passed` (current baseline). Any drop means a regression elsewhere in the codebase.

### Step 4 — Live Dump Verification

```bash
export PI_FLOW_DUMP_SNAPSHOT=/tmp/pi-dump
npm run build
pi -p "spawn scout, run ls command, web search for node.js streams"
```

**Assertion after running:**
1. Files exist: `ls /tmp/pi-dump.scout.*.md` and `ls /tmp/pi-dump.scout.*.txt`.
2. The `.md` file contains `<!-- pi-agent-flow dump | State: post-sanitization | Passes: ...`.
3. The `.md` file contains `## Compression Stats` with `Reduction: 95%+` (typical).
4. The `.md` JSONL section does **not** contain `--- bash [` (X1 must have compressed bash).
5. The `.md` JSONL section does **not** contain `<thinking>` (reasoning stripped).
6. The `.md` JSONL section does **not** contain `batch_read` (stripped).
7. The `.md` JSONL section does **not** contain raw HTML from web results (Q1 must compress to `[web:...]`).

### Step 5 — Child Context Inspection (Manual)

Read the dump file and verify:

```bash
# Find the latest scout dump
cat $(ls -t /tmp/pi-dump.scout.*.md | head -1)
```

**Pristine checklist:**
- [ ] No `<context-seal>` blocks inside JSONL `user` messages at depth 1 (they should only appear in the `-p` prompt, not the JSONL).
- [ ] At depth ≥ 2, any `<context-seal>` inside JSONL is compressed to `[Parent flow activation stripped]`.
- [ ] No raw flow tool results > 2000 chars (must be `[Flow: X accomplished]` or cache-miss placeholder).
- [ ] `compression-stats` JSONL entry is present as the last line.
- [ ] `passesApplied` array includes `compressToolResults`, `stripBatchRead`, `reparentOrphans`.

### Step 6 — Zero Tech Debt Checklist

- [ ] No `console.warn()` or `console.error()` in flow code — use `logWarn`/`logError` from `src/config/log.ts`.
- [ ] No `TODO` or `FIXME` comments in `src/snapshot/snapshot.ts` without a linked issue.
- [ ] No dead code (unused functions, commented-out passes).
- [ ] All new compression functions have corresponding test cases in `tests/snapshot-compress.test.ts`.
- [ ] `package.json` version is referenced in dump artifacts (integration test verifies `Pipeline: ${pipelineVersion}`).

---

## Ideation Vectors: Where to Find the Next 10× Improvement

### Known High-ROI Vectors (Ranked)

| Rank | Vector | Estimated Savings | Complexity | Test Strategy |
|------|--------|-------------------|------------|---------------|
| 1 | **Q1 cross-turn dedup** | 30-70% of web lines | Medium | Extend `snapshot-integration.test.ts` with repeated web queries; assert single latest result. |
| 2 | **rg output compression** | 50-90% per rg result | Low | Add `compressRgResult()` in `snapshot.ts`, add test in `snapshot-compress.test.ts`. |
| 3 | **Read content preview tuning** | 10-20% per read | Low | In `compressBatchResult`, preserve first/last 2 lines of reads at depth 1 instead of truncating to header-only. |
| 4 | **Cache miss summary fallback** | Improves child UX | Low | If raw flow result < 500 chars and structured output failed, include raw text in placeholder instead of hiding it. |
| 5 | **Batch result section rollup** | 20-40% for multi-op batches | Medium | If all ops in a batch are superseded by later turns, emit `[batch] N ops (all superseded)` instead of individual lines. |
| 6 | **Duplicate ask_user dedup** | 30-50% if user asked same thing twice | Medium | Build `DedupIndex` for `ask_user` keyed by question string. |
| 7 | **Compression pass telemetry** | Observability, not tokens | Low | Add per-pass byte deltas to `compression-stats` entry (e.g. `passDeltas: { stripReasoning: 4200, compressToolResults: 184000 }`). |

### Methodology for Discovering NEW Vectors

1. **Capture a real dump** using `PI_FLOW_DUMP_SNAPSHOT=/tmp/pi-dump` during a long orchestrator session (≥ 10 turns with multiple flows).
2. **Measure per-tool bloat:** Look at `compression-stats` lines in dumps. If `preBytes` is large but `postBytes` is also large, investigate which tool is leaking.
3. **Inspect the raw vs sanitized diff:** Compare `preBytes` and `postBytes`. If reduction is < 90%, one of the passes is failing or a new tool type is passing through verbatim.
4. **Use `PI_FLOW_DEBUG_CONTEXT=1`:** Run `PI_FLOW_DEBUG_CONTEXT=1 pi` and watch stderr for `[context-compress] <tool>: N → M bytes`. Any tool showing `0% reduction` is a candidate.
5. **Read `docs/CONTEXT-DIAGNOSTICS.md`:** The "Known Bloat Sources" table maps symptoms to fixes. If your symptom is not listed, it is a new vector.
6. **Check for orphan patterns:** Run integration test `is orphan-free after full sanitization`. If it fails, a pass is dropping messages without reparenting — this is a bug, not a vector, but fixing it may reveal hidden bloat.

---

## Conservation Rules: What NOT to Change

### Hard Constraints (Breaking These Breaks Child Flows)

1. **Never remove `usage.totalTokens` from assistant messages.** `src/core/session.ts` (or equivalent consumer) reads `message.usage.totalTokens`. Stripping `usage` entirely causes `Cannot read properties of undefined (reading 'totalTokens')`.
   - Safe: strip `usage.cost`, `usage.inputTokens`, `usage.outputTokens` if not needed.
   - Unsafe: `delete message.usage`.

2. **Never pass `batch_read` tool calls to children.** Children do not have `batch_read` in their tool manifest. API providers reject requests with `tool_call_id is not found` if orphaned results remain.
   - The `stripBatchReadToolCalls` pass must always run after any pass that could drop assistant messages.

3. **Never strip `toolCallId` from tool results.** Even when compressing content, the `toolCallId` must survive so the child session's tool-result pairing remains valid.

4. **Never modify `compressToolResults` signature without updating tests.** Both unit and integration tests call this function directly. The current signature is:
   ```typescript
   export function compressToolResults(
     snapshot: string,
     cache: Map<string, CompressedFlowResult[]>,
     depth?: number,
   ): string
   ```

5. **Never emit `console.warn/error` in flow code.** Use `logWarn`/`logError` from `src/config/log.ts` to avoid TUI text flash.

### Soft Constraints (Changing These Requires Migration)

1. **Format tokens must remain recognizable.** `[bash:ok]`, `[batch:write]`, `[batch:edit]`, `[web:search]`, `[web:fetch]`, `[ask_user]`, `[Flow: X Y]` are parsed by child flows (informally). If you change the prefix, update `docs/telemetry-compression-protocols.md` and `tests/snapshot-compress.test.ts`.

2. **Depth behavior is contractual.** Depth 1 = moderate compression with previews. Depth 2+ = maximum compression, no previews. Child flows at depth 2+ expect terse context.

3. **The `compression-stats` trailing JSONL entry must remain parseable.** Its schema is:
   ```json
   { "type": "compression-stats", "preBytes": N, "postBytes": N, "reductionPercent": N, "passesApplied": ["..."] }
   ```
   Adding new fields is safe. Removing fields breaks `buildDumpArtifact` in `tests/snapshot-integration.test.ts` and any external parsers.

4. **Dump artifact format is contractual.** The `.md` / `.txt` twin file format is consumed by developers for debugging. Changes to the markdown header must be backward-compatible.

---

## Iteration Loop: How to Make Incremental Progress

This prompt is designed to be followed repeatedly. Each pass should take 1-3 hours and produce a mergeable improvement.

### Loop Steps

```
START
  │
  ▼
1. DISCOVER — Run Verification Protocol Steps 4-5 on a live dump.
  │           Identify the largest uncompressed artifact.
  │
  ▼
2. ISOLATE — Write a minimal reproduction in tests/snapshot-compress.test.ts.
  │          Assert the current (bloated) behavior so the test passes today.
  │
  ▼
3. DESIGN — Decide which protocol pass needs extension (W1/E1/X1/Q1 or new).
  │         Check Conservation Rules. If it touches hard constraints, stop and re-design.
  │
  ▼
4. IMPLEMENT — Add the compression/dedup logic in src/snapshot/snapshot.ts.
  │            Keep changes localized. Prefer new helper functions over inlining.
  │
  ▼
5. VERIFY — Run Verification Protocol Steps 1-6.
  │         If any step fails, fix before proceeding.
  │
  ▼
6. DOCUMENT — Update docs/telemetry-compression-protocols.md with the new protocol spec.
  │          Update this prompt's "Current State" table.
  │
  ▼
7. COMMIT — `npm run lint`, `npm test -- --run`, then commit.
  │
  ▼
  RETURN TO START (next iteration)
```

### Decision Gates

At each step, ask:
- **Gate 1 (Discover):** Is the bloat > 5% of total payload? If no, skip — not worth the regression risk.
- **Gate 2 (Isolate):** Can I reproduce the bloat in a unit test with < 20 lines of snapshot JSONL? If no, the artifact is too complex to safely compress.
- **Gate 3 (Design):** Does this change alter an existing format token? If yes, does the child still understand it? If no → redesign.
- **Gate 4 (Implement):** Did I add a fallback that preserves verbatim output when parsing fails? If no → add fallback before continuing.
- **Gate 5 (Verify):** Did `npm test -- --run` show 971+ passes with zero failures? If no → fix.
- **Gate 6 (Document):** Did I update the spec? If no → do not commit.

---

## Dump Artifact Inspection: Reading Real Child Context

### File Locations

When `PI_FLOW_DUMP_SNAPSHOT=/tmp/pi-dump` is set:
- `/tmp/pi-dump.<flowName>.<timestamp>.md` — Full dump with JSONL + prompt + stats.
- `/tmp/pi-dump.<flowName>.<timestamp>.txt` — Prompt transcript only.

### How to Inspect the JSONL Section

1. Open the `.md` file.
2. Scroll to `## Session Snapshot (JSONL)`.
3. Copy the JSONL block into a temp script for analysis.

Example analysis script (save to `./tmp/inspect-dump.js`):

```javascript
const fs = require('fs');
const md = fs.readFileSync(process.argv[2], 'utf8');
const jsonl = md.split('## Session Snapshot (JSONL)')[1].split('## Activation Prompt')[0].trim();
const lines = jsonl.split('\n').filter(l => l.trim());
const entries = lines.map(l => JSON.parse(l));

const toolResults = entries.filter(e => e?.message?.role === 'tool');
const totalToolBytes = toolResults.reduce((sum, e) => sum + JSON.stringify(e).length, 0);
const stats = entries.find(e => e?.type === 'compression-stats');

console.log('Entries:', entries.length);
console.log('Tool results:', toolResults.length);
console.log('Tool result bytes:', totalToolBytes);
console.log('Compression stats:', stats);

// Find the largest tool result
const largest = toolResults.reduce((max, e) => {
  const size = JSON.stringify(e).length;
  return size > max.size ? { size, entry: e } : max;
}, { size: 0, entry: null });
console.log('Largest tool result:', largest.size, 'bytes');
console.log(JSON.stringify(largest.entry, null, 2).slice(0, 500));
```

Run: `node ./tmp/inspect-dump.js /tmp/pi-dump.scout.1234567890.md`

### Red Flags in a Dump

If you see any of these, the pipeline has a bug:
- `<thinking>` blocks inside JSONL → `stripReasoning` failed.
- `batch_read` tool calls inside JSONL → `stripBatchRead` failed.
- `--- bash [` inside JSONL at depth ≥ 1 → `compressBashSection` failed or `depth` was not threaded.
- `--- write: ...` inside JSONL when a later turn wrote the same file → `buildDedupIndex` or `compressBatchResult` dedup failed.
- `tool_call_id is not found` API errors → `stripBatchRead` orphaned a result, or a pass dropped a toolCall without dropping its result.
- `undefined` in `[Flow: ... undefined]` → `renderCompressedFlowResult` returned `undefined` but the caller didn't fall back.
- Raw HTML from web pages (> 1000 chars) → `compressWebResult` regex mismatch.

---

## Quick Reference: Exact Commands

```bash
# Full test suite (baseline)
npm test -- --run

# Compression tests only
npm test -- --run tests/snapshot-compress.test.ts

# Integration tests only
npm test -- --run tests/snapshot-integration.test.ts

# Lint check
npm run lint

# Build
npm run build

# Live dump capture
export PI_FLOW_DUMP_SNAPSHOT=/tmp/pi-dump
npm run build
pi -p "spawn scout, run ls command, web search for node.js streams"
ls -lh /tmp/pi-dump.*

# Debug context telemetry
PI_FLOW_DEBUG_CONTEXT=1 pi

# Clean old dumps
find /tmp -name 'pi-dump.*' -mtime +7 -delete
```

---

## Changelog (Update This Section Each Iteration)

| Date | Agent | Change | Tests Added |
|------|-------|--------|-------------|
| 2026-05-17 | craft | Initial prompt document created | N/A |

---

*End of prompt. This document is a living artifact. After each improvement cycle, update the Current State table, the Changelog, and the Ideation Vectors if new patterns were discovered.*
