# 3. Phase 2 Basic Hatchet Backend

Date: 2026-05-14

## Status

Proposed

## Context

After the local runner seam exists, the next step is to make Hatchet available as an optional backend. The first Hatchet integration should prioritize low risk and should not attempt to reproduce all live local behavior immediately.

Some `runFlow()` inputs are not safe to serialize across a queue, including `AbortSignal`, live update callbacks, and local detail factories.

## Decision

Add an optional Hatchet runner selected by configuration such as `PI_FLOW_RUNNER=hatchet`. The Hatchet task payload must be plain JSON. A worker entrypoint will receive the payload, reconstruct local helpers, and call `runFlow()` as the execution primitive.

The first Hatchet backend returns final results only. Live streaming and cancellation propagation are deferred.

## Consequences

- Hatchet can manage queueing and worker slots while Pi keeps child-flow semantics in `runFlow()`.
- The Hatchet SDK should be dynamically loaded or otherwise optional so existing local users are unaffected.
- The worker must set or validate `PI_FLOW_SPAWN_COMMAND=pi` so spawned child flows do not execute the worker entrypoint.
- Serialization boundaries become explicit and testable.
