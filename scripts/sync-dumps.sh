#!/usr/bin/env bash
# Sync /tmp dump artifacts into dump-artifacts/ and regenerate manifests.
# Idempotent — safe to run multiple times.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DUMP_DIR="$REPO_ROOT/dump-artifacts"
TMP_DIR="/tmp"

mkdir -p "$DUMP_DIR"

# Remove stale dump artifacts (keep meta files which will be regenerated)
cd "$DUMP_DIR"
rm -f pi-dump.* snapshot-dump.*

# Copy current artifacts from /tmp
cp "$TMP_DIR"/pi-dump.* "$DUMP_DIR"/ 2>/dev/null || true
cp "$TMP_DIR"/snapshot-dump.* "$DUMP_DIR"/ 2>/dev/null || true

# Regenerate manifests using Node.js for reliable JSON handling
node -e "
const fs = require('fs');
const path = require('path');
const dumpDir = process.argv[1];
const files = fs.readdirSync(dumpDir).sort();
const entries = [];
const now = new Date().toISOString();

for (const file of files) {
  const fullPath = path.join(dumpDir, file);
  const stats = fs.statSync(fullPath);
  const mtime = stats.mtime.toISOString();
  entries.push({ file, size: stats.size, mtime });
}

const manifest = {
  generatedAt: now,
  totalFiles: entries.length,
  files: entries
};
fs.writeFileSync(path.join(dumpDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\\n');

let md = '# Dump Artifacts Manifest\\n\\n';
md += '> Auto-generated. Contains all \`pi-dump*\` and \`snapshot-dump*\` artifacts.\\n\\n';
md += '| File | Size (bytes) | Modified (UTC) |\\n';
md += '|------|-------------:|----------------|\\n';
for (const e of entries) {
  const dateStr = new Date(e.mtime).toUTCString().replace(/ GMT$/, '');
  md += '| \`' + e.file + '\` | ' + e.size + ' | ' + dateStr + ' |\\n';
}
fs.writeFileSync(path.join(dumpDir, 'MANIFEST.md'), md);
" "$DUMP_DIR"

echo "Synced $(ls -1 "$DUMP_DIR"/pi-dump.* 2>/dev/null | wc -l | tr -d ' ') pi-dump and $(ls -1 "$DUMP_DIR"/snapshot-dump.* 2>/dev/null | wc -l | tr -d ' ') snapshot-dump files."
echo "Manifests regenerated: MANIFEST.md, manifest.json"
