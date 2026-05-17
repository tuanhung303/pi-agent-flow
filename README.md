# Pi Agent Flow

<p align="center">
  <a href="https://www.npmjs.com/package/pi-agent-flow"><img src="https://img.shields.io/npm/v/pi-agent-flow" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/pi-agent-flow" alt="license"></a>
</p>

<p align="center"><code>pi install npm:pi-agent-flow</code></p>

<p align="center"><strong>Flow-state transition</strong> for the <a href="https://pi.dev">Pi coding agent</a>. Isolate context, run specialist agents in parallel, and get structured results back.</p>

---

## Why This Exists

Long conversations bloat context, duplicate tool calls, and bury signal in noise. Pi Agent Flow solves this by forking each task into an isolated child process with only the context it needs. The parent stays clean; the workers stay focused.

Four concrete benefits:

1. **Avoid duplicate tool calls** — flow states no longer re-run the same `read`, `grep`, or `bash` probes the parent already performed.
2. **Prevent context bloat** — long transcripts with repeated file listings stay out of the main conversation thread.
3. **Eliminate unnecessary noise** — the parent sees only structured results instead of pages of intermediate reasoning.
4. **Preserve focus** — each flow stays locked on its intent because it isn't distracted by unrelated earlier messages.

## Quick Demo

```shell
# 1) Install the extension
pi install npm:pi-agent-flow

# 2) Start Pi and transition two tasks in parallel
pi
{ "flow": [
  { "type": "scout", "intent": "Map auth code", "aim": "Find JWT logic" },
  { "type": "audit", "intent": "Audit auth module", "aim": "Security audit" }
] }
```

The root state spawns both flows concurrently. Each receives a sanitized fork of your session, runs in isolation, and returns structured JSON with a summary, files touched, and recommended next steps.

## Quickstart

Install via the Pi CLI:

```shell
pi install npm:pi-agent-flow
```

Or add it to your Pi settings:

```json
// ~/.pi/agent/settings.json
{ "packages": ["npm:pi-agent-flow"] }
```

Restart Pi and transition tasks using `{ "flow": [...] }`.

<details>
<summary>Install from a local clone</summary>

```shell
git clone https://github.com/tuanhung303/pi-agent-flow.git
cd pi-agent-flow
pi install .
```

</details>

## Core Concepts

| Concept | What it means |
|---|---|
| **Root state** | The main Pi agent that routes tasks and talks to you |
| **Flows** | Isolated specialist workers (`scout`, `build`, `debug`, `audit`, `craft`, `ideas`) |
| **Forked context** | Child processes receive a sanitized snapshot of your session |
| **Structured results** | Every flow returns JSON with summary, files, actions, next steps |
| **Parallel execution** | Batch independent flows with bounded concurrency |
| **Clean slate** | Optional mode where a flow receives only your intent, no inherited history |

When you transition, the root state spawns each flow as an isolated `pi` child process, injects your intent, and waits for structured output. The parent conversation stays lean because it only receives the final result, not the full reasoning transcript.

## Features

### Transition
- Six bundled specialist flows with tiered model selection (`lite` / `flash` / `full`)
- Configurable max transition depth (default: `3`) and automatic cycle prevention
- Smart post-flow advisories suggesting the optimal next step (e.g. `scout` → `build`, `debug` → `audit`)

### Isolation
- Sanitized session snapshots forked to each child; steering hints and reasoning artifacts are stripped
- Optional clean-slate mode (`inheritContext: false`) for unbiased creative work
- Child flows see a `<context-seal>` telling them the parent's history is sealed reference only

### Execution
- Parallel flow batches with bounded concurrency (default: 4, capped to CPU count)
- Five session modes from `snap` (90s) to `extreme_long` (1200s)
- Graceful shutdown with two-stage timeout warnings, live `MM:SS` countdowns, and a 90-second reporting grace

### Tools
- Unified `batch` / `batch_read` for cross-cutting file work (read, write, edit, delete in one call)
- Built-in `web` search (Brave + DuckDuckGo) and fetch with HTML→Markdown conversion
- `ask_user` interactive prompts for root state decision-gathering; flows emit `⚠️ Decision Required` blocks instead

### Output
- Structured JSON results with `summary`, `files`, `actions`, `notDone`, `nextSteps`, `reasoning`, and `notes`
- Mechanically enriched bash commands with exact verbatim strings and execution times
- `extensions` escape hatch for flow-specific data (audit findings, debug root cause, etc.)

### Developer Experience
- Local development loop with `npm link` and `scripts/switch.sh` to toggle local ↔ published builds
- Payload dump workflow via `PI_FLOW_DUMP_SNAPSHOT` to inspect exact child prompts
- TUI-safe logging (`logWarn`/`logError` write to file instead of stderr), glitch scramble animations, and live countdowns

See [docs/FLOWS.md](docs/FLOWS.md), [docs/TOOLS.md](docs/TOOLS.md), and [docs/STRUCTURED-OUTPUT.md](docs/STRUCTURED-OUTPUT.md) for full details.

## Usage

### Single flow
```json
{ "flow": [{ "type": "scout", "intent": "Find auth code", "aim": "Find auth code" }] }
```

### Parallel flows
```json
{
  "flow": [
    { "type": "scout", "intent": "Map auth code", "aim": "Map auth" },
    { "type": "audit", "intent": "Audit auth module", "aim": "Audit auth" }
  ]
}
```

### Override working directory
```json
{
  "flow": [
    { "type": "scout", "intent": "Map packages/ui", "aim": "Map UI package", "cwd": "packages/ui" }
  ]
}
```

### End-to-end example
Chain discovery → audit → build to fix issues in one batch:

```json
{
  "flow": [
    { "type": "scout", "intent": "Map the auth module", "aim": "Map auth" },
    { "type": "audit", "intent": "Audit auth for security issues", "aim": "Audit auth" },
    { "type": "build", "intent": "Fix the issues found", "aim": "Fix auth issues", "acceptance": "All audit findings resolved" }
  ]
}
```

## Flow Loop & Warp

Set a multi-step objective and the system auto-spawns flows to advance it after each turn.

```bash
/flow:goal set "Refactor tests to vitest" --acceptance "All tests pass" --max-flows 5
/flow:goal status       # Check progress, budgets, and completed flows
/flow:goal pause        # Stop auto-continuation
/flow:goal resume       # Resume and immediately trigger the next flow
/flow:goal edit "Refactor tests to vitest + coverage"   # Update objective
/flow:goal complete     # Mark finished manually
/flow:goal clear        # Mark abandoned and move to history
```

- **Auto-continuation** — after each turn, the root state spawns the next flow until the goal is complete or budgets are exhausted
- **Idle wake-up** — after ~10 min of inactivity, the system nudges the root state to make safe, conservative progress
- **Warp** — `/flow:warp` distills conversation context into a transfer prompt (## Context + ## Task) and spawns a new session with the goal preserved

Goals persist in `.pi/flow.json`. Add `.pi/` to `.gitignore` — this is local runtime state.

See [docs/FLOWS.md](docs/FLOWS.md#flow-loop--warp) for details.

## Custom Flows

Create `.md` files in `~/.pi/agent/agents/` (user-level) or `.pi/agents/` (project-level):

```markdown
---
name: myflow
description: Short description
tools: batch, bash
maxDepth: 1
---

Your mission is ...
```

See [docs/CUSTOM-FLOWS.md](docs/CUSTOM-FLOWS.md) for front-matter options and examples.

## Configuration

Flow behavior is controlled via CLI flags, environment variables, and `.pi/settings.json`. Resolution priority: **CLI flag > env var > settings.json > default**.

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full reference (model strategies, flags, env vars, and slash commands).

## Local Development

Link the local checkout for instant iteration:

```shell
./scripts/switch.sh       # Link local checkout (or `npm run switch:local`)
npm run build             # Compile TypeScript → dist/
# Quit pi and restart it to pick up the new dist/ via the symlink
```

Toggle back to the published version anytime with `./scripts/switch.sh`.

> ⚠️ Never run `pi update` while linked locally — it overwrites the symlink.

## Contributing

PRs welcome. Please run `npm run lint` and `npm test` before submitting.

## License

[MIT](./LICENSE)
