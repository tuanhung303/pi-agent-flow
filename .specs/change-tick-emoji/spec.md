# Spec: Change Tick Emoji System-Wide

## Investigation Findings

The `✓` / `✗` emoji pair is used in 4 subsystems across the codebase:

1. **`src/batch/execute.ts`** — batch tool output summary lines like `✓ 3 operations: 2 reads, 1 edit`
2. **`src/render.ts`** — flow status icons (`✓` for success, `✗` for error)
3. **`src/ask-user.ts`** — checkbox UI `[✓]`, response header `✓ `, error prefix `✗`
4. **`src/single-select-layout.ts`** — checkbox UI `[✓]`
5. **`src/context/plan-mode.ts`** — plan step indicators `✓` / `○`

Test files with hardcoded assertions (~35+ matches):
- `tests/batch.test.ts`
- `tests/render.test.ts`
- `tests/snapshot-compress.test.ts`
- `tests/snapshot-compress-fixes.test.ts`

## User Alignment

| Question | Choice | Impact |
|----------|--------|--------|
| Scope | All ✓/✗ system-wide | Changes batch output, flow status, ask-user UI, plan-mode steps |
| Replacement | `✔` / `✖` | Monochrome-safe, heavier but minimal. Replaces all ✓→✔ and ✗→✖ |
| Test alignment | Update tests as part of change | All ~35 test assertions updated to match new symbols |

## Technical Context

- **Stack**: TypeScript, Node.js, Vitest for testing
- **Key files**: 5 source files + 4 test files
- **Pattern**: Symbols are inline string literals, not extracted to constants
- **CI**: `ci.yml` runs lint + test on PR/push to main

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|----------|
| Symbol pair | `✔` / `✖` | User preference; monochrome-safe, minimal |
| Scope | System-wide | Consistent visual language everywhere |
| Test handling | Update in same PR | Keeps CI green, no follow-up needed |
| Extraction to constants | No (this PR) | Out of scope; can be done later if symbols change again |

## Implementation Plan

### Phase 1: Source files
1. `src/batch/execute.ts` — Replace `✓` with `✔` and `✗` with `✖` in summary output strings
2. `src/render.ts` — Replace `✓` with `✔` and `✗` with `✖` in flow status icons
3. `src/ask-user.ts` — Replace `✓` with `✔` and `✗` with `✖` in checkbox UI, response header, error prefix
4. `src/single-select-layout.ts` — Replace `✓` with `✔` in checkbox UI
5. `src/context/plan-mode.ts` — Replace `✓` with `✔` in plan step indicators

### Phase 2: Test files
1. `tests/batch.test.ts` — Update all assertions containing `✓` or `✗`
2. `tests/render.test.ts` — Update all assertions containing `✓` or `✗`
3. `tests/snapshot-compress.test.ts` — Update all assertions containing `✓` or `✗`
4. `tests/snapshot-compress-fixes.test.ts` — Update all assertions containing `✓` or `✗`

### Phase 3: Verify
1. Run `npm run lint` — ensure no lint errors
2. Run `npm test` — ensure all tests pass
3. Manual spot-check — `npm link` and verify tool output shows `✔` instead of `✓`

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Missed occurrences of ✓/✗ | Medium | Full codebase grep after changes; test suite catches regressions |
| Font rendering differences for ✔/✖ | Low | Both are Unicode block characters with broad terminal support |
| Snapshot tests break | Medium | Update inline/snapshot assertions alongside source changes |

## Assumptions

- `✔` and `✖` render correctly in all target terminals (macOS Terminal, iTerm2, VS Code, Windows Terminal)
- No other emoji sets in the codebase use `✓`/`✗` that were not found by scout
- The `○` in plan-mode (uncompleted step) is not being changed — only `✓` → `✔`
