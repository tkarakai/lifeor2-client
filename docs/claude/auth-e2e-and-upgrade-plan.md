# Auth E2E Coverage & better-auth Upgrade — Working Plan

**Status as of 2026-09-15.** Written as a handoff: it assumes no prior conversation
context. Read it end to end before picking up any item below.

**Steps 1–5b are done** (one PR). The `apps/web` E2E suite is green for the first time:
**102 passed, 2 skipped, 0 failed.** Step 6 is now unblocked and is a repo-settings change
only the owner can make. Step 7 is the follow-up PR, and it is a bug fix rather than
housekeeping — backup-code sign-in returns HTTP 500 today, which is what the two remaining
quarantined tests pin down.

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
- `auth-session.spec.ts` — 6 running.
- `auth-password.spec.ts` — 7 running.
- `auth-two-factor.spec.ts` — 4 running, 2 quarantined (adapter, see step 4).
- `auth-passkey.spec.ts` — 4 running.

Whole-suite status: **102 passed, 2 skipped, 0 failed** in 5.3 minutes at `--workers=1`.

Run them:

```bash
cd apps/web && bunx playwright test --project=chromium --workers=1 \
  auth-session.spec.ts auth-password.spec.ts auth-two-factor.spec.ts auth-passkey.spec.ts
# → 21 passed, 2 skipped
```

`--workers=1` is required locally: the rate-limit throttles are per-process.

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

## 3. Open TODOs, in execution order

Reordered 2026-09-15. The original numbering (TODO 1–7) is kept in each heading so
older references still resolve; the sequence below is the one to work in.

Two facts drove the reorder, neither known when the list was first written:

- **`SKIP_E2E` was set for CI time/cost, not for flakiness** (confirmed by the repo
  owner). The suite was never judged unreliable — so the blocker is a runtime budget,
  which is fixable, and step 5 now exists to fix it.
- **The vacuous-`fill` problem in §4 is wider than recorded there** — it reaches
  `forgot-password.spec.ts` and `email-verification.spec.ts` too, ~33 tests. Auditing it
  has to precede turning CI on, or the first green run certifies tests that never typed
  anything.

The shape: **fix the product bugs → make the coverage real → make CI affordable → repair
the rotted specs (5b) → turn it on → then migrate.**

---

### Step 1 — DONE: enabling 2FA never showed the backup codes *(was TODO 3)*

**Fixed.** The diagnosis in the original plan was wrong, and worth recording because it
sent the investigation in the wrong direction: there is **no session drop and no redirect
to `/sign-in`**. The browser stays on the settings page and the `backup-codes` step does
render — it renders *empty*.

What actually happens, from a network trace of the enrolment flow:

| Request | Returns |
|---|---|
| `POST /api/auth/two-factor/enable` | `{ totpURI, backupCodes: [...10] }` |
| `POST /api/auth/two-factor/verify-totp` | `{ token, user }` — **no `backupCodes`** |

`two-factor-section.tsx` read only `totpURI` from the enable response and threw the codes
away, then `handleVerify` tried to read `backupCodes` off the *verify* response, which
never carries them. `setBackupCodes(data?.backupCodes ?? [])` therefore stored `[]`.

The impact the plan described was real — 2FA enforced with zero recovery codes — but the
mechanism was a discarded field, not a lost session.

Fix: capture `backupCodes` at enable time, keep preferring the verify response if a later
Better Auth version starts returning them, and clear them when enrolment is cancelled.

Note this invalidates the plan's reasoning that `auth.two_factor.enabled` has no emitter
"because the client never reaches that code path". The client *does* reach it. That audit
gap is a separate, still-open backend issue (step 9).

### Step 2 — DONE: the reset link was never broken *(was TODO 4)*

**Harness bug, not a product bug.** Password reset works end to end.

`waitForAuthEmail()` captured the URL with `(\S+)`. Convex writes the logged email block's
line breaks as the two characters `\` + `n`, not real newlines, so `\S+` ran past the end
of the value and swallowed the block's box-drawing border:

```
...?callbackURL=%2Freset-password\n╚═══════════╝\n'
```

Better Auth then correctly rejected that mangled `callbackURL` with
`INVALID_CALLBACKURL`. The 403 was the server doing its job.

With the regex fixed to stop at a literal `\n`, the link 302s to
`/reset-password?token=...` and the form renders. Both quarantined tests now pass.

Also corrected while enabling them: the app confirms the reset **in place** with a
"Password updated" panel and a manual "Sign in now" button — it does not redirect — so the
tests' `waitForURL(/sign-in|dashboard/)` could never have succeeded.

### Step 3 — DONE: specs that used raw `page.fill` *(new)*

27 call sites converted to `fillStable` across `auth-flow`, `forgot-password`,
`email-verification` and `auth-rate-limits`. `fillStable` throws when a value does not
stick, so a vacuous pass now fails loudly instead of going green.

### Step 4 — DONE (with one adapter-blocked pair) *(was TODO 2)*

All four auth specs run on disposable accounts; the shared-seed restore hooks are gone.
**21 passing, 2 quarantined** (`--workers=1`).

Fixed along the way — each of these was a real defect, not a flaky selector:

- **`revokeSessions()` instead of `revokeOtherSessions()`** — "Sign out all others" signed
  the user out of the device they were sitting at. The bug existed in **two** copies of
  the logic: `components/settings/sessions-list.tsx` and the one the route actually
  renders, `app/[locale]/(dashboard)/dashboard/settings/sessions/sessions-client.tsx`.
  Fixing only the first changes nothing — that duplication is itself worth cleaning up.
- **Passkey rename/delete were icon-only buttons with no accessible name**, so they were
  unreachable by role for screen readers and for tests. Added `aria-label`s.
- **`disableTwoFactor` raced the section's async status fetch** and silently reported
  "already off", which surfaced much later as an unexpected 2FA challenge.
- **The backup-code challenge step is a `<div>`, not a `<form>`** — Enter does not submit,
  the "Verify" button must be clicked. A real UX papercut in the recovery path.
- **`/dashboard/settings/sessions` renders fine.** The old "no session cards" quarantine
  was not reproducible on a disposable account; it was most likely shared-seed fallout.

**Still quarantined — backup-code sign-in is broken by the adapter:**

`POST /api/auth/two-factor/verify-backup-code` returns **HTTP 500**, empty body. Convex
logs `Error: where clause not supported`. Better Auth consumes a backup code with a
two-condition where clause (optimistic concurrency):

```js
where: [{ field: "id", ... }, { field: "backupCodes", ... }]
```

`@convex-dev/better-auth@0.10.10` supports only a single `eq` condition and throws
otherwise (`src/client/adapter.ts`, the `update` branch). Not fixable in app code —
`packages/backend/convex/betterAuth/adapter.ts` is a thin re-export of `createApi`.

**This makes the upgrade a bug fix, not housekeeping: backup codes are the documented
account-recovery path and they do not work at all.** The two quarantined tests are the
acceptance criteria for step 7.

**Rate limits are IP-keyed, and that bites.** `authPasswordResetRequest` is 3/minute
keyed by IP (`rateLimits.ts`), so disposable users do *not* isolate it. Added
`throttlePasswordResetRequest()` alongside `throttleSignIn()`. Both counters are
per-process, so **the auth specs only pass reliably at `--workers=1`** — which is what CI
uses, and each CI shard gets its own backend, so this is a local-run caveat.

### Step 5 — DONE: E2E suite brought inside a CI budget *(new — the real `SKIP_E2E` blocker)*

`apps/web` carries ~134 collected tests across 15 specs; the other four apps have 7–15
each and need nothing. CI ran `workers: 1` with `retries: 2` against `timeout-minutes: 15`,
so flipping `SKIP_E2E` would have produced a timeout rather than a signal.

Changes:

- `ci-web.yml`: the `e2e` job is now a 4-way shard matrix
  (`--shard=${{ matrix.shard }}/${{ strategy.job-total }}`), `fail-fast: false`,
  `timeout-minutes` 15 → 20.
- `playwright.config.ts`: CI reporter is `blob`; a new `e2e-report` job merges the shards
  into one HTML report via `playwright merge-reports`.
- Blob and snapshot artifacts are per-shard (`blob-report-web-<n>`).

`workers` deliberately stays at **1**. Sharding is what buys the parallelism, and it
*fixes* the rate-limit constraint rather than worsening it: each shard boots its own
Convex backend through the Playwright `webServer`, so the IP-keyed auth limits and the
per-process `throttleSignIn` / `throttlePasswordResetRequest` counters all stay correct.
Raising `workers` inside a shard would reintroduce exactly the interference that makes the
auth specs fail locally.

**Not yet measured on a real runner** — `SKIP_E2E` is still `true`, so no sharded run has
executed in CI. The 4-way split is sized from local timings, not observed CI timings;
expect to tune the shard count after the first green run.

### Step 5b — DONE: 34 pre-existing failures, from a UI redesign *(new)*

**The full `apps/web` suite is now green: 102 passed, 2 skipped, 0 failed, 5.3 minutes**
(`--workers=1`). Before: 69 passed, 34 failed, 11 minutes — the failures were each burning
a 30s timeout, which is most of the difference.

These 34 were **not** caused by the rest of this work. Verified by stashing every change
and re-running the seven affected specs on clean `main`: identical failure sets, zero
regressions. And the plan's guess that they were "passing vacuously" was wrong — they were
failing outright, and had been since a UI redesign, invisible because `SKIP_E2E` has been
`true` since 2026-02-09.

Not one root cause but several, each a spec frozen against a UI that moved on:

| Cause | Fix |
|---|---|
| Sign-in is now a **two-step** form; `#password` does not exist until the email step is submitted | `submitEmailStep()` before touching `#password` |
| Sign-up is **invitation-gated** (`onboardingType: inviteOnly`); `/en/sign-up` renders no inputs at all | rewritten to assert the gate — a stranger must not be able to self-register |
| Reset-password `minLength` is **12**, not 8, and submit is disabled until a **strength** check passes | strength-passing fixture password; corrected the attribute |
| Session tests authenticated with a **fabricated cookie** — enough for the proxy, not for the dashboard layout's server-side validation, so they asserted against the sign-in page | real `signIn()` via a disposable user |
| `__Secure-` prefixed cookie without `secure: true` | Chrome rejects the whole `addCookies` call |
| CSP test appended a script via `page.evaluate` and expected it to be blocked | under `'strict-dynamic'` that is *supposed* to run; now asserts the policy (nonce present, no `'unsafe-inline'`) |
| Assertions greping `page.content()` / serialized HTML for payload substrings | scoped to visible text, or asserted structurally — `"description"` contains `"script"` |

**Two of these "test failures" were product bugs.** A stale test is not automatically a
wrong test:

- **`listSessions()` failures were silent.** It resolves with `{ data, error }` rather than
  throwing, and the code checked only `result.data`. On an API failure the page sat in its
  loading skeleton forever with no message. Fixed in both copies of the sessions UI.
- ~~The sign-up page offers no route back to sign-in~~ — **this was wrong**, and the first
  real CI run caught it. The blocked page's CTA is conditional on `onboardingType`:
  `publicWaitlist` links out to the marketing waitlist, and anything else — including the
  `inviteOnly` default — links back to sign-in. The local dev database had been left on
  `publicWaitlist`, so only the waitlist variant was ever observed. The test now asserts
  the affordance exists without pinning the variant. A reminder that a dev database is not
  a fresh one, and that asserting on locally-observed state is how environment-dependent
  tests get written.

Some tests were retargeted rather than repaired, because what they asserted no longer
exists: the sign-up XSS test now exercises forgot-password, the only other unauthenticated
form that echoes input back. `email-verification.spec.ts`'s sign-up test now asserts the
absence of a self-service path instead of the presence of a form.

### Step 6 — Flip `SKIP_E2E` *(was TODO 1)*

**The repo variable `SKIP_E2E` is set to `true`.** Every E2E job in every workflow is
gated on `vars.SKIP_E2E != 'true'`, so **no E2E test has ever run in CI** — not the ones
added recently, not the pre-existing ones. Until this flips, the entire suite is
local-only and protects nothing.

It was set for CI time/cost. Step 5 made it affordable and step 5b made it safe, and both
are done — **this is now unblocked.** The full suite is green locally at `--workers=1`,
which is the configuration each CI shard runs.

The one thing still unverified is the sharded run itself: no E2E job has ever executed on
a real runner, so the 4-way split is sized from local timings (5.3 min serial on a fast
laptop; GitHub runners are slower, which is why the split is deliberately generous).
Expect to tune the shard count after the first green run.

```bash
gh api repos/tkarakai/web-app-starter/actions/variables/SKIP_E2E   # inspect
```

That first run will be the first real validation these specs have ever had.

### Step 7 — The better-auth migration *(was TODO 5)*

Only after steps 4 and 6 give coverage that actually runs. One PR moving all three
packages together to the set in §1.

**This is now a bug fix, not housekeeping.** Step 4 established that backup-code sign-in
returns HTTP 500 on `0.10.10` because the adapter rejects Better Auth's two-condition
where clause. Backup codes are the documented recovery path for a lost authenticator, so
today a user who enrols in 2FA and loses their device cannot get back in.

**Acceptance criteria:** un-quarantine the two `test.fixme` cases in
`auth-two-factor.spec.ts` ("accepts a backup code at the challenge and burns it",
"regenerating backup codes invalidates the previous set"). If they pass, the adapter
upgrade genuinely fixed recovery; if they still 500, the upgrade did not deliver the one
thing that most justifies it. Then `next` → 16.3.3 and `vitest` 3→5 as separate
PRs — neither is coupled to the auth stack, and vitest 5 is a two-major jump needing its
own migration.

Close dependabot **#77** as superseded.

### Step 8 — Land Renovate *(was TODO 6)*

Independent of the E2E work; can be picked up in parallel at any point, but the grouping
rule below must be in place before it is enabled.

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

Note that automerge-on-green is worth strictly less while `SKIP_E2E` is `true` — the gate
it merges on does not include E2E. Another reason step 6 matters.

### Step 9 — Smaller follow-ups *(was TODO 7)*

Opportunistic; none blocks anything above.

- **Add `CI Landing Static Complete` to the branch ruleset's required checks.** The
  workflow landed in #79 and passed its first run, but is not yet required. Repo-settings
  change, not a file. Two minutes — do it whenever.
- **Audit-trail gaps** from `docs/audit-trail-event-inventory.md`: `onboardingType`
  changes are unaudited (it governs who may create an account at all); no emitters for
  `auth.passkey.sign_in`, `auth.two_factor.enabled`, `auth.email_verified`,
  `admin.invitation.revoked`, `user.avatar_changed`; backend admin mutations throw before
  auditing so failures are invisible; `actor` is a user ID rather than an email in
  `appSettings.set` and the two `adminAuth.ts` policy mutations.
  (`auth.two_factor.enabled` does **not** resolve as part of step 1 — the client does
  reach that code path, so the missing emitter is a genuine backend gap.)
- **`apps/demo`** has no `.env.local` and no CI, like `landing-static` did. It is
  described as a static style experiment with no backend, so this may be fine — worth a
  glance.

## 4. Traps — things that cost real time

**`locator.fill()` silently does nothing on this app's controlled inputs.** Filling
`#password` and reading it back yields `""`. `pressSequentially()` works. Use
`fillStable()` from `helpers/auth.ts`. This is almost certainly why no authenticated E2E
test existed before — an attempt produces a login that appears to do nothing, with no
error.

Four pre-existing specs still use `page.fill` on auth forms and **may be passing
vacuously**: `auth-flow.spec.ts` (9), `forgot-password.spec.ts` (7),
`email-verification.spec.ts` (13), `auth-rate-limits.spec.ts` (4). Nearly all assert that
an error appears — and an empty form produces a validation error too, so they pass
whether or not the fill worked. See step 3; this must be settled before `SKIP_E2E` flips.

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
not in the DOM until expanded. Target the trigger via Radix's `[data-state="closed"]`
**scoped to the tabpanel** — page-wide, that selector matches other collapsed things and
the click hangs. The secret renders in a `<code>`, not a `[data-slot="copyable-field"]`.
Simplest of all: take `totpURI` straight off the `/two-factor/enable` response.

**Backup codes render in a `<pre>` inside `[data-slot="copyable-field"]`**, not a
`<textarea>` — and only when `CopyableField` is given `rows`; without it the value sits in
a `<span>`.

**Convex writes the auth-email log block's line breaks as literal `\` + `n`,** not real
newlines. Any `\S+` scrape of that block runs past the value and swallows the box border.
This masqueraded as a broken password reset for an entire session — see step 2.

**Reset/verification rate limits are keyed by IP, not email.** `authPasswordResetRequest`
is 3/minute (`rateLimits.ts`), so disposable users do not isolate it the way they isolate
sign-in. Use `throttlePasswordResetRequest()`.

**The auth specs need `--workers=1` locally.** The throttle counters are per-process and
Playwright workers do not share them, so parallel local runs fail in ways that look like
product bugs. CI already uses `workers: 1`.

**A locator built on a mutable attribute cannot be re-resolved.**
`input[value="Before Rename"]` stops matching the instant the field is cleared, and the
next action hangs to the test timeout. Target a stable `aria-label` instead.

**Adding an `aria-label` can break an existing role selector.** Labelling the passkey
pencil button "Rename passkey …" made `getByRole("button", { name: /rename/i })` ambiguous
with the "Save" button, and the pencil wins on DOM order. Use `{ exact: true }`.

**There are two copies of the sessions UI.** `components/settings/sessions-list.tsx` and
`app/[locale]/(dashboard)/dashboard/settings/sessions/sessions-client.tsx`. The route
renders the second. Fixing only the first looks correct and changes nothing.

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
# Auth E2E only (fast; avoids the full turbo build graph). --workers=1 is required:
# the rate-limit throttle counters are per-process and workers do not share them.
cd apps/web && bunx playwright test --project=chromium --workers=1 \
  auth-session.spec.ts auth-password.spec.ts auth-two-factor.spec.ts auth-passkey.spec.ts

# What Playwright collects (fixme tests appear here but do not execute)
cd apps/web && bunx playwright test --project=chromium --list

# Full local CI
bun run ci          # or ci:quick to skip E2E

# Check a dependency's peer requirements before proposing an upgrade
bun info @convex-dev/better-auth@latest peerDependencies
```
