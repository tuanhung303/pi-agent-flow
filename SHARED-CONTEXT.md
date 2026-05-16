# Shared Context Pipeline — Formal Synthesis

> **Document type:** Conservative architectural specification  
> **Scope:** What IS, not what could be. Based on source-code evidence (`src/core/flow.ts`, `src/snapshot/snapshot.ts`, `src/steering/flow-prompt.ts`, `src/core/depth.ts`) and actual dump artifacts (`dump-artifacts/`).  
> **Date:** 2026-05-16  
> **Pipeline version:** 1.8.40

---

## 1. MAIN IDEAS — What Every Child Flow Receives

### 1.1 The Four-Part Activation Prompt (`-p`)

When the orchestrator spawns a child flow, it constructs a single prompt string passed via `pi -p`. This prompt has **four sequential phases**, hard-coded in `src/core/flow.ts` (`buildFlowArgs`, lines ~321–495):

| Phase | XML Tag | Purpose | Source |
|-------|---------|---------|--------|
| **1. Context Seal** | `<context-seal>` | Declares that all conversation history above this line is sealed and for situational awareness only. Child must not respond to it. | Hard-coded string in `buildFlowArgs` |
| **2. Activation** | `<activation flow="…" depth="…" tools="…" tier="…">` | Injects role, available tools, delegation guards, flow list, time budget, and tier. | Dynamically generated from `flow` config + `depth.ts` |
| **3. Directive** | `<directive>` | Contains the flow's own `systemPrompt` (from front-matter) plus structured-output instructions when enabled. | `flow.systemPrompt` |
| **4. Mission** | `<mission>` | The user-provided `intent` plus optional `acceptance` criteria and execution instructions. | Caller-provided `intent` / `acceptance` |

**Evidence from dumps:** Every `.txt` dump artifact (e.g. `pi-dump.scout.1778112000000.txt`) begins exactly with `<context-seal>`, followed by `<activation>`, `<directive>`, `<mission>`. No variation.

**Optional Phase 4.5:** `<flow>` block (flow-goal context) appended when a goal is active — child sees objective + progress, not full goal state file.

### 1.2 The Sanitized JSONL Fork Snapshot (`--session`)

The child process receives a `--session <tmpfile>.jsonl` argument containing a **replayable transcript** of the parent session. This is built by `buildForkSessionSnapshotJsonl` (`src/snapshot/snapshot.ts`, lines ~44–81) and then sanitized by `sanitizeForkSnapshot` (lines ~731–977).

**What the snapshot contains (post-sanitization):**
- A `session` header with `forkedFrom`, `forkedAt`, `parentFlow`, `depth` metadata injected.
- `message` entries (role: user/assistant/tool) with reasoning, API metadata, timestamps, and internal signals stripped.
- A trailing `compression-stats` entry with `preBytes`, `postBytes`, `reductionPercent`, `passesApplied`.

**What the snapshot explicitly drops:**
- `system` events (parent orchestrator prompt stripped)
- `custom_message` events (orchestrator hidden instructions, e.g. flow-continuation hooks)
- `model_change` / `thinking_level_change` events (parent config leaked)
- Messages containing steering-hint tags
- `batch_read` tool calls (children don't have this tool)
- `details` on tool/toolResult messages (UI metadata)
- Inner `timestamp`, `api`, `provider`, `model`, `stopReason`, `responseId`, `cost` fields
- Raw tool results replaced by compressed metadata

**Evidence from dumps:** The `.md` dump files show a `## Session Snapshot (JSONL)` section containing the sanitized JSONL, followed by `## Activation Prompt (-p)` and `## Compression Stats`.

### 1.3 Compression of Historical Results

Before the snapshot reaches the child, three global passes mutate the JSONL **after** the per-entry loop:

1. **`reparentOrphans`** — Fixes `parentId` references after messages were dropped.
2. **`stripBatchRead`** — Removes `batch_read` tool calls from assistant messages (children don't have this tool).
3. **`compressToolResults`** — Replaces verbose tool result content with compact metadata:
   - `flow` results → `[Flow: type status] Intent: … Summary: … Files: …`
   - `batch` results → bash/edit/write/delete sections kept verbatim; read sections truncated
   - `web` results → `[web:search] "query" · N results · first: Title` or `[web:fetch] url · "Title" · N chars`
   - `ask_user` results → `[ask_user] "question" → "answer"`
   - `batch_read` results → `[batch_read] N ops → paths: file1.ts, file2.ts, …`

**Evidence:** `src/snapshot/snapshot.ts` lines 366–595 define `compressToolResults`; lines 597–675 define `stripBatchReadToolCalls`; lines 677–729 define `reparentOrphans`.

### 1.4 Depth / Tier / Guard Propagation

Delegation state travels via **two channels**:

| Channel | Mechanism | What It Carries |
|---------|-----------|-----------------|
| **Env vars** | `process.env` propagated to child | `PI_FLOW_DEPTH`, `PI_FLOW_MAX_DEPTH`, `PI_FLOW_STACK`, `PI_FLOW_PREVENT_CYCLES`, `PI_FLOW_TOOL_OPTIMIZE`, `PI_FLOW_DEADLINE_MS`, `PI_FLOW_TOOL_SUMMARY_GRACE_MS`, `PI_OFFLINE=1` |
| **Activation prompt** | Inline in `-p` | `depth="current/max"`, `cycles: blocked/off`, `stack: (root)` or `a -> b -> c` |

**Key constants** (`src/core/depth.ts`):
- `DEFAULT_MAX_DELEGATION_DEPTH = 3`
- `DEFAULT_PREVENT_CYCLE_DELEGATION = true`

**Evidence from dumps:** The `<activation>` block shows `depth="1/3"`, `cycles: blocked`, `stack: (root)`. The child process reads these env vars to reconstruct `FlowDepthConfig` locally.

### 1.5 Env-Var Propagation as Control Plane

The orchestrator spawns the child with a **fresh environment** that inherits the parent process env but overrides specific flow-control variables (`src/core/flow.ts`, lines ~700–720):

```
PI_FLOW_DEPTH       = nextDepth          (parentDepth + 1)
PI_FLOW_MAX_DEPTH   = propagatedMaxDepth
PI_FLOW_STACK       = JSON.stringify([...parentFlowStack, flowName])
PI_FLOW_PREVENT_CYCLES = "1" or "0"
PI_FLOW_TOOL_OPTIMIZE  = "1" or "0"
PI_OFFLINE          = "1"
PI_FLOW_DEADLINE_MS = deadlineAtMs (if timeout > 0)
PI_FLOW_TOOL_SUMMARY_GRACE_MS = computed grace
PI_FLOW_REMINDER_FILE_ENV = reminderFilePath
```

**No other hidden channels exist.** The child cannot read the parent's goal file directly; it only sees what is injected into `-p` and `--session`.

---

## 2. ACTUAL DUMPS — What They Confirm vs. What Could Drift

### 2.1 Confirmed Behaviors (verified against `src/core/flow.ts` and artifacts)

| Behavior | Evidence | Location in Code |
|----------|----------|-------------------|
| Dump writes **before** child spawns | `atomicWriteFileSync` called before `spawn()` | `src/core/flow.ts` ~670 |
| Two files per dump: `.md` + `.txt` | `makeUniqueDumpPath` + `makeUniqueDumpTxtPath` | `src/core/flow.ts` ~230–240 |
| HTML comment header with metadata | `<!-- pi-agent-flow dump \| State: post-sanitization \| Passes: … \| Pipeline: 1.8.40 -->` | `src/core/flow.ts` ~642 |
| Compression stats included | `## Compression Stats` section with pre/post bytes | `src/core/flow.ts` ~630 |
| TTL cleanup of stale dumps | `cleanupStaleDumps` runs before each write | `src/core/flow.ts` ~210 |
| `pipelineVersion` from `package.json` | `const { version: pipelineVersion } = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))` | `src/core/flow.ts` ~36 |
| Source-vs-dist stale warning | `checkStale("snapshot.ts", "snapshot.js")` | `src/core/flow.ts` ~685 |

### 2.2 Fixed Misalignments (verified in actual artifacts)

| Issue | Severity | Root Cause | Fix Applied |
|-------|----------|------------|-------------|
| `custom_message` entries leaked into child snapshots | **P0** | `sanitizeForkSnapshot` had no branch for `type === "custom_message"` | Added `dropCustomMessages` pass (`src/snapshot/snapshot.ts` ~791) |
| `model_change` / `thinking_level_change` leaked | **P1** | No branch for config events | Added `dropConfigEvents` pass (`src/snapshot/snapshot.ts` ~798) |
| `pipelineVersion: null` in compression-stats | **P1** | `sanitizeForkSnapshot` doesn't know package version | Removed from stats entry (already in dump header) |

### 2.3 What Could Still Drift (conservative watchlist)

| Drift Risk | Detection Method | Mitigation |
|------------|------------------|------------|
| New JSONL entry type added to core but not handled in sanitization | `grep 'type.*=.*"' src/*.ts` — any new type must have a branch in `sanitizeForkSnapshot` | See §3.3 |
| `VALID_PASS_NAMES` set in tests desyncs from actual passes | `npm test` will fail with "unknown pass name found" | See §3.3 |
| Dump format changes without doc update | Manual review of `.md` artifacts | Regenerate fixtures after any pipeline change |
| Source newer than dist | Console warning `[pi-agent-flow] ⚠️ Source newer than dist` | Always run `npm run build` before analyzing dumps |

---

## 3. CONSERVATIVE IMPROVEMENT PRINCIPLES

### 3.1 When to Modify the Shared Context Pipeline

> **Rule 1: Only change if tests break or a concrete security/correctness bug is proven.**

The shared context pipeline is a **hot path** — every flow invocation depends on it. Changes here affect all flows silently. The bar for modification is intentionally high.

| Situation | Action |
|-----------|--------|
| Tests pass, no leak observed | **Do not touch.** |
| New feature wants to pass data to children | Prefer env var or `-p` injection over snapshot mutation |
| Dump format readability issue | Cosmetic-only changes are acceptable if they don't alter JSONL protocol |
| New tool result type needs compression | Add compressor in `compressToolResults` with regression test |
| New JSONL entry type from upstream core | Must add handling branch in `sanitizeForkSnapshot` and update `VALID_PASS_NAMES` |

### 3.2 Backward Compatibility Rules

> **Rule 2: Preserve backward compatibility of dump format.**

- The `.md` dump file structure (HTML header → `## Session Snapshot` → `## Activation Prompt` → `## Compression Stats`) is a **de facto API** for debugging and audit scripts. Do not reorder or rename these sections.
- The `.txt` twin must remain a **verbatim copy of the reconstructed `-p` prompt only**.
- The `compression-stats` JSONL entry type is internal; removing fields is safe, adding fields is safe, but changing the meaning of `preBytes` / `postBytes` is not.

### 3.3 Pass-Name Registry Discipline

> **Rule 3: Never add a sanitization pass without updating `VALID_PASS_NAMES`.**

The test file `tests/snapshot-pipeline.test.ts` (line 23) maintains the canonical set:

```ts
const VALID_PASS_NAMES = new Set([
  "forkMetadataInjection",
  "stripSystemPrompt",
  "dropSlidingSystemPrompts",
  "dropSystemEvents",
  "dropCustomMessages",
  "dropConfigEvents",
  "dropUnknownTypes",
  "dropMalformedMessages",
  "normalizeToolResultRole",
  "stripReasoning",
  "stripTimestamps",
  "stripApiMetadata",
  "stripDetails",
  "stripSteeringHints",
  "stripStrategicHints",
  "reparentOrphans",
  "stripBatchRead",
  "compressToolResults",
]);
```

**Procedure for adding a pass:**
1. Add pass logic to `src/snapshot/snapshot.ts`.
2. Add name to `VALID_PASS_NAMES` in `tests/snapshot-pipeline.test.ts`.
3. Add regression test covering the new branch.
4. Run `npm test` — the "unknown pass name found" assertion will catch desyncs.
5. Run `npm run build` before generating new dump artifacts for analysis.

### 3.4 Fixture Regeneration After Pipeline Changes

> **Rule 4: Always regenerate fixtures after pipeline changes.**

If `sanitizeForkSnapshot` logic changes, existing dump artifacts in `tests/fixtures/dumps/` or `dump-artifacts/` become **stale evidence**. The `preBytes`/`postBytes` values will not match, and `passesApplied` arrays will differ.

**Procedure:**
1. Make code change.
2. `npm run build`
3. `npm test`
4. Re-run flows that produce dumps (`export PI_FLOW_DUMP_SNAPSHOT=/tmp/pi-dump && pi`)
5. Copy new dumps to `dump-artifacts/` or update test fixtures.

### 3.5 No Half-Measures

> **Rule 5: If a redesign is warranted, cut fully rather than leaving half-measures.**

The current architecture (JSONL snapshot + reconstructed `-p` prompt) has served through 1.8.x. If a future version moves to a different serialization (e.g., protobuf, delta-compression), the migration must:
- Replace both `buildForkSessionSnapshotJsonl` and `sanitizeForkSnapshot` entirely.
- Update dump format version in the HTML header comment.
- Maintain a backward-compat reader for at least one minor version.
- Never leave dual-protocol code paths in production.

---

## 4. CONTRACT — Orchestrator ↔ Child Flow

### 4.1 Guaranteed

| Guarantee | Mechanism | Fallback if Broken |
|-----------|-----------|--------------------|
| Child receives sanitized history | `sanitizeForkSnapshot` + `--session` arg | Child starts with clean slate if `--session` is null |
| Child receives its own directive | `<activation>` + `<directive>` in `-p` | Child would inherit parent system prompt (security issue) |
| Child knows its depth and limits | `depth="current/max"` in activation + env vars | Depth defaults to 0 if env unreadable |
| Child cannot use tools outside its set | `--tools` CLI arg restricts available tools | Tool call fails at API level |
| Dumps reflect exact payload | Written before `spawn()` from same `piArgs` | None — dump is best-effort debug aid |
| TTL cleanup prevents unbounded accumulation | `cleanupStaleDumps` before each write | Manual cleanup of dump directory |

### 4.2 Optional / Conditional

| Feature | Condition | Evidence |
|---------|-----------|----------|
| Flow-goal context injection | Only when `goalContext?.objective` is set | `src/core/flow.ts` ~490 |
| Structured output appendix | Only when `structuredOutput === true` and not opted out via `PI_FLOW_SKIP_STRUCTURED_DIRECTIVE` | `src/core/flow.ts` ~460 |
| Web steering hints in directive | Only when `toolOptimize === false` and prompt looks like URL/search | `src/steering/flow-prompt.ts` ~56 |
| Reminder file for timeout warnings | Only when `effectiveTimeout > 0` | `src/core/flow.ts` ~535 |
| Compression stats in dump | Always emitted in JSONL, but `## Compression Stats` section only when `lastEntry.type === "compression-stats"` | `src/core/flow.ts` ~625 |

### 4.3 Compressed (Not Guaranteed to Survive)

| Data | Compression Behavior | Child Visibility |
|------|----------------------|------------------|
| Prior `flow` tool results | Replaced by `[Flow: type status] …` compact text | Child sees summary, not full result |
| `batch` tool results | Read sections truncated; bash/edit/write/delete kept | Child sees metadata, not file contents |
| `web` tool results | Replaced by `[web:search/fetch] …` one-liner | Child sees query + count + first title |
| `ask_user` tool results | Replaced by `[ask_user] "q" → "a"` | Child sees question + answer |
| `batch_read` tool results | Replaced by `[batch_read] N ops → paths: …` | Child sees paths only |
| Reasoning/thinking blocks | Stripped from assistant messages | Child never sees reasoning |
| API metadata (`api`, `provider`, `model`, `cost`) | Stripped from assistant messages | Child never sees it |

---

## 5. FILE REFERENCES

| File | Role | Lines of Interest |
|------|------|-------------------|
| `src/core/flow.ts` | Spawn logic, dump writing, env propagation, `-p` construction | ~30–40 (pipelineVersion), ~210–240 (dump helpers), ~321–495 (buildFlowArgs), ~625–670 (dump write block), ~700–720 (env propagation) |
| `src/snapshot/snapshot.ts` | JSONL building, sanitization passes, compression | ~44–81 (buildForkSessionSnapshotJsonl), ~366–595 (compressToolResults), ~597–675 (stripBatchRead), ~677–729 (reparentOrphans), ~731–977 (sanitizeForkSnapshot) |
| `src/steering/flow-prompt.ts` | Before-agent-start prompt augmentation, web steering | ~34–143 (buildBeforeAgentStartPrompt) |
| `src/core/depth.ts` | Depth config parsing, env var constants | ~1–210 |
| `tests/snapshot-pipeline.test.ts` | Regression tests, `VALID_PASS_NAMES` canonical set | ~1–380 |

---

## 6. GLOSSARY

| Term | Meaning |
|------|---------|
| **Fork snapshot** | Serialized session state passed to child via `--session` |
| **Sanitization** | The process of stripping/redacting parent-only data before forking |
| **Pass** | A named transformation step in `sanitizeForkSnapshot` (tracked in `passesApplied`) |
| **Dump** | The `.md` + `.txt` files written to disk when `PI_FLOW_DUMP_SNAPSHOT` is set |
| **Activation prompt** | The reconstructed `-p` string a child receives (phases 1–4) |
| **Compression stats** | Trailing JSONL entry measuring sanitization delta |
| **Tool optimize** | Mode where `read`/`write`/`edit` are replaced by unified `batch` |
| **Flow goal** | Auto-continuation objective injected as `<flow>` block in `-p` |

---

*This document is conservative by design: it records the ground truth of what the code does today, not speculative improvements. Update it only when the pipeline actually changes.*
