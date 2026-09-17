#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
DIM='\033[2m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_DIR/.dev-pids"
CONVEX_STATE_DIR="$HOME/.convex/anonymous-convex-backend-state"

# ============================================================
# HELPER FUNCTIONS
# ============================================================

get_deployment_name() {
    for env_file in "$PROJECT_DIR/packages/backend/.env.local" "$PROJECT_DIR/.env.local"; do
        if [ -f "$env_file" ]; then
            local result=$(grep "^CONVEX_DEPLOYMENT=" "$env_file" 2>/dev/null | sed 's/CONVEX_DEPLOYMENT=//' | sed 's/ #.*//' | sed 's/anonymous://')
            if [ -n "$result" ]; then
                echo "$result"
                return
            fi
        fi
    done
}

get_convex_ports() {
    local deployment_name="$1"
    local config_file="$CONVEX_STATE_DIR/$deployment_name/config.json"
    if [ -f "$config_file" ]; then
        local cloud_port=$(grep -o '"cloud":[0-9]*' "$config_file" | grep -o '[0-9]*')
        local site_port=$(grep -o '"site":[0-9]*' "$config_file" | grep -o '[0-9]*')
        echo "$cloud_port $site_port"
    fi
}

get_dashboard_url() {
    local log_file="$PROJECT_DIR/.convex-dev.log"
    if [ -f "$log_file" ]; then
        grep -o 'http://127\.0\.0\.1:[0-9]*/?d=[^ ]*' "$log_file" | head -1
    fi
}

# Get app URL from its log file
get_app_url() {
    local app_name="$1"
    local log_file="$PROJECT_DIR/.next-${app_name}.log"
    if [ -f "$log_file" ]; then
        grep -o 'http://localhost:[0-9]*' "$log_file" | head -1
    fi
}

# Get PID for a service name from the PID file
get_pid() {
    local name="$1"
    if [ -f "$PID_FILE" ]; then
        grep "^${name}:" "$PID_FILE" 2>/dev/null | cut -d':' -f2
    fi
}

# Check if a PID is alive
is_running() {
    local pid="$1"
    [ -n "$pid" ] && python3 "$SCRIPT_DIR/dev-processes.py" running "*" "$pid"
}

# ============================================================
# CHECK IF ANYTHING IS RUNNING
# ============================================================

ANY_RUNNING=false
if [ -f "$PID_FILE" ]; then
    while IFS= read -r line; do
        pid=$(echo "$line" | cut -d':' -f2)
        if is_running "$pid"; then
            ANY_RUNNING=true
            break
        fi
    done < "$PID_FILE"
fi

if [ "$ANY_RUNNING" = false ]; then
    echo ""
    echo -e "  ${YELLOW}No dev services running.${NC}"
    echo -e "  Start with: ${BLUE}bun run dev${NC}"
    echo ""
    exit 0
fi

# ============================================================
# DISPLAY
# ============================================================

echo ""
echo -e "${GREEN}  Development Environment Status${NC}"
echo ""

printf "  ${YELLOW}%-12s  %-6s  %-30s  %s${NC}\n" "SERVICE" "STATUS" "URL" "PID"
printf "  ${YELLOW}%-12s  %-6s  %-30s  %s${NC}\n" "────────────" "──────" "──────────────────────────────" "─────"

# Apps (in display order)
for app_name in landing web admin storybook; do
    pid=$(get_pid "next-${app_name}")
    if [ -n "$pid" ]; then
        url=$(get_app_url "$app_name")
        # Capitalize first letter (bash 3.2 compatible)
        display_name="$(echo "${app_name:0:1}" | tr '[:lower:]' '[:upper:]')${app_name:1}"
        if is_running "$pid"; then
            printf "  %-12s  ${GREEN}%-6s${NC}  ${BLUE}%-30s${NC}  %s\n" "$display_name" "up" "${url:-unknown}" "$pid"
        else
            printf "  %-12s  ${RED}%-6s${NC}  %-30s  %s\n" "$display_name" "dead" "-" "$pid"
        fi
    fi
done

# Convex backend
CONVEX_PID=$(get_pid "convex")
if [ -n "$CONVEX_PID" ]; then
    CLOUD_PORT=""
    SITE_PORT=""
    DEPLOYMENT_NAME=$(get_deployment_name)
    if [ -n "$DEPLOYMENT_NAME" ]; then
        PORTS=$(get_convex_ports "$DEPLOYMENT_NAME")
        if [ -n "$PORTS" ]; then
            CLOUD_PORT=$(echo $PORTS | cut -d' ' -f1)
            SITE_PORT=$(echo $PORTS | cut -d' ' -f2)
        fi
    fi

    echo ""
    if is_running "$CONVEX_PID"; then
        if [ -n "$CLOUD_PORT" ]; then
            printf "  %-12s  ${GREEN}%-6s${NC}  ${BLUE}%-30s${NC}  %s\n" "Convex API" "up" "http://127.0.0.1:$CLOUD_PORT" "$CONVEX_PID"
        else
            printf "  %-12s  ${GREEN}%-6s${NC}  %-30s  %s\n" "Convex API" "up" "unknown" "$CONVEX_PID"
        fi
        if [ -n "$SITE_PORT" ]; then
            printf "  %-12s  ${GREEN}%-6s${NC}  ${BLUE}%-30s${NC}\n" "Site API" "up" "http://127.0.0.1:$SITE_PORT"
        fi
        DASHBOARD_URL=$(get_dashboard_url)
        if [ -n "$DASHBOARD_URL" ]; then
            printf "  %-12s  ${DIM}%-6s${NC}  ${BLUE}%s${NC}\n" "Dashboard" "" "$DASHBOARD_URL"
        fi
    else
        printf "  %-12s  ${RED}%-6s${NC}  %-30s  %s\n" "Convex API" "dead" "-" "$CONVEX_PID"
    fi
fi

# Logs
LOG_FILES=""
for app_name in landing web admin storybook; do
    pid=$(get_pid "next-${app_name}")
    if [ -n "$pid" ] && is_running "$pid"; then
        LOG_FILES="$LOG_FILES .next-${app_name}.log"
    fi
done
if [ -n "$CONVEX_PID" ] && is_running "$CONVEX_PID"; then
    LOG_FILES=".convex-dev.log$LOG_FILES"
fi
if [ -n "$LOG_FILES" ]; then
    echo ""
    echo -e "  ${YELLOW}Logs:${NC} tail -f$LOG_FILES"
fi

echo ""
echo -e "  ${YELLOW}Stop with:${NC} bun dev:stop"
echo ""
