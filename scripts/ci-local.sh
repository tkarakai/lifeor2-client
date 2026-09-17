#!/usr/bin/env bash
#
# ============================================================================
#  IMPORTANT: Keep this script in sync with the GitHub Actions CI workflows!
#
#  This script mirrors what runs in .github/workflows/:
#    - ci-shared.yml     (lint, typecheck, backend tests)
#    - ci-web.yml        (web: tests, coverage, build, bundle size, E2E)
#    - ci-admin.yml      (admin: tests, coverage, build, bundle size, E2E)
#    - ci-landing.yml    (landing: tests, coverage, build, bundle size, E2E)
#    - ci-storybook.yml  (storybook: build, E2E)
#
#  When you add or change a CI step in GitHub Actions, update this script too.
#  When you add or change a step here, update the GitHub Actions workflows too.
# ============================================================================
#
# Uses Turborepo to orchestrate across all workspace packages.
# Runs per-app when possible so failures show exactly which app broke.
#
# Phases (per-app when possible for granular pass/fail):
#   1. TypeScript check (all packages)
#   2. ESLint (all packages)
#   3. Bun unit tests (per app: web, admin, landing)
#   4. Component tests + coverage (per app: web, admin, landing)
#   5. Convex backend tests (backend)
#   6. Production build (per app: web, admin, landing, storybook)
#   7. Bundle size check (per app: apps with .size-limit.json)
#   8. E2E tests (per app: web, admin, landing, storybook) — skip with --skip-e2e
#
# NOT included (CI-only):
#   - Security checks (CodeQL, dependency audit, secrets scan)
#   - Lighthouse performance audits
#   - Artifact uploads to GitHub (coverage, Playwright reports)
#   - Change detection (always runs everything)
#   - CI gate (commit status aggregation)
#
# Artifacts are saved to .ci-local-artifacts/ for local inspection.
#
# Usage: bun run ci
#        bun run ci:quick             # Skip E2E tests
#        bun run ci:reset-coverage    # Reset coverage thresholds to 0, then run
#
# Flags can be combined: ./scripts/ci-local.sh --skip-e2e --reset-coverage
#

set -e

# Parse flags
SKIP_E2E=false
RESET_COVERAGE=false
for arg in "$@"; do
  case "$arg" in
    --skip-e2e) SKIP_E2E=true ;;
    --reset-coverage) RESET_COVERAGE=true ;;
  esac
done

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Color

print_step() {
  echo -e "\n"
  echo -e "${BLUE}▶ $1${NC}"
  echo -e "\n"
}

print_success() {
  echo -e "\n${GREEN}✓ $1${NC}"
}

print_error() {
  echo -e "\n${RED}✗ $1${NC}"
}

print_warning() {
  echo -e "${YELLOW}⚠ $1${NC}"
}

# ── Step timing ──────────────────────────────────────────────
# Tracks per-step durations and prints a summary table at the end.
# Uses centiseconds (hundredths of a second) for sub-second precision.
STEP_NAMES=()
STEP_DURATIONS=()
STEP_RESULTS=()
STEP_START=0

# Current time in centiseconds (hundredths of a second).
# Uses perl's Time::HiRes for sub-second precision on macOS where
# date +%s only gives whole seconds.
now_cs() {
  perl -MTime::HiRes=time -e 'printf "%d\n", time() * 100'
}

step_start() {
  STEP_START=$(now_cs)
}

step_end() {
  local name="$1"
  local result="$2"  # "pass", "fail", or "skip"
  local now=$(now_cs)
  local dur=$((now - STEP_START))
  STEP_NAMES+=("$name")
  STEP_DURATIONS+=("$dur")
  STEP_RESULTS+=("$result")
}

# Format a duration in centiseconds for display.
# Under 1 minute: "12.34s" (two decimal places)
# 1 minute or more: "2m 15s" (whole seconds)
format_duration() {
  local cs=$1
  local secs=$((cs / 100))
  local frac=$((cs % 100))
  if [ "$secs" -ge 60 ]; then
    printf "%dm %ds" $((secs / 60)) $((secs % 60))
  else
    printf "%d.%02ds" "$secs" "$frac"
  fi
}

print_timing_summary() {
  # Calculate total duration
  local total_dur=0
  for dur in "${STEP_DURATIONS[@]}"; do
    total_dur=$((total_dur + dur))
  done

  echo -e "\n${BOLD}Step Timings:${NC}"
  echo -e "  ┌─────┬────────────────────────────────────────────┬────────┬─────────┐"
  echo -e "  │  #  │ Step                                       │ Result │    Time │"
  echo -e "  ├─────┼────────────────────────────────────────────┼────────┼─────────┤"
  for i in "${!STEP_NAMES[@]}"; do
    local num=$((i + 1))
    local name="${STEP_NAMES[$i]}"
    local dur="${STEP_DURATIONS[$i]}"
    local res="${STEP_RESULTS[$i]}"
    local formatted
    formatted=$(format_duration "$dur")

    # Use fixed-width ASCII labels to avoid UTF-8 padding issues
    local colored_result=""
    case "$res" in
      pass) colored_result="${GREEN}  pass  ${NC}" ;;
      fail) colored_result="${RED}  FAIL  ${NC}" ;;
      skip) colored_result="${YELLOW}  skip  ${NC}" ;;
    esac

    printf "  │ %2d  │ %-42s │%b│ %7s │\n" \
      "$num" "$name" "$colored_result" "$formatted"
  done
  echo -e "  ├─────┼────────────────────────────────────────────┼────────┼─────────┤"
  printf "  │     │ %-42s │        │ %7s │\n" \
    "Total" "$(format_duration "$total_dur")"
  echo -e "  └─────┴────────────────────────────────────────────┴────────┴─────────┘"
}

# Track overall timing
START_TIME=$(now_cs)

# Clean stale turbo caches so each CI run gets fresh results.
# We do NOT clean .next/ — dev servers are expected to be running and manage it.
print_warning "Cleaning stale turbo caches..."
rm -rf apps/*/.turbo packages/*/.turbo

# Reset coverage thresholds to 0 if requested.
# Useful when source files have been added/removed and thresholds are stale.
# autoUpdate: true will ratchet them back up on the next successful run.
if [ "$RESET_COVERAGE" = true ]; then
  print_warning "Resetting coverage thresholds to 0 in all vitest configs..."
  for CONFIG in apps/*/vitest.config.ts; do
    if [ -f "$CONFIG" ]; then
      sed -i '' -E 's/(lines|branches|functions|statements): [0-9.]+/\1: 0/g' "$CONFIG"
      echo "  Reset: $CONFIG"
    fi
  done
fi

# Check Bun version matches packageManager field
EXPECTED_BUN_VERSION=$(grep -o '"packageManager": "bun@[^"]*"' package.json 2>/dev/null | grep -o '[0-9][0-9.]*')
ACTUAL_BUN_VERSION=$(bun --version 2>/dev/null)
if [ -n "$EXPECTED_BUN_VERSION" ] && [ -n "$ACTUAL_BUN_VERSION" ]; then
  EXPECTED_MAJOR_MINOR=$(echo "$EXPECTED_BUN_VERSION" | cut -d. -f1,2)
  ACTUAL_MAJOR_MINOR=$(echo "$ACTUAL_BUN_VERSION" | cut -d. -f1,2)
  if [ "$EXPECTED_MAJOR_MINOR" != "$ACTUAL_MAJOR_MINOR" ]; then
    print_warning "Bun version mismatch: expected ${EXPECTED_BUN_VERSION} (package.json), got ${ACTUAL_BUN_VERSION}"
    print_warning "Run 'bun upgrade' to update, or update packageManager in package.json"
    if [ -t 0 ]; then
      read -r -p "Continue anyway? [y/N] " answer
      if [[ ! "$answer" =~ ^[Yy] ]]; then
        echo "Aborted."
        exit 1
      fi
    fi
  fi
fi

# Artifact directory for local inspection
ARTIFACTS_DIR=".ci-local-artifacts"
rm -rf "$ARTIFACTS_DIR"
mkdir -p "$ARTIFACTS_DIR"

echo -e "${BLUE}"
echo "┌──────────────────────────────────────────────────────────────┐"
echo "│                    Local CI Check                            │"
echo "│  Running the same checks as GitHub Actions CI workflows      │"
echo "│  Artifacts saved to .ci-local-artifacts/                     │"
echo "└──────────────────────────────────────────────────────────────┘"
echo -e "${NC}"

# On exit (success or failure), print timing summary and artifact list
on_exit() {
  print_timing_summary

  if [ -d "$ARTIFACTS_DIR" ] && [ "$(ls -A "$ARTIFACTS_DIR" 2>/dev/null)" ]; then
    echo -e "\n${BOLD}Artifacts saved to ${ARTIFACTS_DIR}/:${NC}"
    for APP_ARTIFACT_DIR in "$ARTIFACTS_DIR"/*/; do
      if [ -d "$APP_ARTIFACT_DIR" ]; then
        APP=$(basename "$APP_ARTIFACT_DIR")
        echo -e "  ${DIM}$APP/${NC}"
        for ITEM in "$APP_ARTIFACT_DIR"*/; do
          if [ -d "$ITEM" ]; then
            echo -e "    ${DIM}$(basename "$ITEM")/${NC}"
          fi
        done
        for ITEM in "$APP_ARTIFACT_DIR"*; do
          if [ -f "$ITEM" ]; then
            echo -e "    ${DIM}$(basename "$ITEM")${NC}"
          fi
        done
      fi
    done
    echo ""
  fi

  # Kill any orphaned child processes (Playwright browsers, webServer, etc.)
  # that might keep the terminal hanging after the script finishes.
  local children
  children=$(jobs -rp 2>/dev/null) || true
  if [ -n "$children" ]; then
    kill $children 2>/dev/null || true
  fi
  # Also kill by process group for processes reparented away from us
  pkill -P $$ 2>/dev/null || true
}
trap on_exit EXIT
# Ctrl-C should exit the whole script, not just the current subcommand
trap 'exit 130' INT

# Helper: save coverage artifacts and display summary for an app
save_coverage() {
  local APP_NAME="$1"
  local COVERAGE_DIR="apps/$APP_NAME/qa/coverage"
  local SUMMARY_FILE="$COVERAGE_DIR/coverage-summary.json"

  if [ -d "$COVERAGE_DIR" ]; then
    mkdir -p "$ARTIFACTS_DIR/$APP_NAME"
    cp -r "$COVERAGE_DIR" "$ARTIFACTS_DIR/$APP_NAME/coverage"
  fi

  if [ -f "$SUMMARY_FILE" ]; then
    echo -e "\n  ${BOLD}Coverage Summary ($APP_NAME):${NC}"
    echo -e "  ┌────────────┬──────────┐"
    echo -e "  │ Metric     │ Coverage │"
    echo -e "  ├────────────┼──────────┤"
    printf "  │ Lines      │ %7s%% │\n" "$(jq -r '.total.lines.pct' "$SUMMARY_FILE")"
    printf "  │ Branches   │ %7s%% │\n" "$(jq -r '.total.branches.pct' "$SUMMARY_FILE")"
    printf "  │ Functions  │ %7s%% │\n" "$(jq -r '.total.functions.pct' "$SUMMARY_FILE")"
    printf "  │ Statements │ %7s%% │\n" "$(jq -r '.total.statements.pct' "$SUMMARY_FILE")"
    echo -e "  └────────────┴──────────┘"
  fi
}

# Helper: save E2E artifacts for an app
save_e2e_artifacts() {
  local APP_NAME="$1"
  local APP_DIR="apps/$APP_NAME"

  mkdir -p "$ARTIFACTS_DIR/$APP_NAME"

  # Playwright report
  if [ -d "$APP_DIR/qa/playwright-report" ]; then
    cp -r "$APP_DIR/qa/playwright-report" "$ARTIFACTS_DIR/$APP_NAME/playwright-report"
  fi

  # Visual snapshots
  if [ -d "$APP_DIR/qa/e2e/__screenshots__" ]; then
    cp -r "$APP_DIR/qa/e2e/__screenshots__" "$ARTIFACTS_DIR/$APP_NAME/visual-snapshots"
  fi

  # Dev logs (useful for debugging failures)
  if [ -f ".convex-dev.log" ]; then
    cp ".convex-dev.log" "$ARTIFACTS_DIR/$APP_NAME/convex-dev.log" 2>/dev/null || true
  fi
  if [ -f ".next-${APP_NAME}.log" ]; then
    cp ".next-${APP_NAME}.log" "$ARTIFACTS_DIR/$APP_NAME/next-${APP_NAME}.log" 2>/dev/null || true
  fi
}

# ============================================================
# Phase 1: TypeScript (mirrors ci-shared.yml → lint job)
# ============================================================
print_step "Step 1/8: TypeScript Check"
step_start
if turbo typecheck; then
  print_success "TypeScript check passed"
  step_end "all: TypeScript" "pass"
else
  print_error "TypeScript check failed"
  step_end "all: TypeScript" "fail"
  exit 1
fi

# ============================================================
# Phase 2: ESLint (mirrors ci-shared.yml → lint job)
# ============================================================
print_step "Step 2/8: ESLint"
step_start
if turbo lint; then
  print_success "ESLint passed"
  step_end "all: ESLint" "pass"
else
  print_error "ESLint failed"
  step_end "all: ESLint" "fail"
  exit 1
fi

# ============================================================
# Phase 3: Bun Unit Tests (mirrors ci-{web,admin,landing}.yml → test job)
# Per-app so failures show which app broke.
# ============================================================
print_step "Step 3/8: Unit Tests (Bun)"
PHASE_FAILED=false
for APP in web admin landing; do
  step_start
  if turbo test --filter=@repo/$APP; then
    print_success "Bun tests passed ($APP)"
    step_end "$APP: Tests (Bun)" "pass"
  else
    print_error "Bun tests failed ($APP)"
    step_end "$APP: Tests (Bun)" "fail"
    PHASE_FAILED=true
  fi
done
if [ "$PHASE_FAILED" = true ]; then exit 1; fi

# ============================================================
# Phase 4: Component Tests + Coverage — Vitest (per app)
# (mirrors ci-{web,admin,landing}.yml → test job → "Run Vitest with coverage")
# Saves coverage artifacts even on failure for inspection.
# ============================================================
print_step "Step 4/8: Component Tests + Coverage (Vitest)"
COVERAGE_PASSED=true
for APP in web admin landing; do
  step_start
  if turbo test:coverage --filter=@repo/$APP; then
    print_success "Coverage tests passed ($APP)"
    step_end "$APP: Coverage (Vitest)" "pass"
  else
    print_error "Coverage tests failed ($APP)"
    step_end "$APP: Coverage (Vitest)" "fail"
    COVERAGE_PASSED=false
  fi
  # Always save coverage artifacts (even on failure)
  save_coverage "$APP"
done
if [ "$COVERAGE_PASSED" = false ]; then
  print_error "Exiting due to coverage failure (artifacts saved to $ARTIFACTS_DIR/)"
  exit 1
fi

# ============================================================
# Phase 5: Convex Backend Tests (mirrors ci-shared.yml → test-convex job)
# ============================================================
print_step "Step 5/8: Backend Tests (Convex)"
step_start
if turbo test:convex; then
  print_success "Convex tests passed"
  step_end "backend: Tests (Convex)" "pass"
else
  print_error "Convex tests failed"
  step_end "backend: Tests (Convex)" "fail"
  exit 1
fi

# ============================================================
# Phase 6: Production Build (per app)
# (mirrors ci-{web,admin,landing}.yml → build job + ci-storybook.yml)
# Uses --filter=@repo/$APP... to include dependency builds.
# Turbo caching means shared packages only build once.
# ============================================================
print_step "Step 6/8: Production Build"
# Provide placeholder env vars for apps that need them at build time.
# These mirror the placeholder values in ci-{web,admin,landing}.yml.
# The actual values are only needed at runtime, not at build time.
export NEXT_PUBLIC_CONVEX_URL="${NEXT_PUBLIC_CONVEX_URL:-https://placeholder.convex.cloud}"
export NEXT_PUBLIC_CONVEX_SITE_URL="${NEXT_PUBLIC_CONVEX_SITE_URL:-https://placeholder.convex.site}"
export NEXT_PUBLIC_LANDING_URL="${NEXT_PUBLIC_LANDING_URL:-http://localhost:3000}"
export NEXT_PUBLIC_WEB_APP_URL="${NEXT_PUBLIC_WEB_APP_URL:-http://localhost:3002}"
BUILD_FAILED=false
for APP in web admin landing storybook; do
  # Set per-app NEXT_PUBLIC_SITE_URL (each app runs on a different port)
  case "$APP" in
    web)     _SITE_URL="http://localhost:3002" ;;
    admin)   _SITE_URL="http://localhost:3003" ;;
    landing) _SITE_URL="http://localhost:3000" ;;
    *)       _SITE_URL="" ;;
  esac
  step_start
  if NEXT_PUBLIC_SITE_URL="${NEXT_PUBLIC_SITE_URL:-$_SITE_URL}" turbo build --filter=@repo/$APP...; then
    print_success "Build succeeded ($APP)"
    step_end "$APP: Build" "pass"
  else
    print_error "Build failed ($APP)"
    step_end "$APP: Build" "fail"
    BUILD_FAILED=true
  fi
done
if [ "$BUILD_FAILED" = true ]; then exit 1; fi

# ============================================================
# Phase 7: Bundle Size Check (per app)
# (mirrors ci-{web,admin,landing}.yml → build job → "Check bundle size")
# Only runs for apps that have a .size-limit.json config.
# ============================================================
print_step "Step 7/8: Bundle Size"
BUNDLE_FAILED=false
for APP_DIR in apps/*/; do
  APP_NAME=$(basename "$APP_DIR")
  # Skip apps not included in CI builds (no corresponding workflow)
  case "$APP_NAME" in landing-static) continue ;; esac
  if [ -f "$APP_DIR/.size-limit.json" ]; then
    step_start
    if (cd "$APP_DIR" && bun run size); then
      print_success "Bundle size check passed ($APP_NAME)"
      step_end "$APP_NAME: Bundle Size" "pass"
    else
      print_error "Bundle size check failed ($APP_NAME)"
      step_end "$APP_NAME: Bundle Size" "fail"
      BUNDLE_FAILED=true
    fi
  fi
done
if [ "$BUNDLE_FAILED" = true ]; then exit 1; fi

# ============================================================
# Phase 8: E2E Tests — Playwright (per app)
# (mirrors ci-{web,admin,landing,storybook}.yml → e2e job)
# Optional — skip with --skip-e2e
# ============================================================
if [ "$SKIP_E2E" = true ]; then
  print_warning "Skipping E2E tests (--skip-e2e flag)"
  for APP in web admin landing storybook; do
    step_start
    step_end "$APP: E2E (Playwright)" "skip"
  done
else
  print_step "Step 8/8: E2E Tests (Playwright)"
  # Each app's playwright.config.ts has a webServer + reuseExistingServer setting.
  # Locally (no CI env), Playwright reuses running dev servers automatically.
  # If no server is running, Playwright starts one via the webServer command.
  # No manual detection needed — Playwright handles everything.

  E2E_PASSED=true
  E2E_FAILED_APPS=()

  for APP in web admin landing storybook; do
    step_start
    echo -e "  ${BOLD}Running E2E tests ($APP)...${NC}"
    E2E_EXIT=0
    pushd "apps/$APP" > /dev/null
    PLAYWRIGHT_HTML_OPEN=never bunx playwright test --reporter=list || E2E_EXIT=$?
    popd > /dev/null
    if [ $E2E_EXIT -eq 0 ]; then
      print_success "E2E tests passed ($APP)"
      step_end "$APP: E2E (Playwright)" "pass"
    else
      print_error "E2E tests failed ($APP)"
      step_end "$APP: E2E (Playwright)" "fail"
      E2E_FAILED_APPS+=("$APP")
      E2E_PASSED=false
    fi
    save_e2e_artifacts "$APP"
  done

  if [ "$E2E_PASSED" = false ]; then
    echo ""
    print_warning "Failed E2E reports:"
    for FAILED_APP in "${E2E_FAILED_APPS[@]}"; do
      echo -e "  ${YELLOW}$FAILED_APP${NC}"
      echo -e "    npx playwright show-report apps/$FAILED_APP/qa/playwright-report"
      echo -e "    .ci-local-artifacts/$FAILED_APP/playwright-report/index.html"
    done
    exit 1
  fi
fi

# Note: The following are NOT included in local CI (GitHub Actions only):
#   - Security checks (CodeQL, dependency audit, secrets scan) → security.yml
#   - Lighthouse performance audits
#   - CI gate (commit status aggregation) → runs inside cd-staging.yml

# Calculate duration
END_TIME=$(now_cs)
DURATION_CS=$((END_TIME - START_TIME))

echo -e "\n${GREEN}"
echo "┌──────────────────────────────────────────────────────────────┐"
echo "│                  All CI Checks Passed!                       │"
echo "└──────────────────────────────────────────────────────────────┘"
echo -e "${NC}"
echo -e "Total time: $(format_duration $DURATION_CS)"
echo ""
