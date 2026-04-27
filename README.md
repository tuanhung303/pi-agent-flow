# pi-agent-flow

Flow-state delegation extension for [Pi coding agent](https://pi.dev).

Delegates tasks to specialized flow states running as isolated pi processes. Each flow receives a snapshot of the current session context and returns a structured report.

## Features

- Isolated context — flows always receive your current session snapshot
- Parallel execution — batch independent flows into one call
- Structured reports — every flow returns [Summary], [Done], [Not Done], [Next Steps]
- Depth guards — configurable max delegation depth (default: 3)
- Cycle prevention — blocks recursive delegation chains
- Flow discovery — reads definitions from ~/.pi/agent/agents/ and .pi/agents/
- TUI rendering — rich collapsed/expanded display in interactive mode

## Installation

```bash
pi install /path/to/pi-agent-flow
```

Or add to ~/.pi/agent/settings.json:

```json
{
  "packages": [
    "./path/to/pi-agent-flow"
  ]
}
```

## Flow Definitions

Create .md files in ~/.pi/agent/agents/ or .pi/agents/:

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

## Bundled Flows

- [explore] — discover files, trace code paths, map architecture
- [debug] — investigate logs, errors, stack traces, root causes
- [code] — implement features, fix bugs, write tests
- [architect] — plan structure, break down requirements, design solutions
- [review] — audit security, quality, correctness

## Usage

```json
{ "flow": [{ "type": "explore", "intent": "Find all authentication-related code" }] }
```

Batch multiple flows:

```json
{
  "flow": [
    { "type": "explore", "intent": "Find auth code" },
    { "type": "review", "intent": "Audit auth module" }
  ]
}
```

## Configuration

Flags (passed to parent pi process):

- --flow-max-depth [n] — Maximum delegation depth (default: 3)
- --flow-prevent-cycles — Block cyclic delegation (default: true)
- --no-flow-prevent-cycles — Disable cycle prevention

Environment variables (propagated to child processes):

- PI_FLOW_DEPTH — Current depth
- PI_FLOW_MAX_DEPTH — Max allowed depth
- PI_FLOW_STACK — JSON array of ancestor flow names
- PI_FLOW_PREVENT_CYCLES — "1" or "0"

## License

MIT
