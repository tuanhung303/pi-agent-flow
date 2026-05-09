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
3. The workflow bumps `package.json`, commits, tags `v*`, and pushes.
4. **Then manually trigger publish** (tag-trigger only fires if a PAT secret is configured):
   ```bash
   gh workflow run publish.yml --ref v<NEW_VERSION>
   ```
5. Verify: `npm view pi-agent-flow version`

### Workflows

| File | Trigger | Purpose |
|------|---------|---------|
| `ci.yml` | PR / push to `main` | Runs `lint` + `test` |
| `bump-version.yml` | `workflow_dispatch` (patch/minor/major) | Bumps version → commits → tags → pushes |
| `publish.yml` | `workflow_dispatch` or push `v*` tag | Publishes to npm with provenance |

## Local Development

```bash
npm link                     # Symlink local checkout — restart `pi` after editing
npm uninstall -g pi-agent-flow && npm install -g pi-agent-flow  # Restore published version
npm ls -g pi-agent-flow     # Verify link status
```

## Bundled Flows

Six flow-state prompts in `agents/`:

| Flow | Tools | maxDepth | Tier | Notes |
|------|-------|----------|------|-------|
| `scout` | batch, bash, find, grep, ls, web | 0 | lite | Discovery, surgical efficiency |
| `debug` | batch, bash, find, grep, ls, web | 0 | lite | Forensic investigation, evidence-only |
| `build` | batch, bash, find, grep, ls, web | 0 | flash | Implement, test, verify, ship |
| `craft` | batch, bash, find, grep, ls, web | 0 | full | Conservative design, may delegate to `[scout]` |
| `audit` | batch, bash, find, grep, ls, web | 0 | flash | Audit security, quality, correctness; fix safe issues |
| `ideas` | batch, bash, web | 0 | full | Clean slate, diverge → evaluate → recommend |

Global default delegation depth (`DEFAULT_MAX_DELEGATION_DEPTH`) is 3; each flow's `maxDepth` overrides it.

## Key Implementation Details

- **Fork-only delegation**: Every flow runs as an isolated `pi` child process with a session snapshot.
- **Directive delimiters**: `buildFlowArgs` uses 4-part XML-style prompts: `<context-seal>`, `<activation>`, `<directive>`, `<mission>`. Tags avoid CLI parsing conflicts (none start with `-`).
- **Depth guards**: `PI_FLOW_DEPTH`, `PI_FLOW_MAX_DEPTH`, `PI_FLOW_STACK`, `PI_FLOW_PREVENT_CYCLES` env vars propagated to children.
- **Cycle prevention**: Blocks re-entering flows already in the ancestor stack.
- **Session modes**: `fast` (300s), `default` (600s), `long` (900s), `extreme_long` (1200s). Defined in `session-mode.ts`.
- **Two-stage timeout**: Parent-side warning at `effectiveTimeout - 2min`, final urge at `effectiveTimeout - 2m15s`, hard timeout + 90s reporting grace before SIGKILL. Deadline and grace env vars are propagated to children (`PI_FLOW_DEADLINE_MS`, `PI_FLOW_TOOL_SUMMARY_GRACE_MS`).
- **Timeout reminder injection**: A reminder file (`PI_FLOW_REMINDER_FILE`) is written by the parent and read by the timed-bash wrapper so the child sees warnings before its next tool call.
- **Graceful shutdown**: `SIGINT`/`SIGTERM` handlers on the parent propagate to all registered child process groups via `terminateAllChildGroups()`. `process.prependListener` is used so our handler runs before the host's cleanup.
- **Structured output**: JSON schema injected at the end of the flow prompt when `structuredOutput` is true. Parsed by `extractStructuredOutput()` and mechanically enriched by `enrichStructuredOutputCommands()` which replaces paraphrased bash commands with verbatim tool-call args and attaches `executionTime` from the timed-bash wrapper.
- **Flow-mode persistence**: `--flow-mode` writes `flowModelConfig` to global `settings.json` via atomic rename (`writeGlobalFlowMode`). Startup prints either concise (`mode: name | lite: model · flash: model · full: model`) or verbose format with per-tier flow-name labels.
- **Transition matrix**: Data-driven post-flow routing in `transitions.ts`. Converted to hooks via `buildTransitionHooks()`. `autoTransition` (opt-in) queues qualifying follow-up flows automatically.
- **Tool optimization**: When enabled, `getOptimizedTools()` strips legacy `read`/`write`/`edit` and injects `batch`. The parent sets active tools to `["batch_read", "flow", "web"]`; children get `["batch", "bash", "web"]` (or plus `flow` if they can delegate).
- **Session snapshot sanitization**: `sanitizeForkSnapshot()` strips sliding prompts, reasoning artifacts, and compresses prior flow tool results into compact `CompressedFlowResult` context maps before forking.
