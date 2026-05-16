# Dump Artifact Misalignment Analysis

This document tracks known misalignments between dump artifacts and the actual snapshot pipeline state.

## Post-Sync Findings (2026-05-16)

After running `./scripts/sync-dumps.sh`, **2,792** `pi-dump.*` files were synced from `/tmp` into `dump-artifacts/`; **0** legacy `snapshot-dump.*` files remain. Manifests (`MANIFEST.md`, `manifest.json`) were regenerated. Legacy `snapshot-dump.*` files were purged from both `/tmp` and `dump-artifacts/`.

### Today's Scout Runs (Sequential)

Two sequential scout flows ran on 2026-05-16, generating representative dumps:

| Timestamp | Dump | Size (pre → post) | Reduction | Finding |
|-----------|------|-------------------|-----------|---------|
| 00:13:09 | `pi-dump.scout.1778890389209.md` | 1,040,129 → 8,962 bytes | **99%** | Mapped 3 TUI leak vectors (session-scoping bypass, `console.warn` flash, tracked `.pi/` files) + 1 missing safeguard (silent state corruption). |
| 00:43:04 | `pi-dump.scout.1778892184530.md` | 1,340,644 → 7,048 bytes | **99%** | Traced TUI glow render duplication to pi-tui widget lifecycle; identified `ToolExecutionComponent.updateDisplay` shared-state risk. |

Both dumps show identical pass signatures: `forkMetadataInjection, dropConfigEvents, stripTimestamps, stripReasoning, stripApiMetadata, normalizeToolResultRole, stripDetails, stripStrategicHints, reparentOrphans, stripBatchRead, compressToolResults, reparentOrphans`.

### Misalignments Identified & Fixed

#### A1 — Stale fixture dumps in `tests/fixtures/dumps/`
**Status: FIXED**

The `pi-dump.*.md` files in `tests/fixtures/dumps/` were a mix of old and new formats. Some lacked `Tier:` and `Pipeline:` fields; others used hardcoded pass lists. No tests in `tests/` reference `tests/fixtures/dumps/`, so the fixtures were orphaned.

**Fix:** Removed all stale `pi-dump.*` fixtures and replaced them with **3 current-format representatives** copied from the synced `dump-artifacts/`:
- `pi-dump.scout.1778872735967.md` + `.txt` — empty-snapshot scout (`Tier: lite | Pipeline: 1.8.40`)
- `pi-dump.scout.1778890389209.md` + `.txt` — rich-context scout (`Tier: lite | Pipeline: 1.8.40`)
- `pi-dump.build.1778872929174.md` + `.txt` — build flow (`Tier: flash | Pipeline: 1.8.40`)

All three include the HTML comment header with dynamic `Passes:`, `Flow:`, `Tier:`, `Pipeline:`, and `Generated:` fields, plus `.txt` twins and compression stats.

#### A3 — Legacy `snapshot-dump.*` artifacts in `tests/fixtures/dumps/`
**Status: FIXED**

Two legacy `snapshot-dump.*.md` files (pre-batch-refactor) remained in `tests/fixtures/dumps/`. They lacked HTML headers, `.txt` twins, dynamic compression-stats, and `Pipeline:` fields. No tests referenced them.

**Fix:** Deleted all `snapshot-dump.*` files from `tests/fixtures/dumps/`.

#### A2 — Stale docs/dump-analysis dumps
**Status: FIXED**

`docs/dump-analysis/` contained a mix of pre- and post-tier/pipeline `pi-dump.*` files. They were removed, preserving only `VERSION-NOTES.md` and `manifest.json`.

#### A4 — Orphan `.gitignore` entries
**Status: ALREADY FIXED**

The orphan references to `flow-artifacts/dumps/` and `dump-artifacts-representative/` were removed in a prior commit; no such entries exist in the current `.gitignore`.

## Historical Misalignments (Previously Fixed)

### Misalignment I — Orphan parentId after destructive passes
**Status: ALREADY FIXED**

The second `reparentOrphans` pass runs after `stripBatchRead` and `compressToolResults` in `src/snapshot.ts:~943-955`. This ensures that any messages dropped by destructive passes have their orphaned children reparented to valid ancestors. No destructive passes run after the second `reparentOrphans` call.

### Misalignment J — Header pass list drift from actual passesApplied
**Status: ALREADY FIXED**

The header pass list is now derived dynamically from the compression-stats entry at `src/flow.ts:~603`. The dump builder reads `passesApplied` from the trailing JSONL entry and joins them into the HTML comment header. The header always reflects the actual passes that were applied.

## Verification

- `tests/snapshot-role-fix.test.ts` validates pass order and zero orphaned `parentId` references.
- `tests/snapshot-pipeline.test.ts` validates `VALID_PASS_NAMES` and dead-pass-name rejection.
- `tests/dump.test.ts` validates the full end-to-end dump format (header, JSONL, prompt, compression stats, `.txt` twin) against the current code path.
- `npm test` and `npm run lint` pass after fixture refresh.
