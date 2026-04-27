<p align="center"><code>pi install /path/to/pi-agent-flow</code></p>
<p align="center"><strong>Pi Agent Flow</strong> is a flow-state delegation extension for the <a href="https://pi.dev">Pi coding agent</a> that runs locally in your terminal.</p>
<p align="center">
  <img src="https://github.com/user-attachments/assets/pi-agent-flow-demo.png" alt="Pi Agent Flow demo" width="80%" />
</p>
<br/>

---

## Quickstart

### Installing Pi Agent Flow

Install via the Pi CLI with your local path:

```shell
# Install from a local path
pi install /path/to/pi-agent-flow
```

Or add it to your Pi settings:

```shell
# ~/.pi/agent/settings.json
{
  "packages": [
    "./path/to/pi-agent-flow"
  ]
}
```

Then start Pi and delegate tasks using flow states.

<details>
<summary>You can also clone this repository and use it directly.</summary>

```shell
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

---

## Flow Definitions

Create `.md` files in `~/.pi/agent/agents/` or `.pi/agents/`:

```markdown
---
name: explore
description: Discover files, trace code paths, map architecture
tools: read, bash
---

You are the explore flow — your mission is discovery. Stay focused on your intent at all times.

When your mission is accomplished, end your response with:

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

## Usage

### Single flow

```json
{ "flow": [{ "type": "explore", "intent": "Find all authentication-related code" }] }
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

### Flags (passed to parent pi process)

| Flag | Description | Default |
|------|-------------|---------|
| `--flow-max-depth [n]` | Maximum delegation depth | `3` |
| `--flow-prevent-cycles` | Block cyclic delegation | `true` |
| `--no-flow-prevent-cycles` | Disable cycle prevention | — |

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
- [**Contributing**](./docs/contributing.md) *(if available)*
- [**License**](./LICENSE)

This repository is licensed under the [MIT License](LICENSE).
