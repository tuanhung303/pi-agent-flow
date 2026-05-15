import { buildFlowArgs } from '/Users/__blitzzz/Documents/GitHub/pi-agent-flow/dist/flow.js';
import * as fs from 'node:fs';

// Realistic scout flow config
const flow = {
  name: 'scout',
  description: 'Explore, map, discover. The pathfinder.',
  tools: ['batch', 'bash', 'find', 'grep', 'ls', 'web'],
  tier: 'lite',
  systemPrompt: '## Mission\nExplore, map, discover. Full access for best exploration. The pathfinder.\n\n## Workflow\n1. Analyze — read existing code for context.\n2. Plan — outline approach before modifying.\n3. Execute — implement changes following core principles.\n\n## Rules\n- Follow SOLID, DRY, KISS.\n- Unexpected errors → recommend [debug], don\'t guess.',
  source: 'bundled',
  filePath: '/dev/null',
};

// Realistic session JSONL simulating parent conversation
const sessionJsonl = [
  JSON.stringify({ type: 'header', version: 3, id: 'test-session-001', timestamp: '2026-05-15T00:00:00Z', cwd: '/Users/__blitzzz/Documents/GitHub/pi-agent-flow' }),
  JSON.stringify({ type: 'system', content: 'You are a helpful coding assistant.' }),
  JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'How does context sharing work between parent and child agents?' }] } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Let me explore the codebase to understand context sharing.' }, { type: 'toolCall', id: 'flow_1', name: 'flow', arguments: { flow: 'scout', intent: 'Explore how context is shared between parent and child agents in pi-agent-flow', aim: 'Map the context sharing mechanism' } }] } }),
  JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: 'flow_1', toolName: 'flow', content: [{ type: 'text', text: '[Flow: scout accomplished]\nFiles:\n  src/snapshot.ts (context sharing logic)\n  src/flow.ts (spawn mechanism)\nCommands:\n  cmd: grep -rn "forkSession" src/' }] } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Should I also inspect the actual session files to see what gets passed?' }, { type: 'toolCall', id: 'ask_1', name: 'ask_user', arguments: { question: 'Should I inspect actual session JSONL files to verify the compression?' } }] } }),
  JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: 'ask_1', toolName: 'ask_user', content: [{ type: 'text', text: 'User answered: Yes, check src/snapshot.ts and src/flow.ts — I want the verbatim child payload.' }] } }),
  JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Yes, check src/snapshot.ts and src/flow.ts — I want the verbatim child payload.' }] } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Let me pull the code and the session dump.' }, { type: 'toolCall', id: 'batch_1', name: 'batch', arguments: { o: [{ o: 'read', p: 'src/snapshot.ts', s: 1, l: 50 }, { o: 'read', p: 'src/flow.ts', s: 520, l: 40 }] } }] } }),
  JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: 'batch_1', toolName: 'batch', content: [{ type: 'text', text: '--- src/snapshot.ts (50 lines) ---\n// Context sharing logic here...\n--- src/flow.ts (40 lines) ---\n// Spawn mechanism here...' }] } }),
].join('\n') + '\n';

// Write session to temp file
const tmpDir = fs.mkdtempSync('/tmp/pi-agent-flow-');
const sessionPath = tmpDir + '/test-session.jsonl';
fs.writeFileSync(sessionPath, sessionJsonl, { encoding: 'utf-8' });

// Build the exact args a child would receive
const args = buildFlowArgs(
  flow,
  'Explore how context is shared between parent and child agents. Look at snapshot.ts, flow.ts, and any session dump files. Report exactly what gets passed to children.',
  sessionPath,
  undefined, // model
  0, // parentDepth
  3, // maxDepth
  true, // toolOptimize
  true, // structuredOutput
  'long', // sessionMode
  900000, // sessionTimeoutMs
  'Return a clear summary of what the child sees in its context window.'
);

// Extract JSONL path and -p prompt
const sessionIdx = args.indexOf('--session');
const pIdx = args.indexOf('-p');
const jsonlFile = sessionIdx >= 0 ? args[sessionIdx + 1] : null;
const prompt = pIdx >= 0 ? args[pIdx + 1] : null;

// Read the actual sanitized JSONL that would be passed
const actualJsonl = jsonlFile ? fs.readFileSync(jsonlFile, 'utf-8') : '(none)';

// Write the dump
const dump = [
  '## Session Snapshot (JSONL)',
  '',
  '```jsonl',
  actualJsonl.trimEnd(),
  '```',
  '',
  '## Activation Prompt (-p)',
  '',
  '```',
  prompt,
  '```',
].join('\n');

const dumpPath = '/Users/__blitzzz/Documents/GitHub/pi-agent-flow/docs/agent-context-dump.md';
fs.mkdirSync('/Users/__blitzzz/Documents/GitHub/pi-agent-flow/docs', { recursive: true });
fs.writeFileSync(dumpPath, dump, { encoding: 'utf-8' });

console.log('Dump written to:', dumpPath);
console.log('JSONL size:', actualJsonl.length, 'bytes');
console.log('Prompt size:', prompt?.length ?? 0, 'bytes');
