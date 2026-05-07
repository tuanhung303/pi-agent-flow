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
git clone https://github.com/your-org/pi-agent-flow.git
cd pi-agent-flow
pi install .
```

</details>

---

## Features

- **Flow-state delegation** — six bundled specialist flows (`scout`, `debug`, `build`, `craft`, `audit`, `ideas`) plus custom flows via Markdown front-matter
- **Isolated forked context** — each flow runs as an isolated `pi` child process with a session snapshot (or clean slate when configured)
- **Parallel execution** — batch independent flows into one call with bounded concurrency
- **Structured reports** — every flow returns `[Summary]`, `[Done]`, `[Not Done]`, `[Next Steps]`
- **Depth guards** — configurable max delegation depth (default: `3`)
- **Session timeout modes** — child flows use controlled budgets: `fast` (300s), `default` (600s), or `long` (900s)
- **Cycle prevention** — blocks re-entering flows already in the ancestor stack
- **Model tiering & failover** — flows map to `lite` / `flash` / `full` tiers with primary + failover model chains
- **Unified batch tools** — `batch` (read/write/edit/delete) and `batch_read` replace separate file tools for cross-cutting work
- **Web tool** — built-in `web` search (Brave + DuckDuckGo) and page fetch with HTML→Markdown conversion
- **Sliding system prompt** — lightweight routing reminder injected before each user message, stripped from child snapshots to avoid duplication
- **Session snapshot sanitization** — removes sliding prompts, reasoning/thinking artifacts, and non-inheritable content before forking
- **Project flow confirmation** — prompts before running project-local flows from `.pi/agents/` for security
- **Post-flow hooks** — automatic advisory messages suggesting follow-up flows (e.g., `build → audit`)
- **Rich TUI rendering** — collapsed activity-panel view with per-flow stats, plus expanded view with full reports and tool traces
- **Smooth streaming metrics** — token counters and smoothed TPS increment tick-by-tick during active streaming

---

## Why Flow Style?

Flow-style delegation is designed for **context efficiency**. Instead of launching every sub-agent with the full, ever-growing conversation history, each flow receives only what it needs: your intent and (when appropriate) a sanitized session snapshot.

This approach delivers four concrete benefits:

1. **Avoid duplicate tool calls** — every sub-agent launch no longer re-runs the same `read`, `grep`, or `bash` probes that the parent already performed.
2. **Prevent context bloat** — long transcripts with repeated file listings and command outputs are kept out of the main conversation thread.
3. **Eliminate unnecessary noise** — the parent agent sees only structured results (`[Summary]`, `[Done]`, `[Not Done]`, `[Next Steps]`) instead of pages of intermediate reasoning.
4. **Preserve focus** — each flow stays locked on its intent because it isn't distracted by unrelated earlier messages.

The result is faster, cheaper, and cleaner delegation: the main agent remains uncluttered while specialized flows do the heavy lifting in isolated contexts.

---

## Bundled Flows

| Flow | Purpose | Tools | Tier |
|------|---------|-------|------|
| `[scout]` | Discover files, trace code paths, map architecture | `batch`, `bash`, `find`, `grep`, `ls` | `lite` |
| `[debug]` | Investigate logs, errors, stack traces, root causes | `batch`, `bash`, `find`, `grep`, `ls` | `lite` |
| `[build]` | Implement features, fix bugs, write tests, ship | `batch`, `bash`, `find`, `grep`, `ls` | `flash` |
| `[craft]` | Plan structure, break down requirements, design solutions | `batch`, `bash`, `find`, `grep`, `ls` | `full` |
| `[audit]` | Audit security, quality, correctness; fix issues autonomously | `batch`, `bash`, `find`, `grep`, `ls` | `flash` |
| `[ideas]` | Generate ideas and explore possibilities with inherited context | `batch`, `bash` | `full` |

> **Note:** All bundled flows have `maxDepth: 0`, meaning they do not delegate further by default. Custom flows can override this via front-matter.

> **Clean slate:** Set `inheritContext: false` in a custom flow's front-matter so it receives only the intent, ideal for unbiased creative work.

### Session modes

Each flow call may set `sessionMode` to choose the child-agent time budget:

| Mode | Budget | Recommended use |
|------|-------:|-----------------|
| `fast` | 300s | quick scouting, narrow checks, small design passes |
| `default` | 600s | normal flow work; this is the default |
| `long` | 900s | large builds, full test runs, broad refactors, complex debugging |

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

---

## Post-Flow Hooks

When certain flows complete successfully, the system injects advisory messages suggesting follow-up flows. This keeps the agent on the optimal path without requiring the user to manually chain flows.

### Built-in Hooks

| Hook | Trigger | Advice |
|------|---------|--------|
| `build → audit` | A `[build]` flow succeeds | *"Consider running an [audit] flow to audit the changes…"* |
| `debug → build` | A `[debug]` flow succeeds | *"The root cause has been identified. Consider running a [build] flow to implement the fix."* |
| `audit → scout` | An `[audit]` flow succeeds | *"Audit complete. Consider running a [scout] flow to trace the audit findings across the codebase."* |

Hooks are smart: if the agent already included the suggested flow in the same batch, the advisory is suppressed to avoid redundancy.

### Extending

Hooks are registered via `registerHook()` in `hooks.ts`. Each hook defines a trigger (flow type + success requirement) and an action that returns advisory text.

Example — a custom `scout → craft` hook:

```ts
registerHook({
  name: "my/scout-to-craft",
  trigger: { flowTypes: ["scout"], onlyOnSuccess: true },
  action: (ctx) => ({
    content: "Consider running a [craft] flow to design a solution.",
    priority: 10,
  }),
});
```

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

### Override working directory for a flow

```json
{
  "flow": [
    { "type": "scout", "intent": "Map packages/ui", "aim": "Map UI package", "cwd": "packages/ui" }
  ]
}
```

---

## Tools

### `flow` — delegate to flow states

The core delegation tool. Accepts an array of flow tasks and runs them in parallel.

### `batch` / `batch_read` — unified file operations

When **tool optimization** is enabled (default), the separate `read` / `write` / `edit` tools are replaced by:

- **`batch`** — sequential read, write, edit, and delete operations in one call. Edits use fuzzy matching and preserve line endings.
- **`batch_read`** — read-only variant for multiple reads. Small full-file reads return raw content; large full-file reads return code/infra context maps or total line counts, and oversized targeted reads are capped with continuation guidance.

### `web` — search and fetch

Built-in web operations (no API keys required):

- **Search** — queries Brave and DuckDuckGo HTML endpoints, returns top results with titles, URLs, and snippets.
- **Fetch** — downloads a page, converts HTML to Markdown via JSDOM + Turndown, saves to a temp file in the session directory, and returns a preview. Falls back through direct fetch → `r.jina.ai` → `curl`.

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

Switch the global active strategy quickly with `--flow-mode`:

```bash
pi --flow-mode balance
pi --flow-mode quality
pi --flow-mode mimo
```

`--flow-mode` updates `flowModelConfig` in global `~/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json`) and applies the mode immediately for the current invocation. The mode must already exist in the merged `flowModelConfigs`; project `.pi/settings.json` can still override global settings on later no-flag runs.

You can also set flow runtime defaults under `flowSettings`:

```json
{
  "flowSettings": {
    "sessionMode": "default",
    "maxConcurrency": 4,
    "toolOptimize": true,
    "structuredOutput": true,
    "autoTransition": false
  }
}
```

`flowSettings.sessionMode` accepts `fast`, `default`, or `long`. Session mode precedence is:

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
| `--flow-session-mode [mode]` | Default child-flow session mode: `fast`, `default`, or `long` | `default` |
| `--tool-optimize` | Use unified `batch`/`batch_read` instead of separate read/write/edit | `true` |
| `--no-tool-optimize` | Disable tool optimization; use legacy read/write/edit tools | — |

### Environment variables

| Variable | Description |
|----------|-------------|
| `PI_FLOW_DEPTH` | Current delegation depth |
| `PI_FLOW_MAX_DEPTH` | Max allowed depth |
| `PI_FLOW_STACK` | JSON array of ancestor flow names |
| `PI_FLOW_PREVENT_CYCLES` | `"1"` or `"0"` |
| `PI_FLOW_TOOL_OPTIMIZE` | `"1"` or `"0"` (overrides default tool optimization) |
| `PI_FLOW_SESSION_MODE` | Default child-flow session mode: `fast`, `default`, or `long` |

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
