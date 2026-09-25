#!/bin/bash
#
# ensure-local-deps.sh
#
# Ensures this worktree has its own local dependencies and caches,
# not symlinks to the parent project. Symlinked node_modules and
# cache directories cause issues with test runners, build tools,
# and concurrent development across multiple worktrees.
#
# Usage:
#   ./scripts/ensure-local-deps.sh [--quiet]
#
# Options:
#   --quiet    Suppress informational output (only show errors/changes)
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

QUIET=false
if [[ "$1" == "--quiet" ]]; then
    QUIET=true
fi

log() {
    if [[ "$QUIET" == false ]]; then
        echo -e "$1"
    fi
}

log_always() {
    echo -e "$1"
}

cd "$PROJECT_DIR"

# ============================================================
# CHECK BUN VERSION MATCHES packageManager FIELD
# ============================================================
EXPECTED_BUN_VERSION=$(grep -o '"packageManager": "bun@[^"]*"' package.json 2>/dev/null | grep -o '[0-9][0-9.]*')
ACTUAL_BUN_VERSION=$(bun --version 2>/dev/null)

if [ -n "$EXPECTED_BUN_VERSION" ] && [ -n "$ACTUAL_BUN_VERSION" ] && [ "$CI_BUN_VERSION_CHECKED" != "1" ]; then
    EXPECTED_MAJOR_MINOR=$(echo "$EXPECTED_BUN_VERSION" | cut -d. -f1,2)
    ACTUAL_MAJOR_MINOR=$(echo "$ACTUAL_BUN_VERSION" | cut -d. -f1,2)

    if [ "$EXPECTED_MAJOR_MINOR" != "$ACTUAL_MAJOR_MINOR" ]; then
        log_always ""
        log_always "${YELLOW}⚠ Bun version mismatch:${NC}"
        log_always "  Expected: ${GREEN}bun@${EXPECTED_BUN_VERSION}${NC} (from package.json packageManager)"
        log_always "  Actual:   ${RED}bun@${ACTUAL_BUN_VERSION}${NC}"
        log_always "  Run ${BLUE}bun upgrade${NC} to update, or update packageManager in package.json"
        log_always ""
        if [ -t 0 ]; then
            read -r -p "Continue anyway? [y/N] " answer
            if [[ ! "$answer" =~ ^[Yy] ]]; then
                log_always "Aborted."
                exit 1
            fi
        fi
    else
        log "  ${GREEN}✔${NC} Bun version matches (${ACTUAL_BUN_VERSION})"
    fi
fi

# Directories that must be local (not symlinked)
# These are either installed dependencies or generated caches
MUST_BE_LOCAL=(
    "node_modules"
    "apps/web/.next"
    "apps/admin/.next"
    "apps/landing/.next"
    ".turbo"
    ".cache"
)

CHANGES_MADE=false

log "${BLUE}Checking for symlinked directories...${NC}"

for dir in "${MUST_BE_LOCAL[@]}"; do
    if [ -L "$dir" ]; then
        log_always "${YELLOW}Found symlink: $dir${NC}"

        # Get the target of the symlink for logging
        target=$(readlink "$dir" 2>/dev/null || echo "unknown")
        log_always "  ${BLUE}→ Target: $target${NC}"

        # Remove the symlink
        rm "$dir"
        log_always "  ${GREEN}✔ Removed symlink${NC}"

        CHANGES_MADE=true

        # Handle specific directories
        case "$dir" in
            "node_modules")
                log_always "${GREEN}▶ Running bun install to create local node_modules...${NC}"
                bun install
                log_always "${GREEN}✔ Local node_modules installed${NC}"
                ;;
            *)
                log "  ${BLUE}ℹ $dir will be recreated as needed${NC}"
                ;;
        esac

        echo ""
    elif [ -d "$dir" ]; then
        log "  ${GREEN}✔${NC} $dir is a real directory"
    fi
done

# Also check for symlinks in node_modules that point outside the project
if [ -d "node_modules" ]; then
    CRITICAL_PACKAGES=("vitest" "next" "@playwright/test")

    for pkg in "${CRITICAL_PACKAGES[@]}"; do
        pkg_path="node_modules/$pkg"
        if [ -L "$pkg_path" ]; then
            target=$(readlink "$pkg_path" 2>/dev/null || echo "unknown")
            if [[ "$target" == /* ]] || [[ "$target" == ../* && "$target" == *"../.."* ]]; then
                log_always "${YELLOW}Warning: $pkg_path is a symlink to $target${NC}"
                log_always "  ${YELLOW}This may cause issues. Consider running 'bun install' fresh.${NC}"
            fi
        fi
    done
fi

if [ "$CHANGES_MADE" = true ]; then
    log_always ""
    log_always "${GREEN}✔ Worktree isolation fixes applied${NC}"
else
    log "${GREEN}✔ All directories are properly local${NC}"
fi
