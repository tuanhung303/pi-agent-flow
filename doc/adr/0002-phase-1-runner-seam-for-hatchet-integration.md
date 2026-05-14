# 2. Phase 1 Runner Seam for Hatchet Integration

Date: 2026-05-14

## Status

Accepted

## Context

Hatchet support should be introduced without changing the existing default flow execution semantics. The current execution path resolves flow attempts in `executeFlows()` and delegates each attempt to `runFlow()`, which owns Pi-specific child-process behavior such as session snapshots, environment propagation, timeouts, structured output parsing, and cleanup.

Phase 1 is already implemented in PR #1 as a local runner seam.

## Decision

Introduce a `FlowRunner` abstraction and a default local runner that calls `runFlow()` directly. Keep `executeFlows()` responsible for flow resolution, model failover, depth checks, and concurrency policy while routing execution through the runner seam.

Do not add Hatchet dependencies or worker entrypoints in this phase.

## Acceptance Criteria

This ADR may move to Accepted when:

- The `FlowRunner` interface exists and default execution uses a local runner.
- Local execution still calls `runFlow()` and preserves existing flow behavior.
- Focused tests cover the runner seam without requiring real child-process flow execution.
- CI-relevant checks pass for the phase 1 change.

## Consequences

- Default local execution remains the compatibility baseline.
- Future Hatchet work can be added behind the runner interface instead of rewriting `runFlow()`.
- Tests can verify behavior through a runner seam without spawning real child processes.
- The abstraction must stay small enough to avoid duplicating executor responsibilities.
