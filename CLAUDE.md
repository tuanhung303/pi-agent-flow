# pi-agent-flow — Project Notes

## CI/CD

Publishing is **fully automated** via GitHub Actions.

### Strict Rules

- **Never edit `package.json` version manually.** The Release workflow handles bumping.
- **Never run `npm publish` locally.** Always use CI.
- **Never run `npm version` locally.** The Release workflow handles tagging.

### Publish Flow

When the user asks to publish:

1. Merge feature branch to `main` and push.
2. Trigger the Release workflow:
   ```bash
   gh workflow run bump-version.yml -f bump_type=patch
   ```
3. The workflow bumps `package.json`, commits, tags `v*`, and pushes — which auto-triggers `publish.yml` to npm.

### Workflows

| File | Trigger | Purpose |
|------|---------|--------|
| `ci.yml` | PR / push to `main` | Runs `lint` + `test` |
| `bump-version.yml` | `workflow_dispatch` (patch/minor/major) | Bumps version → commits → tags → pushes → triggers npm publish |
| `publish.yml` | Push `v*` tag | Publishes to npm with provenance |

## Local Development

```bash
npm link                     # Symlink local checkout — restart `pi` after editing
npm uninstall -g pi-agent-flow && npm install -g pi-agent-flow  # Restore published version
npm ls -g pi-agent-flow     # Verify link status
```

## Bundled Flows

Six flow-state prompts in `agents/`:

| Flow | Tools | maxDepth | Notes |
|------|-------|----------|-------|
| `scout` | batch, bash, find, grep, ls | 0 | Discovery, surgical efficiency |
| `architect` | batch, bash, find, grep, ls | 0 | Conservative design, may delegate to `[scout]` |
| `code` | batch, bash, find, grep, ls | 0 | TDD workflow (red → green → refactor → verify) |
| `debug` | batch, bash, find, grep, ls | 0 | Forensic investigation, evidence-only |
| `review` | batch, bash, find, grep, ls | 0 | **Read-only audit** — reports only, no edits |
| `brainstorm` | batch, bash | 0 | Clean slate, diverge → evaluate → recommend |

Global default delegation depth (`DEFAULT_MAX_DELEGATION_DEPTH`) is 3; each flow's `maxDepth` overrides it.

## Key Implementation Details

- **Fork-only delegation**: Every flow runs as an isolated `pi` child process with a session snapshot.
- **Directive delimiters**: `buildFlowArgs` uses 4-part XML-style prompts: `<context-seal>`, `<activation>`, `<directive>`, `<mission>`. Tags avoid CLI parsing conflicts (none start with `-`).
- **Depth guards**: `PI_FLOW_DEPTH`, `PI_FLOW_MAX_DEPTH`, `PI_FLOW_STACK`, `PI_FLOW_PREVENT_CYCLES` env vars propagated to children.
- **Cycle prevention**: Blocks re-entering flows already in the ancestor stack.
