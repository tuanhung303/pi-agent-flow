# pi-agent-flow — Project Notes

> 🗺️ **This file is your index route.**
> Think of it as the project's control panel — not a dry spec sheet, but an activation map. If you need to deploy, bump a version, debug a flow, or figure out which script to run, this file points you to the right door. Start here before wandering the codebase.
>
> 🌱 **Keep this index alive.**
> CLAUDE.md is a living document. When flows change, scripts move, or CI/CD steps get updated, this file must reflect reality. If you just changed something structural — added a workflow, renamed a script, tweaked a flow's tools — **update this file before you wrap up**.

## CI/CD

Publishing is **fully automated** via GitHub Actions.

### Strict Rules

- **Never run `npm publish` locally.** Always use CI.
- **Never run `npm version` locally.** The Release workflow handles tagging.

### Publish Flow

1. Merge feature branch to `main` and push.
2. Trigger the Release workflow:
   ```bash
   gh workflow run bump-version.yml -f bump_type=patch
   ```
3. For an alpha prerelease:
   ```bash
   gh workflow run bump-version.yml -f bump_type=prerelease
   ```
4. If the tag-trigger fallback is needed:
   ```bash
   gh workflow run publish.yml --ref v<NEW_VERSION>
   ```
5. Verify: `npm view pi-agent-flow version`

### Workflows

| File | Trigger | Purpose |
|------|---------|---------|
| `ci.yml` | PR / push to `main` | Runs `lint` + `test` |
| `bump-version.yml` | `workflow_dispatch` | Bumps version, commits, tags, pushes |
| `publish.yml` | `workflow_dispatch` or push `v*` tag | Publishes to npm; alpha uses `--tag alpha` |

## Local Development

### One-time setup

```bash
./scripts/switch.sh
npm ls -g pi-agent-flow
```

### Daily dev loop

```bash
npm run build
# Restart pi after rebuilding
```

### Going back to published

```bash
./scripts/switch.sh
npm ls -g pi-agent-flow
```

## Quick Switch (Local ↔ Remote)

| Mode | Command | When to use |
|------|---------|-------------|
| **Toggle** | `./scripts/switch.sh` | Flip local ↔ remote |
| **Local** | `npm run switch:local` | Force link to this repo |
| **Remote** | `npm run switch:remote` | Force install from npm |

> ⚠️ **Always restart `pi` after switching** so the extension loader picks up the change.

### `pi update` danger

> 🚫 **Never run `pi update` while linked locally.** It overwrites and destroys your local symlink. Switch to REMOTE first, then run `pi update`.

## Payload dump workflow

Use `PI_FLOW_DUMP_SNAPSHOT` or `--dump <path>` to capture the prompt stream sent to flows.

```bash
./scripts/dev-start.sh
```

Manual:

```bash
export PI_FLOW_DUMP_SNAPSHOT=/tmp/pi-dump
pi
cat /tmp/pi-dump.scout.1715724000000.txt
```

> ⚠️ Export the variable in the same shell that starts `pi`.

## Architecture Decision Records

ADRs live in `doc/adr/`. Use `adr init doc/adr` for initialization and `adr new "Decision title"` for new records. Regenerate the index with `adr generate toc > doc/adr/README.md`.

ADR lifecycle policy:

- Proposed ADRs may change while under review or implementation.
- Proposed phase ADRs become Accepted only when their acceptance criteria are fulfilled.
- Accepted ADRs are immutable; amend or supersede them with a later ADR instead of editing them in place.

Current Hatchet integration plan:

- ADR 2: phase 1 runner seam (accepted; implemented in PR #1)
- ADR 3: phase 2 basic Hatchet backend (accepted; implemented in PR #4)
- ADR 4: phase 3 operational hardening (accepted; implemented in follow-up PR)
- ADR 5: phase 4 advanced Hatchet UX (proposed)

## Flow Taxonomy

Agent work is organized into two tiers. **Access is not the boundary — intent is.**

### Tier 1 — Intent-Driven Workers

**Question:** "Do the thing, but stay in your lane."
**Mutations:** Yes — reads, writes, edits, tests, ships. Each flow has a strict mission profile. No mission drift.

| Flow | Tools | maxDepth | Tier | Notes |
|------|-------|----------|------|-------|
| `scout` | batch, bash, find, grep, ls, web | 0 | lite | Explore and map |
| `build` | batch, bash, find, grep, ls, web | 0 | flash | Implement and verify |
| `audit` | batch, bash, find, grep, ls, web | 0 | flash | Audit and fix safe issues |
| `debug` | batch, bash, find, grep, ls, web | 0 | lite | Investigate root cause and fix |
| `ideas` | batch, bash, web | 0 | full | Strategy and recommendation |
| `craft` | batch, bash, find, grep, ls, web | 0 | full | Conservative design |

### Tier 2 — Orchestrator: Main Agent

**Question:** "What should we do, and who should do it?"
**Mutations:** No direct code edits.
**Role:** The router, synthesizer, and user-facing coordinator.

The orchestrator decides whether to delegate, chooses the matching flow, crafts the mission, and synthesizes results. It does not implement directly.

## Key Implementation Details

- **Flow runner seam**: `executeFlows()` dispatches each resolved flow attempt through a `FlowRunner`.
- **Fork-only delegation**: Every flow runs as an isolated `pi` child process with a session snapshot.
- **Directive delimiters**: `buildFlowArgs` uses `<context-seal>`, `<activation>`, `<directive>`, and `<mission>`.
- **Depth guards**: `PI_FLOW_DEPTH`, `PI_FLOW_MAX_DEPTH`, `PI_FLOW_STACK`, and `PI_FLOW_PREVENT_CYCLES` propagate to children.
- **Session modes**: `fast`, `default`, `long`, `extreme_long`.
- **Tool optimization**: Parent can inject `batch`; override with `PI_FLOW_TOOL_OPTIMIZE`.
- **Context compression**: Prior flow/tool output can be sanitized and compressed before forking.
- **Max concurrency**: `PI_FLOW_MAX_CONCURRENCY` overrides the default.
- **Spawn override**: `PI_FLOW_SPAWN_COMMAND` overrides child spawn command.

### What a snapshot dump looks like

Each flow writes:

1. `<base>.<flowName>.<timestamp>.md`
2. `<base>.<flowName>.<timestamp>.txt`

## Environment Variables

| Variable | Effect |
|----------|--------|
| `PI_FLOW_DUMP_SNAPSHOT` | Base path for snapshot dumps |
| `PI_FLOW_MAX_DEPTH` | Override default delegation depth |
| `PI_FLOW_TOOL_OPTIMIZE` | Enable tool-call optimization |
| `PI_FLOW_SESSION_MODE` | Override session mode |

## Workflow Learning with Git Notes

After a successful workflow and commit, add a structured Git note to the commit documenting how the solution was reached.

```bash
git notes add -m "problem: Fix failing cache invalidation
approach: Compared cache key inputs and added missing parameter
failed_paths:
  - Suspected stale filesystem cache first
verification:
  - pytest tests/optimize/test_backtesting.py
workflow_learning: For cache bugs, inspect key composition before invalidation logic
related_files:
  - tests/optimize/test_backtesting.py"
```

Show notes with `git log --show-notes`. Share them with `git push origin refs/notes/commits`.
