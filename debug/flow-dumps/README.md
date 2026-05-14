# Verbatim Flow Dumps

These are the verbatim payload dumps from the current `pi` session (May 15).
They capture the exact JSONL + activation prompt sent to the model.

| File | Size | What |
|------|------|------|
| `flow-dump.md` | ~1.4 MB | Latest dump — 38 JSONL events + activation prompt (scout run that located these files) |
| `snapshot-dump.md` | ~443 KB | Prior dump — 27 JSONL events + activation prompt (earlier pipeline-tracing scout) |

These files are generated when `PI_FLOW_DUMP_SNAPSHOT` is exported in the shell before starting `pi`.
Do **not** commit stale dumps — always refresh from `/tmp` before archiving.
