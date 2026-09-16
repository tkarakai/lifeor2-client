# Auth E2E Coverage & better-auth Upgrade — Working Plan

**Status as of 2026-09-16.** Written as a handoff: it assumes no prior conversation
context. Read it end to end before picking up any item below.

**Steps 1–8 are merged. Start at step 9.**

| Step | State |
|---|---|
| 1–5b | merged — PRs #81, #82 |
| 6 — flip `SKIP_E2E` | done; it is `false`, and E2E now runs in CI on all five apps |
| 7 — better-auth upgrade | merged — PR #83 |
| 8 — Renovate | merged — PR #84. `RENOVATE_TOKEN` is set and `renovate.yml` is on `main`. **The verification dispatch has not been run yet** — see step 8 item 9 |
| **9 — follow-ups** | **next up**; sized and ordered below. Item 1 also gates how much automerge is worth |

`apps/web` is **104 passed, 0 failed, 0 skipped** on the upgraded auth stack, with nothing
quarantined. (An earlier revision of this doc said 105. That was wrong — the run behind it
still had a leftover scratch spec in `qa/e2e/`. The suite collects 104; confirm with
`cd apps/web && bunx playwright test --project=chromium --list`.) E2E is green across web, admin, landing, landing-static and storybook.

Two things to know before trusting any of this:

- **Run the auth specs with `--workers=1` locally.** The rate-limit throttles are
  per-process and Playwright workers do not share them; parallel local runs fail in ways
  that look like product bugs. CI already uses `workers: 1` per shard.
- **A dev database is not a fresh one.** Two mistakes in this work came from asserting on
  state a local backend happened to be in (`onboardingType` left on `publicWaitlist`, a
  stale `out/` directory). If a test passes locally and fails in CI, suspect that first.

---

## 1. Why this exists

> **Historical.** This section describes the situation *before* step 7. The versions below
> are no longer current — see step 7 for what landed. Kept because the failure modes it
> documents are exactly what Renovate will reproduce if step 8 lands without the
> auth-stack grouping rule.

`@convex-dev/better-auth` was pinned at `0.10.10` and `better-auth` at `1.4.12`. Neither
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
- `auth-two-factor.spec.ts` — 6 running (the 2 adapter-blocked ones unblocked by step 7).
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

### Step 6 — DONE: `SKIP_E2E` flipped *(was TODO 1)*

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

### Step 7 — DONE: the better-auth migration *(was TODO 5)*

**Backup-code sign-in works.** Both quarantined tests pass, and the whole `apps/web`
suite is **104 passed, 0 failed, 0 skipped** (was 102 passed + 2 skipped on the old
stack — same 104 collected, with the two backup-code tests no longer quarantined). Typecheck is green across all 6 packages.

The set that landed — newer than the one originally scoped, because all three can sit on
the same minor:

| Package | From | To |
|---|---|---|
| `@convex-dev/better-auth` | 0.10.10 | **0.12.5** (peer `better-auth >=1.6.11 <1.7.0`) |
| `better-auth` | 1.4.12 | **1.6.33** |
| `@better-auth/passkey` | 1.4.12 / ^1.4.18 | **1.6.33** (peer `^1.6.33`) |

`@better-auth/passkey@1.7.x` exists but requires `better-auth ^1.7.5`, outside the
adapter's range — so passkey stays on 1.6 until the adapter widens.

**The nested-copy problem from §1 is gone *for web, auth and backend*.** Adapter 0.12.5
nests `better-auth@1.6.33`, the same version those packages resolve.

**It is NOT gone for `apps/admin`.** An earlier revision of this doc claimed the problem
was fully solved; that was wrong. `apps/admin/package.json` still pins
`@convex-dev/better-auth: 0.10.10`, which drags `better-auth@1.4.12` along with it, so the
second divergent copy is still in `bun.lock`. This is live code —
`apps/admin/src/components/auth/auth-guard.tsx` imports `usePreloadedAuthQuery` from that
adapter — so admin and web run different auth libraries today.

Typecheck and E2E are green either way, which is exactly why it went unnoticed: nothing
fails, the two apps simply disagree. **Open follow-up:** bump `apps/admin` to `0.12.5` in
its own PR with its own test run. Renovate independently planned the same bump inside
`renovate/auth-stack`.

The lesson for the next upgrade: check **every** workspace that depends on the package,
not just the ones the change obviously touches.

**What actually had to change, beyond the version numbers:**

1. **`packages/backend/convex/betterAuth/schema.ts` was stale.** better-auth 1.6 added
   three fields to the `twoFactor` table — `verified`, `failedVerificationCount` and
   `lockedUntil`. Convex validators reject unknown fields, so `/two-factor/enable`
   returned **500 `ArgumentValidationError`** and 2FA enrolment broke outright. Each field
   surfaced one at a time, one request deeper into the flow.

   The file's header says to regenerate with `@better-auth/cli`, but **that package has no
   1.6 release** (latest is `1.5.0-beta.13`), and adapter 0.12.5's own bundled schema
   carries `verified` but neither of the other two. So the fields are hand-added and
   marked as such — regenerating blindly would drop them.

2. **`packages/auth/src/provider.tsx` needs a cast.** The adapter declares
   `AuthClient` as `ReturnType<typeof createAuthClient<BetterAuthClientPlugin & { plugins }>>`,
   an instantiation that collapses `useSession().data` to `never`. No client built with
   real plugin inference can satisfy it. Documented at the call site; revisit when the
   adapter's types widen.

Notably, the `$ERROR_CODES` and `viewBackupCodes` errors that dependabot's PRs produced
never appeared — they were artefacts of bumping `better-auth` while leaving the adapter
behind, exactly as §1 predicted.

Close dependabot **#77** as superseded.

### Step 8 — DONE: Renovate landed *(was TODO 6)*

Independent of everything above. Two parts: a code change an agent can do, and one secret
only the repo owner can create.

**Merged in PR #84** (2026-09-16): rebased onto `main`, auth-stack grouping rule added,
`RENOVATE_TOKEN` created. Originally stranded on branch
`025-renovate-dependency-automation` (tip `3d363ff`).

**The token is under-scoped and Renovate silently does ~12% of its job.** A verification
dispatch exits `0` but aborts after 4 of 34 branches:

```
POST /repos/tkarakai/web-app-starter/statuses/<sha> = 403
  "Resource not accessible by personal access token"
DEBUG: Caught error setting branch status - aborting
```

Renovate publishes the release-age hold as a **commit status**, so the PAT needs
**`Commit statuses: Read and write`** — a permission the table below originally omitted.
Consequences, all silent: `renovate/auth-stack` is planned but never pushed, and no
Dependency Dashboard issue is created (the dashboard is written at the *end* of a run).

Add the permission, re-dispatch, then confirm the dashboard issue exists and
`renovate/auth-stack` is one un-automerged PR.

Two things that *are* confirmed working: the token opens PRs authored by `tkarakai` (so
`ci-*` workflows trigger, which is the whole reason it is a PAT), and the auth-stack
grouping applies — Renovate planned `better-auth`, `@better-auth/passkey` and
`@convex-dev/better-auth` on a single branch, so #74/#77 cannot recur.

Do **not** use the string "Not enough time has elapsed" as an acceptance check; that is
PR-body text, not log text. Grep the debug log for `pendingVersions` instead.

**One thing is still outstanding:** nobody has run the verification dispatch (item 9
below). Until someone does, it is unknown whether the token is scoped correctly — the
first scheduled run is Monday/Thursday 06:00 UTC, and a 401/403 there fails quietly.

It adds
`renovate.json`, `.github/workflows/renovate.yml`, `docs/dependency-updates.md`, a
`CLAUDE.md` pointer, and pins GitHub Action digests across the `ci-*` workflows.

**The rebase no longer applies cleanly.** An earlier version of this doc said "zero
conflicts" — that is stale, and re-verified as stale on 2026-09-16. Conflict:
`.github/actions/setup-playwright/action.yml`. The branch changes the browser cache key
from `hashFiles('**/bun.lockb')` to `hashFiles('**/bun.lock')`; `main` now keys that cache
on the resolved Playwright version instead, which is strictly better (browser builds are
tied to the Playwright version, not the lockfile).

**Resolution: keep `main`'s version of that hunk and drop the branch's.** Expect the same
shape of conflict in the `ci-*.yml` files, where the branch pins action digests and `main`
has since edited nearby lines — take both changes there (keep `main`'s logic, apply the
branch's digest pins).

Before enabling, add a rule so the auth stack can never be split:

```json
{
  "description": "The auth stack moves together — the Convex adapter pins its own better-auth",
  "matchPackageNames": ["better-auth", "@better-auth/**", "@convex-dev/better-auth"],
  "groupName": "auth stack",
  "automerge": false
}
```

Without it, Renovate proposes `better-auth` alone and reproduces #74/#77 exactly. Step 7
is the proof: bumping `better-auth` without the adapter breaks the build, and bumping both
without reconciling the Convex schema breaks 2FA at runtime. **Also pin `@better-auth/passkey`
to `<1.7.0`** (or expect the group to fail): 1.7.x requires `better-auth ^1.7.5`, outside
the adapter's `>=1.6.11 <1.7.0` peer range.

Automerge-on-green is now genuinely worth something: `SKIP_E2E` is `false`, so the gate
Renovate merges against includes the E2E suite. That was not true when this step was
first written.

#### Creating `RENOVATE_TOKEN` — owner only

The workflow needs a **fine-grained PAT**, not the default `GITHUB_TOKEN`. The reason is
in `renovate.yml`: PRs opened with `GITHUB_TOKEN` do **not** trigger the `ci-*` workflows,
so automerge-on-green would merge against a gate that never ran.

1. Go to **https://github.com/settings/personal-access-tokens/new**
   (Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token)
2. **Token name:** `renovate-web-app-starter`
3. **Resource owner:** `tkarakai`
4. **Expiration:** 90 days or custom. Note the date — the workflow starts failing silently
   when it lapses, and the next agent will not be able to tell that from a config problem.
5. **Repository access:** *Only select repositories* → `web-app-starter`
6. **Permissions → Repository permissions:**

   | Permission | Access | Why |
   |---|---|---|
   | Contents | **Read and write** | push update branches |
   | Pull requests | **Read and write** | open, update, automerge PRs |
   | Workflows | **Read and write** | update `.github/workflows/*` when pinning action digests |
   | Issues | **Read and write** | the Dependency Dashboard issue |
   | Dependabot alerts | **Read-only** | vulnerability-driven updates |
   | Commit statuses | **Read and write** | publishes the release-age hold; without it the run aborts after ~4 branches while still exiting 0 |
   | Metadata | Read-only | mandatory, auto-selected |

7. **Generate token** and copy it — it is shown once.
8. Add it as a repository **secret** named exactly `RENOVATE_TOKEN`:

   ```bash
   gh secret set RENOVATE_TOKEN --repo tkarakai/web-app-starter
   # paste the token at the prompt, then confirm:
   gh secret list --repo tkarakai/web-app-starter
   ```

   Or in the browser: **Settings → Secrets and variables → Actions → New repository secret**
   (https://github.com/tkarakai/web-app-starter/settings/secrets/actions).

   It is a **secret**, not a variable — do not put it next to `SKIP_E2E`.

9. **Merge the Renovate PR before verifying.** `workflow_dispatch` can only reach a
   workflow that exists on the **default branch**, so while `renovate.yml` is unmerged you
   get:

   ```
   HTTP 404: workflow renovate.yml not found on the default branch
   ```

   That means the code has not landed, not that the token is wrong. The secret can be
   created at any time; only this check depends on the merge. Once it is on `main`:

   ```bash
   gh workflow run renovate.yml --repo tkarakai/web-app-starter -f logLevel=debug
   gh run watch "$(gh run list --workflow=renovate.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
   ```

   A missing or under-scoped token fails fast with a 401/403 in the "Run Renovate" step.

Also close dependabot **#77** as superseded by step 7.

### Step 9 — Smaller follow-ups *(was TODO 7)*

Opportunistic; none blocks anything else. Roughly in order of value per minute.

**1. Make the two passing gates required** *(repo settings, ~2 min)*

`CI Landing Static Complete` and `CI Storybook Complete` exist as jobs but are not in the
branch ruleset. Both were excluded because they had never passed; both pass reliably now.
Current required set is exactly:

```
CI Admin Complete, CI Landing Complete, CI Shared Complete, CI Web Complete
```

Add the two missing ones at
https://github.com/tkarakai/web-app-starter/settings/branches (ruleset `rule01`), or:

```bash
gh api -X PATCH repos/tkarakai/web-app-starter/branches/main/protection/required_status_checks \
  -f 'contexts[]=CI Admin Complete' \
  -f 'contexts[]=CI Landing Complete' \
  -f 'contexts[]=CI Shared Complete' \
  -f 'contexts[]=CI Web Complete' \
  -f 'contexts[]=CI Landing Static Complete' \
  -f 'contexts[]=CI Storybook Complete'
```

Until this lands, a storybook or landing-static regression cannot block a merge.

**2. De-duplicate the sessions UI** — **DONE, PR #90**

`SessionsList` is now the single implementation and `sessions-client.tsx` is presentational.

Correcting this entry, because its original wording was misleading and nearly caused a
working screen to be deleted: it said "the route renders the second", implying the first
was dead. **Both were live** — `sessions-client.tsx` serves the
`/dashboard/settings/sessions` route, and `sessions-list.tsx` is rendered by
`security-section.tsx` as the Security → Sessions tab. They were byte-identical in logic,
so consolidation was safe, but only after checking rather than trusting the description.

A **third copy** remains: `apps/admin/src/components/settings/admin-sessions-list.tsx`.
Left alone deliberately — sharing it means promoting the component into
`@repo/design-system`, which is a bigger job than this item.

**2b. Bump `apps/admin` to `@convex-dev/better-auth` 0.12.5** *(dependency change, own PR)*

Step 7 missed it. Admin still runs adapter 0.10.10 with nested `better-auth@1.4.12` while
the rest of the workspace is on 0.12.5 / 1.6.33. See step 7 for the detail. Needs its own
test run — admin has 10 E2E specs and they pass today on the old adapter, so a regression
there would be the signal.

**3. Audit-trail gaps** from `docs/audit-trail-event-inventory.md`

- `onboardingType` changes are unaudited, and that setting governs who may create an
  account at all.
- No emitters for `auth.passkey.sign_in`, `auth.two_factor.enabled`,
  `auth.email_verified`, `admin.invitation.revoked`, `user.avatar_changed`.
  Note `auth.two_factor.enabled` is a genuine backend gap — an earlier version of this doc
  claimed the client never reaches that code path, which is wrong; it does.
- Backend admin mutations throw before auditing, so failures are invisible.
- `actor` is a user ID rather than an email in `appSettings.set` and the two `adminAuth.ts`
  policy mutations.

**4. UX papercuts found while writing the E2E suite** *(product calls, not test problems)*

- **The backup-code challenge does not submit on Enter.** The step is a plain `<div>`, not
  a `<form>` (`auth-form.tsx`), so the "Verify" button must be clicked. This is in the
  account-recovery path, where a user is already stressed.
- **`/sign-up` has no link back to sign-in** under `publicWaitlist`; the only route out is
  "Join waitlist" to the marketing site. Under the `inviteOnly` default it *does* link to
  sign-in, so this only bites when onboarding is set to waitlist.
- **Inconsistent rate-limit copy:** the forgot-password form says "Too many requests.
  Please try again later." while the sign-in form says "Too many attempts. Please wait a
  moment before trying again."

**5. `apps/demo`** has no CI. It now gets a `prebuild` asset copy like the other apps, but
nothing builds or tests it. It is described as a static style experiment with no backend,
so this may be fine — worth a glance.

## 4. Traps — things that cost real time

**`locator.fill()` silently does nothing on this app's controlled inputs.** Filling
`#password` and reading it back yields `""`. `pressSequentially()` works. Use
`fillStable()` from `helpers/auth.ts`. This is almost certainly why no authenticated E2E
test existed before — an attempt produces a login that appears to do nothing, with no
error.

All auth-form fills now go through `fillStable`. If you add a spec, use it — `page.fill`
on these inputs fails silently, and a negative-path test ("expect an error") passes either
way, because an empty form also produces a validation error.

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

### CI-specific traps

These all cost time on the day E2E first ran on a real runner. Every one of them looked
like a test failure and was not.

**`dev-start.sh` was macOS-only.** `check_esbuild()` hardcoded `darwin-arm64` in all three
lookup paths, so on a Linux runner it reported the binary missing and exited before Convex
started. Now derived from `uname` via `esbuild_platform()`. If you add a platform-specific
path to that script, this is the shape of bug to avoid.

**Playwright must be installed from the app directory.** There is no `playwright` binary at
the repo root, so `bunx playwright install` there fetches the *latest* from npm and
downloads a browser build the pinned version cannot use — surfacing much later as
`Executable doesn't exist at .../chromium_headless_shell-<n>/`. `setup-playwright` now
takes a required `working-directory` and runs that workspace's own binary.

**`convex dev` downloads its backend from GitHub unauthenticated.** Four shards booting at
once hit `403 API rate limit exceeded`. Mitigated by caching `~/.convex` and staggering
shard startup. If you raise the shard count, re-check this.

**Playwright discards `webServer` stdout by default.** Without `stdout: "pipe"` a boot
failure is just `Process from config.webServer was not able to start. Exit code: 1` with no
diagnostics. All five configs now pipe it. Do not remove that.

**npm-script pre-hooks do not run when CI calls the tool directly.** `pretest:e2e` and
`predev` seed env files and copy shared assets, but CI runs `bunx playwright test` and
`bun run build` directly. Anything a local run gets from a hook has to be reachable from
`dev-start.sh` or the app's own `prebuild`.

**`apps/*/public/icon.svg` is gitignored.** It is produced by `copy-shared-assets.sh`, so a
fresh checkout never has it. Every app now runs that script in its own `prebuild` — a build
on a clean machine shipped without the icon before that.

**Convex's `SITE_URL` is a comma-separated trusted-origin list.** `dev-start.sh` used to
sync it for the web app only, so starting landing alone left its origin untrusted and every
browser call to the Convex HTTP router failed CORS. It now merges the starting app's origin
into whatever is already set.

**`waitForLoadState("networkidle")` never resolves on an authenticated page.** Convex holds
a live websocket open, so the network never goes idle and the wait burns the whole test
timeout. Wait for a concrete element instead.

**A fabricated `better-auth.session_token` cookie is not a session.** It satisfies the
proxy, which only checks presence, but not the dashboard layout, which validates
server-side. Tests that "authenticate" that way run against `/sign-in` — strict assertions
fail, and lenient ones pass vacuously, which is worse. Use `createDisposableUser()` and a
real sign-in.

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
