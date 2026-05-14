# pi-agent-flow — Project Notes

> 🗺️ **This file is your index route.**
> Think of it as the project's control panel — not a dry spec sheet, but an activation map. If you need to deploy, bump a version, debug a flow, or figure out which script to run, this file points you to the right door. Start here before wandering the codebase.
>
> 🌱 **Keep this index alive.**
> CLAUDE.md is a living document. When flows change, scripts move, or CI/CD steps get updated, this file must reflect reality. If you just changed something structural — added a workflow, renamed a script, tweaked a flow's tools — **update this file before you wrap up**. The next agent (or future you) will thank you. Don't leave them lost in the maze.

## CI/CD

Publishing is **fully automated** via GitHub Actions.

### Strict Rules
- **Never run `npm publish` locally.** Always use CI.
- **Never run `npm version` locally.** The Release workflow handles tagging.

### Publish Flow

When the user asks to publish:

1. Merge feature branch to `main` and push.
2. Trigger the Release workflow:
   ```bash
   gh workflow run bump-version.yml -f bump_type=patch
   ```
   
   For an alpha prerelease:
   ```bash
   gh workflow run bump-version.yml -f bump_type=prerelease
   ```
3. The workflow bumps `package.json`, commits, tags `v*`, and pushes. The tag push automatically triggers `publish.yml` (via `push: tags: v*`) if a PAT secret is configured.
4. **Manual fallback** — if the tag-trigger did not fire (e.g. PAT secret missing), run:
   ```bash
   gh workflow run publish.yml --ref v<NEW_VERSION>
   ```
5. Verify: `npm view pi-agent-flow version`

### Workflows

| File | Trigger | Purpose |
|------|---------|---------|
| `ci.yml` | PR / push to `main` | Runs `lint` + `test` |
| `bump-version.yml` | `workflow_dispatch` (patch/minor/major/prerelease) | Bumps version → commits → tags → pushes |
| `publish.yml` | `workflow_dispatch` or push `v*` tag | Publishes to npm with provenance; alpha versions use `--tag alpha` |

## Local Development

### One-time setup
```bash
./scripts/switch.sh         # Link local checkout (or `npm run switch:local`)
npm ls -g pi-agent-flow     # Verify link status — should show "-> /path/to/repo"
```

### Daily dev loop
You do **not** need to switch between every edit. Once linked, just rebuild and restart `pi`:
```bash
npm run build               # Compile TypeScript → dist/
# Quit pi (Ctrl+C), then start it again — it picks up the new dist/ via the symlink
```

### Going back to published
```bash
./scripts/switch.sh         # Toggle back to REMOTE (or `npm run switch:remote`)
npm ls -g pi-agent-flow     # Should show a version number, not "->"
```

## Quick Switch (Local ↔ Remote)

Use the toggle script to swap between your **local dev build** (for testing
changes) and the **published npm version** (for stable daily usage).

| Mode | Command | When to use |
|------|---------|-------------|
| **Toggle** | `./scripts/switch.sh` | One-command flip between local ↔ remote |
| **Local** | `npm run switch:local` | Force link to this repo (testing new code) |
| **Remote** | `npm run switch:remote` | Force install from npm (stable daily work) |

```bash
./scripts/switch.sh        # Detects current state and flips to the other side
```

> ⚠️ **Always restart `pi` after switching** so the extension loader picks up the change.

### Dev loop after switching
Switching is only needed when changing **modes** (local ↔ remote), not between every edit.
Once linked locally, your daily loop is just:
1. Edit code
2. `npm run build`
3. Quit `pi` and restart it

### `pi update` danger
> 🚫 **Never run `pi update` while linked locally.** It installs the published npm package
> globally, which **overwrites and destroys your local symlink**. To get published updates,
> run `./scripts/switch.sh` first to toggle to REMOTE, then run `pi update`.

## Flow Taxonomy

Agent work is organized into two tiers. **Access is not the boundary — intent is.** All worker flows have full read/write access to files and the shell. What separates them is their *mission profile*.

### Tier 1 — Intent-Driven Workers
**Question:** "Do the thing, but stay in your lane."  
**Mutations:** Yes — reads, writes, edits, tests, ships. Each flow has a strict mission profile. No mission drift.

| Flow | Tools | maxDepth | Tier | Notes |
|------|-------|----------|------|-------|
| `scout` | batch, bash, find, grep, ls, web | 0 | lite | Explore, map, discover. Full access for best exploration. The pathfinder. |
| `build` | batch, bash, find, grep, ls, web | 0 | flash | Implement, test, verify, ship. The craftsman. |
| `audit` | batch, bash, find, grep, ls, web | 0 | flash | Audit security, quality, correctness; fix safe issues. The watchful eye. |
| `debug` | batch, bash, find, grep, ls, web | 0 | lite | Investigate root cause AND fix the bug. The detective + fixer. |
| `ideas` | batch, bash, web | 0 | full | Diverge → evaluate → recommend with inherited context. The strategist. |
| `craft` | batch, bash, find, grep, ls, web | 0 | full | Conservative design, may delegate to `[scout]`. The architect. |

> **None of these flows have `ask_user`.** If user input is needed, a flow emits a `⚠️ Decision Required` block for the orchestrator to present. Only the orchestrator talks to the user.
>
> These flows do the heavy lifting. They do not talk to the user — they receive a mission, execute, and return structured results. Their intent is scoped: a `scout` maps the terrain; a `build` agent ships code; an `audit` agent checks it; a `debug` agent traces roots *and* fixes them; an `ideas` agent explores possibilities; a `craft` agent designs carefully.

> **Tier** (lite / flash / full) only affects **model selection** — which LLM candidate to use. It does **not** restrict tools or access.

### Tier 2 — Orchestrator: Main Agent
**Question:** "What should we do, and who should do it?"  
**Mutations:** No direct code edits.  
**Role:** The router, synthesizer, and user-facing coordinator.

The Orchestrator is the agent you're talking to right now (when not inside a flow). It:
- Understands the user's goal.
- Decides **whether** to delegate to a flow.
- Chooses **which** flow matches the task.
- Crafts the **intent** (mission) for that flow.
- Synthesizes results back to the user.
- **Never implements directly** — it routes and coordinates.

Global default delegation depth (`DEFAULT_MAX_DELEGATION_DEPTH`) is 3; each flow's `maxDepth` overrides it.
