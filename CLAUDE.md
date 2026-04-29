# pi-agent-flow — Project Notes for Claude

## CI/CD

Publishing is fully automated via GitHub Actions. Do **not** run `npm publish` locally.

### How to publish

1. Commit and push changes to `main`.
2. Go to **Actions → Bump Version → Run workflow** (or manually create a `v*` tag).
3. The `bump-version.yml` workflow will bump `package.json`, commit, tag, and push.
4. The `publish.yml` workflow triggers automatically on `v*` tags and publishes to npm with provenance using `secrets.NPM_TOKEN`.

### Workflows

| File | Trigger | Purpose |
|------|---------|---------|
| `.github/workflows/ci.yml` | PR / push to `main` | Runs tests (`npm test`) |
| `.github/workflows/bump-version.yml` | `workflow_dispatch` | Bumps version, commits, tags, pushes |
| `.github/workflows/publish.yml` | Push `v*` tag | Publishes to npm registry |

## Bundled Flows

Six flow-state prompts live in `agents/`:

| Flow | Tools | maxDepth | Notes |
|------|-------|----------|-------|
| `explore` | read, bash, find, grep, ls | 0 | Discovery, surgical efficiency |
| `architect` | read, bash, find, grep, ls | 2 | Conservative design, may delegate to `[explore]` |
| `code` | read, write, edit, bash, find, grep, ls | 2 | TDD workflow (red → green → refactor → verify) |
| `debug` | read, bash, find, grep, ls | 0 | Forensic investigation, evidence-only |
| `review` | read, bash, find, grep, ls | 2 | **Read-only audit** — reports only, no edits |
| `brainstorm` | read, bash | 0 | Clean slate, diverge → evaluate → recommend |

## Key Implementation Details

- **Fork-only delegation**: Every flow runs as an isolated `pi` child process with a session snapshot.
- **Directive delimiters**: `buildFlowArgs` wraps flow directives in `<flow-directive>` / `<system-directive>` XML-style tags to avoid CLI argument parsing conflicts (tags don't start with `-`).
- **Depth guards**: `PI_FLOW_DEPTH`, `PI_FLOW_MAX_DEPTH`, `PI_FLOW_STACK`, `PI_FLOW_PREVENT_CYCLES` env vars propagated to children.
- **Cycle prevention**: Blocks re-entering flows already in the ancestor stack.
