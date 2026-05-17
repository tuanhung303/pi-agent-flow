# Structured Output

When `structuredOutput` is enabled (default), flows are instructed to append a JSON code block to their final response. The block is mechanically validated and enriched:

- **Bash commands** are replaced with the exact verbatim strings from the actual tool calls, fixing the common LLM behaviour of paraphrasing `curl -s -X POST …` as `"curl GAWA baseline"`.
- **Execution time** is captured from the timed-bash wrapper and attached to each bash command entry.

## Schema

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
  "notes": ["observation or warning"],
  "extensions": { "auditFindings": [...], "debugRootCause": "..." }
}
```

Only include fields that have data. Omit empty arrays; missing array fields are acceptable.

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `version` | `string` | Schema version for forward compatibility |
| `status` | `"complete" \| "partial" \| "blocked" \| "failed"` | Overall completion status |
| `summary` | `string` | 1–3 sentence summary of what was accomplished |
| `files` | `FileEntry[]` | Files touched, read, or referenced |
| `actions` | `Action[]` | Actions performed or attempted |
| `commands` | `CommandEntry[]` | Commands or tool calls executed during the flow |
| `notDone` | `NotDoneItem[]` | Incomplete, skipped, blocked, or deferred work |
| `nextSteps` | `string[]` | Recommended next steps or follow-up flows |
| `reasoning` | `string[]` | Reasoning chains, hypotheses, inferences made during the flow |
| `notes` | `string[]` | Observations, warnings, caveats, side notes |
| `extensions` | `Record<string, unknown>` | Escape hatch for flow-specific data (audit findings, debug root cause, etc.) |

### FileEntry

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | Path to the file, relative or absolute |
| `role` | `"reference" \| "read" \| "modified" \| "created" \| "deleted" \| "test"` | Semantic role of this file in the flow's work |
| `description` | `string` | Why this file matters (1 sentence) |
| `snippet` | `string` | Short excerpt or snippet (not full content) |
| `ranges` | `Array<{start: number, end: number, label?: string}>` | Specific line ranges of interest |

### CommandEntry

| Field | Type | Description |
|-------|------|-------------|
| `command` | `string` | The exact verbatim command string or tool call that was executed |
| `tool` | `string` | Tool used: `bash`, `grep`, `find`, `ls`, `batch`, `read`, `write`, `edit`, `flow`, `web` |
| `executionTime` | `string` | Execution time classification from the timed bash wrapper (e.g. `"3.5s (normal)"`) |

### Action

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Action type |
| `description` | `string` | What was done |
| `target` | `string` | File or entity affected |
| `result` | `"success" \| "failure" \| "partial" \| "skipped"` | Outcome |
| `evidence` | `string` | Output or proof |

### NotDoneItem

| Field | Type | Description |
|-------|------|-------------|
| `item` | `string` | The unfinished item |
| `reason` | `string` | Why the item was not completed |
| `blocker` | `string` | Concrete blocker preventing completion, when applicable |
| `nextStep` | `string` | Suggested follow-up for this item |
