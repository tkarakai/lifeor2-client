# Development Workflow

> Detailed guide for AI agents. See `CLAUDE.md` for the quick reference.

## Starting Development

```bash
# Start core apps + Convex (recommended)
bun run dev                  # Uses scripts/dev-start.sh

# Start a specific app + Convex
bun run dev:web              # Convex + web app (port 3001)
bun run dev:admin            # Convex + admin app (port 3002)
bun run dev:landing          # Landing only (port 3000, no Convex needed)
bun run dev:landing-static   # Static landing page (port 3004, no Convex)
bun run dev:storybook        # Component storybook only (port 3003, no Convex)

# Check service status
bun run dev:status           # Shows running processes

# Stop all services
bun run dev:stop
```

> **Note**: Do NOT use `turbo dev` directly. The custom `dev-start.sh` script handles Convex setup, port management, and environment configuration.

### Development process isolation

The launcher requires Python 3.9+ and the usual `ps`, `pgrep`, and `lsof` utilities. Each checkout records its own service PIDs and process start identities in ignored `.dev-pids` and `.dev-processes.json` files. Start, restart, and stop verify the identity and working directory before signalling a process or its descendants. Unrelated Convex servers, other clones, and unregistered processes are left alone; there is no machine-wide orphan cleanup.

- `bun run dev:stop` stops verified services in this checkout.
- `bun run dev:stop:convex` stops only this checkout's verified Convex process tree.
- `bun run dev:nuke-all` explicitly stops verified services across this Git repository's worktrees, with confirmation (`--yes` for non-interactive use). It preserves databases, dependencies and build caches.
- Existing servers started before this change have no identity record. Stop them from their original terminals once, then restart with the updated launcher. Unknown or stale PIDs are never adopted automatically.

Keep separate deployments and API/HTTP ports for separate applications. A different deployment's process name does not indicate a conflict. Run the isolation regression tests with `bun run test:dev-scripts`; they use disposable processes and temporary checkouts.

### Dev Seed Accounts

On first startup, `dev-start.sh` automatically creates two test accounts via `packages/backend/convex/devSeed.ts`:

| Email | Password | Role |
|-------|----------|------|
| `admin@admin.com` | email pasted x 3 | admin |
| `user@user.com` | email pasted x 3 | user |

The seed is gated behind the `DEV_SEED_ENABLED` Convex env var (set automatically by `dev-start.sh`) and is idempotent — it skips if the accounts already exist. To re-seed after a database reset, just restart `bun run dev`.

## Testing Commands (Detailed)

> **CRITICAL**: Always use `bun run test` (with `run`), never bare `bun test`.
> Bare `bun test` picks up ALL test files and fails because some require Vitest's DOM environment.

All test commands run via Turborepo from the project root:

```bash
# Bun Tests (fast, for utility functions)
bun run test                 # Run all Bun unit tests across workspaces

# Vitest Tests (React components with DOM)
bun run test:unit            # Run Vitest once (apps/web)
bun run test:watch           # Watch mode for development (run from apps/web)

# Convex Tests (backend functions)
bun run test:convex          # Run Convex backend tests (packages/backend)

# Playwright E2E Tests
bun run test:e2e             # Run all E2E tests

# Run everything
bun run test:all             # Bun + Vitest + Convex + Playwright
```

To run tests for a specific workspace directly:

```bash
# From apps/web/
cd apps/web
bun run test                 # Bun unit tests for web app
bun run test:unit            # Vitest component tests
bun run test:e2e             # Playwright E2E

# From packages/backend/
cd packages/backend
bun run test:convex          # Convex backend tests
```

## Build and Lint

```bash
bun run build                # Production build (all apps via Turborepo)
bun run lint                 # ESLint (all packages via Turborepo)
bun run typecheck            # TypeScript check (all packages via Turborepo)
```

## Debugging

### Common Issues

**Tests not finding modules:**
```bash
# Check path aliases match tsconfig.json
bun run typecheck
```

**Vitest configuration errors:**
```bash
# Run from the specific app directory
cd apps/web && bunx vitest --version
cd apps/web && bunx vitest run --reporter=verbose
```

**Playwright browser not installed:**
```bash
npx playwright install chromium
```

**Convex sync issues:**
```bash
# Restart the dev environment
bun run dev:stop && bun run dev:web
```

**convex-test module discovery fails in monorepo:**
```bash
# Ensure you pass the glob as second arg to convexTest()
# convexTest(schema, import.meta.glob("./**/*.*s"))
```
