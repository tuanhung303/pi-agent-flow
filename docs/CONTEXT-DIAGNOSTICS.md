# Context Diagnostics Runbook

Diagnose high token counts in child flows fast. Reference (do not duplicate):
- [`docs/agent-payload-example.md`](agent-payload-example.md) — full payload anatomy
- [`docs/agent-context-dump.md`](agent-context-dump.md) — verbatim child context dump

---

## 1. Quick Start: Capture Dumps

```bash
# Method A: per-flow dump files (recommended)
export PI_FLOW_DUMP_SNAPSHOT=/tmp/pi-dump
pi
# → /tmp/pi-dump.<flow>.<ts>.md  (JSONL + prompt + stats)
# → /tmp/pi-dump.<flow>.<ts>.txt  (prompt only)

# Method B: live stderr telemetry
export PI_FLOW_DEBUG_CONTEXT=1
pi
# → [context-compress] flow: 142387 → 87 bytes (100% reduction)
# → [context-snapshot] pre: 184320 → 2450 bytes (99% reduction)
```

> ⚠️ Export in the **same shell** that starts `pi`. Subshell exports do not propagate.

---

## 2. Read the `compression-stats` from `sanitizeForkSnapshot`

Stats are returned **out-of-band** in the `stats` property of `sanitizeForkSnapshot`'s return value. They are **not** appended to the child-visible JSONL (that would be telemetry noise for the model). Dump consumers can access them via:

```json
{"preBytes":184320,"postBytes":2450,"reductionPercent":99}
```

| Field | Meaning | Threshold |
|-------|---------|-----------|
| `preBytes` | Raw snapshot size before sanitization | > 100 KB = investigate |
| `postBytes` | Size after all passes | > 20 KB = investigate |
| `reductionPercent` | Overall compression | < 50% = something leaked |

**If `reductionPercent` is low,** one of the sanitization passes failed to fire or a new tool type is bloating the payload.

---

## 3. Known Bloat Sources

| Vector | Symptom | Fix / Mitigation | Code |
|--------|---------|------------------|------|
| **Flow cache miss** | `[flow] prior result · 150000 chars (not cached or evicted)` | Increase `PI_FLOW_CACHE_MAX_ENTRIES` (default 100). Eviction is FIFO. | `src/core/executor.ts:~167` |
| **Flow cache corruption** | `undefined` in `[Flow: …]` output → fallback to raw | Fix the flow’s structured-output JSON so `renderCompressedFlowResult` produces valid text. | `src/snapshot/snapshot.ts:~93` |
| **Batch file reads** | `--- file.ts (2000 lines) ---` repeated in child | Normal. `compressBatchResult` keeps bash verbatim; file reads are truncated to headers. Child can re-read with `batch`. | `src/snapshot/snapshot.ts:~216` |
| **Web search/fetch** | Raw page HTML in snapshot | Should compress to `[web:search] …` or `[web:fetch] …`. If not, check `compressWebResult` regex mismatch. | `src/snapshot/snapshot.ts:~267` |
| **ask_user results** | Full Q&A transcript in child | Should compress to `[ask_user] "Q" → "A"`. | `src/snapshot/snapshot.ts:~305` |
| **Reasoning / thinking** | `<thinking>` blocks visible in child | Stripped by `sanitizeForkSnapshot`. If present, check `stripReasoningFromAssistantMessage`. | `src/snapshot/snapshot.ts:~841`, `src/snapshot/reasoning-strip.ts` |
| **Steering hints** | `<pi-flow-steering-hint>` tags in child | Stripped by `stripSteeringHintFromContent`. If present, hint tag constants changed. | `src/snapshot/snapshot.ts:~899`, `src/steering/sliding-prompt.ts` |
| **batch_read orphans** | API rejects with `tool_call_id is not found` | `stripBatchReadToolCalls` removes calls + results. If failure persists, a toolCallId is mismatched. | `src/snapshot/snapshot.ts:~592` |

---

## 4. Diagnostic Flowchart

```
1. Run PI_FLOW_DEBUG_CONTEXT=1 and trigger the slow flow.
   ↓
2. Check stderr for [context-snapshot] reduction.
   ↓
   ├─ < 50%? → Go to 3.
   └─ ≥ 90%? → Bloat is elsewhere (model context limit, not payload).
   ↓
3. Check [context-compress] lines per tool.
   ↓
   ├─ flow: huge before → Cache miss? Increase cache size or check cache key.
   ├─ batch: huge before → File reads not truncating? Check compressBatchResult.
   ├─ web: huge before → compressWebResult regex mismatch? Inspect raw text.
   └─ ask_user: huge before → compressAskUserResult failed? Inspect raw text.
   ↓
4. Capture PI_FLOW_DUMP_SNAPSHOT and inspect the .md file.
   ↓
   ├─ JSONL still has reasoning? → Check stripReasoningFromAssistantMessage.
   ├─ JSONL has steering hints? → Check stripSteeringHintFromContent.
   ├─ JSONL has batch_read calls? → Check stripBatchReadToolCalls.
   └─ compression-stats missing? → sanitizeForkSnapshot did not run.
   ↓
5. Fix the source → rebuild → retest with debug context on.
```

---

## 5. Code References by Pass

| Pass | Function | File |
|------|----------|------|
| Strip steering hints | `stripSteeringHintFromContent`, `stripSteeringHintText` | `src/steering/sliding-prompt.ts` |
| Strip reasoning | `stripReasoningFromAssistantMessage` | `src/snapshot/reasoning-strip.ts` |
| Strip batch_read | `stripBatchReadToolCalls` | `src/snapshot/snapshot.ts:~592` |
| Compress flow | `compressToolResults` → `renderCompressedFlowResult` | `src/snapshot/snapshot.ts:~365`, `~93` |
| Compress batch | `compressBatchResult` | `src/snapshot/snapshot.ts:~216` |
| Compress web | `compressWebResult` | `src/snapshot/snapshot.ts:~267` |
| Compress ask_user | `compressAskUserResult` | `src/snapshot/snapshot.ts:~305` |
| Snapshot assembly | `sanitizeForkSnapshot` | `src/snapshot/snapshot.ts:~726` |
| Dump writer | `makeUniqueDumpPath` + atomic write | `src/core/flow.ts:~671` |

---

## 6. Checklist: Before Escalating

- [ ] `PI_FLOW_DEBUG_CONTEXT=1` shows per-tool compression ratios
- [ ] `PI_FLOW_DUMP_SNAPSHOT` produces `.md` and `.txt` files for the affected flow
- [ ] `compression-stats` are present in the dump artifact header (out-of-band, not a JSONL line)
- [ ] No `[flow] prior result · N chars (not cached or evicted)` placeholders for recent flows
- [ ] `batch_read` tool calls are absent from child snapshot (should be stripped entirely)
- [ ] Reasoning blocks are absent from assistant messages in dump
- [ ] Rebuild (`npm run build`) and retest after any code change
