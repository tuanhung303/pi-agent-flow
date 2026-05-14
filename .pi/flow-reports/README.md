# Flow Reports

This directory contains structured, timestamped reports from flow executions. Each report captures the complete output of a flow run — files touched, actions taken, reasoning, and notes — so we can analyze and improve our flow definitions over time.

## Reports

| Date | Flow | Status | Summary |
|------|------|--------|---------|
| 2026-05-15 | scout | complete | Comprehensive map of pi-agent-flow; identified circular imports, unclamped maxDepth, deprecated exports |
| 2026-05-15 | build | success | Fixed flaky illuminate-mode tests in scramble.test.ts |

## How to Add a Report

When a flow finishes, export its structured output as a new markdown file named `YYYY-MM-DDTHHMM-{flow-type}.md` and update this index table.
