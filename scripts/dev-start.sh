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
    echo "💾  PI_FLOW_DUMP_SNAPSHOT base path: ${PI_FLOW_DUMP_SNAPSHOT}"
    echo "     Each flow writes to a unique file (e.g. .scout.1234567890.jsonl)."
else
    echo "💾  Using existing PI_FLOW_DUMP_SNAPSHOT base path: ${PI_FLOW_DUMP_SNAPSHOT}"
    echo "     Each flow writes to a unique file."
fi

echo "🚀  Starting pi…"
pi "$@"
