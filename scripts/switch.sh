#!/usr/bin/env bash
set -euo pipefail

# Quick toggle between LOCAL (linked dev) and REMOTE (published npm) pi-agent-flow.
# Usage: ./scripts/switch.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Detect current state: linked installs show "->" in npm ls output
STATE=$(npm ls -g pi-agent-flow 2>/dev/null || true)

if echo "${STATE}" | grep -q '->'; then
    echo "🔌 pi-agent-flow is LOCAL (linked). Switching to REMOTE..."
    npm uninstall -g pi-agent-flow
    npm install -g pi-agent-flow
    echo "✅ Now using REMOTE version from npm."
else
    echo "📦 pi-agent-flow is REMOTE (or missing). Switching to LOCAL..."
    cd "${REPO_ROOT}"
    npm link
    echo "✅ Now using LOCAL linked version."
    echo ""
    echo "💾  To capture verbatim snapshots for debugging, start pi like this:"
    echo ""
    echo "      export PI_FLOW_DUMP_SNAPSHOT=/tmp/pi-snapshot.jsonl"
    echo "      pi"
    echo ""
    echo "   Or use the helper: ./scripts/dev-start.sh"
fi

echo ""
echo "⚠️  Restart 'pi' to pick up the change."
echo ""
echo "🛡️  GUARD: While linked locally, NEVER run 'pi update' — it will overwrite"
echo "    your symlink with the published npm version and destroy your link."
echo "    To go back to published, run './scripts/switch.sh' first to toggle"
echo "    to REMOTE, then run 'pi update'."
