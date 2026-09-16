#!/bin/bash
#
# ensure-app-env.sh
#
# Seeds a local .env.local for every app that ships an .env.example but does not
# have one yet.
#
# Next.js loads .env.local from the app directory, not the monorepo root, so each
# app needs its own. dev-start.sh writes them — but only for the apps it starts,
# so an app you have never run (landing-static, say) is left without one. Its
# build then fails the moment a route reads a required variable, which is easy to
# hit through `bun run build` or `bun run test:e2e` since turbo builds every app.
#
# Values come from the app's own checked-in .env.example, which holds the right
# localhost port for that app. Existing .env.local files are never touched.
#
# Only apps whose .env.example is self-sufficient are seeded — that is, every key
# already has a value. apps/web and apps/admin deliberately ship empty
# NEXT_PUBLIC_CONVEX_URL / NEXT_PUBLIC_CONVEX_SITE_URL entries, because those are
# only knowable once `convex dev` has assigned a port; dev-start.sh owns them.
# Copying an empty value there would swap one build failure for a more confusing
# one ("CONVEX_SITE_URL is not set"), so those apps are skipped.
#
# Usage:
#   ./scripts/ensure-app-env.sh [--quiet]
#

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

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

created=0

for app_dir in "$PROJECT_DIR"/apps/*/; do
    [ -d "$app_dir" ] || continue

    example="$app_dir.env.example"
    local_env="$app_dir.env.local"
    app_name="$(basename "$app_dir")"

    # Nothing to copy from — app takes no configuration.
    [ -f "$example" ] || continue

    # Never clobber a developer's real values.
    if [ -f "$local_env" ]; then
        continue
    fi

    # Skip apps whose example leaves keys blank — dev-start.sh fills those in.
    if grep -qE '^[A-Za-z_][A-Za-z0-9_]*=[[:space:]]*$' "$example"; then
        log "  ${YELLOW}—${NC} Skipped ${app_name}: .env.example needs values from dev-start.sh"
        continue
    fi

    cp "$example" "$local_env"
    created=$((created + 1))
    log "  ${GREEN}✔${NC} Created ${app_name}/.env.local from .env.example"
done

if [ "$created" -gt 0 ]; then
    log ""
    log "  ${YELLOW}Note:${NC} seeded $created .env.local file(s) with localhost defaults."
    log "  Ports are managed by dev-start.sh once you run that app."
else
    log "  ${GREEN}✔${NC} Every app already has its .env.local"
fi
