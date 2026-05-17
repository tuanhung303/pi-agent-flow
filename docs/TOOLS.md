# Tools Reference

## `flow` — transition to flow states

The core transition tool. Accepts an array of flow tasks and runs them in parallel with bounded concurrency (default: 4, capped to CPU count).

Each flow item accepts:

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Flow name (`scout`, `build`, `debug`, `audit`, `craft`, `ideas`, or custom) |
| `intent` | `string` | What the flow should do |
| `aim` | `string` | Short headline of what the flow aims to do |
| `acceptance` | `string` | One-sentence success criteria |
| `sessionMode` | `string` | Override session mode for this flow (`snap`, `fast`, `default`, `long`, `extreme_long`) |
| `cwd` | `string` | Override working directory |

Example:

```json
{
  "flow": [
    { "type": "scout", "intent": "Find all authentication-related code and trace JWT validation", "aim": "Find auth code and trace JWT", "acceptance": "All auth files identified with JWT flow traced" }
  ]
}
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

## `batch` / `batch_read` — unified file operations

When **tool optimization** is enabled (default), the separate `read` / `write` / `edit` tools are replaced by:

- **`batch`** — sequential read, write, edit, and delete operations in one call. Edits use fuzzy matching and preserve line endings.
- **`batch_read`** — read-only variant for multiple reads. Small full-file reads return raw content; large full-file reads return code/infra context maps or total line counts, and oversized targeted reads are capped with continuation guidance.

## `batch_bash_poll` — poll pending bash commands

For child flows using the `batch` tool, `batch_bash_poll` lets the agent check on pending bash operations that exceeded the soft timeout. Pass the operation IDs from the pending results to retrieve completed output or see updated partial output.

## `web` — search and fetch

Built-in web operations (no API keys required):

- **Search** — queries Brave and DuckDuckGo HTML endpoints, returns top results with titles, URLs, and snippets.
- **Fetch** — downloads a page, converts HTML to Markdown via JSDOM + Turndown, saves to a temp file in the session directory, and returns a preview. Falls back through direct fetch → `r.jina.ai` → `curl`.

In the collapsed activity panel, web operations display as compact one-line summaries (e.g., `search: "query"` or `fetch: example.com`). Like other tools, web results are scramble-animated in the collapsed view.

## `ask_user` — interactive prompts

Ask the user a focused question with optional multiple-choice answers. Use this to gather information interactively. Ask exactly one focused question per call. When presenting options, mark your recommended choice with `[preferred]` and place it first.

### Tool parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `question` | `string` | The question to ask the user |
| `options` | `array` | Optional list of choices. Each option is an object with `title` (short label) and `description` (longer explanation). |

Example:

```json
{
  "question": "Which database should we use?",
  "options": [
    { "title": "PostgreSQL", "description": "Robust relational database with great TypeScript support" },
    { "title": "SQLite", "description": "Simple file-based database, good for small projects" }
  ]
}
```

> **Note:** The `ask_user` tool only accepts `question` and `options`. Timeout and UI behavior are controlled via flow settings (`/flow:settings ask-user timeout <seconds>` or `PI_ASK_USER_TIMEOUT`). If user input is needed inside a flow, the flow emits a `⚠️ Decision Required` block for the root state to present. Only the root state talks to the user; bundled flows do not have `ask_user`.
