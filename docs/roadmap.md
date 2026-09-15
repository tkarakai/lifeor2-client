# Roadmap

Status as of 2026-09-15.

## Now

- [ ] Land Renovate. The repo settings were flipped on 2026-07-07 for the self-hosted
      workflow, but `renovate.json` and the workflow itself were never committed, and
      `RENOVATE_TOKEN` is still unset.
- [ ] Close or rebase the two stale PRs: #35 (build-once promotion, conflicting since
      2026-02) and #74 (dependabot, behind but mergeable).
- [x] Slash commands for PR review — see `.claude/commands/pr-review.md` and
      `.claude/commands/pr-review-respond.md`.

## Shipped

### Before going live

- [x] About page, T&C, Privacy page templates
- [x] API rate limiting
- [x] Admin app with user management and banning
- [x] `CLAUDE.md` refactor
- [x] Security test suite
- [x] Deploy to Convex / Vercel
- [x] i18n framework, RTL and SEO included
- [x] Waitlist for early preview release — no open signup page, token-gated signup,
      Convex-backed, admin-configurable, batch invites with single-use token links
- [x] Environment-specific dev banner
- [x] Landing page is CDN-deployable
- [x] Announcement banner system — scheduled publish/unpublish, single live announcement,
      call-to-action and learn-more modal, dismissal per session or permanently, all
      managed from the admin dashboard
- [x] Audit trail with admin dashboard — see
      [`audit-trail-architecture.md`](./audit-trail-architecture.md) and
      [`audit-trail-event-inventory.md`](./audit-trail-event-inventory.md)
- [x] Graceful offline detection and handling (web and admin)
- [x] Passkey auth and security policy settings
- [x] Admin bootstrap, auth hardening, and onboarding wizard

### Bugs

- [x] Landing and web static links
- [x] Infinite redirect for non-admin logins on the admin app
- [x] Staging protected from public access (automatic via Vercel preview deployments)

### In flight

- [~] Build once, promote through environments — PR #35 has been conflicting since
      2026-02. Decide whether to rebase or restart.

## Next

### Auth

The identity anchor is always the email address in Better Auth; every account needs one,
regardless of which methods are enabled. Primary methods are parallel paths to a session —
a single account can carry a password, a passkey, and multiple social providers at once,
linked to one user record via account linking.

Shipped: email + password, passkey, TOTP 2FA, backup codes, email verification, password
reset.

Candidates, roughly in order of value:

- [ ] Magic link (no password)
- [ ] Email OTP
- [ ] Social providers
- [ ] Session management UI — active sessions across devices with remote revocation,
      showing device type and last activity. Partially built: revocation exists in
      settings; device metadata display does not.
- [ ] Phone number with OTP verification, including number changes
- [ ] Username as an alternative identifier
- [ ] Anonymous accounts, upgradeable to full accounts later
- [ ] Corporate / SSO

**Known Better Auth constraint:** the `twoFactor` plugin currently works only with
credential (email + password) accounts. Social-login users cannot enable it, and passkeys
are treated as inherently phishing-resistant and get no layered second factor. A mandatory
2FA policy therefore has to keep a credential pathway available during enrolment.

**Recovery is a separate product surface.** Target at least two meaningfully independent
recovery options per account. Available building blocks: backup codes (shipped), email OTP
for forgot-password flows, and a magic-link regain-access flow if built.

### Platform

- [ ] Versioning — synchronized across all apps, surfaced in the UI, with repo releases
- [ ] Framework-level security tests, independent of the app but assuming Convex and
      Better Auth. The specific worry is the Firebase-style failure mode: shared tables
      where default access control does not enforce row-level ownership.
- [ ] Health check endpoint. `packages/backend/convex/meta.ts` exports a `health` query
      returning `{status, timestamp}` — it is a public Convex query, not an HTTP endpoint.
      Decide whether to expose it over HTTP for external uptime monitoring.
- [ ] Email notifications for failed workflows (GitHub built-in)
- [ ] Uptime page, optionally including deployment status polled from the GitHub status API
- [ ] Accessibility testing and guidelines
- [ ] Next.js bundle analyzer and production optimization
- [ ] SEO for the landing page
- [ ] Email provider integration — Resend, SendGrid, or Postmark
- [ ] Customer feedback form feeding into the admin app; issue tracking, effectively

### Audit trail follow-ups

From the gaps in
[`audit-trail-event-inventory.md`](./audit-trail-event-inventory.md#8-gaps):

- [ ] Audit `onboardingType` changes. It governs who may create an account at all, and is
      currently changeable with no trace.
- [ ] Emit `auth.passkey.sign_in` so passkey logins are distinguishable from password ones
- [ ] Emit `auth.two_factor.enabled` and `auth.email_verified` on completion
- [ ] Capture failures in the backend admin mutations, which currently throw before
      auditing
- [ ] Normalise `actor` to an email in `appSettings.set` and the `adminAuth.ts` policy
      mutations, which use a user ID

### Agentic development

- [ ] Assess how suitable this repo is for agentic development — structure, testability,
      conventions, reusable parts, security awareness, shared solutions to common
      problems, E2E testability, ability to test running code rather than only units, and
      deployability. Produce a document covering what already works and what needs
      building. Research current best practice first.
- [ ] Evaluate a TDD-driven agentic feature flow. Reference:
      [ship-daily system](https://theailaunchpad.substack.com/p/my-ship-daily-system-with-claude),
      built on [superpowers](https://github.com/obra/superpowers).

## Later

- [ ] Analytics — PostHog, Plausible, or Umami
- [ ] Error monitoring — Sentry or similar
- [ ] Webhook infrastructure for external integrations: signature verification, retry
      logic, and example implementations. Needed for payment providers and third-party
      automation.
- [ ] Payment integration — Stripe, Square
- [ ] Database seeding with realistic sample data and relationships for development and
      testing

## Schema refactor (proposed, not scheduled)

Current tables: `migrations`, `userProfiles`, `adminEmails`, `projects`, `tasks`,
`uploads`, `appSettings`, `waitlistEntries`, `invitationTokens`, `adminInvitations`,
`announcements`, `auditTrail`.

`projects`, `tasks`, and `uploads` are app-specific rather than framework-level; leave
them alone.

> An earlier draft of this plan proposed renaming every table with a leading underscore
> (`_userWaitlist`, `_auditTrail`, …). That is not possible: Convex reserves the underscore
> prefix for system tables such as `_storage` and `_scheduled_functions`. Dropped.

Ideas still worth considering, none of them urgent — each is a schema migration on a
starter template, so weigh the cost:

- Split `waitlistEntries` into separate waitlist and invitation tables. Today one table
  carries both concerns via a `status` field.
- Split admin profiles from `userProfiles`. The argument is blast radius: admin records
  and user records have different sensitivity and different access patterns.
- Give admin invitations their own token table, matching how `invitationTokens` is
  separate from `waitlistEntries`. Admin invitation tokens currently live inline on
  `adminInvitations`.
- Confirm whether `adminEmails` is still needed beyond bootstrap. It is deliberately left
  populated after invitation removal so those addresses can always self-register for
  system recovery — worth revisiting.

Already resolved and dropped from this plan: `signInPreferences` and `userAuthSettings`
both no longer exist, and `invitationTokens` is already separate from `waitlistEntries`.
