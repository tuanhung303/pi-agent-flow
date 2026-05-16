#!/usr/bin/env bash
# Sync /tmp dump artifacts into dump-artifacts/ and regenerate manifests.
# Idempotent — safe to run multiple times.
# Additive: only copies newer or missing files from /tmp; never deletes curated dumps.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DUMP_DIR="$REPO_ROOT/docs/dump-artifacts"
TMP_DIR="/tmp"

mkdir -p "$DUMP_DIR"

# Copy current artifacts from /tmp only if newer or missing (portable cp -u)
for pattern in 'pi-dump.*' 'snapshot-dump.*'; do
  for src in "$TMP_DIR"/$pattern; do
    [ -e "$src" ] || continue
    dest="$DUMP_DIR/$(basename "$src")"
    if [ ! -e "$dest" ] || [ "$src" -nt "$dest" ]; then
      cp "$src" "$dest"
    fi
  done
done

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

PI_COUNT=$(find "$DUMP_DIR" -maxdepth 1 -name 'pi-dump.*' | wc -l | tr -d ' ')
SNAP_COUNT=$(find "$DUMP_DIR" -maxdepth 1 -name 'snapshot-dump.*' | wc -l | tr -d ' ')
echo "Synced $PI_COUNT pi-dump and $SNAP_COUNT snapshot-dump files."
echo "Manifests regenerated: MANIFEST.md, manifest.json"
