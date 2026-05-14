# 5. Phase 4 Advanced Hatchet UX

Date: 2026-05-14

## Status

Proposed

## Context

The initial Hatchet backend intentionally defers child-process token streaming and cancellation. Those features matter for parity with local execution, especially for long-running child flows and interactive observability. They should be added only after the basic backend and hardening work are stable.

Phase 4 is broad, so it can ship in coherent slices while this ADR remains Proposed until all acceptance criteria are met.

## Decision

Add advanced Hatchet UX features incrementally: stream `onUpdate` events through Hatchet-compatible event channels, propagate cancellation from the parent to Hatchet and then to the child process group, expose better run observability, and consider remote snapshot or object-store support if payload size limits require it. Do not block the basic backend on these features.

The first Phase 4 slice adds parent-side lifecycle observability for Hatchet-backed attempts. The parent emits `queued/running`, `completed`, and `failed` updates through the existing flow progress path around Hatchet task submission. This improves queue-level transparency without pretending that worker-side token streaming or cancellation propagation are complete.

## Acceptance Criteria

This ADR may move to Accepted when:

- Hatchet-backed runs can surface live flow updates with behavior comparable to local `onUpdate` reporting.
- Parent cancellation propagates through Hatchet to child process-group termination.
- Observability for queued/running/completed Hatchet flow attempts is documented.
- Large snapshot or remote-worker payload handling is implemented or explicitly ruled out.

## Consequences

- Hatchet support can ship incrementally while preserving a clear path to local-execution parity.
- Long-running runs become more transparent once streaming is added.
- Parent-side lifecycle updates improve immediate UX but are not a replacement for worker-side streaming.
- Cancellation semantics must be carefully tested to avoid orphaning child processes.
- Additional infrastructure may be needed for large snapshots or remote workers.
