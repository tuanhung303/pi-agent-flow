# Configuration Reference

Flow behavior is controlled via CLI flags, environment variables, and persistent settings in `.pi/settings.json`.

**Resolution priority:** CLI flag > env var > `settings.json` > default. An explicit `auto` is a selected CLI value, so it remains adaptive and cannot fall through to a lower-priority environment override.

## Flow Model Strategies

Use `flowModelConfigs` in your Pi settings to define tiered model strategies. Each tier (`lite`, `flash`, `full`) can specify a `primary` model and an optional `failover` array.

```json
{
  "flowModelConfig": "balance",
  "flowModelConfigs": {
    "performance": {
      "lite": { "primary": "github-copilot/gpt-5.4-mini", "failover": ["github-copilot/gpt-5.5"] },
      "flash": { "primary": "github-copilot/gpt-5.5" },
      "full": { "primary": "github-copilot/gpt-5.5" }
    },
    "balance": {
      "lite": { "primary": "github-copilot/gpt-5.4-mini" },
      "flash": { "primary": "github-copilot/gpt-5.5", "failover": ["github-copilot/gpt-5.4-mini"] },
      "full": { "primary": "github-copilot/gpt-5.5" }
    },
    "quality": {
      "lite": { "primary": "github-copilot/gpt-5.5" },
      "flash": { "primary": "github-copilot/gpt-5.5" },
      "full": { "primary": "github-copilot/gpt-5.5-large", "failover": ["github-copilot/gpt-5.5"] }
    }
  }
}
```

- `performance` — favors speed and lower-cost models.
- `balance` — best default mix of quality and cost.
- `quality` — prefers the strongest models first.

Settings are merged: project `.pi/settings.json` overrides global `~/.pi/agent/settings.json`. For the nested `steering`, `animation`, `askUser`, and `tools` groups, fields merge independently, so a project setting changes only the named field and retains global siblings.

Models referenced in `flowModelConfigs` are checked against the local `models.json` registry (usually `~/.pi/agent/models.json`) and, when present, the optional `models-store.json` fallback. A missing optional store is silent; malformed or unreadable existing registry files still warn. If a model is known to be missing from the registry, a warning is logged, but the model is still tried so that stale or incomplete registries do not silently block valid provider-side models. The missing-model warning is coalesced into a single line per resolution (`N configured flow model(s) are not present in models.json; trying them anyway: a, b, c`) rather than emitted per-candidate. If **every** configured model for a flow or trace is missing from the registry, the invocation fails fast with a clear `Bad settings` error and the synthesized result leaves `model` undefined so per-model telemetry rollups are not poisoned.

## Persistent Flow Mode Switch

Switch the global active strategy quickly with `--flow-mode`:

```bash
pi --flow-mode balance
pi --flow-mode quality
```

`--flow-mode` updates `flowModelConfig` in global `~/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json`) and applies the mode immediately for the current invocation. The mode must already exist in the merged `flowModelConfigs`; project `.pi/settings.json` can still override global settings on later no-flag runs.

On startup, the selected mode is printed in a compact notification:

```
mode: balance | lite: gpt-5.4-mini - flash: gpt-5.5 - full: gpt-5.5
```

Failover-only tiers are shown as `failover: model-a, model-b`. Verbose mode includes the flow names associated with each tier.

## Flow Settings

Set flow runtime defaults under `flowSettings`:

```json
{
  "flowSettings": {
    "complexity": "moderate",
    "maxConcurrency": 4,
    "toolOptimize": true,
    "structuredOutput": true
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `complexity` | `moderate` | Default child-flow complexity: `snap`, `simple`, `moderate`, `complex`, or `intricate` |
| `maxConcurrency` | `4` | Maximum parallel flows (capped to CPU count) |
| `toolOptimize` | `true` | Use unified `batch`/`batch_read` instead of separate read/write/edit |
| `structuredOutput` | `true` | Inject JSON structured-output instructions into flow prompts |
| `bodyVerbosity` | `lite` | Collapsed result body: `lite` (aim + command) or `full` (includes message) |
| `steering.enabled` | `true` | Inject the root steering hint |
| `steering.customPrompt` | unset | Replace the built-in steering hint |
| `animation.enabled` / `animation.glitch` | `true` / `true` | Enable animation and its scramble effect |
| `askUser.enabled` / `askUser.timeout` | `false` / `300` seconds | Enable the ask-user countdown and configure its timeout |
| `tools.trace` | `true` | Enable the `trace` tool |
| `tools.batchRead` | follows `toolOptimize` | Enable the `batch_read` tool |
| `debugMode` | `false` | Write child activation prompts for debugging |
| `contextCompression` | `auto` | Child snapshot compression: `auto`, `light`, `medium`, or `aggressive` |
| `subAgentMaxRetries` | `3` | Connection-error retries after model failover exhaustion (0–10) |
| `subAgentBaseDelayMs` | `1000` | Base delay (ms) for exponential backoff between connection retries |

## CLI Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--flow-max-depth [n]` | Maximum transition depth | `3` |
| `--flow-prevent-cycles` | Block cyclic transition | `true` |
| `--no-flow-prevent-cycles` | Disable cycle prevention | — |
| `--flow-model-config [name]` | Select a named model strategy for this invocation | `default` |
| `--flow-mode [name]` | Persistently switch the global model strategy and apply it immediately | — |
| `--flow-lite-model [model]` | Override the lite-tier model | — |
| `--flow-flash-model [model]` | Override the flash-tier model | — |
| `--flow-full-model [model]` | Override the full-tier model | — |
| `--flow-complexity [mode]` | Default child-flow complexity | `moderate` |
| `--flow-context-compression [mode]` | Override child snapshot compression (`auto`, `none`, `light`, `medium`, `aggressive`) | `auto` |
| `--flow-max-concurrency [n]` | Maximum parallel flows | `4` |
| `--tool-optimize` | Use unified `batch`/`batch_read` | `true` |
| `--tools-trace` | Enable the `trace` tool | `true` |
| `--tools-batch-read` | Enable the `batch_read` tool | follows `--tool-optimize` |
| `--no-steering` | Disable root state steering hint injection | — |
| `--no-animation` | Disable all flow animation (instant render) | — |
| `--no-glitch` | Disable glitch/scramble effect | — |
| `--body-lite` / `--body-full` | Select collapsed result verbosity | `lite` |
| `--flow-debug` | Write child activation prompts for debugging | `false` |
| `--steering-prompt <path>` | Read a UTF-8 custom steering prompt from a file for this invocation; it overrides `steering.customPrompt` but does not enable or disable steering | — |
| `--dump <path>` | Base path for snapshot dumps (alternative to `PI_FLOW_DUMP_SNAPSHOT`) | — |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PI_FLOW_DEPTH` | Current transition depth |
| `PI_FLOW_MAX_DEPTH` | Max allowed depth |
| `PI_FLOW_STACK` | JSON array of ancestor flow names |
| `PI_FLOW_PREVENT_CYCLES` | `"1"` or `"0"` |
| `PI_FLOW_TOOL_OPTIMIZE` | `"1"` or `"0"` (overrides default tool optimization) |
| `PI_FLOW_TOOLS_TRACE` | `"1"` or `"0"` (enable/disable the `trace` tool; default: `1`) |
| `PI_FLOW_TOOLS_BATCH_READ` | `"1"` or `"0"` (enable/disable the `batch_read` tool; default: follows `PI_FLOW_TOOL_OPTIMIZE`) |
| `PI_FLOW_COMPLEXITY` | Default child-flow complexity: `snap`, `simple`, `moderate`, `complex`, or `intricate` |
| `PI_FLOW_MAX_CONCURRENCY` | Maximum parallel flows |
| `PI_FLOW_SUB_AGENT_MAX_RETRIES` | Connection-error retries after model failover exhaustion (default: `3`, max: `10`; set `0` to disable) |
| `PI_FLOW_SUB_AGENT_BASE_DELAY_MS` | Base delay in ms for exponential backoff between connection retries (default: `1000`) |
| `PI_FLOW_SPAWN_COMMAND` | Override the spawn command for exotic runtime environments (e.g. bundled with pkg/nexe) |
| `PI_FLOW_DEADLINE_MS` | Absolute deadline timestamp (ms) propagated to child flows for timeout awareness |
| `PI_FLOW_TOOL_SUMMARY_GRACE_MS` | Time before hard timeout when the agent should stop tool use and summarize (ms) |
| `PI_FLOW_REMINDER_FILE` | Path to a file the parent writes warning messages into; the timed-bash wrapper reads it before each tool call |
| `PI_FLOW_DEBUG_CONTEXT` | Set to `1` to emit context-compression telemetry to stderr |
| `PI_OFFLINE` | Always set to `1` for child flow processes |
| `PI_FLOW_NO_STEERING` | Set to `1` to disable root state steering hint injection |
| `PI_FLOW_NO_ANIMATION` | Set to `1` to disable all flow animation (instant render) |
| `PI_FLOW_NO_GLITCH` | Set to `1` to disable glitch/scramble effect |
| `PI_FLOW_BODY_VERBOSITY` | Set collapsed body verbosity to `lite` or `full` |
| `PI_FLOW_STRUCTURED_OUTPUT` | Set to `1` or `0` to enable/disable structured flow output |
| `PI_FLOW_DEBUG` | Set to `1` or `0` to enable/disable child activation prompt dumps |
| `PI_FLOW_LOG_FILE` | TUI-safe log file path (default: `$TMPDIR/pi-agent-flow.log`; set to `/dev/null` to suppress) |
| `PI_FLOW_DUMP_SNAPSHOT` | Base path for snapshot dumps. Each flow appends `.<flowName>.<timestamp>` before the extension so parallel flows don't collide. Must be **exported** in the shell before `pi` starts. |
| `PI_FLOW_LITE_MAX_MESSAGES` | Override lite-tier snapshot message cap (default: `30`) |
| `PI_FLOW_FLASH_MAX_MESSAGES` | Override flash-tier snapshot message cap (default: `50`) |
| `PI_FLOW_FULL_MAX_MESSAGES` | Override full-tier snapshot message cap (default: `80`) |
| `PI_FLOW_CONTEXT_COMPRESSION` | Compression preference: `auto`, `none`, `light`, `medium`, or `aggressive`; overridden by `--flow-context-compression` (including explicit `auto`) |
| `PI_FLOW_CONTEXT_THRESHOLD` | Automatic compression threshold in estimated tokens (default: `70000`) |
| `PI_FLOW_DUMP_MAX_AGE_HOURS` | Max age of dump files before auto-cleanup deletes them (default: `168` = 7 days) |
| `PI_FLOW_SKIP_STRUCTURED_DIRECTIVE` | Set to `1` to skip structured output directive if a provider rejects that prompt shape |
| `PI_ASK_USER_TIMEOUT` | Override the ask_user default timeout in seconds (e.g., `60` for 1 minute) |
| `PI_BATCH_MAX_LINES` | Override the default batch max lines limit (default: 2000, Pi spec: 2000) |
| `PI_BATCH_MAX_BYTES` | Override the default batch max bytes limit (default: 51200, Pi spec: 51200) |
| `PI_BATCH_MAX_BYTES_PER_LINE` | Per-line byte cap for read/rg/bash output (default: 1024) |
| `PI_RG_MAX_LINES` | Max rg match lines returned per op (default: 500) |
| `PI_RG_MAX_BYTES` | Max rg match bytes returned per op (default: 51200) |
| `PI_RG_DEFAULT_MAX_COUNT` | Auto `--max-count` per file for broad `.` searches when `n` omitted (default: 50) |
| `PI_BASH_MAX_LINES` | Override the default bash max output lines limit (default: 2000, Pi spec: 2000) |
| `PI_BASH_MAX_BYTES` | Override the default bash max output bytes limit (default: 51200, Pi spec: 51200) |
| `PI_FLOW_SIGKILL_TIMEOUT_MS` | Override the default SIGKILL timeout in milliseconds (default: 5000) |
| `PI_FLOW_FINISH_KILL_GRACE_MS` | Override the default finish kill grace period in milliseconds (default: 5000) |
| `PI_FLOW_AGENT_END_GRACE_MS` | Override the default agent end grace period in milliseconds (default: 2000) |
| `PI_FLOW_TIME_BUDGET_WARNING_MS` | Override the default flow time budget warning threshold in milliseconds (default: 120000) |
| `PI_FLOW_FINAL_URGE_MS` | Override the default final urge threshold in milliseconds (default: 135000) |
| `PI_FLOW_REPORTING_GRACE_MS` | Override the default reporting grace period in milliseconds (default: 90000) |
| `PI_FLOW_SNAP_THRESHOLD_MS` | Override the default snap threshold in milliseconds (default: 120000) |
| `PI_FLOW_IDLE_WAKEUP_MS` | Override the idle wake-up threshold in milliseconds (default: 600000 = 10 minutes) |
| `PI_TUI_MODE` | Set to `1` to route `logWarn`/`logError` to a log file instead of stderr, preventing on-screen text flash. Detected automatically when stdout is a TTY or `PI_FLOW_DEPTH > 0`. |

## `/flow:settings` Slash Commands

| Command | Usage |
|---------|-------|
| `show` | `/flow:settings show` — Display persisted/default values and loop state. It does not annotate sources or display CLI/environment overrides. |
| `steering` | `/flow:settings steering on\|off` — Enable/disable root state steering hint injection. |

| `animation` | `/flow:settings animation on\|off` — Enable/disable all flow animations. |
| `glitch` | `/flow:settings glitch on\|off` — Enable/disable glitch/scramble effect. |
| `tool-optimize` | `/flow:settings tool-optimize on\|off` — Enable/disable tool-call optimization. |
| `trace` | `/flow:settings trace on\|off` — Enable/disable the `trace` tool. |
| `batch-read` | `/flow:settings batch-read on\|off` — Enable/disable the `batch_read` tool. |
| `structured-output` | `/flow:settings structured-output on\|off` — Enable/disable structured JSON output from flows. |
| `body` | `/flow:settings body <lite\|full>` — Set collapsed result verbosity. |
| `complexity` | `/flow:settings complexity <snap\|simple\|moderate\|complex\|intricate>` — Set the child-flow complexity (budget + review). |
| `context-compression` | `/flow:settings context-compression <auto\|light\|medium\|aggressive>` — Set child snapshot compression. |
| `max-concurrency` | `/flow:settings max-concurrency <n>` — Set maximum concurrent flows. |
| `ask-user` | `/flow:settings ask-user enabled <on\|off>` — Enable/disable ask_user countdown. `/flow:settings ask-user timeout <seconds>` — Set auto-dismiss timeout. |
| `reset` | `/flow:settings reset` — Reset all settings to their defaults. |

## Example `.pi/settings.json`

```json
{
  "flowSettings": {
    "steering": {
      "enabled": true,
      "customPrompt": "Plan next step..."
    },
    "animation": {
      "enabled": true,
      "glitch": true
    },
    "askUser": {
      "enabled": false,
      "timeout": 300
    },
    "toolOptimize": false,
    "structuredOutput": true,
    "complexity": "moderate",
    "maxConcurrency": 3
  }
}
```

> 💡 Settings are stored in `.pi/settings.json` and persisted across sessions. Use `/flow:settings reset` to discard them and fall back to defaults.

Changes made through `/flow:settings` are re-resolved immediately for future root-session work, including steering, animation, tools, ask-user, rendering, flow execution defaults, and snapshot compression. Existing child processes keep the settings they were started with. Model strategy discovery and child tool registration remain startup-time concerns.
