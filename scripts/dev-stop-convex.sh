#!/bin/bash
set -e

# Leave Next.js and every other checkout's Convex deployment alone.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 "$SCRIPT_DIR/dev-processes.py" stop --name convex
