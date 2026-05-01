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
| `explore` | batch, bash, find, grep, ls | 0 | Discovery, surgical efficiency |
| `architect` | batch, bash, find, grep, ls | 0 | Conservative design, may delegate to `[explore]` |
| `code` | batch, bash, find, grep, ls | 0 | TDD workflow (red → green → refactor → verify) |
| `debug` | batch, bash, find, grep, ls | 0 | Forensic investigation, evidence-only |
| `review` | batch, bash, find, grep, ls | 0 | **Read-only audit** — reports only, no edits |
| `brainstorm` | batch, bash | 0 | Clean slate, diverge → evaluate → recommend |

Note: Global default delegation depth (`DEFAULT_MAX_DELEGATION_DEPTH`) is 3, but each flow's `maxDepth` overrides it.

## Key Implementation Details

- **Fork-only delegation**: Every flow runs as an isolated `pi` child process with a session snapshot.
- **Directive delimiters**: `buildFlowArgs` uses a 4-part XML-style prompt structure: `<context-seal>` (sharp boundary sealing conversation history), `<activation>` (dynamic role/tools/delegation rules from flow config), `<directive>` (the flow's system prompt body), and `<mission>` (intent with execution contract). Tags avoid CLI parsing conflicts (none start with `-`).
- **Depth guards**: `PI_FLOW_DEPTH`, `PI_FLOW_MAX_DEPTH`, `PI_FLOW_STACK`, `PI_FLOW_PREVENT_CYCLES` env vars propagated to children.
- **Cycle prevention**: Blocks re-entering flows already in the ancestor stack.
