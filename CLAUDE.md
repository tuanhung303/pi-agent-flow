# pi-agent-flow — Project Notes

> 🗺️ **This file is your index route.**
> Think of it as the project's control panel — not a dry spec sheet, but an activation map. If you need to deploy, bump a version, debug a flow, or figure out which script to run, this file points you to the right door. Start here before wandering the codebase.
>
> 🌱 **Keep this index alive.**
> CLAUDE.md is a living document. When flows change, scripts move, or CI/CD steps get updated, this file must reflect reality. If you just changed something structural — added a workflow, renamed a script, tweaked a flow's tools — **update this file before you wrap up**. The next agent (or future you) will thank you. Don't leave them lost in the maze.

## CI/CD

Publishing is **fully automated** via GitHub Actions.

### Strict Rules

- **Never edit `package.json` version manually.** The Release workflow handles bumping.
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

```bash
npm link                     # Symlink local checkout — restart `pi` after editing
npm uninstall -g pi-agent-flow && npm install -g pi-agent-flow  # Restore published version
npm ls -g pi-agent-flow     # Verify link status
```

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

## Key Implementation Details

- **Fork-only delegation**: Every flow runs as an isolated `pi` child process with a session snapshot.
- **Directive delimiters**: `buildFlowArgs` uses 4-part XML-style prompts: `<context-seal>`, `<activation>`, `<directive>`, `<mission>`. Tags avoid CLI parsing conflicts (none start with `-`).
- **Depth guards**: `PI_FLOW_DEPTH`, `PI_FLOW_MAX_DEPTH`, `PI_FLOW_STACK`, `PI_FLOW_PREVENT_CYCLES` env vars propagated to children.
- **Cycle prevention**: Blocks re-entering flows already in the ancestor stack.
- **Session modes**: `fast` (300s), `default` (600s), `long` (900s), `extreme_long` (1200s). Defined in `session-mode.ts`.
- **Two-stage timeout**: Parent-side warning at `effectiveTimeout - 2min`, final urge at `effectiveTimeout - 2m15s`, hard timeout + 90s reporting grace before SIGKILL. Deadline and grace env vars are propagated to children (`PI_FLOW_DEADLINE_MS`, `PI_FLOW_TOOL_SUMMARY_GRACE_MS`).
- **Timeout reminder injection**: A reminder file (`PI_FLOW_REMINDER_FILE`) is written by the parent and read by the timed-bash wrapper so the child sees warnings before its next tool call.
- **Graceful shutdown**: `SIGINT`/`SIGTERM` handlers on the parent first abort pending bash operations via `bashTracker.abortAll()`, then propagate to all registered child process groups via `terminateAllChildGroups()`. `process.prependListener` is used so our handler runs before the host's cleanup.
- **Structured output**: JSON schema injected at the end of the flow prompt when `structuredOutput` is true. Parsed by `extractStructuredOutput()` and mechanically enriched by `generateCommandsFromHistory()` which replaces paraphrased bash commands with verbatim tool-call args and attaches `executionTime` from the timed-bash wrapper.
- **Flow-mode persistence**: `--flow-mode` writes `flowModelConfig` to global `settings.json` via atomic rename (`writeGlobalFlowMode`). Startup prints either concise (`mode: name | lite: model - flash: model - full: model`) or verbose format with per-tier flow-name labels.
- **Transition matrix**: Data-driven post-flow routing in `transitions.ts`. Declarative transition matrix maps source flow + outcome to follow-up recommendations.
- **Tool optimization**: When enabled, `getOptimizedTools()` strips legacy `read`/`write`/`edit` and injects `batch`. The parent sets active tools to `["batch_read", "flow", "web", "ask_user"]`; children get `["batch", "bash", "web"]` (or plus `flow` if they can delegate); `batch_bash_poll` is registered separately by the extension for polling pending bash ops. Override with `PI_FLOW_TOOL_OPTIMIZE`.
- **Session snapshot sanitization**: `sanitizeForkSnapshot()` strips steering hints, reasoning artifacts, strategic hints, and `batch_read` tool calls from assistant messages, and compresses prior flow tool results into compact `CompressedFlowResult` context maps before forking.
- **Context compression**: Tool results from `batch`, `batch_read`, `web`, and `ask_user` are selectively compressed for child snapshots — bash sections are kept verbatim, read content is truncated, and context-map/file-summary sections are collapsed; web, ask_user, and batch_read results are replaced with compact metadata. Set `PI_FLOW_DEBUG_CONTEXT=1` to emit telemetry to `stderr`.
- **Compact structured output**: When `structuredOutput` is enabled, the JSON schema is injected as a compact single-line reference (not a verbose essay) to reduce token bloat.
- **Max concurrency**: `PI_FLOW_MAX_CONCURRENCY` env var overrides the default maximum parallel flows.
- **Spawn override**: `PI_FLOW_SPAWN_COMMAND` env var overrides the child spawn command for exotic runtime environments (e.g. bundled with pkg/nexe).
- **Strategic hints**: `PI_FLOW_NO_STRATEGIC_HINT=1` suppresses the strategic planning hints appended after tool calls.
