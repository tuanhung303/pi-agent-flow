# pi-agent-flow — Project Notes

> 🗺️ **This file is your index route.**
> Think of it as the project's control panel — not a dry spec sheet, but an activation map. If you need to deploy, bump a version, debug a flow, or figure out which script to run, this file points you to the right door. Start here before wandering the codebase.
>
> 🌱 **Keep this index alive.**
> CLAUDE.md is a living document. When flows change, scripts move, or CI/CD steps get updated, this file must reflect reality. If you just changed something structural — added a workflow, renamed a script, tweaked a flow's tools — **update this file before you wrap up**. The next agent (or future you) will thank you. Don't leave them lost in the maze.

## Project Index

| Category | Files |
|----------|-------|
| **Docs** | [`docs/CONTEXT-DIAGNOSTICS.md`](docs/CONTEXT-DIAGNOSTICS.md) — diagnose high token counts in child flows • [`docs/agent-context-dump.md`](docs/agent-context-dump.md) — verbatim child context dump anatomy • [`docs/agent-payload-example.md`](docs/agent-payload-example.md) — exact payload reproduction from source code • [`docs/autonomous-pi-testing.md`](docs/autonomous-pi-testing.md) — scripted Pi sessions over PTY • [`docs/scout-report.md`](docs/scout-report.md) — generated codebase map • [`docs/telemetry-compression-protocols.md`](docs/telemetry-compression-protocols.md) — W1/E1/X1/Q1 compression protocol specs • [`docs/SHARED-CONTEXT-IMPROVEMENT-PROMPT.md`](docs/SHARED-CONTEXT-IMPROVEMENT-PROMPT.md) — living improvement prompt for context compression pipeline • [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) — configuration reference (flags, env vars, settings) • [`docs/FLOWS.md`](docs/FLOWS.md) — bundled flows, session modes, timeout behavior, flow loop & warp • [`docs/TOOLS.md`](docs/TOOLS.md) — tool reference (batch, web, ask_user) • [`docs/CUSTOM-FLOWS.md`](docs/CUSTOM-FLOWS.md) — custom flow creation and front-matter • [`docs/STRUCTURED-OUTPUT.md`](docs/STRUCTURED-OUTPUT.md) — structured JSON output schema • [`docs/NOTIFICATIONS.md`](docs/NOTIFICATIONS.md) — terminal and desktop notification config |
| **Dump Analysis** | [`docs/dump-analysis/VERSION-NOTES.md`](docs/dump-analysis/VERSION-NOTES.md) — version notes for collected artifacts • [`docs/dump-artifacts/ANALYSIS.md`](docs/dump-artifacts/ANALYSIS.md) — cross-reference of dumps against source • [`docs/dump-artifacts/README.md`](docs/dump-artifacts/README.md) — catalog of representative dump files |
| **Workflows** | [`ci.yml`](.github/workflows/ci.yml) — lint + test on PR/push • [`bump-version.yml`](.github/workflows/bump-version.yml) — version bump → commit → tag → push • [`publish.yml`](.github/workflows/publish.yml) — npm publish with provenance |
| **Scripts** | [`dev-start.sh`](scripts/dev-start.sh) — start `pi` with `PI_FLOW_DUMP_SNAPSHOT` preset • [`switch.sh`](scripts/switch.sh) — toggle local ↔ remote install • [`sync-dumps.sh`](scripts/sync-dumps.sh) — sync `/tmp` dumps into `dump-artifacts/` • [`example-autonomous-pi.expect`](scripts/example-autonomous-pi.expect) — PTY test harness template • [`./tmp/validate-context-pipeline.js`](./tmp/validate-context-pipeline.js) — synthetic context pipeline validator • [`./tmp/analyze-dump.js`](./tmp/analyze-dump.js) — real dump analyzer |
| **Key Source** | `src/index.ts` — entrypoint • `src/core/flow.ts` — flow fork runner and process management • `src/snapshot/snapshot.ts` — session fork & sanitization pipeline • `src/core/agents.ts` — bundled flow definitions & loading • `src/batch/index.ts` / `src/batch/` — unified file/batch tools • `src/tui/render.ts` — TUI rendering & animations • `src/snapshot/structured-output.ts` — JSON output validation & enrichment • `src/tools/web-tool.ts` — search & fetch • `src/tools/ask-user.ts` — interactive prompts • `src/config/config.ts` — settings resolution • `src/notify/notify.ts` — desktop/terminal notifications • `src/flow/loop.ts` — endless loop state management (enable, disable, reset, terminate, warp tracking) • `src/flow/loop-command.ts` — `/flow:loop` slash command (enable/disable/status/stop/reset) • `src/flow/auto-warp.ts` — auto-warp trigger when loop budget is exceeded • `src/flow/loop-templates.ts` — loop runtime prompt templates • `src/flow/warp.ts` — warp distillation and session creation |
| **Additional Source** | `src/flow/` — flow goal orchestration, continuation, loop, and settings commands • `src/steering/` — steering hint injection, sliding prompts, and tool utilities • `src/types/` — shared TypeScript types for flow execution, output, and UI • `src/batch/` — batch operation engine, rendering, fuzzy editing, symbol extraction • `src/core/` — flow executor, transition logic, depth config, session modes, transitions • `src/config/` — TUI-safe logging and settings resolution • `src/tui/` — color themes, render utilities, single-select layout, scramble animation • `src/snapshot/` — CLI arg inheritance, reasoning strip, runner event parsing • `src/tools/` — timed bash wrapper with deadline awareness • `src/notify/` — notification state tracking |

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

> ⚠️ **Source vs. dist mismatch:** After editing `src/snapshot/snapshot.ts` or `src/core/flow.ts`, you **MUST** `npm run build` and restart `pi` before dumps reflect the changes. Child flows run the compiled `dist/` code, not the TypeScript source.

### `pi update` danger
> 🚫 **Never run `pi update` while linked locally.** It installs the published npm package
> globally, which **overwrites and destroys your local symlink**. To get published updates,
> run `./scripts/switch.sh` first to toggle to REMOTE, then run `pi update`.

### Autonomous Pi testing (bash + PTY)

For **`npm run lint` / `npm test`** plus scripted **`pi`** sessions over a pseudo-terminal (`expect`, optional `script` wrapper)—including why bare **`pi -p`** runs often skip full TUI behavior—see **[docs/autonomous-pi-testing.md](docs/autonomous-pi-testing.md)**. Template harness: `scripts/example-autonomous-pi.expect` (copy and tune `AFTER_MS`, optional `STARTUP_RE`, and `RESPONSE_RE` to match your Pi layout / mission).

## Write-Then-Execute Convention

For non-trivial scripts (Python, Node, shell), always **write the script to `./tmp/` first, then execute it** — never inline multi-line code via `python -c '...'` or `node -e '...'`.

Why:
- The `batch` tool guarantees file ops complete before bash ops, so write → execute is safe in a single call.
- Avoids shell escaping nightmares with quotes and newlines.
- Produces better error traces (file path + line numbers).
- Leaves the script inspectable for debugging.

Example workflow in a single `batch` call:
1. `o: "write"`, `p: "./tmp/analyze.py"`, `c: "<script content>"`
2. `o: "bash"`, `c: "python ./tmp/analyze.py"`

Clean up one-time-use `./tmp/` scripts when the task is complete.

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
# After switching to LOCAL, export the dump path manually if you want snapshots:
export PI_FLOW_DUMP_SNAPSHOT=/tmp/pi-dump   # or use ./scripts/dev-start.sh
```

> ⚠️ The variable **must** be exported in the same shell that starts `pi`. Running `export` inside a subshell (e.g. `bash -c 'export …'`) will **not** work because child-process environment variables do not propagate upward to the parent.

### Validation Instruments

After capturing dumps, validate them with the standalone instruments in `./tmp/` before manual reading:

```bash
# Synthetic validation (requires dist/ to be built)
npm run build
node ./tmp/validate-context-pipeline.js

# Real dump analysis (run after a live `pi` session)
node ./tmp/analyze-dump.js
```

These scripts catch forbidden placeholders, incomplete flow tool params, pass-count regressions, and orphan errors automatically.

### Syncing dump artifacts to the repo

Use `scripts/sync-dumps.sh` to copy the current `/tmp` dump files into `dump-artifacts/` and regenerate the manifests:

```bash
./scripts/sync-dumps.sh
```

This script is **idempotent** — safe to run multiple times. It:
1. Copies newer or missing `pi-dump*` and `snapshot-dump*` files from `/tmp` into `dump-artifacts/` (additive — never deletes curated dumps)
2. Regenerates `MANIFEST.md` and `manifest.json`

> 💡 **When to use it:** After a debugging session where you want to archive or diff the exact prompts that were sent to child flows. The synced artifacts are analysis material and can be committed if you are tracking format evolution, but they are not required for CI.
>
> **Integration test dumps:** You can also generate dump artifacts without running `pi` directly by setting `PI_FLOW_DUMP_SNAPSHOT` when running the integration test:
> ```bash
> PI_FLOW_DUMP_SNAPSHOT=/tmp/pi-dump npm test -- tests/snapshot-integration.test.ts
> ```

## TUI-Safe Logging Convention

**Never use `console.warn()` or `console.error()` in flow code.** During TUI rendering, stderr output briefly flashes on-screen before being overwritten by the next frame — this causes the "text appears then disappears" glitch.

Instead, use the `logWarn` / `logError` functions from `src/config/log.ts`:

| Function | TUI mode | Non-TUI mode (tests, CLI) |
|----------|----------|---------------------------|
| `logWarn(msg)` | Writes to `$TMPDIR/pi-agent-flow.log` | Falls back to `console.warn()` |
| `logError(msg)` | Writes to `$TMPDIR/pi-agent-flow.log` | Falls back to `console.error()` |

TUI mode is detected automatically when `PI_TUI_MODE=1`, `PI_FLOW_DEPTH > 0`, or `stdout.isTTY` is true.

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
| `craft` | batch, bash, find, grep, ls, web | 0 | full | Conservative design, may transition to `[scout]`. The architect. |

> **None of these flows have `ask_user`.** If user input is needed, a flow emits a `⚠️ Decision Required` block for the root state to present. Only the root state talks to the user.
>
> These flows do the heavy lifting. They do not talk to the user — they receive a mission, execute, and return structured results. Their intent is scoped: a `scout` maps the terrain; a `build` agent ships code; an `audit` agent checks it; a `debug` agent traces roots *and* fixes them; an `ideas` agent explores possibilities; a `craft` agent designs carefully.

> **Tier** (lite / flash / full) only affects **model selection** — which LLM candidate to use. It does **not** restrict tools or access.
>
> The tier is also injected into the flow's `<activation>` tag as `tier="..."` so the model knows which candidate is running.

### Nested flow snapshots

At depth ≥ 2, the sanitized JSONL snapshot embeds the **parent flow's full activation prompt** as a `user` message. This is expected behavior: the parent's conversation history begins with its own `-p` prompt, and sanitization preserves that history so the child can replay it.

Child flows should treat any `<context-seal>`, `<activation>`, or `<directive>` blocks appearing inside JSONL `user` messages as **sealed parent context**, not as their own instructions. The child's own activation prompt is delivered separately in the `-p` argument.

### Tier 2 — Root state: Main Agent
**Question:** "What should we do, and who should do it?"  
**Mutations:** No direct code edits.  
**Role:** The router, synthesizer, and user-facing coordinator.

The Root state is the agent you're talking to right now (when not inside a flow). It:
- Understands the user's goal.
- Decides **whether** to transition to a flow.
- Chooses **which** flow matches the task.
- Crafts the **intent** (mission) for that flow.
- Synthesizes results back to the user.
- **Never implements directly** — it routes and coordinates.

Global default transition depth (`DEFAULT_MAX_TRANSITION_DEPTH`) is 3; each flow's `maxDepth` overrides it.

### Nested flow snapshots

At depth ≥ 2, the sanitized JSONL snapshot embeds the **parent flow's full activation prompt** as a `user` message. This is expected behavior: the parent's conversation history begins with its own `-p` prompt, and sanitization preserves that history so the child can replay it.

Child flows should treat any `<context-seal>`, `<activation>`, or `<directive>` blocks appearing inside JSONL `user` messages as **sealed parent context**, not as their own instructions. The child's own activation prompt is delivered separately in the `-p` argument.

### What a snapshot dump looks like

When `PI_FLOW_DUMP_SNAPSHOT` is set (or `--dump <path>` is passed), every time a
flow spawns the agent writes two files **per flow** (the base path gets a unique
suffix so parallel flows don't overwrite each other):

1. `<base>.<flowName>.<timestamp>.md` — a markdown file containing:
   - A `<!-- pi-agent-flow dump -->` header with sanitization metadata (flow name, tier, `pipelineVersion`, passes applied)
   - `## Session Snapshot (JSONL)` — the full fork snapshot JSONL (post-sanitization)
   - `## Activation Prompt (-p)` — the reconstructed raw prompt
   - `## Compression Stats` — Pre-sanitization bytes, Post-sanitization bytes, and Reduction percentage

> **Cold-start dumps:** When there is no session history, the markdown file contains only the HTML header (`<!-- pi-agent-flow dump -->`) and `## Activation Prompt (-p)` sections — the `## Session Snapshot (JSONL)` and `## Compression Stats` sections are omitted.

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
| `PI_FLOW_MAX_DEPTH` | Override the default transition depth limit. |
| `PI_FLOW_MAX_CONCURRENCY` | Override the default maximum concurrent flows (default 4, capped to CPU count). |
| `PI_FLOW_IDLE_WAKEUP_MS` | Override the idle wake-up threshold in milliseconds (default 600000 = 10 minutes). |
| `PI_FLOW_TOOL_OPTIMIZE` | Set to `1` to enable tool-call optimization. |
| `PI_FLOW_SESSION_MODE` | Override the default child-flow session mode (`snap`, `fast`, `default`, `long`, `extreme_long`). |
| `PI_TUI_MODE` | Set to `1` to route `logWarn`/`logError` to a log file instead of stderr, preventing on-screen text flash. Detected automatically when stdout is a TTY or `PI_FLOW_DEPTH > 0`. |
| `PI_FLOW_LOG_FILE` | Override the default log file path (`$TMPDIR/pi-agent-flow.log`) for TUI-safe logging. Set to `/dev/null` to suppress entirely. |
| `PI_FLOW_NO_STEERING` | Set to `1` to disable root state steering hint injection. |
| `PI_FLOW_NO_DIRECTIVE` | Set to `1` to disable adaptive `[Directive: ...]` hints after tool results. |
| `PI_FLOW_NO_STRATEGIC_HINT` | Legacy alias for `PI_FLOW_NO_DIRECTIVE` — still honored for backward compatibility. |
| `PI_FLOW_NO_ANIMATION` | Set to `1` to disable all flow animation (instant render). |
| `PI_FLOW_NO_GLITCH` | Set to `1` to disable glitch/scramble effect. |
| `PI_ASK_USER_TIMEOUT` | Override the ask_user default timeout in seconds (e.g., `60` for 1 minute). |
| `PI_BATCH_MAX_LINES` | Override the default batch max lines limit (default 3000, Pi spec: 2000). |
| `PI_BATCH_MAX_BYTES` | Override the default batch max bytes limit (default 102400, Pi spec: 51200). |
| `PI_BASH_MAX_LINES` | Override the default bash max output lines limit (default 4000, Pi spec: 2000). |
| `PI_BASH_MAX_BYTES` | Override the default bash max output bytes limit (default 102400, Pi spec: 51200). |
| `PI_FLOW_SIGKILL_TIMEOUT_MS` | Override the default SIGKILL timeout in milliseconds (default 5000). |
| `PI_FLOW_FINISH_KILL_GRACE_MS` | Override the default finish kill grace period in milliseconds (default 5000). |
| `PI_FLOW_AGENT_END_GRACE_MS` | Override the default agent end grace period in milliseconds (default 2000). |
| `PI_FLOW_TIME_BUDGET_WARNING_MS` | Override the default flow time budget warning threshold in milliseconds (default 120000). |
| `PI_FLOW_FINAL_URGE_MS` | Override the default final urge threshold in milliseconds (default 135000). |
| `PI_FLOW_REPORTING_GRACE_MS` | Override the default reporting grace period in milliseconds (default 90000). |
| `PI_FLOW_SNAP_THRESHOLD_MS` | Override the default snap threshold in milliseconds (default 120000). |

## Flow Settings

Control runtime behavior via slash commands, CLI flags, environment variables, or persistent settings in `.pi/settings.json`.

### `/flow:settings` slash commands

| Command | Usage |
|---------|-------|
| `show` | `/flow:settings show` — Display current settings and their sources. |
| `steering` | `/flow:settings steering on\|off` — Enable/disable root state steering hint injection. |
| `strategic-hint` | `/flow:settings strategic-hint on\|off` — Enable/disable adaptive `[Directive: ...]` hints after tool results. |
| `directive` | Alias for `strategic-hint` — controls the same setting. |
| `animation` | `/flow:settings animation on\|off` — Enable/disable all flow animations. |
| `glitch` | `/flow:settings glitch on\|off` — Enable/disable glitch/scramble effect. |
| `tool-optimize` | `/flow:settings tool-optimize on\|off` — Enable/disable tool-call optimization. |
| `structured-output` | `/flow:settings structured-output on\|off` — Enable/disable structured JSON output from flows. |
| `session-mode` | `/flow:settings session-mode <snap\|fast\|default\|long\|extreme_long>` — Set the child-flow session budget mode. |
| `max-concurrency` | `/flow:settings max-concurrency <n>` — Set maximum concurrent flows. |
| `ask-user` | `/flow:settings ask-user enabled <on\|off>` — Enable/disable ask_user countdown. `/flow:settings ask-user timeout <seconds>` — Set auto-dismiss timeout. |
| `reset` | `/flow:settings reset` — Reset all settings to their defaults. |

### CLI flags

Pass these when starting `pi`:

| Flag | Effect |
|------|--------|
| `--no-steering` | Disable root state steering hint injection. |
| `--steering-prompt <text>` | Provide a custom steering prompt (implies `--no-steering` override). |
| `--no-strategic-hint` | Disable adaptive `[Directive: ...]` hints after tool results. |
| `--no-animation` | Disable all flow animation (instant render). |
| `--no-glitch` | Disable glitch/scramble effect. |

### Resolution priority

When the same setting is defined in multiple places, the value is resolved as:

**CLI flag > env var > `settings.json` > default**

### Example `.pi/settings.json`

```json
{
  "flowSettings": {
    "steering": {
      "enabled": true,
      "customPrompt": "Plan next step..."
    },
    "strategicHint": {
      "enabled": true
    },
    "directive": {
      "enabled": true
    },
    "animation": {
      "enabled": true,
      "glitch": true
    },
    "askUser": {
      "enabled": false,
      "timeout": 300
    },
    "toolOptimize": false,
    "structuredOutput": true,
    "sessionMode": "default",
    "maxConcurrency": 3
  }
}
```

> 💡 Settings are stored in `.pi/settings.json` and persisted across sessions. Use `/flow:settings reset` to discard them and fall back to defaults.

## Flow (Autonomous Continuation)

Set a multi-step objective and the system automatically spawns flows to advance it after each turn. When active, the root state receives a hidden instruction at `turn_end` to call the `flow` tool again until the goal is complete, paused, or a budget is exhausted.

### Slash commands

| Command | Usage |
|---------|-------|
| `set` | `/flow:goal set <objective> [--acceptance <text>] [--max-tokens <n>] [--max-flows <n>]` — Sets the goal and **immediately auto-triggers** a build flow to start working. |
| `clear` | `/flow:goal clear` — Marks the active goal as `abandoned` and moves it to history. |
| `pause` | `/flow:goal pause` — Pauses auto-continuation so no new flows are spawned until the goal is resumed or cleared. |
| `resume` | `/flow:goal resume` — Resumes a paused goal and **immediately auto-triggers** a build flow to continue. |
| `edit` | `/flow:goal edit <new-objective> [--acceptance <text>]` — Updates the objective and optionally the acceptance criteria. |
| `complete` | `/flow:goal complete` — Marks the current goal as completed. |
| `status`, `show` | `/flow:goal status` (or `show`) — Displays current goal state, budgets, and completed flows |
| `warp` | `/flow:warp [goal]` — Distills conversation context into a simple context-transfer prompt (## Context + ## Task) and spawns a new session with the goal auto-set. Preserves unresolved blockers, key files, and end-goal intent. If no goal is provided, a default continuation goal is used. |

> **Note on `completed` status:** `completed` is a valid `GoalStatus`. Goals can be marked completed manually via `/flow:goal complete`. The agent cannot self-terminate a goal — only the user can end it.

#### Warp gotchas

| Gotcha | Why |
|--------|-----|
| **No model selected** | Warp requires a configured LLM to distill context. Set a model in Pi settings first. |
| **Empty conversation** | If the branch has no messages, there's nothing to warp. |
| **Deep warp chains (>3)** | Consecutive warps dilute context. A warning is shown; consider consolidating instead. |
| **User cancels editor** | No session is created; the current session remains unchanged. |
| **Blank goal fallback** | If no goal is provided, warp uses a default: "Continue where we left off — summarize what we've done, where we are, and what the natural next step is." |

#### Warp output format

Warp produces a simple **context-transfer prompt** with two markdown sections:

- **## Context** — orientation summary, decisions made, files touched, unresolved blockers, and edge cases
- **## Task** — the immediate next action to take

Example distilled prompt:

## Context

We've been refactoring the auth layer from Express middleware to NestJS guards.

Key decisions:
- Use @nestjs/passport with JWT strategy
- Skip session auth; keep stateless only

Files involved:
- `src/auth/jwt.strategy.ts` — created, basic validate()
- `src/auth/auth.module.ts` — registered JwtStrategy

Unresolved work / blockers:
- Role-based access not implemented yet
- E2E tests failing after guard injection (needs debug)

Edge cases to watch:
- JWT secret is overridden by AUTH_SECRET env var in CI
- `src/auth/auth.module.ts` exports order matters for DI

## Task

Complete the Discover phase by mapping middleware usage, then begin Convert on the first batch of routes.

### How it works

1. On `turn_end`, if a goal is **active**, the continuation hook checks token/flow budgets. If `maxTokens` or `maxFlows` is exceeded, the goal is **auto-paused** and a hidden budget-limit message is sent to the root state.
2. If under budget, the hook sends a hidden message instructing the root state to call the `flow` tool.
3. The spawned flow receives a `<flow>` block in its activation prompt with the objective, acceptance criteria, and progress (`flowCount/maxFlows`).
4. Completed flows (type, intent, aim, completedAt) and token usage are recorded in goal state.
5. A **5-second cooldown** (`SPAWN_COOLDOWN_MS`) prevents rapid-fire spawns.
6. A **3-second post-completion hold** (`FLOW_COMPLETE_HOLD_MS`) delays the next spawn after a flow finishes, giving the user time to read the completed result before it scrolls off-screen.
7. Goals are **session-scoped** via `sessionId`; resuming in a new session still works but clears the old session binding.

### Idle wake-up

When a goal is active and the user has been idle for **~600 seconds** (10 minutes), the system sends a hidden `<flow-wakeup>` nudge to the root state. The nudge prompts the agent to review the active goal and find safe, conservative improvements that advance it — such as verification, testing, or documentation — without making risky changes or refactoring large areas.

The wake-up interval is checked every 60 seconds. It resets after any user turn or flow completion. Override the default idle threshold via the `PI_FLOW_IDLE_WAKEUP_MS` environment variable (value in milliseconds).

### Persistence

Goals are stored in `.pi/flow.json` in the project root (atomic writes). The file contains:
- `current`: the active goal (`id`, `objective`, `acceptance`, `createdAt`, `updatedAt`, `status`, `completedFlows`, `totalTokens`, `maxTokens`, `maxFlows`, `sessionId`).
- `history`: previously completed or abandoned goals.

Add `.pi/` to `.gitignore` — this is local runtime state.

> ⚠️ **Token counting:** The continuation hook estimates tokens using `Math.ceil(messageText.length / 4)`, not actual model token counts. This is a lightweight heuristic for budget guarding.

### Typical lifecycle

```bash
/flow:goal set "Refactor all tests to vitest" --acceptance "All tests pass" --max-flows 5
# Work normally — after each turn the root state auto-transitions
/flow:goal pause    # Stop auto-continuation
/flow:goal status   # Check progress
/flow:goal clear    # Done
```

> No environment variable controls auto-continuation; it is active whenever a goal is set and not paused.
