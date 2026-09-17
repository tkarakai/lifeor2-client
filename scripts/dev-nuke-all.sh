#!/bin/bash
# Explicitly stop recorded services across this repository's worktrees.
# Never match global process names or delete shared Convex state.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
WORKTREES=()
while IFS= read -r line; do
    case "$line" in
        "worktree "*) WORKTREES+=("${line#worktree }") ;;
    esac
done < <(git -C "$PROJECT_DIR" worktree list --porcelain)
if [ ${#WORKTREES[@]} -eq 0 ]; then
    WORKTREES=("$PROJECT_DIR")
fi

for checkout in "${WORKTREES[@]}"; do
    echo "Verified services in $checkout:"
    python3 "$SCRIPT_DIR/dev-processes.py" --root "$checkout" list
done
if [ "${1:-}" != "--yes" ]; then
    if [ ! -t 0 ]; then
        echo "Use --yes to stop these services non-interactively."
        exit 1
    fi
    read -r -p "Stop these verified services? [y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] || exit 0
fi
for checkout in "${WORKTREES[@]}"; do
    python3 "$SCRIPT_DIR/dev-processes.py" --root "$checkout" stop
done
echo "Verified services stopped. Databases, dependencies and build caches preserved."
