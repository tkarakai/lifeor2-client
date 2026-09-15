# Audit Trail Event Inventory

Companion to [`audit-trail-architecture.md`](./audit-trail-architecture.md). That document
covers the schema, write paths, validation, and enum conventions. This one is the
per-event catalogue: which user action produces which record, and what the fields hold.

Last verified against `main` on 2026-09-15.

> **Anchors are file + exported symbol, not line numbers.** Line numbers in an earlier
> revision of this document rotted within months. When adding an event here, name the
> function, not the line.

## Conventions

- `happenedAt`, IDs, and tokens are dynamic.
- Unless a row lists them, `oldValue`, `newValue`, `reason`, `meta`, and `truncatedFields`
  are empty.
- `source` is `<transport>:<detail>` — the tables below give the full value.
- For `web:*` events posted through `auditTrail.postEvent`, the backend injects `actor`
  (signed-in email) and `authenticatedUserId` (signed-in user ID). Clients cannot forge them.
- For `server:*` events, both come from backend code or hook context.
- Client emitters call `postEvent` in a `finally` block and swallow rejection
  (`.catch(() => {})`), so an audit write never breaks the user-facing action — and a
  dropped event is silent.

## Write paths

| Helper | Module | Use |
|---|---|---|
| `scheduleAuditEvent` | `packages/backend/convex/auditTrailHelpers.ts` | Mutation contexts; schedules `internal.auditTrail.insertEvent` |
| `runAuditEvent` | `packages/backend/convex/auditTrailHelpers.ts` | Action contexts; runs `internal.auditTrail.insertEvent` |
| `postEvent` | `packages/backend/convex/auditTrail.ts` | Public mutation for `web:*` events from browser clients |

---

## 1. Public and unauthenticated flows

### Join waitlist (`POST /api/waitlist/join`)

`waitlist.join` — `packages/backend/convex/waitlist.ts`

- `action`: `waitlist.joined`
- `source`: `server:waitlist`
- `actor`: submitted email (lowercased by the HTTP layer)
- `authenticatedUserId`: empty
- `resource`: `waitlist-entry:<entryId>`
- `status`: `succeeded`
- `meta`: `{"ip":"<clientIp>"}`, plus `"alreadyJoined":true` on a duplicate submission

No event is written for `WAITLIST_NOT_ENABLED`, validation failures, or rate-limit
rejections — those throw before the audit call.

### Invitation signup claims a token

`waitlistTokens.beginClaim` — `packages/backend/convex/waitlistTokens.ts`

Emitted from a `finally`, so both outcomes are recorded.

- `action`: `waitlist.token.claimed`
- `source`: `server:waitlist-token`
- `authenticatedUserId`: empty
- `actor`: invited email from the token, or `unknown` when the token is not found
- `resource`: `invitation-token:<tokenId>`, or `token:unknown` when not found
- `status`: `succeeded`, or `failed.not_found` / `failed.expired` / `failed.already_used` /
  `failed.internal_error`
- `reason`: backend error message on failure (`TOKEN_NOT_FOUND`, `TOKEN_EXPIRED`,
  `TOKEN_ALREADY_USED`)

Lookup is by `sha256Hex(token)` against the `by_token` index — tokens are hashed at rest.

### Invitation signup releases a claim after signup fails

`waitlistTokens.releaseClaim` — `packages/backend/convex/waitlistTokens.ts`

- `action`: `waitlist.token.released`
- `source`: `server:waitlist-token`
- `actor`: invited email from the token
- `resource`: `invitation-token:<tokenId>`
- `status`: `succeeded`

Only fires when the token is currently in `claiming`. A missing token returns silently
with no event.

> `waitlistTokens.finalizeClaim` (`claiming` → `claimed`) writes **no** audit event. The
> successful signup is covered by `auth.sign_up`, but the token's terminal transition
> itself is not recorded.

---

## 2. Better Auth endpoint hook events

`source`: `server:auth-endpoint-hook`. Emitted by the `hooks.after` middleware in
`packages/backend/convex/auth.ts`, driven by the `AUTH_ENDPOINT_AUDIT_CONFIG` map in the
same module. Every event in this section carries:

- `authenticatedUserId`: empty
- `actor`: request body email, else session email, else `unknown`
- `meta`: `{"endpoint":"<normalized-path>"}`
- `reason`: backend error message on failure
- `status`: `succeeded`, or a `failed.*` value from `mapEndpointErrorToStatus`

| Endpoint | `action` | `resource` | Typical failures |
|---|---|---|---|
| `/sign-in/email` | `auth.sign_in.requested` | `user:<actor>` | `failed.wrong_password`, `failed.blocked`, `failed.not_found`, `failed.rate_limited` |
| `/sign-up/email` | `auth.sign_up.requested` | `user:<actor>` | `failed.validation_error`, `failed.rate_limited`, `failed.blocked` |
| `/request-password-reset` | `auth.password_reset.requested` | `user:<actor>` | `failed.rate_limited`, `failed.validation_error` |
| `/reset-password` | `auth.password_reset.completed` | `password-reset:self` | `failed.expired` on a stale token |
| `/send-verification-email` | `auth.email_verification.requested` | `user:<actor>` | `failed.rate_limited` |
| `/two-factor/enable` | `auth.two_factor.setup_started` | `user:self` | `failed.unauthorized`, `failed.validation_error` |
| `/two-factor/disable` | `auth.two_factor.disabled` | `user:self` | `failed.unauthorized` |
| `/two-factor/verify-totp` | `auth.two_factor.verify_totp` | `session:pending-2fa` | `failed.invalid_code` |
| `/two-factor/verify-backup-code` | `auth.two_factor.verify_backup_code` | `session:pending-2fa` | `failed.invalid_code` |
| `/two-factor/generate-backup-codes` | `auth.two_factor.backup_codes_regenerated` | `user:self` | `failed.unauthorized` |

A successful `/reset-password` additionally marks the account email verified (completing
the reset proves address control) — that side effect writes no separate audit event.

**Passkey endpoints are not in this map.** Passkey events come from client emitters
(section 3), so a passkey *sign-in* is invisible here — see section 7.

---

## 3. Better Auth database hook events

`source`: `server:auth-hook`. Emitted from `databaseHooks` in
`packages/backend/convex/auth.ts`. `meta` carries `{"ip":…,"userAgent":…}` when the
session record has them (IP truncated to 200 chars, user agent to 500).

### Session created

- `action`: `auth.sign_in`
- `actor`: signed-in email (`unknown` if the user lookup fails)
- `authenticatedUserId`: user ID
- `resource`: `session:<sessionId>`
- `status`: `succeeded`

Fires on **any** path that mints a session — password, passkey, post-2FA. Pair it with
`auth.sign_in.requested` to tell a credential sign-in from a passkey one.

### Session deleted

- `action`: `auth.sign_out`
- `actor`: signed-out email
- `authenticatedUserId`: user ID
- `resource`: `session:<sessionId>`
- `status`: `succeeded`

Fires on explicit sign-out *and* on admin- or self-initiated session revocation, since
both delete the session row. No failure event exists for sign-out.

### User created

- `action`: `auth.sign_up`
- `actor`: created user's email
- `authenticatedUserId`: created user ID
- `resource`: `user:<userId>`
- `status`: `succeeded`

The `before` hook enforces signup gating (`SIGNUP_DISABLED` unless the mode is signup, or
the email holds a valid waitlist or admin invitation) and auto-assigns `admin` to emails
in `adminEmails`. A rejection there throws before the `after` hook, so **no
`auth.sign_up` event is written** — only `auth.sign_up.requested` with a `failed.*`
status records the attempt.

---

## 4. Authenticated user settings

`source`: `web:settings` (web app) or `web:admin-settings` (admin app). All are
client-posted with `actor` and `authenticatedUserId` injected server-side.

| Action | `action` | `resource` | Notes |
|---|---|---|---|
| Change password | `auth.password_changed` | `user:self` | `meta`: `{"revokeOtherSessions":true}` when checked. `failed.wrong_password` on auth error, `failed.unknown` on throw. Client-side mismatch (pre-request) writes nothing. |
| Save profile, name changed | `user.name_changed` | `user:self` | `oldValue`: `{"name":"<old>"}`, `newValue`: `{"name":"<new>"}` |
| Save profile, name unchanged | `user.profile_updated` | `user:self` | |
| Revoke one of my sessions | `auth.session.revoked` | `session:…<last8OfToken>` | Also produces a `server:auth-hook` `auth.sign_out` |
| Revoke all my other sessions | `auth.session.revoked_all` | `session:all-others` | One `auth.sign_out` per deleted session |
| Register a passkey | `auth.passkey.added` | `passkey:self` | |
| Rename a passkey | `auth.passkey.renamed` | `passkey:<id>` | |
| Delete a passkey | `auth.passkey.deleted` | `passkey:<id>` | |

Emitters:

- Web: `change-password-form.tsx`, `profile-section.tsx`, `sessions-list.tsx`,
  `passkey-section.tsx` under `apps/web/src/components/settings/`, plus
  `sessions-client.tsx` under `apps/web/src/app/[locale]/(dashboard)/dashboard/settings/sessions/`
- Admin: `admin-sessions-list.tsx`, `admin-passkey-section.tsx` under
  `apps/admin/src/components/settings/`

> The web session UI is emitted from two places — `sessions-list.tsx` and
> `sessions-client.tsx` — with identical action/resource shapes. Worth collapsing.

Failure status on all of these is `failed.unknown` unless noted; the client maps only the
password case more precisely.

---

## 5. Admin user management

`source`: `web:admin`. Emitted from the shared helpers in `apps/admin/src/lib/admin-api.ts`
(`banUser`, `unbanUser`, `removeUser`, `setUserRole`, `revokeSession`, `revokeAllSessions`),
each taking `postAuditEvent` as a callback from the calling component.

Callers: `users-data-table.tsx`, `user-sessions-dialog.tsx` (under
`apps/admin/src/components/users/`) and `session-viewer.tsx` (under
`apps/admin/src/components/sessions/`).

All emit from a `finally`, so both success and failure are recorded. Failure statuses are
mapped from the auth API error: `failed.validation_error`, `failed.unauthorized`,
`failed.blocked`, `failed.not_found`, `failed.rate_limited`, `failed.internal_error`,
`failed.unknown`.

| Action | `action` | `resource` | Extra fields |
|---|---|---|---|
| Ban user | `admin.user.banned` | `user:<targetUserId>` | `reason`: ban reason; `meta`: `{"banExpiresIn":<seconds>}` when set |
| Unban user | `admin.user.unbanned` | `user:<targetUserId>` | |
| Delete user | `admin.user.deleted` | `user:<targetUserId>` | |
| Change role | `admin.role_changed` | `user:<targetUserId>` | `newValue`: `{"role":"admin"}` or `{"role":"user"}` |
| Revoke one session | `admin.session.revoked` | `session:…<last8OfToken>` | |
| Revoke all sessions | `admin.session.revoked_all` | `user:<targetUserId>` | |

On failure the extra fields still reflect what was *requested*, not what took effect.

---

## 6. Backend admin mutations

`source`: `server:admin-mutation` unless noted. `actor` is the admin's email and
`authenticatedUserId` is `ctx.ownerId` — except where flagged below. **None of these
write a failure event**; the mutations throw before reaching the audit call.

### Waitlist — `packages/backend/convex/waitlist.ts`

| Function | `action` | `resource` | `meta` |
|---|---|---|---|
| `invite` | `waitlist.invitation.sent` | `waitlist-entry:<entryId>` | `{"inviteeEmail":"…"}` |
| `inviteDirect` | `waitlist.invitation.sent` | `waitlist-entry:<entryId>` | `{"inviteeEmail":"…","source":"direct-invite"}` |
| `uninvite` | `waitlist.invitation.revoked` | `waitlist-entry:<entryId>` | `{"inviteeEmail":"…"}` |
| `remove` | `waitlist.entry.deleted` | `waitlist-entry:<entryId>` | `{"deletedEmail":"…"}` |

`uninvite` revokes outstanding `sent`/`claiming` tokens and resets the entry to `waiting`.
`remove` refuses to delete a `claimed` entry and hard-deletes associated tokens — those
token deletions are not individually audited.

### Admin invitations — `packages/backend/convex/adminInvitations.ts`

| Function | `action` | `resource` | `meta` |
|---|---|---|---|
| `invite` | `admin.invitation.sent` | `admin-invitation:<email>` | `{"inviteeEmail":"…"}` |
| `remove` | `admin.invitation.deleted` | `admin-invitation:<entryId>` | `{"inviteeEmail":"…"}` |

Note the `resource` shape is inconsistent between the two — email for `sent`, entry ID for
`deleted`.

`invite` deliberately does **not** insert into `adminEmails`; that happens only in
`claimInvitation`, so the admin role cannot be obtained without proving token possession.
Token lookup is by `sha256Hex(token)`.

### Announcements — `packages/backend/convex/announcements.ts`

All routed through the module's local audit helper, with `resource` always
`announcement:<announcementId>` and `status` always `succeeded`.

Admin-initiated (`source`: `server:admin-mutation`, `actor`: admin email):
`announcement.created`, `announcement.updated`, `announcement.deleted`,
`announcement.live_enabled`, `announcement.live_disabled`,
`announcement.publish_scheduled`, `announcement.publish_canceled`,
`announcement.unpublish_scheduled`.

Scheduler-initiated, from the publish/unpublish jobs rather than a human:
`announcement.published`, `announcement.unpublished`, `announcement.publish_noop`,
`announcement.unpublish_noop`. The `*_noop` variants record a job that fired but found
nothing to do (announcement deleted, already live, schedule moved); `reason` explains
which.

### Settings and policy changes — `packages/backend/convex/appSettings.ts`

`appSettings.set` is the mutation the admin UI actually calls. It emits
`source`: `server:admin-settings` with `actor` and `authenticatedUserId` both set to
`ctx.ownerId` (a **user ID, not an email** — unlike every other admin event),
`resource`: `appSettings:<key>`, and `oldValue` / `newValue` holding the raw stored
strings.

Only keys present in the module's `POLICY_AUDIT_ACTIONS` map produce an event:

| Setting key | `action` |
|---|---|
| user magic link enabled | `admin.user_magic_link_policy_changed` |
| user MFA required | `admin.user_mfa_policy_changed` |
| admin MFA required | `admin.admin_mfa_policy_changed` |
| user email verification required | `admin.user_email_verification_policy_changed` |
| admin email verification required | `admin.admin_email_verification_policy_changed` |
| user passkey policy | `admin.user_passkey_policy_changed` |
| admin passkey policy | `admin.admin_passkey_policy_changed` |

Other accepted keys write **no** audit event — see section 7.

### Legacy policy mutations — `packages/backend/convex/adminAuth.ts`

`setMfaPolicy` (`admin.mfa_policy_changed`) and `setEmailVerificationPolicy`
(`admin.email_verification_policy_changed`) still emit, with `actor` set to `ctx.ownerId`
rather than an email. **Neither is called from the admin UI** — the UI uses
`appSettings.set` and its granular per-audience actions. API-only paths.

---

## 7. Admin onboarding wizard

`source`: `web:admin-onboarding`, `resource`: `admin-invitation:<email>`, `status`:
`succeeded`. Emitted from
`apps/admin/src/components/onboarding/admin-onboarding-wizard.tsx`.

| Step | `action` |
|---|---|
| 0 — account created from invitation | `admin.onboarding.account_created` |
| 1 — TOTP verified | `admin.onboarding.totp_configured` |
| 2 — backup codes acknowledged | `admin.onboarding.backup_codes_acknowledged` |
| 3 — passkey registered | `admin.onboarding.passkey_registered` |
| 3 — passkey skipped | `admin.onboarding.passkey_skipped` |
| 3 — wizard finished | `admin.onboarding.completed` |

Step 3 emits two events: the passkey outcome, then `completed`.

These are best-effort. `postAuditEvent` is `.catch(() => {})`-ed, and the paired
`advanceOnboardingStep` / `completeOnboarding` mutations are too — the Convex auth session
may not have propagated yet right after account creation. An audited step therefore does
not guarantee the persisted step advanced.

---

## 8. Gaps

### Defined actions with no emitter

Present in `AUDIT_ACTIONS` but never written by any code path:

| Action | Why it matters |
|---|---|
| `auth.passkey.sign_in` | Passkey sign-ins produce only the generic `auth.sign_in`, so the trail cannot distinguish a passkey login from a password one. The endpoint hook map covers no passkey routes. |
| `auth.two_factor.enabled` | `auth.two_factor.setup_started` is logged, completion is not — a started-but-abandoned enrolment looks the same as a finished one. |
| `auth.email_verified` | Verification completion is unrecorded. `/reset-password` silently sets `emailVerified` too. |
| `admin.invitation.revoked` | Admin invitations can be deleted (`admin.invitation.deleted`) but there is no revoke path, unlike the waitlist's `uninvite`. |
| `user.avatar_changed` | No avatar-change flow is wired up. |
| `admin.waitlist_setting_changed` | Superseded by the granular policy actions, but the onboarding-mode toggle it would have covered is still unaudited (below). |

### Admin settings changed without an audit event

`appSettings.set` accepts these keys but has no `POLICY_AUDIT_ACTIONS` entry for them, so
changing them leaves no trace:

- `onboardingType` — switches between signup / waitlist / invite-only. This is the
  highest-impact unaudited setting: it governs who may create an account at all.
- `invitationTokenExpiryDays`
- `invitationEmailTemplate`
- `emailVerificationTemplate`
- the two legacy MFA / email-verification keys

### Other unrecorded transitions

- `waitlistTokens.finalizeClaim` — the `claiming` → `claimed` terminal transition.
- Token deletions cascaded by `waitlist.remove`.
- Every failure path in section 6 — the backend admin mutations throw before auditing, so
  a rejected admin action (`NOT_ADMIN`, `CANNOT_DELETE_CLAIMED`, `ENTRY_NOT_FOUND`) is
  invisible. Compare section 5, where the client emits from a `finally` and failures are
  captured.

### Inconsistencies worth normalising

- `actor` is an email everywhere except `appSettings.set` and the two `adminAuth.ts`
  policy mutations, which use a user ID.
- `admin.invitation.sent` uses `admin-invitation:<email>` while `admin.invitation.deleted`
  uses `admin-invitation:<entryId>`.
- The web session-revocation UI emits from two components with duplicated logic.
