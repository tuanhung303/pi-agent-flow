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

## Consequences

- Hatchet support can ship incrementally while preserving a clear path to local-execution parity.
- Long-running runs become more transparent once streaming is added.
- Cancellation semantics must be carefully tested to avoid orphaning child processes.
- Additional infrastructure may be needed for large snapshots or remote workers.
