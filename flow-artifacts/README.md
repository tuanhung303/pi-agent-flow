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

## Notes

- No npm tarballs (`pi-agent-flow-*.tgz`) or tarball directories were copied.
- All files were copied on 2026-05-15 and sizes were verified against originals.
