# Project Conventions for AI Agents

This document provides project-specific guidance for AI agents working on this codebase. **Topic-specific guides** are linked at the bottom — read them when working on those areas.

## Project Overview

This is a **monorepo** powered by **Bun workspaces** and **Turborepo**, containing:
- **Six Next.js 16 apps**: web (port 3001), admin (port 3002), landing (port 3000), landing-static (port 3004), storybook (port 3003), demo
- **Six shared packages**: `@repo/design-system`, `@repo/auth`, `@repo/backend`, `@repo/i18n`, `@repo/edge-rate-limit`, `@repo/design-patterns`
- **Convex** as the backend (database, file storage, API functions)
- **Better Auth** wired to Convex for authentication
- **React 19** with Server Components (App Router)
- **Radix UI + shadcn/ui** for accessible UI primitives (in `@repo/design-system`)
- **Tailwind CSS v4** for styling
- **TypeScript** with strict mode enabled
- **Internationalization** via `@repo/i18n` — 15 languages including RTL (see `docs/i18n-architecture.md`)

## Quick Reference

```bash
# Start development (Convex + core apps via dev-start.sh)
bun run dev                  # Core apps + dev seed (admin@admin.com / pw: email pasted x 3, user@user.com / useruser)
bun run dev:web              # Convex + web app only (port 3001)
bun run dev:admin            # Convex + admin app only (port 3002)
bun run dev:landing          # Landing page only (port 3000, no Convex)
bun run dev:landing-static   # Static landing page (port 3004, no Convex)
bun run dev:storybook        # Component storybook only (port 3003, no Convex)
bun run dev:stop             # Stop all services
bun run dev:nuke-all         # Kill ALL node/convex processes across all worktrees
bun run dev:status           # Show running processes

# Run all CI checks locally before pushing (recommended!)
bun run ci                   # Full CI: lint, types, tests, build, e2e
bun run ci:quick             # Skip E2E tests for faster feedback
bun run ci:act               # Run in Docker via act (first run populates caches)
bun run ci:act:offline       # Offline mode (fast, no network required)

# Run tests via Turborepo (ALWAYS use "bun run test", never bare "bun test")
bun run test                 # Bun unit tests (across all workspaces)
bun run test:unit            # Vitest component tests
bun run test:convex          # Convex backend tests
bun run test:e2e             # Playwright E2E tests (requires browser)
bun run test:all             # All of the above

# Type checking and linting (via Turborepo)
bun run lint                 # ESLint (all packages)
bun run typecheck            # TypeScript check (all packages)

# Build for production
bun run build                # Build all apps via Turborepo

# Infrastructure setup
bun run infra:setup:staging  # Interactive staging setup (Convex + Vercel + GitHub)
```

> **WARNING**: Never use bare `bun test` - it picks up ALL test files including those requiring Vitest's DOM environment. Always use `bun run test` which runs the scoped npm script.

## Directory Structure

```
apps/
  web/              Main web app (@repo/web, port 3001) — src/ + qa/ (tests, e2e)
  admin/            Admin dashboard (@repo/admin, port 3002) — same structure as web
  landing/          Dynamic landing page (@repo/landing, port 3000) — i18n, SSR
  landing-static/   Static landing page (@repo/landing-static, port 3004) — fully static export, client-side i18n
  storybook/        Component storybook (@repo/storybook, port 3003) — src/ (showcase) + qa/ (e2e)
  demo/             Standalone UI style demo — static, no backend
packages/
  backend/          Convex backend (@repo/backend) — convex/ (schema, functions, _generated/ DO NOT EDIT)
  auth/             Authentication (@repo/auth) — src/ (client.ts, server.ts, provider.tsx)
  design-system/    Shared UI (@repo/design-system) — src/ (Radix + shadcn/ui components), tokens/ (CSS)
  i18n/             Internationalization (@repo/i18n) — messages/, src/
  edge-rate-limit/  Shared edge rate limiting (@repo/edge-rate-limit)
  design-patterns/  Design patterns (@repo/design-patterns)
scripts/            dev-start.sh, dev-stop.sh, ci-local.sh, ci-local-act.sh, ensure-local-deps.sh
.github/            workflows/ (ci-shared, ci-web, ci-admin, ci-landing, ci-storybook, ci-gate, cd-*, security)
```

## Cross-Package Import Patterns

| Package | Import | Example |
|---------|--------|---------|
| `@repo/design-system` | Components, utilities | `import { Button, cn } from "@repo/design-system"` |
| `@repo/design-system` | Global styles | `import "@repo/design-system/styles/globals.css"` |
| `@repo/auth` | Client hooks | `import { authClient } from "@repo/auth/client"` |
| `@repo/auth` | Server utilities | `import { auth } from "@repo/auth/server"` |
| `@repo/auth` | Provider component | `import { AuthProvider } from "@repo/auth/provider"` |
| `@repo/backend` | Convex API | `import { api } from "@repo/backend"` |
| `@repo/i18n` | Internationalization | `import { useTranslations } from "@repo/i18n"` |
| `@repo/edge-rate-limit` | Edge rate limiting | `import { createRateLimiter } from "@repo/edge-rate-limit"` |

Within each app, use `@/` as a path alias for `src/`:

```typescript
import { formatDate } from "@/lib/format";
import { DashboardLayout } from "@/components/dashboard-layout";
```

> **Note**: `@/` is app-internal only. For cross-package imports, always use `@repo/` package names.

## Important Warnings

### DO NOT

- **Use bare `bun test`** - Always use `bun run test` (with `run`). Bare `bun test` picks up all test files and fails
- **Edit `packages/backend/convex/_generated/`** - These files are auto-generated
- **Use `npm` or `yarn`** - This project uses Bun exclusively
- **Use `turbo dev`** - Use `bun run dev` (which calls `dev-start.sh`) for proper port and Convex management
- **Skip TypeScript types** - Strict mode catches bugs early
- **Test Server Components with Vitest** - Use Playwright E2E instead
- **Commit `.env.local`** - Contains secrets, use `.env.example` as template
- **Use `var`** - Use `const` or `let` instead

### BE CAREFUL

- **Convex functions** run on the server - no browser APIs available
- **Server Components** cannot use React hooks or browser APIs
- **Client Components** must have `"use client"` directive at top
- **Path aliases** (`@/`) are app-internal only; use `@repo/` for cross-package imports
- **Playwright tests** require Chromium browser installed (`npx playwright install chromium`)
- **convex-test in monorepos**: Must pass `import.meta.glob("./**/*.*s")` as second arg to `convexTest()`

## File Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Component | kebab-case.tsx | `user-avatar.tsx` |
| Page | kebab-case in folder | `apps/web/src/app/sign-up/page.tsx` |
| Utility | camelCase.ts | `formatDate.ts` or `format.ts` |
| Test | same-name.test.ts(x) | `format.test.ts`, `button.test.tsx` |
| E2E Test | descriptive.spec.ts | `auth-flow.spec.ts` |
| Convex | camelCase.ts | `launchItems.ts` |
| Package export | index.ts | `packages/design-system/src/index.ts` |

## Environment Variables

Required variables (see `.env.example`):

| Variable | Description | Required |
|----------|-------------|----------|
| `CONVEX_DEPLOYMENT` | Convex deployment identifier | Yes |
| `NEXT_PUBLIC_CONVEX_URL` | Convex API URL (dynamically assigned port) | Yes |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | Convex site URL (dynamically assigned port) | Yes |
| `NEXT_PUBLIC_SITE_URL` | App URL (e.g., `http://localhost:3001` for web) | Yes |

> **Note**: `bun run dev` auto-manages `.env.local` with the correct ports. You rarely need to edit these manually for local development.

## Verification Checklist

```bash
bun run ci          # Full check (recommended before push)
bun run ci:quick    # Faster check (skips E2E)
```

Code quality: no `console.log` debugging statements, proper error handling, explicit types (not `any`).

## Topic Guides

Read these guides when working on specific areas. They contain detailed patterns, examples, and reference material. **They are NOT loaded automatically** — read them before starting work in that area.

| When you are... | Read |
|-----------------|------|
| Writing or modifying tests (unit, component, E2E, backend) | `docs/claude/testing.md` |
| Working on CI, GitHub Actions, act, or offline mode | `docs/claude/ci.md` |
| Writing new components, Convex functions, or styling | `docs/claude/code-style.md` |
| Working on auth, rate limiting, route protection, or React patterns | `docs/claude/architecture.md` |
| Setting up dev environment, debugging issues, or need detailed command reference | `docs/claude/development.md` |
| Working on auth E2E tests, upgrading better-auth / the Convex auth adapter, Renovate / dependency automation, or E2E in CI | `docs/claude/auth-e2e-and-upgrade-plan.md` — **active work tracker; steps 1–8 done or in review, start at step 9** |
| Working on i18n, locales, translations, or RTL support | `docs/i18n-architecture.md` |
| Changing database schemas, running migrations, or deploying schema changes | `docs/convex-migrations.md` |
| Working on Renovate, dependency-update automation, or the `RENOVATE_TOKEN` secret | `docs/dependency-updates.md` |

## Resources

- [Next.js 16 Docs](https://nextjs.org/docs)
- [Convex Docs](https://docs.convex.dev)
- [Radix UI](https://www.radix-ui.com)
- [Tailwind CSS v4](https://tailwindcss.com)
- [Vitest Docs](https://vitest.dev)
- [Playwright Docs](https://playwright.dev)
- [Turborepo Docs](https://turbo.build/repo/docs)
