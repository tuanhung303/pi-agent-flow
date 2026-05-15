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

> ⚠️ **Source vs. dist mismatch:** After editing `src/snapshot.ts` or `src/flow.ts`, you **MUST** `npm run build` and restart `pi` before dumps reflect the changes. Child flows run the compiled `dist/` code, not the TypeScript source.

### `pi update` danger
> 🚫 **Never run `pi update` while linked locally.** It installs the published npm package
> globally, which **overwrites and destroys your local symlink**. To get published updates,
> run `./scripts/switch.sh` first to toggle to REMOTE, then run `pi update`.

### Autonomous Pi testing (bash + PTY)

For **`npm run lint` / `npm test`** plus scripted **`pi`** sessions over a pseudo-terminal (`expect`, optional `script` wrapper)—including why bare **`pi -p`** runs often skip full TUI behavior—see **[docs/autonomous-pi-testing.md](docs/autonomous-pi-testing.md)**. Template harness: `scripts/example-autonomous-pi.expect` (copy and tune `AFTER_MS`, optional `STARTUP_RE`, and `RESPONSE_RE` to match your Pi layout / mission).

### Payload dump workflow

When developing locally, you often want to capture the exact prompt stream that `pi` sends to flows so you can debug, diff, or replay it.

**Quick start — using the helper script:**
```bash
./scripts/dev-start.sh    # exports PI_FLOW_DUMP_SNAPSHOT and starts pi
```

**Manual — if you prefer to control the path yourself:**
```bash
export PI_FLOW_DUMP_SNAPSHOT=/tmp/pi-dump
pi
# … do your work …
cat /tmp/pi-dump.scout.1715724000000.txt   # read the reconstructed prompt
```

You can also pass `--dump <path>` on the CLI as an alternative to the env var.

**Convenience — one-liner for your shell:**
```bash
eval "$(./scripts/switch.sh)"   # when switching to LOCAL the script prints an export line
```

> ⚠️ The variable **must** be exported in the same shell that starts `pi`. Running `export` inside a subshell (e.g. `bash -c 'export …'`) will **not** work because child-process environment variables do not propagate upward to the parent.

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
>
> The tier is also injected into the flow's `<activation>` tag as `tier="..."` so the model knows which candidate is running.

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

### What a snapshot dump looks like

When `PI_FLOW_DUMP_SNAPSHOT` is set (or `--dump <path>` is passed), every time a
flow spawns the agent writes two files **per flow** (the base path gets a unique
suffix so parallel flows don't overwrite each other):

1. `<base>.<flowName>.<timestamp>.md` — a markdown file containing:
   - A `<!-- pi-agent-flow dump -->` header with sanitization metadata (flow name, tier, pipeline version, passes applied)
   - `## Session Snapshot (JSONL)` — the full fork snapshot JSONL (post-sanitization)
   - `## Activation Prompt (-p)` — the reconstructed raw prompt
   - `## Compression Stats` — sanitization reduction metrics, including `pipelineVersion` (when available)
2. `<base>.<flowName>.<timestamp>.txt` — just the human-readable reconstructed prompt

Example:

```bash
export PI_FLOW_DUMP_SNAPSHOT=/tmp/pi-dump
pi
# After running a flow:
ls -lh /tmp/pi-dump.*
# → pi-dump.scout.1715724000000.md   (structured + human-readable)
# → pi-dump.scout.1715724000000.txt   (prompt transcript only)
```

> 💡 **When to use it:** You need to inspect exactly what was sent to the model, reproduce a bug offline, or share a verbatim trace with another developer. The dump is written **before** the model call, so even if the flow crashes you still have the prompt.

### Dump format evolution

Two dump families may appear in your dump directory:

- **`pi-dump.*`** (canonical, current) — includes HTML header, `.txt` twins, and compression stats.
- **`snapshot-dump.*`** (legacy, pre-batch-refactor) — lacks all of the above; safe to delete.

TTL cleanup runs automatically before each dump write. The default age is **7 days** (168 hours), configurable via `PI_FLOW_DUMP_MAX_AGE_HOURS`.

## Environment Variables

Key env vars that control flow behavior. All are read from the `pi` process environment and propagated to child flows.

| Variable | Effect |
|----------|--------|
| `PI_FLOW_DUMP_SNAPSHOT` | Base path for snapshot dumps. Each flow appends `.<flowName>.<timestamp>` before the extension so parallel flows don't collide. Must be **exported** in the shell before `pi` starts. See [Payload dump workflow](#payload-dump-workflow) below. |
| `PI_FLOW_DUMP_MAX_AGE_HOURS` | Max age of dump files before auto-cleanup deletes them (default 168 = 7 days). |
| `PI_FLOW_MAX_DEPTH` | Override the default delegation depth limit. |
| `PI_FLOW_TOOL_OPTIMIZE` | Set to `1` to enable tool-call optimization. |
| `PI_FLOW_SESSION_MODE` | Override the session mode (`default`, `unsafe`, `failsafe`). |

## Flow Goal (Autonomous Continuation)

Set a multi-step objective and the system automatically spawns flows to advance it after each turn. When active, the orchestrator receives a hidden instruction at `turn_end` to call the `flow` tool again until the goal is complete, paused, or a budget is exhausted.

### Slash commands

| Command | Usage |
|---------|-------|
| `set` | `/flow-goal set <objective> [--acceptance <text>] [--max-tokens <n>] [--max-flows <n>]` — Sets the goal and **immediately auto-triggers** a build flow to start working. |
| `clear` | `/flow-goal clear` — Marks the active goal as `abandoned` and moves it to history. |
| `pause` | `/flow-goal pause` — Pauses auto-continuation so no new flows are spawned until the goal is resumed or cleared. |
| `resume` | `/flow-goal resume` — Resumes a paused goal and **immediately auto-triggers** a build flow to continue. |
| `edit` | `/flow-goal edit <new-objective> [--acceptance <text>]` — Updates the objective and optionally the acceptance criteria. |
| `complete` | `/flow-goal complete` — Marks the current goal as completed. |
| `status`, `show` | `/flow-goal status` (or `show`) — Displays current goal state, budgets, and completed flows |

> **Note on `completed` status:** `completed` is a valid `FlowGoalStatus`. Goals can be marked completed manually via `/flow-goal complete`, or they may reach `completed` status programmatically (for example, when the orchestrator detects that the objective has been fulfilled).

### How it works

1. On `turn_end`, if a goal is **active**, the continuation hook checks token/flow budgets.
2. If under budget, it sends a hidden message instructing the orchestrator to call the `flow` tool.
3. The spawned flow receives a `<flow-goal>` block in its activation prompt with the objective, acceptance criteria, and progress (`flowCount/maxFlows`).
4. Completed flows (type, intent, aim, completedAt) and token usage are recorded in goal state.
5. If `maxTokens` or `maxFlows` is exceeded, the goal **auto-pauses** silently without notifying the user.
6. A **5-second cooldown** (`SPAWN_COOLDOWN_MS`) prevents rapid-fire spawns.
7. Goals are **session-scoped** via `sessionId`; resuming in a new session still works but clears the old session binding.

### Persistence

Goals are stored in `.pi/flow-goal.json` in the project root (atomic writes). The file contains:
- `current`: the active goal (`id`, `objective`, `acceptance`, `createdAt`, `updatedAt`, `status`, `completedFlows`, `totalTokens`, `maxTokens`, `maxFlows`, `sessionId`).
- `history`: previously completed or abandoned goals.

Add `.pi/` to `.gitignore` — this is local runtime state.

> ⚠️ **Token counting:** The continuation hook estimates tokens using `Math.ceil(messageText.length / 4)`, not actual model token counts. This is a lightweight heuristic for budget guarding.

### Typical lifecycle

```bash
/flow-goal set "Refactor all tests to vitest" --acceptance "All tests pass" --max-flows 5
# Work normally — after each turn the orchestrator auto-delegates
/flow-goal pause    # Stop auto-continuation
/flow-goal status   # Check progress
/flow-goal clear    # Done
```

> No environment variable controls auto-continuation; it is active whenever a goal is set and not paused.
