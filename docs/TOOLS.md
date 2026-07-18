# Tools Reference

## `flow` — transition to flow states

The core transition tool. Accepts an array of flow tasks and runs them in parallel with bounded concurrency (default: 4, capped to CPU count).

Each flow item accepts:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string` | ✅ | Flow name (`scout`, `build`, `debug`, `audit`, `craft`, `ideas`, or custom) |
| `intent` | `string` | ✅ | What the flow should do |
| `aim` | `string` | ✅ | Short headline of what the flow aims to do |
| `acceptance` | `string` | — | One-sentence success criteria |
| `concern` | `string` | ✅ | Known risks, uncertainties, or areas requiring extra care. Be specific. |
| `complexity` | `string` | ✅ | Budget/audit level for this flow (`snap`, `simple`, `moderate`, `complex`, `intricate`) |
| `cwd` | `string` | — | Override working directory |
| `dispatch` | `array` | — | Optional list of pre-flight operations (`batch`, `bash`, `web`) to execute before starting the flow. Results are injected into the prompt. |

Example:

```json
{
  "flow": [
    { "type": "scout", "intent": "Find all authentication-related code and trace JWT validation", "aim": "Find auth code and trace JWT", "acceptance": "All auth files identified with JWT flow traced", "concern": "Auth code may be spread across middleware and utils", "complexity": "moderate" }
  ]
}
```

### Batch multiple flows

```json
{
  "flow": [
    { "type": "scout", "intent": "Find auth code", "aim": "Find auth code", "concern": "Recently refactored", "complexity": "simple" },
    { "type": "audit", "intent": "Audit auth module", "aim": "Audit auth module", "concern": "Token expiry edge cases", "complexity": "moderate" }
  ]
}
```

### Override working directory or confirm project flows

```json
{
  "flow": [
    { "type": "scout", "intent": "Map packages/ui", "aim": "Map UI package", "concern": "Monorepo paths", "complexity": "simple", "cwd": "packages/ui" }
  ]
}
```

Suppress the confirmation prompt before running project-local flows:

```json
{
  "flow": [
    { "type": "scout", "intent": "Map packages/ui", "aim": "Map UI package", "concern": "Monorepo paths", "complexity": "simple" }
  ],
  "confirmProjectFlows": false
}
```

### Run pre-flight setup tasks via `dispatch`

Run commands or setup files locally in one step before the flow starts:

```json
{
  "flow": [
    {
      "type": "build",
      "intent": "Implement auth tests",
      "aim": "Add auth tests",
      "concern": "Test env vars must load before the suite",
      "complexity": "moderate",
      "dispatch": [
        { "tool": "bash", "ops": [{ "c": "npm install dotenv" }] }
      ]
    }
  ]
}
```

## `trace` — quick verbatim reads, checks, and exploration

A lightweight flow state with `maxDepth: 0` that runs verbatim checks, explorations, or diagnostics. All fields are optional.

### Tool parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `intent` | `string` | Optional description of the search or check objective. |
| `cwd` | `string` | Optional working directory override. |
| `complexity` | `string` | Optional budget level (`snap`, `simple`, `moderate`, `complex`, `intricate`). |
| `dispatch` | `array` | Optional pre-flight operations (`batch`, `bash`, `web`) to run. Results are injected into the prompt. |

### Snapshot behavior

`trace` receives the **main agent's full session context** — no tier-based message cap, no profile-based compression. The `tier: lite` in `agents/trace.md` only affects which model is selected (cheaper/faster), not the snapshot content. The shared context display accurately reflects the main agent's actual message counts and conversation history.

### Example using `dispatch` for quick edits/reads/bash

Run batch modifications or terminal checks directly in a single step via `dispatch` without additional round-trips:

```json
{
  "dispatch": [
    {
      "tool": "batch",
      "ops": [
        { "o": "write", "p": "src/temp.ts", "c": "console.log('temp');" },
        { "o": "edit", "p": "src/index.ts", "e": [{ "f": "old code", "r": "new code" }] }
      ]
    },
    {
      "tool": "bash",
      "ops": [
        { "c": "npm test" }
      ]
    }
  ]
}
```

### Lenient dispatch

The `trace` and `flow` dispatch surfaces are **forgiving** — they automatically normalize common shape mistakes the model makes before validation. The underlying `batch` and `bash` tools themselves remain strict; the leniency only applies at the dispatch entry point.

**Boundary: `batch` stays precise; `trace`/`flow` dispatch is forgiving.**

Input → normalized output pairs:

| Input | Normalized | Note |
|---|---|---|
| Bare string at top level or inside `ops` | `bash` op `{c: string}` | `string → bash[1]` |
| Single object inside `ops` (where array expected) | wrapped in array | `single obj → array[1]` |
| `batch` op `{p: "x.ts"}` (no `o`) | infers `o: "read"` | `inferred o=read` |
| `batch` op `{c: "ls"}` (no `p`) | infers `o: "bash"`, `p: "ls"` | `inferred o=bash` |
| `batch` op `{p: "x", c: "code"}` | infers `o: "write"` | `inferred o=write` |
| `batch` op `{p: "x", e: [...]}` | infers `o: "edit"` | `inferred o=edit` |
| `bash` op with stray `tool` key | strips it | `stripped stray tool` |
| `web` op `{q: "..."}` (no `o`) | infers `o: "search"` | `inferred o=search` |
| `web` op `{u: "..."}` (no `o`) | infers `o: "fetch"` | `inferred o=fetch` |
| Nested `{tool, ops: {item: {...}}}` inside an op | flattens to inner item | `flattened nested dispatcher` |

When any normalization occurs, the resulting prompt is annotated with a `normalized:` section listing the applied fixes so the agent knows what happened.

### Field aliases

The dispatch surface accepts **one canonical field name per key** plus a single alias. If both are present, the canonical value wins and the alias is silently discarded.

**Wrapper aliases** (apply to the dispatch group object):

| Alias | Canonical | Meaning |
|-------|-----------|---------|
| `t` | `tool` | Tool type (`batch`, `bash`, `web`) |
| `o` | `ops` | Operations array |

**Universal op aliases** (apply in every tool context):

| Alias | Canonical | Meaning |
|-------|-----------|---------|
| `op` | `o` | Operation type (`read`, `write`, `edit`, `bash`, `rg`, `search`, `fetch`) |
| `path` | `p` | File path or search path |
| `edits` | `e` | Edit array (for `o: "edit"`) |
| `offset` | `s` | Start line (for reads) |
| `limit` | `l` | Line limit (for reads) or files-with-matches flag (for `rg`) |
| `cwd` | `h` | Working directory override |
| `query` | `q` | Search query (for `rg` or `web`) |
| `maxCount` | `n` | Max matches per file (for `rg`) |
| `find` | `f` | Old text to find (inside edit objects) |
| `replace` | `r` | New text to replace (inside edit objects) |

**Context-split op aliases** (resolve differently depending on the wrapper `tool`):

| Alias | `batch` | `bash` | `web` |
|-------|---------|--------|-------|
| `content` | `c` | — | — |
| `cmd` | — | `c` | — |
| `command` | — | `c` (legacy fallback) | — |
| `timeout` | — | `t` | — |
| `ignoreCase` | `i` | — | `i` |
| `id` | — | `i` | — |
| `url` | — | — | `u` |

> **Context-split rationale:** the same short alias (`c`, `t`, `i`, `u`) means different things in different tools. By scoping the alias to the wrapper's `tool` value, the normalizer can safely resolve `cmd` to `c` in a `bash` op without accidentally overwriting `content` in a `batch` write op.

### Silent drops (no note added)

Some malformed inputs are **silently dropped** by the normalizer — the canonical form is applied but no `normalized:` note is added because the original input was structurally invalid rather than merely unnormalized. The strict schema is never exposed to the malformed shape.

| Input | Result | Why |
|---|---|---|
| Group with no valid `tool` (e.g. `{}`, `{tool: "unknown"}`) | group dropped from dispatch | no branch of the `anyOf` matches |
| `ops` field missing entirely | `ops` becomes `[]` | `Type.Array(...)` accepts empty array |
| `ops` is a non-string non-object (e.g. `42`, `true`, `null`) | `ops` becomes `[]` | only string and object branches are handled |
| Per-op `null` / `undefined` / `false` / `0` | op dropped from `ops` array | `!op || typeof op !== "object"` skips |

**Prefer the canonical form** to avoid silent drops and to make your intent explicit. Silent drops still produce the right behavior, but the resulting dispatch is shorter than the input you provided, which can be surprising when debugging.

> **Implementation note:** `prepareArguments` in the trace tool always returns the normalized dispatch form, not the original input, because `notes.length === 0` is not a reliable signal that no transformation was made (see the table above). The same pattern applies to the flow tool's `prepareFlowArguments`.

## `batch` / `batch_read` — unified file operations

When **tool optimization** is enabled (default), the separate `read` / `write` / `edit` tools are replaced by:

- **`batch`** — sequential read, write, edit, and delete operations in one call. Edits use fuzzy matching and preserve line endings. `patch` ops take the **apply_patch envelope format** (`*** Begin Patch` / `*** Update File: <path>` / `@@` hunks / `*** End Patch`), not unified diff. For `rg` ops, `l` defaults to `false` (matching lines with content); set `l: true` for filenames only.
- **`batch_read`** — read-only variant for multiple reads. Small full-file reads return raw content; large full-file reads return code/infra context maps or total line counts, and oversized targeted reads are capped with continuation guidance. Also accepts web ops (`search` / `fetch`) via the `w` array, executed after read ops.

  > **Caution:** the `batch_read` `o` array only supports read-only operations (`read` and `rg`). It does **not** support `edit`, `write`, `delete`, `bash`, or `patch` — use the full `batch` tool for those.

## `batch_bash_poll` — poll pending bash commands

For child flows using the `batch` tool, `batch_bash_poll` lets the agent check on pending bash operations that exceeded the soft timeout. Pass the operation IDs from the pending results to retrieve completed output or see updated partial output.

> **One-shot results:** completed results are returned exactly once and then discarded. Re-polling an already-retrieved ID (or an ID that was never launched) returns `status: "unknown"` — don't keep polling it.

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
