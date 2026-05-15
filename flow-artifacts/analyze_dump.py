import json, re

with open("debug/flow-dumps/flow-dump.md") as f:
    content = f.read()

parts = content.split("## Activation Prompt (-p)")
jsonl_part = parts[0].split("## Session Snapshot (JSONL)")[1].strip()
activation = parts[1].strip() if len(parts) > 1 else ""

lines = [l for l in jsonl_part.split("\n") if l.strip()]
print(f"=== JSONL EVENT ANALYSIS ===")
print(f"Total JSONL lines: {len(lines)}")
print()

types = {}
roles = {}
has_content = 0
tool_names = {}
for line in lines:
    try:
        obj = json.loads(line)
        t = obj.get("type", "unknown")
        types[t] = types.get(t, 0) + 1
        if t == "message":
            role = obj.get("message", {}).get("role", "unknown")
            roles[role] = roles.get(role, 0) + 1
            if "content" in obj.get("message", {}):
                has_content += 1
            content = obj.get("message", {}).get("content", [])
            if isinstance(content, list):
                for part in content:
                    if part.get("type") == "toolCall":
                        name = part.get("name", "unknown")
                        tool_names[name] = tool_names.get(name, 0) + 1
    except:
        pass

print("Event types:")
for t, c in sorted(types.items(), key=lambda x: -x[1]):
    print(f"  {t}: {c}")
print()
print("Message roles:")
for r, c in sorted(roles.items(), key=lambda x: -x[1]):
    print(f"  {r}: {c}")
print()
print("Tool calls:")
for t, c in sorted(tool_names.items(), key=lambda x: -x[1]):
    print(f"  {t}: {c}")
print()

print("=== STEERING HINT CHECK ===")
steering_count = 0
for line in lines:
    if "pi-flow-steering-hint" in line:
        steering_count += 1
print(f"Total steering hint occurrences: {steering_count}")
print()

print("=== REASONING CHECK ===")
reasoning_fields = ["thinking", "reasoning", "reasoning_content", "reasoningContent", "thinkingSignature", "thinking_signature", "reasoningSignature", "reasoning_signature"]
for field in reasoning_fields:
    count = sum(1 for line in lines if f'"{field}"' in line)
    if count:
        print(f"  {field}: {count} occurrences (SHOULD BE STRIPPED)")
print()

print("=== batch_read CHECK ===")
batch_read_tool_calls = 0
batch_read_tool_results = 0
for line in lines:
    try:
        obj = json.loads(line)
        if obj.get("type") == "message":
            msg = obj.get("message", {})
            role = msg.get("role", "")
            content = msg.get("content", [])
            if isinstance(content, list):
                for part in content:
                    if part.get("type") == "toolCall" and part.get("name") == "batch_read":
                        batch_read_tool_calls += 1
                    if part.get("type") == "toolResult" and part.get("name") == "batch_read":
                        batch_read_tool_results += 1
    except:
        pass
print(f"batch_read toolCalls: {batch_read_tool_calls}")
print(f"batch_read toolResults: {batch_read_tool_results}")
print()

print("=== ACTIVATION PROMPT ANALYSIS ===")
print(f"Total activation length: {len(activation)}")
for tag in ["context-seal", "activation", "directive", "mission"]:
    open_tag = f"<{tag}"
    close_tag = f"</{tag}>"
    has_open = open_tag in activation
    has_close = close_tag in activation
    print(f"  <{tag}>: open={has_open}, close={has_close}")

depth_match = re.search(r'depth="(\d+)"', activation)
if depth_match:
    print(f"  Depth: {depth_match.group(1)}")

tools_match = re.search(r'tools="([^"]+)"', activation)
if tools_match:
    print(f"  Tools: {tools_match.group(1)}")

mission_match = re.search(r'<mission>(.*?)</mission>', activation, re.DOTALL)
if mission_match:
    m = mission_match.group(1).strip()[:200]
    print(f"  Mission preview: {m}...")

# Check for flow tool result compression
print()
print("=== FLOW RESULT COMPRESSION CHECK ===")
flow_results = 0
for line in lines:
    try:
        obj = json.loads(line)
        if obj.get("type") == "message":
            msg = obj.get("message", {})
            if msg.get("role") in ["tool", "toolResult"]:
                content = msg.get("content", "")
                text = ""
                if isinstance(content, str):
                    text = content
                elif isinstance(content, list):
                    for part in content:
                        if part.get("type") == "text":
                            text = part.get("text", "")
                if text.startswith("[Flow:") or "[flow]" in text:
                    flow_results += 1
                    print(f"  Found compressed flow result: {text[:100]}...")
    except:
        pass
print(f"Total compressed flow results: {flow_results}")
