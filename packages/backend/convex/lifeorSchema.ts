import { defineTable } from "convex/server";
import { v } from "convex/values";

export const dataset = v.object({ id: v.string(), name: v.string() });
export const contextUsage = v.object({
  tokens: v.number(),
  window: v.number(),
  percent: v.number(),
  outputReserve: v.number(),
  estimated: v.boolean(),
});
export const observation = v.object({
  id: v.string(),
  exchange: v.string(),
  channel: v.union(
    v.literal("model"),
    v.literal("compaction"),
    v.literal("mcp"),
  ),
  direction: v.union(v.literal("request"), v.literal("response")),
  label: v.string(),
  body: v.string(),
  at: v.number(),
  truncated: v.boolean(),
});
export const lifeorTables = {
  lifeorMemory: defineTable({
    conversationId: v.id("lifeorConversations"),
    messages: v.string(),
    through: v.number(),
  }).index("by_conversation", ["conversationId"]),
  lifeorTraffic: defineTable({
    ownerId: v.string(),
    runId: v.id("lifeorRuns"),
    entry: observation,
  }).index("by_run", ["runId"]),
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
    memory: v.optional(v.object({ messages: v.string(), through: v.number() })),
    updatedAt: v.number(),
  }).index("by_owner", ["ownerId"]),
  lifeorRuns: defineTable({
    ownerId: v.string(),
    conversationId: v.id("lifeorConversations"),
    requestId: v.string(),
    kind: v.optional(v.literal("compaction")),
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
    context: v.optional(contextUsage),
    observationCount: v.optional(v.number()),
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
    .index("by_request", ["conversationId", "requestId"])
    .index("by_owner_status", ["ownerId", "status"])
    .index("by_owner_created", ["ownerId", "createdAt"])
    .index("by_owner", ["ownerId"]),
};
