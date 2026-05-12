<p align="center"><code>pi install npm:pi-agent-flow</code></p>
<p align="center"><strong>Pi Agent Flow</strong> is a flow-state delegation extension for the <a href="https://pi.dev">Pi coding agent</a> that runs locally in your terminal.</p>

---

## Quickstart

### Installing Pi Agent Flow

Install via the Pi CLI from npm:

```shell
pi install npm:pi-agent-flow
```

Or add it to your Pi settings:

```shell
# ~/.pi/agent/settings.json
{
  "packages": [
    "npm:pi-agent-flow"
  ]
}
```

Then start Pi and delegate tasks using flow states.

<details>
<summary>You can also install from a local path.</summary>

```shell
# Install from a local clone
git clone https://github.com/tuanhung303/pi-agent-flow.git
cd pi-agent-flow
pi install .
```

</details>

---

## Features

- **Flow-state delegation** — six bundled specialist flows (`scout`, `debug`, `build`, `craft`, `audit`, `ideas`) plus custom flows via Markdown front-matter
- **Isolated forked context** — each flow runs as an isolated `pi` child process with a session snapshot (or clean slate when configured)
- **Parallel execution** — batch independent flows into one call with bounded concurrency
- **Structured reports** — every flow returns structured output with `summary`, `files`, `actions`, `commands`, `notDone`, `nextSteps`, `reasoning`, and `notes`; optional JSON schema for machine-readable results
- **Mechanically enriched commands** — bash commands in structured output are replaced with exact verbatim tool-call strings and annotated with `executionTime`
- **Depth guards** — configurable max delegation depth (default: `3`)
- **Session timeout modes** — child flows use controlled budgets: `fast` (300s), `default` (600s), `long` (900s), or `extreme_long` (1200s)
- **Two-stage timeout awareness** — flows receive deadline hints in their prompt; the parent UI shows live countdowns and injects warning reminders before hard kill
- **Graceful shutdown** — parent `SIGINT`/`SIGTERM` propagates to all child process groups; orphaned sub-agents are force-killed after a grace period
- **Cycle prevention** — blocks re-entering flows already in the ancestor stack
- **Model tiering & failover** — flows map to `lite` / `flash` / `full` tiers with primary + failover model chains
- **Persistent flow mode** — switch global model strategies with `--flow-mode`; written to `settings.json` and remembered across sessions
- **Flow-mode notification** — concise (`mode: name | lite: model · flash: model · full: model`) or verbose (with per-tier flow-name labels) startup message
- **Unified batch tools** — `batch` (read/write/edit/delete) and `batch_read` replace separate file tools for cross-cutting work
- **Web tool** — built-in `web` search (Brave + DuckDuckGo) and page fetch with HTML→Markdown conversion
- **Sliding system prompt** — lightweight routing reminder dynamically injected before each user message (never part of the static system prompt); switches between spec-driven planning and implement modes based on the `/spec` toggle, stripped from child snapshots to avoid duplication
- **Session snapshot sanitization** — removes sliding prompts, reasoning/thinking artifacts, and non-inheritable content before forking; compresses prior flow results into compact context maps
- **Shared context inheritance** — child flows receive the parent's sanitized session automatically; write forward-looking intents and let the child pick up context from its inherited snapshot
- **Project flow confirmation** — prompts before running project-local flows from `.pi/agents/` for security
- **Rich TUI rendering** — collapsed activity-panel view with per-flow stats, live countdowns, scramble-animated act/msg/tps lines, and expanded view with full reports and tool traces
- **Smooth streaming metrics** — token counters and smoothed TPS increment tick-by-tick during active streaming
- **Quad-mode TUI scramble** — `stream`, `cascade`, `ripple`, and `illuminate` text animations on act, msg, TPS lines, and tool results (batch, web, ask_user) in the collapsed activity panel (default: `illuminate`)
- **`/spec` command** — toggle spec-driven planning mode that guides the orchestrator through investigate → discuss → plan → delegate
- **Dynamic notifications** — terminal and desktop alerts adapt their title/body based on flow completion state or pending `ask_user` decisions
- **Preferred-choice guidance** — `ask_user` prompts can mark a recommended option with `[preferred]` and place it first

---

## Why Flow Style?

Flow-style delegation is designed for **context efficiency**. Instead of launching every sub-agent with the full, ever-growing conversation history, each flow receives only what it needs: your intent and (when appropriate) a sanitized session snapshot.

This approach delivers four concrete benefits:

1. **Avoid duplicate tool calls** — every sub-agent launch no longer re-runs the same `read`, `grep`, or `bash` probes that the parent already performed.
2. **Prevent context bloat** — long transcripts with repeated file listings and command outputs are kept out of the main conversation thread.
3. **Eliminate unnecessary noise** — the parent agent sees only structured results (`summary`, `notDone`, `nextSteps`, etc.) instead of pages of intermediate reasoning.
4. **Preserve focus** — each flow stays locked on its intent because it isn't distracted by unrelated earlier messages.

The result is faster, cheaper, and cleaner delegation: the main agent remains uncluttered while specialized flows do the heavy lifting in isolated contexts.

---

## Shared Context

When you delegate to a flow, the child agent receives an automatic **sanitized fork** of your current session. This lets you write concise intents that focus on **what new work to do** rather than restating the full problem.

### How it works

1. **Snapshot serialized** — your conversation (files read, commands run, prior flow results) is serialized into a JSONL snapshot.
2. **Sanitized** — sliding prompts, reasoning/thinking artifacts, and other non-inheritable content are stripped.
3. **Compressed** — prior flow tool results are compacted into short summaries: files touched, commands used, outcome status.
4. **Forked** — the child agent loads this snapshot via `--session` at startup.

### Writing good intents

The child already sees what you've done. Write intents that say **what to do next**, not what context it needs:

| ❌ Bad intent | ✅ Good intent |
|---|---|
| `"The auth module uses JWT tokens… inspect src/auth/ for security issues"` | `"Audit the auth module for security issues"` |
| `"We already found the bug… run the failing test and fix it"` | `"Fix the failing test in tests/auth.test.ts"` |
| `"The file structure is… implement the feature described in the PRD"` | `"Implement the feature described in the PRD"` |

### Clean slate

Set `inheritContext: false` in a custom flow's front-matter to start with a clean slate. The child receives only your `intent` — no inherited session. This is ideal for unbiased creative work in `ideas` flows.

### What the child sees

The child's `<context-seal>` prompt tells it: *"The conversation above is sealed — it is your session history for situational awareness only."* The child can reference files and findings already in context but shouldn't act as if it's still in the parent's conversation.

---

## Bundled Flows

| Flow | Purpose | Tools | Tier |
|------|---------|-------|------|
| `[scout]` | Discover files, trace code paths, map architecture | `batch`, `bash`, `find`, `grep`, `ls`, `web` | `lite` |
| `[debug]` | Investigate logs, errors, stack traces, root causes | `batch`, `bash`, `find`, `grep`, `ls`, `web` | `lite` |
| `[build]` | Implement features, fix bugs, write tests, update docs, ship | `batch`, `bash`, `find`, `grep`, `ls`, `web` | `flash` |
| `[craft]` | Plan structure, break down requirements, design solutions | `batch`, `bash`, `find`, `grep`, `ls`, `web` | `full` |
| `[audit]` | Audit security, quality, correctness; fix safe issues autonomously | `batch`, `bash`, `find`, `grep`, `ls`, `web` | `flash` |
| `[ideas]` | Generate ideas and explore possibilities with inherited context | `batch`, `bash`, `web` | `full` |

> **Note:** All bundled flows have `maxDepth: 0`, meaning they do not delegate further by default. Custom flows can override this via front-matter.

> **Clean slate:** Set `inheritContext: false` in a custom flow's front-matter so it receives only the intent, ideal for unbiased creative work.

> **Docs hygiene:** Bundled `build` and `debug` flows are instructed to update relevant documentation after their work when the findings or implementation change developer or operational knowledge. If no docs apply, they should state why in the final report.

### Session modes

Each flow call may set `sessionMode` to choose the child-agent time budget:

| Mode | Budget | Recommended use |
|------|-------:|-----------------|
| `fast` | 300s | quick scouting, narrow checks, small design passes |
| `default` | 600s | normal flow work; this is the default |
| `long` | 900s | large builds, full test runs, broad refactors, complex debugging |
| `extreme_long` | 1200s | very large refactors, extensive audits, or multi-step debugging sessions |

Example:

```json
{
  "flow": [
    {
      "type": "build",
      "intent": "Run the full test suite and fix failures",
      "aim": "Fix failing tests",
      "sessionMode": "long"
    }
  ]
}
```

The public interface is mode-based; arbitrary per-flow numeric timeouts are not exposed.

### Timeout behavior

Flows are aware of their deadline from the moment they start:

- **Prompt injection** — the activation block includes the exact time budget and warns the agent to wrap up before the deadline.
- **Parent UI countdown** — a live `MM:SS` countdown is shown next to the flow's aim while it runs.
- **Two-stage warnings** — at 2 minutes before hard timeout a warning is injected into the child's reminder stream; at 2 minutes 15 seconds a final urge demands the agent stop all tool use and output structured findings.
- **Grace period** — after the hard timeout fires, the agent gets a 90-second reporting grace to finish its summary before the process is force-killed.
- **Graceful shutdown** — when the parent receives `SIGINT` or `SIGTERM`, the signal propagates to every child process group so sub-agents terminate cleanly instead of becoming orphans.

---

## `/spec` Command

Toggle spec-driven planning mode with the `/spec` command. When active, the sliding system prompt instructs the orchestrator to follow a four-phase workflow:

1. **Investigate** — read package files, tests, and config directly; delegate broad discovery to `[scout]`
2. **Discuss** — ask 2–3 targeted, evidence-based questions via `ask_user`, marking the recommended choice with `[preferred]`
3. **Plan** — delegate to `[build]` to write a structured spec to `.specs/{slug}/spec.md`
4. **Delegate** — once the spec is confirmed, proceed with implementation flows

Run `/spec` with a prompt to activate immediately and start investigating:

```bash
/spec Add a REST API endpoint for user preferences
```

Run `/spec` without arguments to toggle the mode on or off. When off, the orchestrator uses the standard implement-mode behavior: investigate first, then delegate directly to flows.

When you deactivate spec mode, a new session is created and the orchestrator synthesizes a full implementation plan from the conversation history, placing it in the editor for review.

---

## Flow Definitions

Create `.md` files in `~/.pi/agent/agents/` (user-level) or `.pi/agents/` (project-level):

```markdown
---
name: myflow
description: Short description of what this flow does
tools: batch, bash
model: github-copilot/gpt-5.5
maxDepth: 1
inheritContext: true
---

During this myflow flow — your mission is ...

When accomplished, end your response with:

flow [myflow] accomplished

[Summary] what was investigated

[Done]
- completed items

[Not Done]
- incomplete items and reasons

[Next Steps]
- recommended follow-up
```

### Front-matter options

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Flow identifier (lowercase, required) |
| `description` | `string` | Short summary (required) |
| `tools` | `string[]` | Tools available to this flow |
| `model` | `string` | Override the model for this flow |
| `thinking` | `string` | Thinking budget (e.g., `"low"`, `"medium"`, `"high"`) |
| `maxDepth` | `number` | How many more delegation levels this flow may spawn |
| `inheritContext` | `boolean` | Whether to fork parent session snapshot (`true`) or start clean (`false`) |
| `tier` | `string` | Explicit tier override: `lite`, `flash`, or `full` |

---

## Structured Output

When `structuredOutput` is enabled (default), flows are instructed to append a JSON code block to their final response. The block is mechanically validated and enriched:

- **Bash commands** are replaced with the exact verbatim strings from the actual tool calls, fixing the common LLM behaviour of paraphrasing `curl -s -X POST …` as `"curl GAWA baseline"`.
- **Execution time** is captured from the timed-bash wrapper and attached to each bash command entry.

Schema:

```json
{
  "version": "1.0",
  "status": "complete",
  "summary": "2-3 sentence summary",
  "files": [
    { "path": "relative/path", "role": "read", "description": "why it matters", "snippet": "short excerpt", "ranges": [{ "start": 10, "end": 25, "label": "bug" }] }
  ],
  "actions": [
    { "type": "read", "description": "what was done", "target": "file.ts", "result": "success", "evidence": "output or proof" }
  ],
  "commands": [
    { "command": "curl -s -X POST https://api.example.com/v1/data", "tool": "bash", "executionTime": "1.2s (normal)" }
  ],
  "notDone": [
    { "item": "unfinished work", "reason": "why it was not completed", "blocker": "blocking issue", "nextStep": "specific follow-up" }
  ],
  "nextSteps": ["recommended follow-up action"],
  "reasoning": ["key hypothesis or inference"],
  "notes": ["observation or warning"]
}
```

Only include fields that have data. Omit empty arrays; missing array fields are acceptable.

---

## Post-Flow Advisory Messages

When certain flows complete, the system injects advisory messages suggesting follow-up flows. This keeps the agent on the optimal path without requiring the user to manually chain flows.

### Built-in transition matrix

| Source | Target | Condition | Advice |
|--------|--------|-----------|--------|
| `scout` | `build` | success | Context mapped. Consider running a [build] flow to implement changes, or [debug] if investigating an issue. |
| `scout` | `debug` | success | Context mapped. Consider running a [debug] flow if investigating an issue. |
| `debug` | `build` | success | The root cause has been identified. Consider running a [build] flow to implement the fix. |
| `debug` | `audit` | success | Root cause identified. Consider running an [audit] flow to verify the fix area for related issues. |
| `build` | `audit` | success | Consider running an [audit] flow to audit the changes for security, correctness, and code quality. |
| `build` | `debug` | failure | Build failed. Consider running a [debug] flow to investigate the root cause. |
| `audit` | `scout` | success | Audit complete. Consider running a [scout] flow to trace the audit findings across the codebase. |
| `audit` | `build` | failure | Audit found issues. Consider running a [build] flow to fix them. |
| `craft` | `build` | success | Plan ready. Consider running a [build] flow to implement the design. |
| `ideas` | `craft` | success | Ideas explored. Consider running a [craft] flow to design the approach, or [build] to implement directly. |

Advisories are smart: if the agent already included the suggested flow in the same batch, the advisory is suppressed to avoid redundancy.

---

## Usage

### Single flow

```json
{ "flow": [{ "type": "scout", "intent": "Find all authentication-related code and trace JWT validation", "aim": "Find auth code and trace JWT" }] }
```

### Batch multiple flows

```json
{
  "flow": [
    { "type": "scout", "intent": "Find auth code", "aim": "Find auth code" },
    { "type": "audit", "intent": "Audit auth module", "aim": "Audit auth module" }
  ]
}
```

### Override working directory or confirm project flows

```json
{
  "flow": [
    { "type": "scout", "intent": "Map packages/ui", "aim": "Map UI package", "cwd": "packages/ui" }
  ]
}
```

Suppress the confirmation prompt before running project-local flows:

```json
{
  "flow": [
    { "type": "scout", "intent": "Map packages/ui", "aim": "Map UI package" }
  ],
  "confirmProjectFlows": false
}
```



---

## Tools

### `flow` — delegate to flow states

The core delegation tool. Accepts an array of flow tasks and runs them in parallel with bounded concurrency (default: 4, capped to CPU count).

### `batch` / `batch_read` — unified file operations

When **tool optimization** is enabled (default), the separate `read` / `write` / `edit` tools are replaced by:

- **`batch`** — sequential read, write, edit, and delete operations in one call. Edits use fuzzy matching and preserve line endings.
- **`batch_read`** — read-only variant for multiple reads. Small full-file reads return raw content; large full-file reads return code/infra context maps or total line counts, and oversized targeted reads are capped with continuation guidance.

### `web` — search and fetch

Built-in web operations (no API keys required):

- **Search** — queries Brave and DuckDuckGo HTML endpoints, returns top results with titles, URLs, and snippets.
- **Fetch** — downloads a page, converts HTML to Markdown via JSDOM + Turndown, saves to a temp file in the session directory, and returns a preview. Falls back through direct fetch → `r.jina.ai` → `curl`.

In the collapsed activity panel, web operations display as compact one-line summaries (e.g., `search: "query"` or `fetch: example.com`). Like other tools, web results are scramble-animated in the collapsed view.

---

## Configuration

### Flow model strategies

Use `flowModelConfigs` in your Pi settings to define tiered model strategies. Each tier (`lite`, `flash`, `full`) can specify a `primary` model and an optional `failover` array.

```json
{
  "flowModelConfig": "balance",
  "flowModelConfigs": {
    "performance": {
      "lite": { "primary": "github-copilot/gpt-5.4-mini", "failover": ["github-copilot/gpt-5.5"] },
      "flash": { "primary": "github-copilot/gpt-5.5" },
      "full": { "primary": "github-copilot/gpt-5.5" }
    },
    "balance": {
      "lite": { "primary": "github-copilot/gpt-5.4-mini" },
      "flash": { "primary": "github-copilot/gpt-5.5", "failover": ["github-copilot/gpt-5.4-mini"] },
      "full": { "primary": "github-copilot/gpt-5.5" }
    },
    "quality": {
      "lite": { "primary": "github-copilot/gpt-5.5" },
      "flash": { "primary": "github-copilot/gpt-5.5" },
      "full": { "primary": "github-copilot/gpt-5.5-large", "failover": ["github-copilot/gpt-5.5"] }
    }
  }
}
```

- `performance` — favors speed and lower-cost models.
- `balance` — best default mix of quality and cost.
- `quality` — prefers the strongest models first.

Settings are merged: project `.pi/settings.json` overrides global `~/.pi/agent/settings.json`.

### Persistent flow mode switch

Switch the global active strategy quickly with `--flow-mode`:

```bash
pi --flow-mode balance
pi --flow-mode quality
```

`--flow-mode` updates `flowModelConfig` in global `~/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json`) and applies the mode immediately for the current invocation. The mode must already exist in the merged `flowModelConfigs`; project `.pi/settings.json` can still override global settings on later no-flag runs.

On startup, the selected mode is printed in a compact notification:

```
mode: balance | lite: gpt-5.4-mini · flash: gpt-5.5 · full: gpt-5.5
```

Failover-only tiers are shown as `failover: model-a, model-b`. Verbose mode includes the flow names associated with each tier.

### Flow settings

You can also set flow runtime defaults under `flowSettings`:

```json
{
  "flowSettings": {
    "sessionMode": "default",
    "maxConcurrency": 4,
    "toolOptimize": true,
    "structuredOutput": true,
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `sessionMode` | `default` | Default child-flow session mode: `fast`, `default`, `long`, or `extreme_long` |
| `maxConcurrency` | `4` | Maximum parallel flows (capped to CPU count) |
| `toolOptimize` | `true` | Use unified `batch`/`batch_read` instead of separate read/write/edit |
| `structuredOutput` | `true` | Inject JSON structured-output instructions into flow prompts |

Session mode precedence is:

```txt
per-flow sessionMode > --flow-session-mode > PI_FLOW_SESSION_MODE > flowSettings.sessionMode > default
```

### Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--flow-max-depth [n]` | Maximum delegation depth | `3` |
| `--flow-prevent-cycles` | Block cyclic delegation | `true` |
| `--no-flow-prevent-cycles` | Disable cycle prevention | — |
| `--flow-model-config [name]` | Select a named model strategy for this invocation | `balance` |
| `--flow-mode [name]` | Persistently switch the global model strategy and apply it immediately | — |
| `--flow-lite-model [model]` | Override the lite-tier model | — |
| `--flow-flash-model [model]` | Override the flash-tier model | — |
| `--flow-full-model [model]` | Override the full-tier model | — |
| `--flow-session-mode [mode]` | Default child-flow session mode | `default` |
| `--flow-max-concurrency [n]` | Maximum parallel flows | `4` |
| `--tool-optimize` | Use unified `batch`/`batch_read` | `true` |

### Environment variables

| Variable | Description |
|----------|-------------|
| `PI_FLOW_DEPTH` | Current delegation depth |
| `PI_FLOW_MAX_DEPTH` | Max allowed depth |
| `PI_FLOW_STACK` | JSON array of ancestor flow names |
| `PI_FLOW_PREVENT_CYCLES` | `"1"` or `"0"` |
| `PI_FLOW_TOOL_OPTIMIZE` | `"1"` or `"0"` (overrides default tool optimization) |
| `PI_FLOW_SESSION_MODE` | Default child-flow session mode: `fast`, `default`, `long`, or `extreme_long` |
| `PI_FLOW_MAX_CONCURRENCY` | Maximum parallel flows |
| `PI_FLOW_SPAWN_COMMAND` | Override the spawn command for exotic runtime environments (e.g. bundled with pkg/nexe) |

### Notifications

Terminal and desktop notifications fire when the agent finishes a turn and is waiting for you. They adapt dynamically: if a flow completed, the title shows the flow name and acceptance summary; if `ask_user` is pending, the title changes to "Decision Required".

Configure notifications with global `~/.pi/agent/extensions/notify.json` or project `.pi/notify.json`. Project settings override global.

```json
{
  "enabled": true,
  "onlyWhenInteractive": true,
  "title": "π",
  "body": "task accomplished!",
  "channels": {
    "terminal": true,
    "desktop": true,
    "bell": true,
    "sound": false
  },
  "terminal": { "backend": "auto" },
  "desktop": { "backend": "auto" },
  "sound": {
    "backend": "auto",
    "name": "Glass",
    "linuxSoundId": "complete",
    "frequencyHz": 1000,
    "durationMs": 250,
    "command": ""
  }
}
```

| Key | Description |
|-----|-------------|
| `enabled` | Master switch for notifications |
| `onlyWhenInteractive` | Only notify when a UI is attached |
| `channels.terminal` | OSC 777/99 terminal notifications |
| `channels.desktop` | OS native notifications (macOS, Linux, Windows) |
| `channels.bell` | Terminal bell |
| `channels.sound` | System beep or custom sound |

**Backends**

| Channel | Backends |
|---------|----------|
| Terminal | `auto` (detect OSC support), `osc777`, `osc99`, `none` |
| Desktop | `auto` (detect OS), `macos`, `linux`, `windows-toast`, `none` |
| Sound | `auto`, `macos`, `linux`, `windows-beep`, `command`, `none` |

When the terminal channel is active and the emulator supports visual OSC notifications (e.g. Warp, iTerm2, kitty), the auto-detected desktop channel is skipped to avoid duplicates.

---

## Local Development

To test local changes with the `pi` CLI before publishing:

```shell
# From the pi-agent-flow repo directory
npm link
```

This creates a global symlink. The `pi` CLI loads the package via `"npm:pi-agent-flow"` in `~/.pi/agent/settings.json`, so changes are picked up immediately — restart `pi` after editing.

To restore the published version:

```shell
npm uninstall -g pi-agent-flow
npm install -g pi-agent-flow
```

---

## Docs

- [**Pi Documentation**](https://pi.dev)
- [**License**](./LICENSE)

This repository is licensed under the [MIT License](LICENSE).
