# Configuration Reference

Flow behavior is controlled via CLI flags, environment variables, and persistent settings in `.pi/settings.json`.

**Resolution priority:** CLI flag > env var > `settings.json` > default

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

Settings are merged: project `.pi/settings.json` overrides global `~/.pi/agent/settings.json`.

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
    "sessionMode": "default",
    "maxConcurrency": 4,
    "toolOptimize": true,
    "structuredOutput": true
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `sessionMode` | `default` | Default child-flow session mode: `snap`, `fast`, `default`, `long`, or `extreme_long` |
| `maxConcurrency` | `4` | Maximum parallel flows (capped to CPU count) |
| `toolOptimize` | `true` | Use unified `batch`/`batch_read` instead of separate read/write/edit |
| `structuredOutput` | `true` | Inject JSON structured-output instructions into flow prompts |

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
| `--flow-session-mode [mode]` | Default child-flow session mode | `default` |
| `--flow-max-concurrency [n]` | Maximum parallel flows | `4` |
| `--tool-optimize` | Use unified `batch`/`batch_read` | `true` |
| `--no-steering` | Disable root state steering hint injection | — |
| `--steering-prompt <text>` | Provide a custom steering prompt (implies `--no-steering` override) | — |
| `--no-strategic-hint` | Disable adaptive `[Directive: ...]` hints after tool results | — |
| `--no-animation` | Disable all flow animation (instant render) | — |
| `--no-glitch` | Disable glitch/scramble effect | — |
| `--dump <path>` | Base path for snapshot dumps (alternative to `PI_FLOW_DUMP_SNAPSHOT`) | — |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PI_FLOW_DEPTH` | Current transition depth |
| `PI_FLOW_MAX_DEPTH` | Max allowed depth |
| `PI_FLOW_STACK` | JSON array of ancestor flow names |
| `PI_FLOW_PREVENT_CYCLES` | `"1"` or `"0"` |
| `PI_FLOW_TOOL_OPTIMIZE` | `"1"` or `"0"` (overrides default tool optimization) |
| `PI_FLOW_SESSION_MODE` | Default child-flow session mode: `snap`, `fast`, `default`, `long`, or `extreme_long` |
| `PI_FLOW_MAX_CONCURRENCY` | Maximum parallel flows |
| `PI_FLOW_SPAWN_COMMAND` | Override the spawn command for exotic runtime environments (e.g. bundled with pkg/nexe) |
| `PI_FLOW_DEADLINE_MS` | Absolute deadline timestamp (ms) propagated to child flows for timeout awareness |
| `PI_FLOW_TOOL_SUMMARY_GRACE_MS` | Time before hard timeout when the agent should stop tool use and summarize (ms) |
| `PI_FLOW_REMINDER_FILE` | Path to a file the parent writes warning messages into; the timed-bash wrapper reads it before each tool call |
| `PI_FLOW_DEBUG_CONTEXT` | Set to `1` to emit context-compression telemetry to stderr |
| `PI_OFFLINE` | Always set to `1` for child flow processes |
| `PI_FLOW_NO_STEERING` | Set to `1` to disable root state steering hint injection |
| `PI_FLOW_NO_STRATEGIC_HINT` | Set to `1` to suppress the strategic planning hints appended after tool calls |
| `PI_FLOW_NO_DIRECTIVE` | Alias for `PI_FLOW_NO_STRATEGIC_HINT` |
| `PI_FLOW_NO_ANIMATION` | Set to `1` to disable all flow animation (instant render) |
| `PI_FLOW_NO_GLITCH` | Set to `1` to disable glitch/scramble effect |
| `PI_FLOW_LOG_FILE` | TUI-safe log file path (default: `$TMPDIR/pi-agent-flow.log`; set to `/dev/null` to suppress) |
| `PI_FLOW_DUMP_SNAPSHOT` | Base path for snapshot dumps. Each flow appends `.<flowName>.<timestamp>` before the extension so parallel flows don't collide. Must be **exported** in the shell before `pi` starts. |
| `PI_FLOW_DUMP_MAX_AGE_HOURS` | Max age of dump files before auto-cleanup deletes them (default: `168` = 7 days) |
| `PI_FLOW_SKIP_STRUCTURED_DIRECTIVE` | Set to `1` to skip structured output directive if a provider rejects that prompt shape |
| `PI_ASK_USER_TIMEOUT` | Override the ask_user default timeout in seconds (e.g., `60` for 1 minute) |
| `PI_BATCH_MAX_LINES` | Override the default batch max lines limit (default: 3000, Pi spec: 2000) |
| `PI_BATCH_MAX_BYTES` | Override the default batch max bytes limit (default: 102400, Pi spec: 51200) |
| `PI_BASH_MAX_LINES` | Override the default bash max output lines limit (default: 4000, Pi spec: 2000) |
| `PI_BASH_MAX_BYTES` | Override the default bash max output bytes limit (default: 102400, Pi spec: 51200) |
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
| `show` | `/flow:settings show` — Display current settings and their sources. |
| `steering` | `/flow:settings steering on\|off` — Enable/disable root state steering hint injection. |
| `strategic-hint` | `/flow:settings strategic-hint on\|off` — Enable/disable adaptive `[Directive: ...]` hints after tool results. |
| `directive` | Alias for `strategic-hint` — controls the same setting. |
| `animation` | `/flow:settings animation on\|off` — Enable/disable all flow animations. |
| `glitch` | `/flow:settings glitch on\|off` — Enable/disable glitch/scramble effect. |
| `tool-optimize` | `/flow:settings tool-optimize on\|off` — Enable/disable tool-call optimization. |
| `structured-output` | `/flow:settings structured-output on\|off` — Enable/disable structured JSON output from flows. |
| `session-mode` | `/flow:settings session-mode <snap\|fast\|default\|long\|extreme_long>` — Set the child-flow session budget mode. |
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
    "strategicHint": {
      "enabled": true
    },
    "directive": {
      "enabled": true
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
    "sessionMode": "default",
    "maxConcurrency": 3
  }
}
```

> 💡 Settings are stored in `.pi/settings.json` and persisted across sessions. Use `/flow:settings reset` to discard them and fall back to defaults.
