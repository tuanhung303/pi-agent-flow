# Dump Artifact Misalignment Analysis

This document tracks known misalignments between dump artifacts and the actual snapshot pipeline state.

## Misalignment I — Orphan parentId after destructive passes

**Status: ALREADY FIXED**

The second `reparentOrphans` pass runs after `stripBatchRead` and `compressToolResults` in `src/snapshot.ts:~943-955`. This ensures that any messages dropped by destructive passes have their orphaned children reparented to valid ancestors. No destructive passes run after the second `reparentOrphans` call.

## Misalignment J — Header pass list drift from actual passesApplied

**Status: ALREADY FIXED**

The header pass list is now derived dynamically from the compression-stats entry at `src/flow.ts:~603`. The dump builder reads `passesApplied` from the trailing JSONL entry and joins them into the HTML comment header. The header always reflects the actual passes that were applied.

## Action Plan

- [x] Misalignment I — Verified fixed in `src/snapshot.ts` (two reparentOrphans calls)
- [x] Misalignment J — Verified fixed in `src/flow.ts` (dynamic header from compression-stats)
- [x] Add orphan parentId regression test (behavioral)
- [x] Add TTL cleanup for /tmp dump files
- [x] Document dump format evolution in CLAUDE.md

## Verification

Existing test assertions in `tests/snapshot-role-fix.test.ts` already validate:
- Pass order: `reparentIndex1 < stripBatchIndex < compressIndex < reparentIndex2`
- The full `sanitizeForkSnapshot` pipeline produces zero orphaned `parentId` references
- `tests/snapshot-pipeline.test.ts` validates `VALID_PASS_NAMES` and dead-pass-name rejection
