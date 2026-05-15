# Flow Artifacts

This directory contains pi-agent-flow related files copied from `/tmp` for archival and reference.

## Catalog

| File | Original Path | Size | Description |
|------|--------------|------|-------------|
| `pi-context-test.jsonl` | `/tmp/pi-context-test.jsonl` | 3.0K | Session metadata and model change events in JSONL format |
| `test-session.jsonl` | `/tmp/test-session.jsonl` | 424B | Test session with header, system prompt, and message events |
| `pi-run-output.log` | `/tmp/pi-run-output.log` | 277K | Full pi run output log with session, agent_start, turn_start, and message events |
| `flow-dump.md` | `/tmp/flow-dump.md` | 1.4M | Markdown session snapshot containing JSONL events including thinking level changes |
| `pi-context-test.md` | `/tmp/pi-context-test.md` | 7B | Simple test output file containing "success" |
| `pi-context-test2.md` | `/tmp/pi-context-test2.md` | 8B | Simple test output file containing "success2" |
| `payload-test.txt` | `/tmp/payload-test.txt` | 20B | Payload test result indicating "env var test passed" |
| `payload-validate.txt` | `/tmp/payload-validate.txt` | 23B | Payload dump validation result |

## Dump Artifacts (`dumps/`)

| File | Size | Flow | Description |
|------|------|------|-------------|
| `pi-dump.scout.1778858936231.md` | 5.0K | scout | Snapshot dump mapping compression code for craft flow |
| `pi-dump.scout.1778859042499.md` | 5.9K | scout | End-to-end dump/snapshot pipeline map (parallel scout 1) |
| `pi-dump.scout.1778859042501.md` | 6.0K | scout | Flow context fork and session snapshot map (parallel scout 2) |
| `pi-dump.scout.1778859057365.md` | 4.9K | scout | Project structure and flow architecture map (sequence start) |
| `pi-dump.scout.1778859099149.md` | 8.6K | scout | Deep dive into dump/snapshot system (sequence follow-up) |
| `pi-dump.craft.1778858979353.md` | 10K | craft | Craft flow writing snapshot troubleshooting guide |
| `pi-dump.build.1778859162642.md` | 9.8K | build | Build flow exporting /tmp dump artifacts to repo (this mission) |
| `pi-dump.scout.1778858936231.txt` | 2.6K | scout | Raw activation prompt (-p) for snapshot compression code scout |
| `pi-dump.scout.1778859042499.txt` | 2.8K | scout | Raw activation prompt (-p) for dump pipeline scout |
| `pi-dump.scout.1778859042501.txt` | 2.8K | scout | Raw activation prompt (-p) for flow context fork scout |
| `pi-dump.scout.1778859057365.txt` | 2.6K | scout | Raw activation prompt (-p) for project structure scout |
| `pi-dump.scout.1778859099149.txt` | 2.7K | scout | Raw activation prompt (-p) for dump system deep dive |
| `pi-dump.craft.1778858979353.txt` | 3.7K | craft | Raw activation prompt (-p) for troubleshooting guide craft |
| `pi-dump.build.1778859162642.txt` | 2.6K | build | Raw activation prompt (-p) for dump export build (this mission) |

## Notes

- No npm tarballs (`pi-agent-flow-*.tgz`) or tarball directories were copied.
- All files were copied on 2026-05-15 and sizes were verified against originals.
