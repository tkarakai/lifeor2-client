import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { migrationsTable } from "convex-helpers/server/migrations";
import { rateLimitTables } from "convex-helpers/server/rateLimit";

import { lifeorTables } from "./lifeorSchema";

export default defineSchema(
{
  ...rateLimitTables,
  ...lifeorTables,

  // --- Migrations state (convex-helpers framework) ---
  migrations: migrationsTable,

  userProfiles: defineTable({
    ownerId: v.string(),
    locale: v.optional(v.string()),
    theme: v.optional(v.string()),
    timezone: v.optional(v.string()),
    avatarColor: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_owner", ["ownerId"]),

  adminEmails: defineTable({
    email: v.string(),
  }).index("by_email", ["email"]),

  projects: defineTable({
    name: v.string(),
    description: v.string(),
    ownerId: v.string(),
    createdAt: v.number(),
  }).index("by_owner", ["ownerId"]),

  tasks: defineTable({
    title: v.string(),
    description: v.string(),
    status: v.union(
      v.literal("todo"),
      v.literal("in_progress"),
      v.literal("done")
    ),
    deadline: v.optional(v.number()),
    projectId: v.id("projects"),
    ownerId: v.string(),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_owner", ["ownerId"])
    .index("by_status", ["status"]),

  uploads: defineTable({
    storageId: v.id("_storage"),
    name: v.string(),
    contentType: v.string(),
    size: v.number(),
    projectId: v.id("projects"),
    ownerId: v.string(),
    createdAt: v.number(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_project", ["projectId"]),

  // --- Global application settings (generic key-value store) ---

  appSettings: defineTable({
    key: v.string(),
    value: v.string(),
    updatedAt: v.number(),
    updatedBy: v.optional(v.string()),
  }).index("by_key", ["key"]),

  // --- Waitlist ---

  waitlistEntries: defineTable({
    email: v.string(),
    meta: v.string(), // JSON: { superpowers: string[], excitement: string[] }
    status: v.union(
      v.literal("waiting"),
      v.literal("invited"),
      v.literal("claimed")
    ),
    invitedAt: v.optional(v.number()),
    invitationExpiresAt: v.optional(v.number()),
    claimedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_status", ["status"])
    .index("by_created", ["createdAt"]),

  invitationTokens: defineTable({
    waitlistEntryId: v.id("waitlistEntries"),
    token: v.string(),
    email: v.string(),
    status: v.union(
      v.literal("sent"),
      v.literal("claiming"),
      v.literal("claimed"),
      v.literal("revoked")
    ),
    expiresAt: v.number(),
    createdAt: v.number(),
    claimedAt: v.optional(v.number()),
    claimStartedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_token", ["token"])
    .index("by_email", ["email"])
    .index("by_waitlist_entry", ["waitlistEntryId"]),

  // --- Admin Invitations ---

  adminInvitations: defineTable({
    email: v.string(),
    token: v.optional(v.string()),
    status: v.union(
      v.literal("invited"),
      v.literal("claimed"),
      v.literal("completed")
    ),
    onboardingStep: v.optional(v.number()),
    invitedAt: v.number(),
    invitationExpiresAt: v.optional(v.number()),
    claimedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_created", ["createdAt"])
    .index("by_token", ["token"]),

  // --- Audit trail (append-only) ---

  // --- Announcements ---

  announcements: defineTable({
    name: v.string(),
    bannerText: v.string(),
    callToActionName: v.optional(v.string()),
    callToActionUrl: v.optional(v.string()),
    learnMoreName: v.optional(v.string()),
    learnMoreContent: v.optional(v.string()),
    scheduleStart: v.optional(v.number()),
    scheduleEnd: v.optional(v.number()),
    publishJobId: v.optional(v.id("_scheduled_functions")),
    unpublishJobId: v.optional(v.id("_scheduled_functions")),
    isLive: v.boolean(),
    isArchived: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
    createdBy: v.optional(v.string()),
    updatedBy: v.optional(v.string()),
  })
    .index("by_isLive", ["isLive"])
    .index("by_scheduleEnd", ["scheduleEnd"])
    .index("by_updatedAt", ["updatedAt"]),

  auditTrail: defineTable({
    happenedAt: v.number(),
    authenticatedUserId: v.optional(v.string()),
    actor: v.string(),
    source: v.string(),
    action: v.string(),
    resource: v.string(),
    status: v.string(),
    oldValue: v.optional(v.string()),
    newValue: v.optional(v.string()),
    reason: v.optional(v.string()),
    meta: v.optional(v.string()),
    truncatedFields: v.optional(v.string()),
  })
    .index("by_happenedAt", ["happenedAt"])
    .index("by_action_happenedAt", ["action", "happenedAt"])
    .index("by_actor_happenedAt", ["actor", "happenedAt"])
    .index("by_source_happenedAt", ["source", "happenedAt"])
    .index("by_status_happenedAt", ["status", "happenedAt"])
    .index("by_action_status_happenedAt", ["action", "status", "happenedAt"])
    .index("by_authenticatedUserId_happenedAt", ["authenticatedUserId", "happenedAt"]),
},
);
