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

- **Isolated context** — flows always receive your current session snapshot (or start clean when configured)
- **Parallel execution** — batch independent flows into one call
- **Structured reports** — every flow returns `[Summary]`, `[Done]`, `[Not Done]`, `[Next Steps]`
- **Depth guards** — configurable max delegation depth (default: `3`)
- **Cycle prevention** — blocks recursive delegation chains
- **Flow discovery** — reads definitions from `~/.pi/agent/agents/` and `.pi/agents/`
- **TUI rendering** — rich collapsed/expanded display in interactive mode
- **Post-flow hooks** — automatic advisory messages after successful flows (e.g., code → review)
- **Smooth streaming metrics** — context token counters increment tick-by-tick during active streaming instead of jumping at boundaries

---

## Why Flow Style?

Flow-style delegation is designed for **context efficiency**. Instead of launching every sub-agent with the full, ever-growing conversation history, each flow receives only what it needs: your intent and (when appropriate) a session snapshot.

This approach delivers four concrete benefits:

1. **Avoid duplicate tool calls** — every sub-agent launch no longer re-runs the same `read`, `grep`, or `bash` probes that the parent already performed.
2. **Prevent context bloat** — long transcripts with repeated file listings and command outputs are kept out of the main conversation thread.
3. **Eliminate unnecessary noise** — the parent agent sees only structured results (`[Summary]`, `[Done]`, `[Not Done]`, `[Next Steps]`) instead of pages of intermediate reasoning.
4. **Preserve focus** — each flow stays locked on its intent because it isn't distracted by unrelated earlier messages.

The result is faster, cheaper, and cleaner delegation: the main agent remains uncluttered while specialized flows do the heavy lifting in isolated contexts.

---

## Flow Definitions

Create `.md` files in `~/.pi/agent/agents/` or `.pi/agents/`:

```markdown
---
name: explore
description: Discover files, trace code paths, map architecture
tools: batch, bash
---

During this explore flow — your mission is discovery. Stay focused on your intent at all times.

When accomplished, end your response with:

flow [explore] accomplished

[Summary] what was investigated

[Done]
- completed items

[Not Done]
- incomplete items

[Next Steps]
- recommended follow-up
```

---

## Bundled Flows

| Flow | Purpose |
|------|---------|
| `[explore]` | Discover files, trace code paths, map architecture |
| `[debug]` | Investigate logs, errors, stack traces, root causes |
| `[code]` | Implement features, fix bugs, write tests |
| `[architect]` | Plan structure, break down requirements, design solutions |
| `[review]` | Audit security, quality, correctness |
| `[brainstorm]` | Generate ideas and explore possibilities with a clean slate |

> **Note:** Some flows — like `[brainstorm]` — start with a **clean slate** and do not inherit the current session context. They receive only the intent, making them ideal for unbiased, creative thinking.

---

## Post-Flow Hooks

When certain flows complete successfully, the system can inject advisory messages suggesting follow-up flows. This keeps the agent on the optimal path without requiring the user to manually chain flows.

### Built-in Hooks

| Hook | Trigger | Advice |
|------|---------|--------|
| `code → review` | A `[code]` flow succeeds | *"Consider running a [review] flow to audit the changes…"* |
| `debug → code` | A `[debug]` flow succeeds | *"The root cause has been identified. Consider running a [code] flow to implement the fix."* |

Hooks are smart: if the agent already included the suggested flow in the same batch, the advisory is suppressed to avoid redundancy.

### Extending

Hooks are registered via `registerHook()` in `hooks.ts`. Each hook defines a trigger (flow type + success requirement) and an action that returns advisory text. The hook system mirrors the flow discovery pattern, making it easy to add domain-specific hints.

Example — a custom `explore → architect` hook:

```ts
registerHook({
  name: "my/explore-to-architect",
  trigger: { flowTypes: ["explore"], onlyOnSuccess: true },
  action: (ctx) => ({
    content: "Consider running an [architect] flow to design a solution.",
    priority: 10,
  }),
});
```

---

## Usage

### Single flow

```json
{ "flow": [{ "type": "explore", "intent": "Find all authentication-related code", "aim": "Find auth code" }] }
```

### Batch multiple flows

```json
{
  "flow": [
    { "type": "explore", "intent": "Find auth code" },
    { "type": "review", "intent": "Audit auth module" }
  ]
}
```

---

## Configuration

### Flow model strategies

Use `flowModelConfigs` in your Pi settings to select different model strategies by name.

```shell
# ~/.pi/agent/settings.json
{
  "flowModelConfig": "balance",
  "flowModelConfigs": {
    "performance": {
      "lite": {
        "primary": "github-copilot/gpt-5.4-mini",
        "failover": ["github-copilot/gpt-5.5"]
      },
      "flash": {
        "primary": "github-copilot/gpt-5.5"
      },
      "full": {
        "primary": "github-copilot/gpt-5.5"
      }
    },
    "balance": {
      "lite": {
        "primary": "github-copilot/gpt-5.4-mini"
      },
      "flash": {
        "primary": "github-copilot/gpt-5.5",
        "failover": ["github-copilot/gpt-5.4-mini"]
      },
      "full": {
        "primary": "github-copilot/gpt-5.5"
      }
    },
    "quality": {
      "lite": {
        "primary": "github-copilot/gpt-5.5"
      },
      "flash": {
        "primary": "github-copilot/gpt-5.5"
      },
      "full": {
        "primary": "github-copilot/gpt-5.5-large",
        "failover": ["github-copilot/gpt-5.5"]
      }
    }
  }
}
```

- `performance` favors speed and lower-cost models.
- `balance` aims for the best default mix of quality and cost.
- `quality` prefers the strongest models first.

### Flags (passed to parent pi process)

| Flag | Description | Default |
|------|-------------|---------|
| `--flow-max-depth [n]` | Maximum delegation depth | `3` |
| `--flow-prevent-cycles` | Block cyclic delegation | `true` |
| `--no-flow-prevent-cycles` | Disable cycle prevention | — |
| `--flow-model-config [name]` | Select a named model strategy from `flowModelConfigs` | `balance` |
| `--flow-lite-model [model]` | Override the lite-tier model for child flows | — |
| `--flow-flash-model [model]` | Override the flash-tier model for child flows | — |
| `--flow-full-model [model]` | Override the full-tier model for child flows | — |

### Environment variables (propagated to child processes)

| Variable | Description |
|----------|-------------|
| `PI_FLOW_DEPTH` | Current depth |
| `PI_FLOW_MAX_DEPTH` | Max allowed depth |
| `PI_FLOW_STACK` | JSON array of ancestor flow names |
| `PI_FLOW_PREVENT_CYCLES` | `"1"` or `"0"` |

---

## Docs

- [**Pi Documentation**](https://pi.dev)
- [**License**](./LICENSE)

This repository is licensed under the [MIT License](LICENSE).
