# Shared Context Pipeline — Core-2 Specification

> **Active document.** This describes the core-2 provider-neutral semantic-history snapshot pipeline (`src/core2/snapshot.ts`) used by forked child flows. The pipeline keeps completed parent interactions useful for orientation while preventing replay of parent-provider tool protocol.
>
> **Correction note:** Earlier revisions described a six-stage, native-result-preserving pipeline. The implementation now removes the active interaction before optimization, retains native structures only while deduplication and compression need them, then flattens completed interactions and enforces a provider-neutral serialization boundary.
>
> **Document type:** Conservative architectural specification  
> **Scope:** What IS, not what could be. Based on source-code evidence (`src/core2/snapshot.ts`, `src/flow/runner.ts`, `src/index.ts`) and test evidence (`tests/core2-snapshot.test.ts`).  
> **Date:** 2026-07-14
> **Pipeline version:** 2.4.2

## §1 Main Ideas — What Every Child Flow Receives

### 1.1 Fork Snapshot JSONL

When a flow is spawned, the parent's session is serialized into a JSONL string and passed as the `--session` argument. This JSONL contains:

1. **One header line** — the session header (with compressed `cwd` and stripped `timestamp`).
2. **N branch entries** — one `JSON.stringify()` per retained entry, in chronological semantic order, after the ordered provider-neutral pipeline.

The function that builds this is `buildCore2Snapshot()` in `src/core2/snapshot.ts`.

### 1.2 Sanitization Philosophy

Core-2's design principle: **strip metadata noise that cannot be acted on by a child flow, while preserving every piece of conversation history the child needs for orientation.**

Core-1 used a 23-pass compression pipeline that made heuristic decisions about what to keep, truncate, or collapse. Core-2 uses deterministic sequence-level and per-entry transforms with one responsibility each and an explicit final serialization boundary.

### 1.3 Ordered Pipeline

The pipeline runs in this order:

| Order | Operation | Contract |
|-------|-----------|----------|
| 1 | Header compression | Remove header timestamp and shorten `cwd`. |
| 2 | Active interaction removal | Remove the active call and matching result, across camelCase, snake_case, and Responses ID shapes, before optimization. |
| 3 | Shared-context optimization | Deduplicate repeated bash, file, flow, and trace work while native protocol is still available. |
| 4 | Entry sanitization and compaction handling | Remove reasoning and transport metadata; summarize compaction entries. |
| 5 | Tier/profile compression | Apply placeholders, standalone bash truncation, message limits, and context compression. |
| 6 | Context-map insertion | Insert the shared-context orientation seal. |
| 7 | Result-text sanitization | Apply batch-body truncation and directive/hint stripping to every retained result text part, including nested result output. |
| 8 | Pairing and flattening | Exclude `batch_read`; pair completed calls/results deterministically; replace them with labelled assistant text; drop identifiable orphans and incomplete calls. |
| 9 | Provider-neutral enforcement | Rebuild retained entries from a strict header/message/text whitelist; omit all unknown roles, entry types, fields, and content blocks. |
| 10 | JSONL serialization | Serialize only the enforced provider-neutral entries. |

Native protocol is deliberately retained through optimization and compression, but never crosses the child-session boundary.
### 1.4 What Is Preserved

- Chronological semantic history and ordinary system, user, and assistant text.
- Completed non-`batch_read` interactions as separate labelled assistant text blocks:

  ```text
  [Historical tool interaction]
  Tool: <tool-name>
  Arguments:
  <serialized arguments>

  Result:
  <compressed and sanitized output>
  [/Historical tool interaction]
  ```

- Truly unidentifiable result-only history as a labelled `[Historical tool result]` assistant block.
- Existing deduplication and compression placeholders inside canonical result text.
- Session/header `type`, numeric `version`, scalar `id`, and compressed `cwd`.
- Message and entry scalar `id` fields.
- Slim assistant usage required for child token accounting.
- Plain text content only, including literal `call_*`, `fc_*`, marker-like, and signature-like substrings in that text.
### 1.5 What Is Stripped — Summary

- The active call and matching result before shared-context optimization.
- `batch_read` calls, named results, and results matched to removed `batch_read` calls.
- Unmatched/incomplete calls and identifiable orphan results introduced by trimming or compression.
- Native call/result content types: `toolCall`, `tool_call`, `function_call`, `toolResult`, `tool_result`, and `function_call_output`.
- Native `tool` and `toolResult` message roles, plus every unrecognized message role and entry type.
- Message-level `toolCalls`, `tool_calls`, pairing/signature fields, transport metadata, response metadata, and arbitrary application fields.
- Non-text content blocks and their nested metadata, including unrelated nested `api`, `provider`, `model`, and `call_id` values.
- Reasoning/thinking fields and blocks, control events, irrelevant response metadata, batch bodies beyond configured orientation lines, and injected directive/hint suffixes.

The boundary is an output whitelist: only session/header identity fields and `system`/`user`/`assistant` text messages can serialize. It intentionally does not preserve arbitrary nested application data.
### 1.6 CWD Compression

The session header's `cwd` field is compressed to save ~50–100 bytes:

| Condition | Result | Example |
|-----------|--------|---------|
| `cwd === process.cwd()` | `"."` | `/Users/dev/project` → `"."` |
| `cwd` starts with `process.cwd() + "/"` | Relative path | `/Users/dev/project/src` → `"src"` |
| `cwd` starts with `process.cwd() + "\\"` | Relative path (Windows) | `C:\project\src` → `"src"` |
| Otherwise | Basename only | `/tmp/some-dir` → `"some-dir"` |

Additionally, the header's `timestamp` field is deleted entirely.

Source: `src/core2/snapshot.ts:26–41`.

### 1.7 Header Deduplication

If the first branch entry already has `type === "session"` or `type === "header"` with the same `id` as the header, the header line is **not emitted**. This prevents double-headers when the session manager includes the header in the branch.

Source: `src/core2/snapshot.ts:55–70`.

## §2 Stage Details

### 2.1 Active Removal and Optimization

`stripActiveToolInteraction()` runs on `sessionManager.getBranch()` before `optimizeSharedContext()`. ID candidate sets include the full ID and non-empty `|` components from `id`, `toolCallId`, `tool_call_id`, and `call_id`. Intersection matching preserves Terra-style `fc_*` and `call_*` identities without inspecting arbitrary text or data.

Completed native interactions remain intact through shared-context deduplication so bash/read/write/edit/flow/trace optimizers continue to recognize prior work.

### 2.2 Sanitization, Compaction, and Compression

`sanitizeSnapshotEntry()` removes reasoning, control metadata, and message-level `api`/`provider`/`model` unconditionally. Compaction entries become readable summaries. Tier/profile compression, standalone bash truncation, message limits, and context compression run before flattening. When compression replaces nested result blocks, their recognized protocol identity is retained solely for final pairing.

### 2.3 Result Sanitization

`stripBatchBodiesFromEntry()` recursively applies `stripDirectives(stripBatchBodies(text, level))` to every retained result string and text part, including recognized nested result `content` and `output`. Images and unrelated non-text parts remain structurally intact until the flattener emits omission markers.

### 2.4 Deterministic Pairing and Flattening

`flattenCompletedToolInteractions()`:

1. Collects recognized calls and results without searching arbitrary text or data.
2. Removes `batch_read` by name and by IDs matched to removed calls.
3. Pairs by ID-candidate intersection, consuming the first unconsumed result in snapshot order.
4. Replaces completed calls at their assistant-turn position with canonical labelled text. Message-level `toolCalls` precede `tool_calls` and append after existing content.
5. Drops unmatched calls and identifiable orphan results.
6. Retains only results with no pairing ID as labelled result-only assistant text.

### 2.5 Provider-Neutral Enforcement

`enforceProviderNeutralHistory()` rebuilds every retained entry from a strict whitelist: session/header identity fields, scalar entry/message IDs, slim assistant usage, and `system`/`user`/`assistant` text content. It omits all unknown entry types, roles, fields, and non-text blocks, so an unrecognized future provider protocol cannot cross the child-session boundary.

### 2.6 Standalone Bash Truncation

Standalone bash output is truncated before flattening according to the selected compression level. Its retained placeholder or output then appears inside the canonical interaction result.
## §3 Processing Pipeline

`buildCore2Snapshot()` performs sequence-level work around the per-entry transforms:

1. Get branch and remove the active interaction.
2. Optimize completed native interactions.
3. Sanitize, compact, and compress each entry.
4. Apply message limiting and context compression.
5. Insert the context map.
6. Sanitize all result text.
7. Exclude `batch_read`, pair results, and flatten completed interactions.
8. Enforce the provider-neutral boundary.
9. Serialize one JSON object per line.

This ordering is required: moving flattening earlier would disable native deduplication; moving it later would expose replayable provider protocol.
## §4 Function Interface

### 4.1 `SessionSnapshotSource`

```ts
export interface SessionSnapshotSource {
  getHeader: () => unknown;
  getBranch: () => unknown[];
}
```

The session manager must implement these two methods. `getHeader()` returns the session header object (or null/undefined if no header). `getBranch()` returns the chronological array of branch entries.

### 4.2 `BuildCore2SnapshotOptions`

```ts
export interface BuildCore2SnapshotOptions {
  activeToolCallId?: string;
  tier?: FlowTier;
  compressionLevel?: CompressionLevel;
  compressionProfile?: ContextProfile;
  compressionStats?: CompressionStats;
  // fork lineage fields omitted here
}
```

`activeToolCallId` excludes the currently executing interaction before optimization. `tier`, `compressionLevel`, and `compressionProfile` control limiting and compression. When supplied, `compressionStats` is populated with byte counts, selected level/profile, dropped-message count, and any synthetic summary.
### 4.3 `buildCore2Snapshot` Return

```ts
export function buildCore2Snapshot(
  sessionManager: SessionSnapshotSource,
  options?: BuildCore2SnapshotOptions,
): string | null
```

- Returns `null` if `getHeader()` returns null or non-object.
- Otherwise returns a JSONL string with a trailing newline.
- Each branch entry is one line; the header (if not deduplicated) is one line.

Source: `src/core2/snapshot.ts:24–103`.

## §5 JSONL Format

### 5.1 Header Line

The first line (if emitted — see §1.7 for dedup) is the session header with compressed `cwd` and no `timestamp`.

### 5.2 Branch Entries

Each retained branch entry is `JSON.stringify(entry)` on its own line. Entries can be removed by sanitization, trimming, pairing, or boundary enforcement; completed tool history appears only as canonical assistant text.

### 5.3 Compression Statistics Are Out-of-Band

The JSONL contains no `compression-stats` entry. `buildSnapshotWithCompression()` returns `CompressionStats` alongside the snapshot when compression runs. The caller logs the applied level and byte/message reductions and forwards the stats for result/UI rendering.
## §6 Dump File Format

When `PI_FLOW_DUMP_SNAPSHOT` is set, each flow produces two files:

### 6.1 Markdown Dump (`.md`)

```markdown
<!-- pi-agent-flow dump -->
{metadata}

## Session Snapshot (JSONL)
{full JSONL content}

## Activation Prompt (-p)
{reconstructed raw prompt}
```

> **Note:** Compression statistics are not embedded in the dump JSONL. They are returned out-of-band and surfaced in flow logging/result statistics when compression is applied.

### 6.2 Text Dump (`.txt`)

Verbatim copy of the reconstructed `-p` prompt only.

### 6.3 Activation Prompt Changes

The activation prompt no longer contains a standalone `Transition: on/off (depth X/Y · stack: ...)` line. Transition state is communicated exclusively through the `<activation ... depth="..." lineage="...">` XML attributes, removing duplication.

Source: `src/flow/runner.ts` (dump writing and activation prompt construction).

### 6.4 Differences from Core-1 Dumps

| Feature | Core-1 | Core-2 |
|---------|--------|--------|
| `compression-stats` JSONL entry | Present | **Absent** |
| Compression metrics | Embedded in snapshot/dump | Returned out-of-band as `CompressionStats` and surfaced by callers |
| `passesApplied` array | Present | **Absent** |
| Parent tool protocol | Replayable native records | Canonical labelled assistant history |
| `Transition:` line in prompt | Present | **Absent** |
## §7 Conservative Improvement Principles

### 7.1 Bar for Adding New Stripping

**High.** Any new stripping rule must be justified by:

1. **Concrete token-bloat measurement** — not aesthetics or assumptions.
2. **No information loss** — truncation must preserve orientation (first/last lines or summary).
3. **Preference for alternatives** — env-var injection, `-p` prompt tuning, or session-mode budgets before snapshot mutation.
4. **Test coverage** — every new strip must have a regression test in `tests/core2-snapshot.test.ts`.

### 7.2 Backward Compatibility

Dump format sections are a de-facto API. Do not reorder or rename:
- `## Session Snapshot (JSONL)`
- `## Activation Prompt (-p)`

Existing dump-analysis scripts depend on these headings.

### 7.3 Fixture Discipline

If `isBatchSectionHeader` or `isKnownSectionHeader` regexes change:
1. Regenerate dump fixtures.
2. Update `tests/core2-snapshot.test.ts`.
3. Run `npm run build && npm test` before committing.

`tests/fixtures/dumps/` are verbatim artifacts — **never** modify them directly.

## §8 File References

| File | Role |
|------|------|
| `src/core2/snapshot.ts` | Active removal, native optimization/compression, recursive result sanitization, deterministic pairing/flattening, boundary enforcement, and shared-context metrics |
| `tests/core2-snapshot.test.ts` | Provider-neutral structural matrix, ID matching, `batch_read`, active-call ordering, sanitization, deduplication, and metadata regressions |
| `tests/index.test.ts` | End-to-end fork snapshot integration and canonical flow/bash history |
| `tests/context-compression.test.ts` | Compression profile/placeholder behavior at the canonical boundary |
| `tests/shared-context.test.ts` | Native and canonical tool-call metric aggregation |
| `src/index.ts` / `src/tools/trace.ts` | Snapshot construction, compression logging, and child-flow handoff |
## §9 Glossary

| Term | Meaning |
|------|---------|
| **Fork snapshot** | Serialized session state passed to child flow via `--session` argument |
| **Sanitization** | Ordered pipeline that removes active work, preserves optimizer inputs, flattens completed semantic history, and enforces provider neutrality |
| **Batch body stripping** | Truncation of read/write/edit/context-map/file-summary sections to first 3 + last 3 lines when body exceeds 6 lines |
| **Orientation lines** | The first 3 and last 3 lines kept after truncation, providing context about what was read/written/edited without the full body |
| **JSONL** | JSON Lines format — one JSON object per line, newline-delimited |
| **Section header** | A line matching `isBatchSectionHeader()` or `isKnownSectionHeader()`, formatted as `--- <path> (<detail>) ---` |
| **Cold-start dump** | A dump where the session has no history — contains only the HTML header and Activation Prompt, no Session Snapshot section |
| **Active tool call** | The `toolCall` block that triggered the current flow spawn; stripped from the parent snapshot so the child does not replay it |

## §10 Compaction Awareness

The native `/compact` command in `pi` summarizes conversation history. Core-2 handles this by treating the resulting summary as a verbatim history entry.

### 10.1 Summarization Injection
To prevent information loss during compaction, `pi-agent-flow` implements a `session_before_compact` hook that injects the current **Goal Objective**, **Acceptance Criteria**, and **Recent Flow History** into the summarization prompt. This ensures that the native "compaction summary" is flow-aware and maintains situational awareness for the current mission.

### 10.2 Post-Compaction Re-anchoring
After a compaction completes, `pi-agent-flow` sends a non-displaying "orientation" message to the tail of the new history. This message restates the current goal to ensure the agent (and any future child flows) remains anchored to the objective, even if the generic summary is brief.

### 10.3 Goal Persistence in Snapshots
Regardless of compaction, every child flow's activation prompt (`-p`) includes a `<flow>` block containing the current goal's objective and a summary of completed steps. This provides a "double-entry" safety mechanism ensuring that child flows never lose sight of the higher-level mission, even in heavily compacted sessions.
