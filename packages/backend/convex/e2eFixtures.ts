/**
 * Disposable user fixtures for E2E tests.
 *
 * The auth E2E suite used to share the single dev-seed account, which made every
 * mutating test unsafe: a failure part-way through left the account on a changed
 * password or with 2FA enabled, breaking every later test and local development
 * until the Convex state was wiped.
 *
 * This gives each test its own throwaway account instead. Tests cannot simply
 * sign up, because `onboardingType` defaults to `inviteOnly` — so this mints the
 * invitation rows first, exactly as `devSeed` does, then creates the user
 * through Better Auth and marks the address verified.
 *
 * SAFETY — three independent guards, all required:
 *
 *   1. `DEV_SEED_ENABLED` must be exactly "true". `dev-start.sh` sets it on the
 *      local anonymous backend; it is never set on staging or production, so
 *      these routes 404 there.
 *   2. The email must match `E2E_EMAIL_PATTERN` — `e2e-<token>@e2e.local`.
 *      `.local` is reserved (RFC 6762) and cannot receive mail, so a fixture can
 *      never collide with, or take over, a real address.
 *   3. Passwords must clear the app's own minimum length, so fixtures cannot be
 *      used to plant weak-credential accounts.
 *
 * Accounts are create-only and never reused. CI gets a fresh backend per run;
 * locally they accumulate harmlessly in a disposable database.
 */

import { v } from "convex/values";

import { internal } from "./_generated/api";
import { httpAction, internalMutation } from "./_generated/server";
import { createAuth } from "./auth";

/**
 * Fixture addresses are confined to a reserved TLD that cannot receive mail.
 * Anything else is rejected before a user is created.
 */
const E2E_EMAIL_PATTERN = /^e2e-[a-z0-9-]{1,60}@e2e\.local$/;

/** Mirrors the app's own credential minimum. */
const MIN_PASSWORD_LENGTH = 12;

function devFixturesEnabled(): boolean {
  return process.env.DEV_SEED_ENABLED === "true";
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: "Not available" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Internal mutation: mint the invitation rows that let signup through
// ---------------------------------------------------------------------------

/**
 * Creates the claimed waitlist entry and `claiming` invitation token that
 * `hasValidInvitation` looks for, so `inviteOnly` mode admits this address.
 *
 * Mirrors `devSeed.setupDevUser`, but keyed to a fixture address and always
 * non-admin unless asked otherwise.
 */
export const prepareE2eInvitation = internalMutation({
  args: {
    email: v.string(),
    isAdmin: v.boolean(),
  },
  handler: async (ctx, args) => {
    if (!E2E_EMAIL_PATTERN.test(args.email)) {
      throw new Error("E2E_EMAIL_REJECTED");
    }

    const now = Date.now();

    if (args.isAdmin) {
      const existingAdmin = await ctx.db
        .query("adminEmails")
        .withIndex("by_email", (q) => q.eq("email", args.email))
        .first();
      if (!existingAdmin) {
        await ctx.db.insert("adminEmails", { email: args.email });
      }
    }

    const existingEntry = await ctx.db
      .query("waitlistEntries")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();
    if (existingEntry) return;

    const entryId = await ctx.db.insert("waitlistEntries", {
      email: args.email,
      meta: JSON.stringify({ superpowers: ["e2e"], excitement: ["e2e"] }),
      status: "claimed",
      createdAt: now,
      invitedAt: now,
      claimedAt: now,
    });

    await ctx.db.insert("invitationTokens", {
      waitlistEntryId: entryId,
      token: `e2e-fixture-${args.email}`,
      email: args.email,
      status: "claiming",
      expiresAt: now + 1000 * 60 * 60 * 24, // fixtures are short-lived
      createdAt: now,
      claimStartedAt: now,
    });
  },
});

/** Moves the fixture's invitation token to `claimed` once signup succeeds. */
export const finalizeE2eInvitation = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    if (!E2E_EMAIL_PATTERN.test(args.email)) {
      throw new Error("E2E_EMAIL_REJECTED");
    }

    const token = await ctx.db
      .query("invitationTokens")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();

    if (token && token.status === "claiming") {
      await ctx.db.patch(token._id, { status: "claimed", claimedAt: Date.now() });
    }
  },
});

// ---------------------------------------------------------------------------
// HTTP: create a disposable user
// ---------------------------------------------------------------------------

/**
 * POST /api/dev/e2e-user
 * Body: { email, password, name?, isAdmin? }
 *
 * Creates a verified, ready-to-sign-in account for the given fixture address.
 * Returns 404 unless dev fixtures are enabled, 400 if the address or password
 * fails validation.
 */
export const createE2eUser = httpAction(async (ctx, request) => {
  if (!devFixturesEnabled()) return notFound();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return badRequest("INVALID_JSON");
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "E2E User";
  const isAdmin = body.isAdmin === true;

  if (!E2E_EMAIL_PATTERN.test(email)) {
    return badRequest("E2E_EMAIL_REJECTED");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return badRequest("PASSWORD_TOO_SHORT");
  }

  // 1. Admit the address past inviteOnly gating.
  await ctx.runMutation(internal.e2eFixtures.prepareE2eInvitation, { email, isAdmin });

  // 2. Create the account through Better Auth so the password is hashed and
  //    every database hook runs exactly as it would for a real signup.
  const auth = createAuth(ctx);
  try {
    const result = await auth.api.signUpEmail({ body: { email, password, name } });
    if (!result?.user) {
      return badRequest("SIGNUP_FAILED");
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("already exists")) {
      return badRequest(`SIGNUP_FAILED: ${message}`);
    }
  }

  // 3. Mark the address verified — fixtures have no inbox to click through.
  const authForVerify = createAuth(ctx);
  const authContext = await authForVerify.$context;
  const existing = await authContext.internalAdapter.findUserByEmail(email);
  if (existing && !existing.user.emailVerified) {
    await authContext.internalAdapter.updateUser(existing.user.id, { emailVerified: true });
  }

  await ctx.runMutation(internal.e2eFixtures.finalizeE2eInvitation, { email });

  return new Response(JSON.stringify({ ok: true, email }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
