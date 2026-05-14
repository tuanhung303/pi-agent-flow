# 5. Phase 4 Advanced Hatchet UX

Date: 2026-05-14

## Status

Proposed

## Context

The initial Hatchet backend intentionally defers live update streaming and cancellation. Those features matter for parity with local execution, especially for long-running child flows and interactive observability.

They should be added only after the basic backend and hardening work are stable.

## Decision

Add advanced Hatchet UX features in a later phase: stream `onUpdate` events through Hatchet-compatible event channels, propagate cancellation from the parent to Hatchet and then to the child process group, expose better run observability, and consider remote snapshot or object-store support if payload size limits require it.

Do not block the basic backend on these features.

## Acceptance Criteria

This ADR may move to Accepted when:

- Hatchet-backed runs can surface live flow updates with behavior comparable to local `onUpdate` reporting.
- Parent cancellation propagates through Hatchet to child process-group termination.
- Observability for queued/running/completed Hatchet flow attempts is documented.
- Large snapshot or remote-worker payload handling is implemented or explicitly ruled out.

## Consequences

- Hatchet support can ship incrementally while preserving a clear path to local-execution parity.
- Long-running runs become more transparent once streaming is added.
- Cancellation semantics must be carefully tested to avoid orphaning child processes.
- Additional infrastructure may be needed for large snapshots or remote workers.
