#!/usr/bin/env bash
set -euo pipefail

# Start pi with PI_FLOW_DUMP_SNAPSHOT pre-configured.
# Usage: ./scripts/dev-start.sh [any args passed to pi]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Default dump path; override by setting PI_FLOW_DUMP_SNAPSHOT yourself.
DEFAULT_DUMP="${REPO_ROOT}/.pi-snapshot.jsonl"

if [[ -z "${PI_FLOW_DUMP_SNAPSHOT:-}" ]]; then
    export PI_FLOW_DUMP_SNAPSHOT="${DEFAULT_DUMP}"
    echo "💾  PI_FLOW_DUMP_SNAPSHOT set to: ${PI_FLOW_DUMP_SNAPSHOT}"
else
    echo "💾  Using existing PI_FLOW_DUMP_SNAPSHOT: ${PI_FLOW_DUMP_SNAPSHOT}"
fi

echo "🚀  Starting pi…"
pi "$@"
