# 4. Phase 3 Operational Hardening for Hatchet

Date: 2026-05-14

## Status

Proposed

## Context

A basic Hatchet backend introduces operational concerns that local execution does not have: worker environment drift, workspace assumptions, queue retries, payload sizes, secrets, and spawn-command correctness.

These checks should be addressed before treating Hatchet execution as production-ready.

## Decision

Add hardening around the Hatchet backend before expanding user-facing features. Required guardrails include spawn-command validation, workspace and package-version checks, explicit environment propagation rules, payload-size limits, retry/failover boundaries, and documentation for local and remote workers.

Model failover remains owned by `executeFlows()`; Hatchet retries must not blindly repeat an entire failover sequence unless explicitly configured.

## Acceptance Criteria

This ADR may move to Accepted when:

- Workers validate the spawn command and fail early with actionable diagnostics.
- Workspace, package-version, environment propagation, and payload-size checks are implemented or explicitly documented.
- Retry behavior is bounded so Hatchet retries do not accidentally duplicate model failover semantics.
- Local and remote worker setup docs cover required secrets and environment variables.

## Consequences

- Misconfigured workers fail early with actionable diagnostics.
- Secrets and environment propagation are deliberate rather than accidental.
- Remote-worker behavior is easier to reason about and support.
- Some setup complexity is added, but it protects correctness and operability.
