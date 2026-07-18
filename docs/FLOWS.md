# Flows Reference

## Why Flow Style?

Flow-style transition is designed for **context efficiency**. Instead of launching every flow state with the full, ever-growing conversation history, each flow receives only what it needs: your intent and (when appropriate) a sanitized session snapshot.

This approach delivers four concrete benefits:

1. **Avoid duplicate tool calls** — every flow state launch no longer re-runs the same `read`, `grep`, or `bash` commands that the parent already performed.
2. **Prevent context bloat** — long transcripts with repeated file listings and command outputs are kept out of the main conversation thread.
3. **Eliminate unnecessary noise** — the parent agent sees only structured results (`summary`, `notDone`, `nextSteps`, etc.) instead of pages of intermediate reasoning.
4. **Preserve focus** — each flow stays locked on its intent because it isn't distracted by unrelated earlier messages.

The result is faster, cheaper, and cleaner transition: the main agent remains uncluttered while specialized flows do the heavy lifting in isolated contexts.

## Shared Context

When you transition to a flow, the flow state receives an automatic **sanitized fork** of your current session. This lets you write concise intents that focus on **what new work to do** rather than restating the full problem.

### How it works

1. **Snapshot serialized** — chronological parent conversation and completed tool/`flow` interactions are collected as JSONL history.
2. **Sanitized and optimized** — the active interaction, reasoning/thinking artifacts, and non-inheritable metadata are removed while native completed interactions remain available for deduplication.
3. **Compressed and flattened** — retained outputs use the configured compression policy; completed interactions become labelled assistant text, and `batch_read` history is excluded. Default/`none` output is capped per completed result while retaining head/tail failure evidence.
4. **Budgeted** — when the selected model exposes `maxContextTokens`, the finalized JSONL is capped at 60% of that window, preserving session identity, the context seal, and the newest user mission first. An oversized mission is explicitly marked as truncated; a window too small for a sealed snapshot receives no inherited history.
5. **Forked** — the provider-neutral snapshot is loaded via `--session`; the child starts a fresh provider-owned tool lifecycle.

### Writing good intents

Parallel flows receive independently built snapshots, so each flow's tier, context profile, and model window are applied to its own fork. When a flow has known failover candidates, its snapshot uses the smallest known candidate context window so retrying cannot overflow a smaller model; unknown windows do not impose an artificial cap.

The child already sees what you've done. Write intents that say **what to do next**, not what context it needs:

| ❌ Bad intent | ✅ Good intent |
|---|---|
| `"The auth module uses JWT tokens… inspect src/auth/ for security issues"` | `"Audit the auth module for security issues"` |
| `"We already found the bug… run the failing test and fix it"` | `"Fix the failing test in tests/auth.test.ts"` |
| `"The file structure is… implement the feature described in the PRD"` | `"Implement the feature described in the PRD"` |

### Clean slate

Set `inheritContext: false` in a custom flow's front-matter to start with a clean slate. The child receives only your `intent` — no inherited session. This is ideal for unbiased creative work in `ideas` flows.

### What the child sees

The child's `<context-seal>` prompt tells it: *"The conversation above is sealed — it is your session history for situational awareness only."* Completed parent tool and `flow` work appears as labelled historical text, not replayable native calls. `batch_read` history is absent. The child can reuse prior findings, but every tool call it makes is a new call owned by the child's provider session.

## Depth boundary

`PI_FLOW_DEPTH` and `PI_FLOW_MAX_DEPTH` are resolved before tool registration. At the configured limit the `flow` tool is intentionally not registered, while `trace` remains available for read-only inspection. This is the canonical depth guard; child process propagation uses the same values.

## Bundled Flows

| Flow | Purpose | Tools | Tier |
|------|---------|-------|------|
| `[scout]` | Discover files, trace code paths, map architecture | `batch`, `bash`, `find`, `grep`, `ls`, `web` | `lite` |
| `[debug]` | Investigate logs, errors, stack traces, root causes, and fix bugs | `batch`, `bash`, `find`, `grep`, `ls`, `web` | `lite` |
| `[trace]` | Read files verbatim, run checks, explore codebase | `batch`, `bash`, `find`, `grep`, `ls`, `web` | `lite` |
| `[build]` | Implement features, fix bugs, write tests, deploy, and ship | `batch`, `bash`, `find`, `grep`, `ls`, `web` | `flash` |
| `[craft]` | Plan structure, break down requirements, design solutions | `batch`, `bash`, `find`, `grep`, `ls`, `web` | `full` |
| `[audit]` | Audit security, quality, correctness; provide feedback and verdict — no code edits | `batch`, `bash`, `find`, `grep`, `ls`, `web` | `flash` |
| `[ideas]` | Generate ideas, explore possibilities, and think creatively using inherited context | `batch`, `bash`, `find`, `grep`, `ls`, `web` | `full` |

> **Note:** All bundled flows have `maxDepth: 0`, meaning they do not transition further by default. Custom flows can override this via front-matter.

> **Clean slate:** Set `inheritContext: false` in a custom flow's front-matter so it receives only the intent, ideal for unbiased creative work.

> **Docs hygiene:** Bundled `build` and `debug` flows are instructed to update relevant documentation after their work when the findings or implementation change developer or operational knowledge. If no docs apply, they should state why in the final report.

## Shared Conventions and Base Understanding

`agents/_conventions.md` is the plain-Markdown source for rules shared by child prompts. Discovery ignores every underscore-prefixed Markdown file as a flow, then resolves `_conventions.md` with **bundled < user < project** precedence. User files live in `~/.pi/agent/agents/` (or `PI_CODING_AGENT_DIR/agents/`); project files live in `.pi/agents/`. The resolved content is injected once as `## Conventions` inside `<directive>`, after the selected flow's own prompt. If no conventions file exists, no section is injected.

Every child `<mission>` also requires a `## Base Understanding` block before its first tool call. It is limited to five lines and must factually restate the mission, name the relevant constraints/context, and identify material assumptions or unknowns. It is not final-report filler: `trace` still ends with its JSON block only.

## Session Modes

Each flow call may set `complexity` to choose the flow state time budget:

| Complexity | Budget | Review | Recommended use |
|------------|-------:|:------:|:----------------|
| `snap` | 120s | no | ultra-quick checks, syntax scans, one-liner verifications |
| `simple` | 300s | no | quick scouting, narrow checks, small design passes |
| `moderate` | 600s | 1x | normal flow work; this is the default |
| `complex` | 900s | 2x | large builds, full test runs, broad refactors, complex debugging |
| `intricate` | 1200s | 3x | very large refactors, extensive audits, or multi-step debugging sessions |

Example:

```json
{
  "flow": [
    {
      "type": "build",
      "intent": "Run the full test suite and fix failures",
      "aim": "Fix failing tests",
      "complexity": "complex"
    }
  ]
}
```

The public interface is mode-based; arbitrary per-flow numeric timeouts are not exposed.

Complexity precedence:

```txt
per-flow complexity > --flow-complexity > PI_FLOW_COMPLEXITY > flowSettings.complexity > moderate
```

## Timeout Behavior

Flows are aware of their deadline from the moment they start:

- **Prompt injection** — the activation block includes the exact time budget and warns the agent to wrap up before the deadline.
- **Parent UI countdown** — a live `MM:SS` countdown is shown next to the flow's aim while it runs.
- **Two-stage warnings** — at 2 minutes before hard timeout a warning is injected into the child's reminder stream; at 2 minutes 15 seconds a final urge demands the agent stop all tool use and output structured findings.
- **Grace period** — after the hard timeout fires, the agent gets a 90-second reporting grace to finish its summary before the process is force-killed.
- **Graceful shutdown** — when the parent receives `SIGINT` or `SIGTERM`, the signal propagates to every child process group so flow states terminate cleanly instead of becoming orphans.

## Audit Loop

When a `build` flow runs with `auditLoop > 0`, the executor automatically spawns a paired `audit` flow after the build completes. The audit reviews the build's output and returns a `verdict`: `pass` or `rework`. If `rework`, the build re-runs with the audit's feedback injected into its intent.

### How it works

1. **Build runs** — writes files, produces output.
2. **Audit reviews** — checks for security, correctness, completeness.
3. **Verdict** — `pass` (done) or `rework` (build re-runs with feedback).
4. **Cycle repeats** — up to `auditLoop` rework cycles.

### Parameters

| Parameter | Default | Description |
|---|---|---|
| `auditLoop` | `0` | Override audit ping-pong cycles. Effective = max(this, complexity-implied). `0` = no override. |

### Visual rendering

Builds and their paired audit are grouped in the TUI with a shared header showing the aggregate state (`● ● ○`). Builds render first, the audit capstone renders last. During execution, dormant flows show `[awaiting...]`; on completion, approved flows show `[approved]`.

### Grouped audit

When multiple `build` flows share the same `auditLoop` value, they share a single audit capstone. The audit receives all build outputs and returns per-build verdicts. Only builds flagged `rework` re-run — others stay approved.

### Audit agent behavioral change

The `audit` flow shifted from a **fixer** (that would apply patches directly) to a **reviewer** (that returns a structured verdict with feedback). The build flow consumes the feedback and applies fixes itself. This separation of concerns keeps the audit focused on analysis and the build focused on implementation.

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

### Loop mode

`/flow:loop enable` enables budget handoff only for an active goal owned by the current session (legacy unbound goals remain available to that session); it always uses that goal's objective. It accepts no custom objective because loop state does not replace the active goal. Supplying `--max-tokens` or `--max-flows` to `/flow:goal set` automatically creates a **fresh active loop** for that goal. At a budget limit, that loop requests a warp rather than pausing the goal. A manual `set` replacement or `clear` abandons the old goal and removes its loop state; only the internal `/flow:warp` handoff preserves loop counters across sessions.

| Command | Effect |
|---------|--------|
| `/flow:loop disable` | Pauses loop-mode auto-warp only. The active goal remains active and normal continuation still runs. |
| `/flow:loop stop` | Terminates loop mode for the current loop state. It does not pause or complete the active goal; use `/flow:goal pause` to pause continuation. A later budget limit follows normal goal behavior and pauses that goal. |
| `/flow:loop reset` | Reactivates loop mode and clears its cross-session counters without changing the active goal. |
| `/flow:loop status` | Shows loop-mode state and counters. |

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

1. On `turn_end`, if a goal is **active**, the continuation hook checks token/flow budgets. If `maxTokens` or `maxFlows` is exceeded, a non-loop goal is **auto-paused** and receives a hidden budget-limit message. An active loop instead sends a hidden warp request to the root state; the root invokes `/flow:warp` to start the next session.
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
- `current`: the active goal (`id`, `objective`, `acceptance`, `createdAt`, `updatedAt`, `status`, `completedFlows`, `totalTokens`, `maxTokens`, `maxFlows`, `sessionId`). During a warp it also holds a transient `pendingWarpSessionId` handoff lock; it is cleared atomically when the new session takes ownership or when warp is cancelled/fails. Legacy loop-level locks are migrated on read.
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
