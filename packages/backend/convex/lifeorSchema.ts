import { defineTable } from "convex/server";
import { v } from "convex/values";

export const dataset = v.object({ id: v.string(), name: v.string() });
export const lifeorTables = {
  lifeorConnections: defineTable({
    ownerId: v.string(),
    identity: v.string(),
    tokens: v.string(),
    status: v.union(
      v.literal("connected"),
      v.literal("reconnect_required"),
      v.literal("disconnected"),
    ),
    scopes: v.array(v.string()),
    datasets: v.array(dataset),
    refreshing: v.boolean(),
  }).index("by_owner", ["ownerId"]),
  lifeorOAuth: defineTable({
    ownerId: v.string(),
    state: v.string(),
    session: v.string(),
    sealed: v.string(),
    expiresAt: v.number(),
  }).index("by_owner", ["ownerId"]),
  lifeorConversations: defineTable({
    ownerId: v.string(),
    connection: v.string(),
    datasetId: v.string(),
    datasetName: v.string(),
    title: v.string(),
    updatedAt: v.number(),
  }).index("by_owner", ["ownerId"]),
  lifeorRuns: defineTable({
    ownerId: v.string(),
    conversationId: v.id("lifeorConversations"),
    requestId: v.string(),
    instance: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("waiting"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("canceled"),
      v.literal("interrupted"),
    ),
    prompt: v.string(),
    answer: v.string(),
    error: v.optional(v.string()),
    events: v.array(
      v.object({
        id: v.string(),
        type: v.string(),
        text: v.string(),
        data: v.optional(v.string()),
      }),
    ),
    confirmation: v.optional(
      v.object({
        id: v.string(),
        message: v.string(),
        operation: v.string(),
        arguments: v.string(),
        schema: v.string(),
        expiresAt: v.number(),
        decision: v.optional(v.string()),
      }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_owner_status", ["ownerId", "status"])
    .index("by_owner_created", ["ownerId", "createdAt"])
    .index("by_owner", ["ownerId"]),
};
