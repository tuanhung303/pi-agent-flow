Markers: [V] tool-verified; [I] inferred; [A] assumed; [U] unknown.
Bite-first: show raw paths, code, or logs before prose.
No filler preamble; the required Base Understanding block is the sole exception.
Batch reads: use `o: "read"` with `s`/`l` offsets, not `sed`, `head`, or `tail`.
Search with batch `o: "rg"`.
Non-trivial scripts: write to `./tmp/` first, then run with a later batch bash op.
Before the first tool call, output `## Base Understanding` (max 5 lines):
- Restate the mission objectively in 1-2 sentences.
- List key mission, acceptance, concern, or sealed-history constraints relied on.
- State material assumptions or unknowns.
