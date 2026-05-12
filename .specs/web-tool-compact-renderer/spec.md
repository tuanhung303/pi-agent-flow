# Web Tool Compact TUI Renderer

## Investigation Findings

### Current State

The `web` tool (`src/web-tool.ts`) registers **no** `renderCall`/`renderResult` hooks. This means the TUI displays the full raw tool output verbatim — every metadata line, every URL, and the entire 500-char preview block.

**Fetch output** (`src/web-tool.ts:366-382`): Generates 5+ lines per fetch:
```
File: /tmp/session/abc123.md
Title: Page Title
Content length: 4200 chars

Preview:
<500 characters of page content...>
```

**Search output** (`src/web-tool.ts:160-170`): Generates ~12 lines for 4 results:
```
1. Result Title
   https://example.com/page
   Snippet text up to 160 chars...

2. Another Title
   https://example.org/other
   Another snippet...
```

The `flow` and `batch` tools already use `renderCall`/`renderResult` hooks for compact TUI display. The pattern is: collapsed = one-line/compact summary, expanded = full text, LLM always receives complete output.

**Evidence:**
- `src/index.ts:290`: `pi.registerTool(createWebTool())` — no render hooks
- `src/index.ts:380-382`: flow tool registers `renderCall` and `renderResult`
- `src/batch/render.ts`: `renderBatchResult` returns `TruncatedText` for collapsed, `Text` for expanded
- `src/render.ts:142+`: `renderFlowResult` uses `Container`/`Text` with tree-style display (├─/└─) — designed for nested flow panels
- `src/snapshot.ts:200+`: Already compresses web results to `[web:search] "query" · N results · first: Title` and `[web:fetch] url · "Title" · N chars` for child flow context
- `src/web-tool.ts:110-130`: `runWebOps` returns `details: { ops: [{ o, q/u, ...searchOrFetchDetails }] }` — structured data available for rendering

### Codebase Patterns

**Batch tool** (structural twin — flat array of ops, no nesting):
- `renderBatchCall(args, theme)` → `Text` with flat summary line: `batch read src/foo.ts, edit src/bar.ts`
- `renderBatchResult(result, expanded, theme, args)` → `TruncatedText` (collapsed, first line) or `Text` (expanded, full)
- Theme: `BatchTheme = { fg, bold, bg }` exported from `batch/constants.ts`

**Flow tool** (nested child panels):
- `renderFlowCall(args, theme)` → `Text`
- `renderFlowResult(result, expanded, theme, args)` → `Container` with tree-style ├─/└─
- Theme: `FlowTheme = { fg, bold, bg }` — local (non-exported) type in `render.ts`

**Key difference**: Flow uses tree prefixes because it has nested child panels. Batch uses flat lines because its ops are a flat list. Web ops are also a flat list — matching the batch pattern.

**Factory pattern**: `createWebTool()` returns `{ name, label, description, promptSnippet, promptGuidelines, parameters, execute }`. The batch tool adds `renderCall`/`renderResult` inside its factory return — a clean self-contained pattern.

## User Alignment

| Question | Answer | Impact |
|----------|--------|--------|
| Theme dependency: how to type the web renderer's theme? | Define a minimal `WebTheme` type in `web-render.ts` (same shape as `BatchTheme`) | No cross-module coupling. Self-contained. Follows batch's proven pattern. |
| Collapsed view style: flat (batch-style) or tree (flow-style)? | Flat minimal (batch-style) | Web ops are a flat list — tree prefixes add noise. One summary line per op, joined with commas or '·'. E.g. `web search "query" → 4 results, fetch example.com · "Title" · 4200 chars` |
| How to wire render hooks into createWebTool()? | Add renderers to the factory return object (batch pattern) | Self-contained — everything about the web tool lives in one factory. `index.ts` stays clean. |

## Technical Context

- **Stack**: TypeScript, `@mariozechner/pi-coding-agent` extension API, `@mariozechner/pi-tui` components (`Text`, `TruncatedText`, `Container`)
- **Theme**: `WebTheme = { fg: (color, text) => string; bold: (s) => string; bg: (color, text) => string }` — defined locally in `web-render.ts`, matching `BatchTheme` shape
- **Details object**: `runWebOps` returns `{ ops: [{ o: "search", q, query, results, errors }, { o: "fetch", u, f, url, title, filePath, contentLength, format }] }` — the renderer consumes `details.ops`
- **Args shape**: `args.op` is `Array<{ o: "search" | "fetch", q?: string, u?: string, f?: string }>`
- **Color scheme**: `muted` for labels/prefixes, `accent` for values (URLs, titles, counts) — consistent with batch tool
- **Strategic hints**: `appendStrategicHintOnce` appends hint text to web results — renderer should show only the primary result in collapsed view

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|----------|
| Renderer approach | Add `renderCall` + `renderResult` to `createWebTool()` factory return | Self-contained factory (batch pattern). LLM context untouched. |
| Theme type | Define `WebTheme` locally in `web-render.ts` | No coupling to flow/batch modules. Same shape as `BatchTheme`. |
| Collapsed format | Flat single-line summary (batch-style) | Web ops are flat data — tree prefixes add visual noise. Matches batch tool's proven approach. |
| Expanded format | Full raw text (current behavior) | Standard pattern — expanded view shows everything. Zero risk of information loss. |
| renderCall format | Compact op list, e.g. `web search "query", fetch example.com` | Flat summary of ops being invoked. |
| renderResult collapsed — single search | `web search "query" → N results` | Concise: op type + query + count. |
| renderResult collapsed — single fetch | `web fetch example.com · "Title" · 4200 chars` | Concise: op type + domain + title + char count. No preview. |
| renderResult collapsed — multiple ops | Comma-joined summaries, e.g. `web search "query" → 4 results, fetch example.com · "Title" · 4200 chars` | Flat list of op summaries. If >3 ops, truncate: first 2 + `+N more`. |
| Error rendering (collapsed) | `web search "query" → 0 results` or `web fetch example.com → error: description` | Op type + indicator of failure. |
| Color scheme | `muted` for labels (`web`, `search`, `fetch`), `accent` for values (queries, URLs, titles, counts) | Consistent with batch tool coloring. |

## Implementation Plan

### Phase 1: Create web renderer module
- Create `src/web-render.ts`
- Define `WebTheme` type: `{ fg: (color, text) => string; bold: (s) => string; bg: (color, text) => string }`
- Implement `renderWebCall(args, theme)`:
  - Extract ops from `args.op`
  - Format: `search "query"` for search ops, `fetch domain` for fetch ops
  - Join with `, ` (truncate at 3: first 2 + `+N more`)
  - Return `Text(theme.fg("muted", "web ") + theme.fg("accent", summary))`
- Implement `renderWebResult(result, expanded, theme, args)`:
  - **Expanded**: return `Text(fullText)` — raw verbatim output
  - **Collapsed**:
    - Parse `result.details.ops` to build per-op summary strings
    - Search op: `search "query" → N results` (or `→ 0 results` / `→ error: ...`)
    - Fetch op: `fetch domain · "Title" · N chars` (or `→ error: ...`)
    - Join with `, ` (truncate at 3 ops)
    - Return `TruncatedText(theme.fg("muted", "web ") + theme.fg("accent", summary), 0, 0)`
  - **Fallback**: if `details.ops` is missing/malformed, use first line of raw text (defensive)
- Handle edge cases:
  - Search with 0 results: `search "query" → 0 results`
  - Search with errors: `search "query" → error: ...`
  - Fetch with no title: `fetch domain · N chars` (omit title)
  - Fetch with warning: `fetch domain · "Title" · N chars · ⚠ short content`
  - Empty ops array: `web (no ops)`

### Phase 2: Wire render hooks into web tool factory
- In `createWebTool()` (`src/web-tool.ts`), import `renderWebCall` and `renderWebResult` from `./web-render.js`
- Add `renderCall` and `renderResult` properties to the returned object:
  ```ts
  renderCall: (args, theme) => renderWebCall(args, theme),
  renderResult: (result, { expanded }, theme, args) => renderWebResult(result, expanded, theme, args),
  ```
- Verify: raw tool output unchanged, TUI gets compact display
- `index.ts` needs NO changes — `pi.registerTool(createWebTool())` stays as-is

### Phase 3: Test
- Add unit tests for `renderWebCall` and `renderWebResult` covering:
  - Single search op
  - Single fetch op
  - Multiple ops (search + fetch)
  - Collapsed vs expanded mode
  - Edge cases: 0 search results, fetch error, missing title, empty ops
  - Fallback: malformed details object
- Follow existing test patterns from `src/batch/render.test.ts` (if exists) or `src/__tests__/`

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| `details.ops` shape changes or is missing | Defensive parsing with optional chaining; fallback to first line of raw text on parse failure |
| Expanded view regression | Expanded view simply returns raw text as `Text` — identical to current behavior. Zero risk. |
| `WebTheme` type drifts from actual theme passed by TUI | `WebTheme` matches `BatchTheme` shape exactly — proven interface. TUI passes objects with `fg`/`bold`/`bg`. |
| `appendStrategicHintOnce` text pollutes collapsed view | Collapsed renderer parses `details.ops`, not raw text. Strategic hints are in raw text only — ignored by collapsed renderer. |
| Domain extraction from URL fails | Use `try { new URL(u).hostname }` with fallback to raw URL string |

## Assumptions

- The `WebTheme` interface (`{ fg, bold, bg }`) matches the theme object passed by the TUI framework to render hooks — confirmed by matching `BatchTheme` which works in production
- The `details.ops` array structure is stable (each op has `o`, plus search/fetch-specific fields)
- `TruncatedText` from `@mariozechner/pi-tui` handles line truncation for single-line collapsed view
- `appendStrategicHintOnce` only modifies `content[0].text`, not `details` — confirmed by reading the function
- The `args` passed to `renderCall` match the `webSchema` shape (`op` key with array value)
