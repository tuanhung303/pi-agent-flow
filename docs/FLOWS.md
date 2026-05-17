# Flows Reference

## Why Flow Style?

Flow-style transition is designed for **context efficiency**. Instead of launching every flow state with the full, ever-growing conversation history, each flow receives only what it needs: your intent and (when appropriate) a sanitized session snapshot.

This approach delivers four concrete benefits:

1. **Avoid duplicate tool calls** — every flow state launch no longer re-runs the same `read`, `grep`, or `bash` probes that the parent already performed.
2. **Prevent context bloat** — long transcripts with repeated file listings and command outputs are kept out of the main conversation thread.
3. **Eliminate unnecessary noise** — the parent agent sees only structured results (`summary`, `notDone`, `nextSteps`, etc.) instead of pages of intermediate reasoning.
4. **Preserve focus** — each flow stays locked on its intent because it isn't distracted by unrelated earlier messages.

The result is faster, cheaper, and cleaner transition: the main agent remains uncluttered while specialized flows do the heavy lifting in isolated contexts.

## Shared Context

When you transition to a flow, the flow state receives an automatic **sanitized fork** of your current session. This lets you write concise intents that focus on **what new work to do** rather than restating the full problem.

### How it works

1. **Snapshot serialized** — your conversation (files read, commands run, prior flow results) is serialized into a JSONL snapshot.
2. **Sanitized** — steering hints, reasoning/thinking artifacts, and other non-inheritable content are stripped.
3. **Compressed** — prior flow tool results are compacted into short summaries: files touched, commands used, outcome status.
4. **Forked** — the flow state loads this snapshot via `--session` at startup.

### Writing good intents

The child already sees what you've done. Write intents that say **what to do next**, not what context it needs:

| ❌ Bad intent | ✅ Good intent |
|---|---|
| `"The auth module uses JWT tokens… inspect src/auth/ for security issues"` | `"Audit the auth module for security issues"` |
| `"We already found the bug… run the failing test and fix it"` | `"Fix the failing test in tests/auth.test.ts"` |
| `"The file structure is… implement the feature described in the PRD"` | `"Implement the feature described in the PRD"` |

### Clean slate

Set `inheritContext: false` in a custom flow's front-matter to start with a clean slate. The child receives only your `intent` — no inherited session. This is ideal for unbiased creative work in `ideas` flows.

### What the child sees

The child's `<context-seal>` prompt tells it: *"The conversation above is sealed — it is your session history for situational awareness only."* The child can reference files and findings already in context but shouldn't act as if it's still in the parent's conversation.

## Bundled Flows

| Flow | Purpose | Tools | Tier |
|------|---------|-------|------|
| `[scout]` | Discover files, trace code paths, map architecture | `batch`, `bash`, `find`, `grep`, `ls`, `web` | `lite` |
| `[debug]` | Investigate logs, errors, stack traces, root causes, and fix bugs | `batch`, `bash`, `find`, `grep`, `ls`, `web` | `lite` |
| `[build]` | Implement features, fix bugs, write tests, deploy, and ship | `batch`, `bash`, `find`, `grep`, `ls`, `web` | `flash` |
| `[craft]` | Plan structure, break down requirements, design solutions | `batch`, `bash`, `find`, `grep`, `ls`, `web` | `full` |
| `[audit]` | Audit security, quality, correctness; fix safe issues autonomously | `batch`, `bash`, `find`, `grep`, `ls`, `web` | `flash` |
| `[ideas]` | Generate ideas, explore possibilities, and think creatively using inherited context | `batch`, `bash`, `find`, `grep`, `ls`, `web` | `full` |

> **Note:** All bundled flows have `maxDepth: 0`, meaning they do not transition further by default. Custom flows can override this via front-matter.

> **Clean slate:** Set `inheritContext: false` in a custom flow's front-matter so it receives only the intent, ideal for unbiased creative work.

> **Docs hygiene:** Bundled `build` and `debug` flows are instructed to update relevant documentation after their work when the findings or implementation change developer or operational knowledge. If no docs apply, they should state why in the final report.

## Session Modes

Each flow call may set `sessionMode` to choose the flow state time budget:

| Mode | Budget | Recommended use |
|------|-------:|-----------------|
| `snap` | 90s | ultra-quick checks, syntax scans, one-liner verifications |
| `fast` | 300s | quick scouting, narrow checks, small design passes |
| `default` | 600s | normal flow work; this is the default |
| `long` | 900s | large builds, full test runs, broad refactors, complex debugging |
| `extreme_long` | 1200s | very large refactors, extensive audits, or multi-step debugging sessions |

Example:

```json
{
  "flow": [
    {
      "type": "build",
      "intent": "Run the full test suite and fix failures",
      "aim": "Fix failing tests",
      "sessionMode": "long"
    }
  ]
}
```

The public interface is mode-based; arbitrary per-flow numeric timeouts are not exposed.

Session mode precedence:

```txt
per-flow sessionMode > --flow-session-mode > PI_FLOW_SESSION_MODE > flowSettings.sessionMode > default
```

## Timeout Behavior

Flows are aware of their deadline from the moment they start:

- **Prompt injection** — the activation block includes the exact time budget and warns the agent to wrap up before the deadline.
- **Parent UI countdown** — a live `MM:SS` countdown is shown next to the flow's aim while it runs.
- **Two-stage warnings** — at 2 minutes before hard timeout a warning is injected into the child's reminder stream; at 2 minutes 15 seconds a final urge demands the agent stop all tool use and output structured findings.
- **Grace period** — after the hard timeout fires, the agent gets a 90-second reporting grace to finish its summary before the process is force-killed.
- **Graceful shutdown** — when the parent receives `SIGINT` or `SIGTERM`, the signal propagates to every child process group so flow states terminate cleanly instead of becoming orphans.

## Post-Flow Advisory Messages

When certain flows complete, the system injects advisory messages suggesting follow-up flows. This keeps the agent on the optimal path without requiring the user to manually chain flows.

### Built-in transition matrix

| Source | Target | Condition | Advice |
|--------|--------|-----------|--------|
| `scout` | `build` | success | Context mapped. Consider running a [build] flow to implement changes, or [debug] if investigating an issue. |
| `scout` | `debug` | success | Context mapped. Consider running a [debug] flow if investigating an issue. |
| `debug` | `build` | success | The root cause has been identified. Consider running a [build] flow to implement the fix. |
| `debug` | `audit` | success | Root cause identified. Consider running an [audit] flow to verify the fix area for related issues. |
| `build` | `audit` | success | Consider running an [audit] flow to audit the changes for security, correctness, and code quality. |
| `build` | `debug` | failure | Build failed. Consider running a [debug] flow to investigate the root cause. |
| `audit` | `scout` | success | Audit complete. Consider running a [scout] flow to trace the audit findings across the codebase. |
| `audit` | `build` | failure | Audit found issues. Consider running a [build] flow to fix them. |
| `craft` | `build` | success | Plan ready. Consider running a [build] flow to implement the design. |
| `ideas` | `craft` | success | Ideas explored. Consider running a [craft] flow to design the approach, or [build] to implement directly. |

Advisories are smart: if the agent already included the suggested flow in the same batch, the advisory is suppressed to avoid redundancy.

## Flow Loop & Warp

Set a multi-step objective and the system automatically spawns flows to advance it after each turn. When active, the root state receives a hidden instruction at `turn_end` to call the `flow` tool again until the goal is complete, paused, or a budget is exhausted.

### Slash commands

| Command | Usage |
|---------|-------|
| `set` | `/flow:goal set <objective> [--acceptance <text>] [--max-tokens <n>] [--max-flows <n>]` — Sets the goal and **immediately auto-triggers** a build flow to start working. |
| `clear` | `/flow:goal clear` — Marks the active goal as `abandoned` and moves it to history. |
| `pause` | `/flow:goal pause` — Pauses auto-continuation so no new flows are spawned until the goal is resumed or cleared. |
| `resume` | `/flow:goal resume` — Resumes a paused goal and **immediately auto-triggers** a build flow to continue. |
| `edit` | `/flow:goal edit <new-objective> [--acceptance <text>]` — Updates the objective and optionally the acceptance criteria. |
| `complete` | `/flow:goal complete` — Marks the current goal as completed. |
| `status`, `show` | `/flow:goal status` (or `show`) — Displays current goal state, budgets, and completed flows |
| `warp` | `/flow:warp [goal]` — Distills conversation context into a simple context-transfer prompt (## Context + ## Task) and spawns a new session with the goal auto-set. Preserves unresolved blockers, key files, and end-goal intent. If no goal is provided, a default continuation goal is used. |

> **Note on `completed` status:** `completed` is a valid `GoalStatus`. Goals can be marked completed manually via `/flow:goal complete`. The agent cannot self-terminate a goal — only the user can end it.

#### Warp gotchas

| Gotcha | Why |
|--------|-----|
| **No model selected** | Warp requires a configured LLM to distill context. Set a model in Pi settings first. |
| **Empty conversation** | If the branch has no messages, there's nothing to warp. |
| **Deep warp chains (>3)** | Consecutive warps dilute context. A warning is shown; consider consolidating instead. |
| **User cancels editor** | No session is created; the current session remains unchanged. |
| **Blank goal fallback** | If no goal is provided, warp uses a default: "Continue where we left off — summarize what we've done, where we are, and what the natural next step is." |

#### Warp output format

Warp produces a simple **context-transfer prompt** with two markdown sections:

- **## Context** — orientation summary, decisions made, files touched, unresolved blockers, and edge cases
- **## Task** — the immediate next action to take

Example distilled prompt:

## Context

We've been refactoring the auth layer from Express middleware to NestJS guards.

Key decisions:
- Use @nestjs/passport with JWT strategy
- Skip session auth; keep stateless only

Files involved:
- `src/auth/jwt.strategy.ts` — created, basic validate()
- `src/auth/auth.module.ts` — registered JwtStrategy

Unresolved work / blockers:
- Role-based access not implemented yet
- E2E tests failing after guard injection (needs debug)

Edge cases to watch:
- JWT secret is overridden by AUTH_SECRET env var in CI
- `src/auth/auth.module.ts` exports order matters for DI

## Task

Complete the Discover phase by mapping middleware usage, then begin Convert on the first batch of routes.

### How it works

1. On `turn_end`, if a goal is **active**, the continuation hook checks token/flow budgets. If `maxTokens` or `maxFlows` is exceeded, the goal is **auto-paused** and a hidden budget-limit message is sent to the root state.
2. If under budget, the hook sends a hidden message instructing the root state to call the `flow` tool.
3. The spawned flow receives a `<flow>` block in its activation prompt with the objective, acceptance criteria, and progress (`flowCount/maxFlows`).
4. Completed flows (type, intent, aim, completedAt) and token usage are recorded in goal state.
5. A **5-second cooldown** (`SPAWN_COOLDOWN_MS`) prevents rapid-fire spawns.
6. A **3-second post-completion hold** (`FLOW_COMPLETE_HOLD_MS`) delays the next spawn after a flow finishes, giving the user time to read the completed result before it scrolls off-screen.
7. Goals are **session-scoped** via `sessionId`; resuming in a new session still works but clears the old session binding.

### Idle wake-up

When a goal is active and the user has been idle for **~600 seconds** (10 minutes), the system sends a hidden `<flow-wakeup>` nudge to the root state. The nudge prompts the agent to review the active goal and find safe, conservative improvements that advance it — such as verification, testing, or documentation — without making risky changes or refactoring large areas.

The wake-up interval is checked every 60 seconds. It resets after any user turn or flow completion. Override the default idle threshold via the `PI_FLOW_IDLE_WAKEUP_MS` environment variable (value in milliseconds).

### Persistence

Goals are stored in `.pi/flow.json` in the project root (atomic writes). The file contains:
- `current`: the active goal (`id`, `objective`, `acceptance`, `createdAt`, `updatedAt`, `status`, `completedFlows`, `totalTokens`, `maxTokens`, `maxFlows`, `sessionId`).
- `history`: previously completed or abandoned goals.

Add `.pi/` to `.gitignore` — this is local runtime state.

> ⚠️ **Token counting:** The continuation hook estimates tokens using `Math.ceil(messageText.length / 4)`, not actual model token counts. This is a lightweight heuristic for budget guarding.

### Typical lifecycle

```bash
/flow:goal set "Refactor all tests to vitest" --acceptance "All tests pass" --max-flows 5
# Work normally — after each turn the root state auto-transitions
/flow:goal pause    # Stop auto-continuation
/flow:goal status   # Check progress
/flow:goal clear    # Done
```

> No environment variable controls auto-continuation; it is active whenever a goal is set and not paused.
