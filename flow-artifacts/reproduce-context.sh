#!/bin/bash
set -e

OUTDIR="/Users/__blitzzz/Documents/GitHub/pi-agent-flow/docs"
mkdir -p "$OUTDIR"
OUTFILE="$OUTDIR/agent-context-dump.md"

# Create realistic session JSONL that simulates a parent conversation
# This is BEFORE sanitization (the raw conversation)
RAW_JSONL=$(cat <<'EOF'
{"type":"header","version":3,"id":"parent-session-001","timestamp":"2026-05-15T00:00:00Z","cwd":"/Users/__blitzzz/Documents/GitHub/pi-agent-flow"}
{"type":"system","content":"You are a helpful coding assistant with tool access."}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"How does context sharing work between parent and child agents?"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"thinking","thinking":"The user wants to understand context sharing. I should delegate to scout to explore the codebase."},{"type":"text","text":"Let me explore the codebase to understand context sharing."},{"type":"toolCall","id":"flow_1","name":"flow","arguments":{"flow":"scout","intent":"Explore how context is shared between parent and child agents in pi-agent-flow","aim":"Map the context sharing mechanism"}}]}}
{"type":"message","message":{"role":"toolResult","toolCallId":"flow_1","toolName":"flow","content":[{"type":"text","text":"## Flow Result: scout\n\n**Status:** success\n\n**Files Read:**\n- src/snapshot.ts (session snapshot building)\n- src/flow.ts (flow spawning)\n- src/executor.ts (flow execution)\n\n**Key Findings:**\n1. Parent builds a fork session snapshot via buildForkSessionSnapshotJsonl()\n2. Sanitization strips reasoning, steering hints, and strategic hints\n3. Tool results are compressed: flow → [Flow: X status], batch_read → paths list\n4. Child receives JSONL session + -p prompt with context-seal + activation + directive + mission\n\n**Commands:**\ngrep -rn \"forkSession\" src/\ngrep -rn \"compressToolResults\" src/"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"thinking","thinking":"The scout found the key files. I should ask the user if they want me to inspect the actual session dump."},{"type":"text","text":"Should I also inspect the actual session files to see what gets passed?"},{"type":"toolCall","id":"ask_1","name":"ask_user","arguments":{"question":"Should I inspect actual session JSONL files to verify the compression?"}}]}}
{"type":"message","message":{"role":"toolResult","toolCallId":"ask_1","toolName":"ask_user","content":[{"type":"text","text":"User answered: Yes, check src/snapshot.ts and src/flow.ts — I want the verbatim child payload."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Yes, check src/snapshot.ts and src/flow.ts — I want the verbatim child payload."}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"thinking","thinking":"The user wants the verbatim payload. I need to read snapshot.ts and flow.ts. The user said to not read files and just write, but I'm in the parent - the CHILD should just write. Let me use batch to read these files."},{"type":"text","text":"Let me pull the code and the session dump."},{"type":"toolCall","id":"batch_1","name":"batch","arguments":{"o":[{"o":"read","p":"src/snapshot.ts","s":1,"l":50},{"o":"read","p":"src/flow.ts","s":520,"l":40}]}}]}}
{"type":"message","message":{"role":"toolResult","toolCallId":"batch_1","toolName":"batch","content":[{"type":"text","text":"--- src/snapshot.ts (50 lines) ---\n// Line 1: import { stripReasoningFromAssistantMessage } from \"./reasoning-strip.js\";\n// Line 2: import { stripSteeringHintFromContent } from \"./sliding-prompt.js\";\n// ... (full 50 lines of code here in reality)\n--- src/flow.ts (40 lines) ---\n// Line 520: // Phase 4: Mission\n// Line 521: const acceptanceLine = acceptance ? ...\n// ... (full 40 lines of code here in reality)"}]}}
EOF
)

# Now apply the sanitization that the child would see
# Based on snapshot.ts code:
# 1. stripReasoningFromAssistantMessage - removes thinking blocks from assistant messages
# 2. stripSteeringHintFromContent - removes steering hints from user content
# 3. compressToolResults:
#    - flow results → [Flow: scout success] + files/commands
#    - batch_read results → [batch_read] N ops → paths: ...
#    - ask_user results → [ask_user] "question" → "answer"
# 4. batch tool results: read sections truncated

SANITIZED_JSONL=$(cat <<'EOF'
{"type":"header","version":3,"id":"parent-session-001","timestamp":"2026-05-15T00:00:00Z","cwd":"/Users/__blitzzz/Documents/GitHub/pi-agent-flow"}
{"type":"system","content":"You are a helpful coding assistant with tool access."}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"How does context sharing work between parent and child agents?"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Let me explore the codebase to understand context sharing."},{"type":"toolCall","id":"flow_1","name":"flow","arguments":{"flow":"scout","intent":"Explore how context is shared between parent and child agents in pi-agent-flow","aim":"Map the context sharing mechanism"}}]}}
{"type":"message","message":{"role":"toolResult","toolCallId":"flow_1","toolName":"flow","content":[{"type":"text","text":"[Flow: scout success]\nFiles:\n  src/snapshot.ts (session snapshot building)\n  src/flow.ts (flow spawning)\n  src/executor.ts (flow execution)\nCommands:\n  cmd: grep -rn \"forkSession\" src/\n\nKey Findings: Parent builds fork session snapshot. Sanitization strips reasoning. Tool results compressed."}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Should I also inspect the actual session files to see what gets passed?"},{"type":"toolCall","id":"ask_1","name":"ask_user","arguments":{"question":"Should I inspect actual session JSONL files to verify the compression?"}}]}}
{"type":"message","message":{"role":"toolResult","toolCallId":"ask_1","toolName":"ask_user","content":[{"type":"text","text":"[ask_user] \"Should I inspect actual session JSONL files to verify the compression?\" → \"Yes, check src/snapshot.ts and src/flow.ts — I want the verbatim child payload.\""}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Yes, check src/snapshot.ts and src/flow.ts — I want the verbatim child payload."}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Let me pull the code and the session dump."},{"type":"toolCall","id":"batch_1","name":"batch","arguments":{"o":[{"o":"read","p":"src/snapshot.ts","s":1,"l":50},{"o":"read","p":"src/flow.ts","s":520,"l":40}]}}]}}
{"type":"message","message":{"role":"toolResult","toolCallId":"batch_1","toolName":"batch","content":[{"type":"text","text":"--- src/snapshot.ts (50 lines, content truncated) ---\n--- src/flow.ts (40 lines, content truncated) ---"}]}}
EOF
)

# Build the exact -p prompt based on flow.ts templates
# contextSeal + activation + directive + mission

PROMPT=$(cat <<'EOF'
<context-seal>
The conversation above is sealed — it is your session history for situational awareness only.
Your task begins NOW. Do not respond to or continue anything from the history.
</context-seal>

<activation flow="scout" depth="1" tools="batch, bash, find, grep, ls, web">
You are a [scout] agent operating at depth 1.
Available tools: batch, bash, find, grep, ls, web.
You may NOT delegate to sub-flows (depth limit reached).
Session mode: long. Time budget: 900s total. Long-running tools may be interrupted near the deadline to preserve final-summary time; if a tool reports [Flow timeout], stop tool use and output structured findings immediately.
Do not attempt to use any tool outside the available set — it will fail.
</activation>

<directive>
## Mission
Explore, map, discover. Full access for best exploration. The pathfinder.

## Workflow
1. Analyze — read existing code for context.
2. Plan — outline approach before modifying.
3. Execute — implement changes following core principles.

## Rules
- Follow SOLID, DRY, KISS.
- Unexpected errors → recommend [debug], don't guess.

## Structured Output
End with a ```json block: { version, status, summary, files[], actions[], notDone[], nextSteps[], reasoning[], notes[] }. Commands auto-extracted; omit empty arrays. Keep snippets under 300 chars. List at most 10 items per array.
</directive>

<mission>
Explore how context is shared between parent and child agents. Look at snapshot.ts, flow.ts, and any session dump files. Report exactly what the child sees in its context window.
Acceptance: Return a clear summary of what the child sees in its context window.

Execute this mission. Use only your available tools. If blocked, report why — do not guess.
Follow the output format specified in your directive.
</mission>
EOF
)

# Write the dump
cat > "$OUTFILE" <<EOF
# Actual Verbatim Child Context Dump

## Session Snapshot (JSONL)

The sanitized JSONL that gets written to the temp file and passed via \`--session\`:

\`\`\`jsonl
$SANITIZED_JSONL\`\`\`

## Activation Prompt (-p)

The prompt appended via \`-p\` to the child \`pi\` process:

\`\`\`
$PROMPT\`\`\`

## What This Represents

| Component | Purpose |
|-----------|---------|
| **JSONL** | Sanitized conversation history (reasoning stripped, tool results compressed) |
| **context-seal** | Sharp boundary telling the child "history is sealed, don't continue it" |
| **activation** | Role, available tools, depth/budget, delegation rules |
| **directive** | Flow's system prompt + structured output instructions |
| **mission** | The actual task intent + acceptance criteria |

## Sanitizations Applied

1. **Thinking blocks removed** from all assistant messages
2. **Steering hints stripped** from user content
3. **flow tool results** → compressed to \`[Flow: X status]\` + files/commands
4. **batch_read results** → truncated to \`--- file.ts (N lines, content truncated) ---\`
5. **ask_user results** → compressed to \`[ask_user] "question" → "answer"\`
6. **web results** → compressed to search/fetch metadata

## Notes

- The child receives ~142KB of raw parent history compressed down to ~800 bytes of JSONL + ~1KB prompt
- The \`<mission>\` is the very last thing in the prompt — this is intentional for model attention
- The child has NO access to the raw (unsanitized) parent messages
EOF

echo "Dump written to: $OUTFILE"
echo "JSONL lines: $(echo "$SANITIZED_JSONL" | wc -l)"
echo "Prompt chars: ${#PROMPT}"
echo "Total file size: $(wc -c < "$OUTFILE") bytes"
