import { isLocalDevelopment } from "./developmentOnly";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { createAuth } from "./auth";

// ---------------------------------------------------------------------------
// Dev-only seed data — hardcoded credentials for local development.
// Gated behind DEV_SEED_ENABLED env var (set by dev-start.sh).
// ---------------------------------------------------------------------------

const DEV_USERS = [
  { email: "admin@admin.com", password: "admin@admin.comadmin@admin.comadmin@admin.com", name: "Dev Admin", isAdmin: true },
  { email: "user@user.com", password: "user@user.comuser@user.comuser@user.com", name: "Dev User", isAdmin: false },
] as const;

// Sentinel key written to appSettings only after ALL users are fully created.
// This avoids the idempotency bug where partial failures (e.g. signUpEmail
// errors) would leave the sentinel set but accounts in a broken state.
const SEED_SENTINEL_KEY = "devSeedCompleted";

// ---------------------------------------------------------------------------
// Internal query: check if seed already ran
// ---------------------------------------------------------------------------

export const isSeeded = internalQuery({
  args: {},
  handler: async (ctx) => {
    const sentinel = await ctx.db
      .query("appSettings")
      .withIndex("by_key", (q) => q.eq("key", SEED_SENTINEL_KEY))
      .first();
    return sentinel !== null;
  },
});

// ---------------------------------------------------------------------------
// Internal mutation: mark seed as complete (written as the very last step)
// ---------------------------------------------------------------------------

export const markSeeded = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.insert("appSettings", {
      key: SEED_SENTINEL_KEY,
      value: "true",
      updatedAt: Date.now(),
    });
  },
});

// ---------------------------------------------------------------------------
// Internal mutation: insert DB state for one dev user
// ---------------------------------------------------------------------------

export const setupDevUser = internalMutation({
  args: {
    email: v.string(),
    isAdmin: v.boolean(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Admin email entry (triggers auto-promotion in databaseHook).
    // Skip if already exists (idempotent for retries after partial failure).
    if (args.isAdmin) {
      const existing = await ctx.db
        .query("adminEmails")
        .withIndex("by_email", (q) => q.eq("email", args.email))
        .first();
      if (!existing) {
        await ctx.db.insert("adminEmails", { email: args.email });
      }
    }

    // Waitlist entry — skip if already exists (idempotent for retries).
    const existingEntry = await ctx.db
      .query("waitlistEntries")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();
    if (existingEntry) return;

    const entryId = await ctx.db.insert("waitlistEntries", {
      email: args.email,
      meta: JSON.stringify({ superpowers: ["dev-seed"], excitement: ["dev-seed"] }),
      status: "claimed",
      createdAt: now,
      invitedAt: now,
      claimedAt: now,
    });

    // Invitation token in "claiming" state — hasValidInvitation checks for
    // status "claiming" or "claimed" with a non-expired expiresAt.
    await ctx.db.insert("invitationTokens", {
      waitlistEntryId: entryId,
      token: `dev-seed-${args.email}`,
      email: args.email,
      status: "claiming",
      expiresAt: now + 1000 * 60 * 60 * 24 * 365, // 1 year
      createdAt: now,
      claimStartedAt: now,
    });
  },
});

// ---------------------------------------------------------------------------
// Internal mutation: finalize invitation token after signup
// ---------------------------------------------------------------------------

export const finalizeDevToken = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const token = await ctx.db
      .query("invitationTokens")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();
    if (token && token.status === "claiming") {
      await ctx.db.patch(token._id, {
        status: "claimed",
        claimedAt: Date.now(),
      });
    }
  },
});

// ---------------------------------------------------------------------------
// Main seed action
// ---------------------------------------------------------------------------

export const seed = internalAction({
  args: {},
  handler: async (ctx) => {
    // Guard: only run when explicitly enabled
    if ((process.env.DEV_SEED_ENABLED !== "true" || !isLocalDevelopment())) {
      console.log("[devSeed] DEV_SEED_ENABLED is not 'true', skipping");
      return;
    }

    // Idempotent: skip if already seeded
    const alreadySeeded = await ctx.runQuery(internal.devSeed.isSeeded);
    if (alreadySeeded) {
      console.log("[devSeed] Already seeded, skipping");
      return;
    }

    for (const user of DEV_USERS) {
      // 1. Insert DB state (admin email, waitlist entry, invitation token)
      await ctx.runMutation(internal.devSeed.setupDevUser, {
        email: user.email,
        isAdmin: user.isAdmin,
      });

      // 1b. For admin users, also create an adminInvitations entry
      if (user.isAdmin) {
        await ctx.runMutation(internal.adminInvitations.createForSeed, {
          email: user.email,
        });
      }

      // 2. Create the user via Better Auth (hashes password, databaseHook promotes admin).
      //    "User already exists" is expected on retry after partial failure — treat as success.
      const auth = createAuth(ctx);
      try {
        const result = await auth.api.signUpEmail({
          body: {
            email: user.email,
            password: user.password,
            name: user.name,
          },
        });

        if (!result?.user) {
          throw new Error(
            `[devSeed] signUpEmail failed for ${user.email}: ${JSON.stringify(result)}`,
          );
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("already exists")) {
          console.log(`[devSeed] ${user.email} already exists, continuing`);
        } else {
          throw error;
        }
      }

      // 3. Mark user as email-verified (requireEmailVerification is enabled).
      //    Use Better Auth's internal adapter to directly update the user record.
      const authForVerify = createAuth(ctx);
      const authContext = await authForVerify.$context;
      const existingUser = await authContext.internalAdapter.findUserByEmail(user.email);
      if (existingUser && !existingUser.user.emailVerified) {
        await authContext.internalAdapter.updateUser(
          existingUser.user.id,
          { emailVerified: true },
        );
      }

      // 4. Finalize the invitation token
      await ctx.runMutation(internal.devSeed.finalizeDevToken, {
        email: user.email,
      });

      const role = user.isAdmin ? "admin" : "user";
      console.log(`[devSeed] Created ${role}: ${user.email}`);
    }

    // Mark seed as complete — this is the sentinel for isSeeded.
    // Only written after ALL users are fully created.
    await ctx.runMutation(internal.devSeed.markSeeded);

    console.log("[devSeed] Dev seed complete");
  },
});
