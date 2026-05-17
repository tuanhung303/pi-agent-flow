# Custom Flows

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

## Front-matter options

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Flow identifier (lowercase, required) |
| `description` | `string` | Short summary (required) |
| `tools` | `string \| string[]` | Tools available to this flow |
| `model` | `string` | Override the model for this flow |
| `thinking` | `string` | Thinking budget (e.g., `"low"`, `"medium"`, `"high"`) |
| `maxDepth` | `number` | How many more transition levels this flow may spawn |
| `inheritContext` | `boolean` | Whether to fork parent session snapshot (`true`) or start clean (`false`) |
| `tier` | `string` | Explicit tier override: `lite`, `flash`, or `full` |

> **Clean slate:** Set `inheritContext: false` so the flow receives only the intent, ideal for unbiased creative work.

## Project flow confirmation

Project-local flows from `.pi/agents/` prompt for confirmation before running for security. Suppress this with `confirmProjectFlows: false` in the `flow` tool call.
