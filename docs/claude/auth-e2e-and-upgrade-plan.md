# Auth E2E Coverage & better-auth Upgrade — Working Plan

**Status as of 2026-09-16.** Written as a handoff: it assumes no prior conversation
context. Read it end to end before picking up any item below.

The through-line: **the `better-auth` stack needs upgrading, and it cannot be done
safely until the auth flows have real test coverage.** Everything here either builds
that coverage or is a blocker discovered while building it.

---

## 1. Why this exists

`@convex-dev/better-auth` is pinned at `0.10.10` and `better-auth` at `1.4.12`. Neither
pin is a compatibility decision — `0.10.10` was published 2026-01-10 and was simply the
newest release when the project was scaffolded. `next@16.1.5` and `convex@1.31.7` were
pinned the same way on the same days. Nothing has moved since.

Dependabot has twice proposed bumping `better-auth` (PR #74, closed; **PR #77, still
open**). Both fail, and they fail *by construction*:

- `@convex-dev/better-auth@0.10.10` **nests its own `better-auth@1.4.12`**. Bumping the
  workspace copy does not upgrade what the Convex adapter actually runs — it just puts
  two copies of the auth library in the tree.
- `@better-auth/passkey@1.4.18` declares `peerDependencies: { better-auth: "1.4.18" }` —
  an exact pin that `1.6.x` violates.
- Dependabot never bumps the adapter, because it is a different package from a different
  org (`get-convex/better-auth`), so it is not in the security group.

Verified by reproducing PR #77 locally (`bun install` + `bunx turbo typecheck`):

```
auth-form.tsx(367,41):            Property 'twoFactor' does not exist on ReactAuthClient
two-factor-section.tsx(94,39):    Property 'twoFactor' does not exist on ReactAuthClient
packages/auth/src/client.ts(70,5):     $ERROR_CODES incompatible — not a BetterAuthClientPlugin
packages/backend/convex/auth.ts(813,7): $ERROR_CODES incompatible — not a BetterAuthPlugin
packages/backend/convex/sessions.ts(270,35): Property 'viewBackupCodes' does not exist
```

Also: `next` never actually upgrades in those PRs — `apps/web/package.json` pins `16.3.3`
but the lockfile still resolves `next@16.1.6`. And neither PR touches `bun.lock` at all.

**A coherent upgrade set does exist** (checked against npm):

| Package | From | To | Constraint |
|---|---|---|---|
| `@convex-dev/better-auth` | 0.10.10 | **0.12.5** | peer `better-auth: ">=1.6.11 <1.7.0"` |
| `better-auth` | 1.4.12 | **1.6.22** | satisfies the adapter's peer |
| `@better-auth/passkey` | 1.4.12 / ^1.4.18 | **1.6.x** (up to 1.6.33) | `1.6.22` peer is `better-auth: "^1.6.22"` |

All three must move together. Expect real API changes: the adapter crosses two minors on
a pre-1.0 package, plus the `$ERROR_CODES` / `viewBackupCodes` / `twoFactor`-client
changes the typecheck already surfaced.

---

## 2. What has landed

| PR | What |
|---|---|
| #76 | Roadmap refresh; regenerated `docs/audit-trail-event-inventory.md` |
| #78 | First authenticated auth E2E coverage (5 running, 18 quarantined) |
| #79 | `ci-landing-static.yml`; `scripts/ensure-app-env.sh`; `bun.lockb` → `bun.lock` fix |
| *this* | Disposable E2E user fixture; 10 auth tests running |

### The E2E suite today

Lives in `apps/web/qa/e2e/`:

- `helpers/auth.ts` — sign-in/out, rate-limit pacing, security sub-tab navigation, OTP
  entry, a dependency-free RFC 6238 TOTP implementation, and an auth-email reader that
  scrapes `.convex-dev.log`.
- `helpers/fixtures.ts` — `createDisposableUser()`.
- `auth-session.spec.ts` — 5 running.
- `auth-password.spec.ts` — 5 running, 2 quarantined.
- `auth-two-factor.spec.ts` — 6 quarantined.
- `auth-passkey.spec.ts` — 4 quarantined.

Run them:

```bash
cd apps/web && CI=true bunx playwright test --project=chromium auth-session.spec.ts auth-password.spec.ts
# → 10 passed, 3 skipped
```

### The disposable user fixture

`packages/backend/convex/e2eFixtures.ts` exposes `POST /api/dev/e2e-user`, which mints a
verified, ready-to-sign-in account. Tests cannot self-register because `onboardingType`
defaults to `inviteOnly`, so the endpoint creates the invitation rows first (mirroring
`devSeed.setupDevUser`), then signs the user up through Better Auth.

**Three independent safety guards, all required:**

1. `DEV_SEED_ENABLED === "true"` — set by `dev-start.sh` on the local anonymous backend,
   never on staging or production, where the route 404s.
2. Email must match `/^e2e-[a-z0-9-]{1,60}@e2e\.local$/`. `.local` is reserved (RFC 6762)
   and cannot receive mail, so a fixture can never collide with a real address.
3. Password must clear the app's 12-character minimum.

Accounts are create-only and never reused. CI gets a fresh backend per run; locally they
accumulate harmlessly in a disposable database.

---

## 3. Open TODOs, in dependency order

### TODO 1 — Decide on `SKIP_E2E` *(blocks all E2E value)*

**The repo variable `SKIP_E2E` is set to `true`.** Every E2E job in every workflow is
gated on `vars.SKIP_E2E != 'true'`, so **no E2E test has ever run in CI** — not the ones
added here, not the pre-existing ones.

Until this flips, the entire suite is local-only and protects nothing.

Before flipping:

- **Find out why it was set.** If E2E was disabled for flakiness, that changes the work.
  This is not recorded anywhere in the repo, and was not known during this session.
- **Raise `timeout-minutes: 15`.** A full local run of `apps/web` took **31 minutes**.
- Expect the first run to exercise ~35 pre-existing tests never validated in CI.

```bash
gh api repos/tkarakai/web-app-starter/actions/variables/SKIP_E2E   # inspect
# flip only after the above
```

### TODO 2 — Un-quarantine the remaining specs

18 tests ship as `describe.fixme` / `test.fixme` (reported as skipped, CI stays green).
Each carries a header explaining why. The shared-account blocker is **now solved** by the
fixture, so most can be rewired the way `auth-password.spec.ts` was — replace
`SEED_USER` with `await createDisposableUser()`.

Remaining genuine blockers are in TODO 3 and TODO 4.

Order: `auth-two-factor.spec.ts` first (highest value — it covers what the upgrade most
likely breaks), then `auth-passkey.spec.ts`.

Note for 2FA: enrolment *does* succeed server-side even though the UI loses the session
(see TODO 3). So tests that only need 2FA to be **on** — the sign-in challenge, rejecting
a bad code, disabling 2FA — can be written by reading the secret before verifying, then
signing back in. Only the two tests that need the **backup codes** are truly blocked.

### TODO 3 — BUG: enabling 2FA never shows the backup codes

**Reproduced twice on a freshly-seeded database.** At the enrolment step, submitting a
valid TOTP code verifies server-side — 2FA really is switched on, confirmed by a later
password sign-in being challenged for a code — but the session is dropped at that moment
and the browser lands on `/sign-in`. The `backup-codes` step in
`apps/web/src/components/settings/two-factor-section.tsx` never renders.

**The user ends up with 2FA enforced and zero recovery codes.** That is a lockout risk.

It also explains a gap recorded in `docs/audit-trail-event-inventory.md`:
`auth.two_factor.enabled` has no emitter, because the client never reaches that code path.

Reproduce: sign in → Settings → Security → Two-Factor → Enable → password → read the
secret from the "Can't scan?" collapsible → submit a valid TOTP.

The TOTP helper in `helpers/auth.ts` is proven correct — the server accepted a code it
generated.

### TODO 4 — BUG?: emailed password-reset link fails with `INVALID_CALLBACKURL`

Navigating to the reset URL from the email returns
`{"code":"INVALID_CALLBACKURL","message":"Invalid callbackURL"}`, both when following the
absolute link and when rewriting it onto the app origin.

**Unresolved whether this is test-harness-only or a genuine break.** It is the primary
account-recovery path, so it matters. **Confirm by clicking a reset link by hand in a
browser** before assuming it is only a test problem.

Two tests are quarantined on this in `auth-password.spec.ts`.

### TODO 5 — The better-auth migration

Only after TODO 2 gives real coverage. One PR moving all three packages together to the
set in §1. Then `next` → 16.3.3 and `vitest` 3→5 as separate PRs — neither is coupled to
the auth stack, and vitest 5 is a two-major jump needing its own migration.

Close dependabot **#77** as superseded.

### TODO 6 — Land Renovate

Fully implemented but **never merged**: branch `025-renovate-dependency-automation`, tip
`3d363ff` (2026-07-07), no open PR. It adds `renovate.json`,
`.github/workflows/renovate.yml`, `docs/dependency-updates.md`, and pinned GitHub Action
digests. It rebases onto current `main` with zero conflicts.

Renovate fixes the *process* problems dependabot has here — it commits the lockfile, and
automerge is gated on green CI. It does **not** fix the coupling on its own. Before
enabling, add a rule so the auth stack can never be split:

```json
{
  "description": "The auth stack moves together — the Convex adapter pins its own better-auth",
  "matchPackageNames": ["better-auth", "@better-auth/**", "@convex-dev/better-auth"],
  "groupName": "auth stack",
  "automerge": false
}
```

Without it, Renovate proposes `better-auth` alone and reproduces #74/#77 exactly. Note
that `1.4.12 → 1.6.22` is a *minor* by semver, so it would otherwise match the existing
automerge rule.

**Still requires a manual step only the repo owner can do:** create the `RENOVATE_TOKEN`
secret (fine-grained PAT: Contents RW, PRs RW, Workflows RW, Issues RW, Dependabot alerts
RO).

### TODO 7 — Smaller follow-ups

- **Add `CI Landing Static Complete` to the branch ruleset's required checks.** The
  workflow landed in #79 and passed its first run, but is not yet required. Repo-settings
  change, not a file.
- **`/dashboard/settings/sessions` renders no session cards under Playwright** — not even
  the current session — so "Sign out all others" never appears. One test is quarantined on
  this in `auth-session.spec.ts`. Unclear whether load-timing or the query returning
  empty.
- **Audit-trail gaps** from `docs/audit-trail-event-inventory.md`: `onboardingType`
  changes are unaudited (it governs who may create an account at all); no emitters for
  `auth.passkey.sign_in`, `auth.two_factor.enabled`, `auth.email_verified`,
  `admin.invitation.revoked`, `user.avatar_changed`; backend admin mutations throw before
  auditing so failures are invisible; `actor` is a user ID rather than an email in
  `appSettings.set` and the two `adminAuth.ts` policy mutations.
- **`apps/demo`** has no `.env.local` and no CI, like `landing-static` did. It is
  described as a static style experiment with no backend, so this may be fine — worth a
  glance.

---

## 4. Traps — things that cost real time

**`locator.fill()` silently does nothing on this app's controlled inputs.** Filling
`#password` and reading it back yields `""`. `pressSequentially()` works. Use
`fillStable()` from `helpers/auth.ts`. This is almost certainly why no authenticated E2E
test existed before — an attempt produces a login that appears to do nothing, with no
error.

Pre-existing `auth-flow.spec.ts` and `auth-rate-limits.spec.ts` both use `page.fill` on
auth forms and **may be passing vacuously**. Worth auditing.

**IDs starting with a digit are invalid CSS selectors.** `#2fa-password` throws; use
`[id='2fa-password']`.

**Settings has two nested tab layers**, and both read the same `?tab=` query param, so the
inner one cannot be deep-linked. Use `openSecurityTab(page, "2fa" | "passkeys" | ...)`.

**A backgrounded tab stalls CSS transitions**, so Playwright's actionability check never
settles and `.click()` hangs for the full timeout. Call `page.bringToFront()` — already
done inside `fillStable`, `signOut`, and `openSecurityTab`.

**`authSignIn` is rate limited to 3 per 10s, keyed by email.** `throttleSignIn()` paces
this, but its counter is per-process — Playwright workers do not share it. Disposable
users sidestep the problem entirely, which is the main reason `auth-session.spec.ts` was
moved onto them.

**The TOTP secret is behind a collapsible** ("Can't scan? Enter this key manually") and is
not in the DOM until expanded. Target the trigger via Radix's `[data-state="closed"]`,
not its localised label — there are 15 locales.

**Backup codes render in a `<pre>` inside `[data-slot="copyable-field"]`**, not a
`<textarea>`.

**Auth emails go to the Convex server console** when `RESEND_API_KEY` is unset, and
`dev-start.sh` redirects that to `.convex-dev.log`. `waitForAuthEmail()` scrapes it.

**A poisoned dev-seed account breaks local development,** not just tests. If sign-in
starts demanding a 2FA code you never set up, wipe the backend:

```bash
bash scripts/dev-stop.sh
rm -rf ~/.convex/anonymous-convex-backend-state/<deployment>   # see CONVEX_DEPLOYMENT in .env.local
```

Disposable users make this much less likely, but the seed account is still shared by any
spec that uses `SEED_USER`.

---

## 5. Useful commands

```bash
# Auth E2E only (fast; avoids the full turbo build graph)
cd apps/web && CI=true bunx playwright test --project=chromium auth-session.spec.ts auth-password.spec.ts

# What Playwright collects (fixme tests appear here but do not execute)
cd apps/web && bunx playwright test --project=chromium --list

# Full local CI
bun run ci          # or ci:quick to skip E2E

# Check a dependency's peer requirements before proposing an upgrade
bun info @convex-dev/better-auth@latest peerDependencies
```
