/** Private persistence. Only the authenticated, server-key-protected HTTP gateway calls these. */
import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internalMutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { rateLimit } from "./rateLimits";

const active = (r: Doc<"lifeorRuns">) =>
  r.status === "running" || r.status === "waiting";
async function conversation(ctx: MutationCtx, ownerId: string, id: string) {
  const key = ctx.db.normalizeId("lifeorConversations", id);
  const row = key ? await ctx.db.get(key) : null;
  if (!row || row.ownerId !== ownerId) throw new Error("NOT_FOUND");
  return row;
}
async function run(ctx: MutationCtx, ownerId: string, id: string) {
  const key = ctx.db.normalizeId("lifeorRuns", id);
  const row = key ? await ctx.db.get(key) : null;
  if (
    !row ||
    row.ownerId !== ownerId ||
    !(await ctx.db.get(row.conversationId))
  )
    throw new Error("NOT_FOUND");
  return row;
}
const str = (p: Record<string, unknown>, key: string, max = 32000): string => {
  const value = p[key];
  if (typeof value !== "string" || !value.length || value.length > max)
    throw new Error("INVALID_INPUT");
  return value;
};

export const dispatch = internalMutation({
  args: { ownerId: v.string(), op: v.string(), payload: v.any() },
  handler: async (ctx, { ownerId, op, payload }) => {
    const p = payload as Record<string, unknown>;
    if (
      [
        "oauth.begin",
        "connection.disconnect",
        "conversation.create",
        "conversation.rename",
        "conversation.delete",
        "run.decision",
      ].includes(op)
    ) {
      await rateLimit(ctx, {
        name: "mutationGlobal",
        key: ownerId,
        throws: true,
      });
    }
    const conn = await ctx.db
      .query("lifeorConnections")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .unique();
    if (op === "state") {
      const instance = str(p, "instance");
      const runs = (
        await Promise.all(
          (["running", "waiting"] as const).map((status) =>
            ctx.db
              .query("lifeorRuns")
              .withIndex("by_owner_status", (q) =>
                q.eq("ownerId", ownerId).eq("status", status),
              )
              .take(2),
          ),
        )
      ).flat();
      // Single application instance only. Never replay work after a restart.
      for (const r of runs)
        if (
          active(r) &&
          (r.instance !== instance ||
            r.updatedAt < Date.now() - 900_000 ||
            (r.updatedAt < Date.now() - 15000 &&
              Array.isArray(p.liveIds) &&
              !p.liveIds.includes(r._id)))
        ) {
          await ctx.db.patch(r._id, {
            status: "interrupted",
            answer: r.events
              .filter((e) => e.type === "assistant")
              .map((e) => e.text)
              .join("\n\n"),
            confirmation: undefined,
            error:
              "The server restarted or the run expired. Completed actions remain saved.",
            updatedAt: Date.now(),
          });
        }
      const conversations = await ctx.db
        .query("lifeorConversations")
        .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
        .collect();
      const selected =
        typeof p.conversationId === "string"
          ? await conversation(ctx, ownerId, p.conversationId)
          : null;
      const history = selected
        ? await ctx.db
            .query("lifeorRuns")
            .withIndex("by_conversation", (q) =>
              q.eq("conversationId", selected._id),
            )
            .order("desc")
            .paginate({ numItems: 30, cursor: null })
        : null;
      return {
        connection: conn
          ? {
              identity: conn.identity,
              status: conn.status,
              scopes: conn.scopes,
              datasets: conn.datasets,
            }
          : null,
        conversations: conversations
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map(({ memory: _memory, ...c }) => c),
        runs: history ? history.page.reverse() : [],
        historyCursor:
          history && !history.isDone ? history.continueCursor : null,
      };
    }
    if (op === "credentials") return conn;
    if (op === "oauth.begin") {
      const old = await ctx.db
        .query("lifeorOAuth")
        .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
        .collect();
      for (const a of old) await ctx.db.delete(a._id);
      await ctx.db.insert("lifeorOAuth", {
        ownerId,
        state: str(p, "state"),
        session: str(p, "session"),
        sealed: str(p, "sealed"),
        expiresAt: Date.now() + 600_000,
      });
      return null;
    }
    if (op === "oauth.consume") {
      const attempt = await ctx.db
        .query("lifeorOAuth")
        .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
        .unique();
      if (
        !attempt ||
        attempt.state !== p.state ||
        attempt.session !== p.session ||
        attempt.expiresAt < Date.now()
      )
        throw new Error("OAUTH_INVALID");
      await ctx.db.delete(attempt._id);
      return attempt.sealed;
    }
    if (op === "connection.save") {
      const value = {
        ownerId,
        identity: str(p, "identity"),
        tokens: str(p, "tokens"),
        status: "connected" as const,
        scopes: p.scopes as string[],
        datasets: p.datasets as { id: string; name: string }[],
        refreshing: false,
      };
      if (conn) await ctx.db.replace(conn._id, value);
      else await ctx.db.insert("lifeorConnections", value);
      return null;
    }
    if (op === "connection.refresh.begin") {
      if (!conn || conn.status !== "connected" || conn.identity !== p.identity)
        throw new Error("RECONNECT_REQUIRED");
      if (conn.refreshing) {
        await ctx.db.patch(conn._id, {
          status: "reconnect_required",
          tokens: "",
          refreshing: false,
        });
        return false;
      }
      await ctx.db.patch(conn._id, { refreshing: true });
      return true;
    }
    if (op === "connection.refresh.finish") {
      if (
        !conn ||
        conn.identity !== p.identity ||
        !conn.refreshing ||
        conn.status !== "connected"
      )
        throw new Error("RECONNECT_REQUIRED");
      await ctx.db.patch(conn._id, {
        tokens: str(p, "tokens"),
        refreshing: false,
      });
      return null;
    }
    if (op === "connection.invalidate" || op === "connection.disconnect") {
      if (conn && (!p.identity || conn.identity === p.identity))
        await ctx.db.patch(conn._id, {
          tokens: "",
          refreshing: false,
          status: op.endsWith("disconnect")
            ? "disconnected"
            : "reconnect_required",
        });
      return null;
    }
    if (op === "connection.datasets") {
      if (!conn || conn.identity !== p.identity || conn.status !== "connected")
        throw new Error("RECONNECT_REQUIRED");
      await ctx.db.patch(conn._id, {
        datasets: p.datasets as { id: string; name: string }[],
      });
      return null;
    }
    if (op === "conversation.create") {
      if (!conn || conn.status !== "connected")
        throw new Error("RECONNECT_REQUIRED");
      const ds = conn.datasets.find((d) => d.id === p.datasetId);
      if (!ds) throw new Error("DATASET_DENIED");
      const count = await ctx.db
        .query("lifeorConversations")
        .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
        .take(200);
      if (count.length >= 200) throw new Error("HISTORY_LIMIT");
      return await ctx.db.insert("lifeorConversations", {
        ownerId,
        connection: conn.identity,
        datasetId: ds.id,
        datasetName: ds.name,
        title: "New conversation",
        updatedAt: Date.now(),
      });
    }
    if (op === "conversation.history") {
      const c = await conversation(ctx, ownerId, str(p, "id"));
      const page = await ctx.db
        .query("lifeorRuns")
        .withIndex("by_conversation", (q) => q.eq("conversationId", c._id))
        .order("desc")
        .paginate({
          numItems: 30,
          cursor: typeof p.cursor === "string" ? p.cursor : null,
        });
      return {
        runs: page.page.reverse(),
        cursor: page.isDone ? null : page.continueCursor,
      };
    }
    if (op.startsWith("conversation.")) {
      const c = await conversation(ctx, ownerId, str(p, "id"));
      const owned = (
        await Promise.all(
          (["running", "waiting"] as const).map((status) =>
            ctx.db
              .query("lifeorRuns")
              .withIndex("by_owner_status", (q) =>
                q.eq("ownerId", ownerId).eq("status", status),
              )
              .take(1),
          ),
        )
      ).flat();
      if (owned.some((r) => r.conversationId === c._id))
        throw new Error("RUN_ACTIVE");
      if (op === "conversation.rename")
        await ctx.db.patch(c._id, {
          title: str(p, "title", 120).trim(),
          updatedAt: Date.now(),
        });
      else if (op === "conversation.delete") {
        const memory = await ctx.db
          .query("lifeorMemory")
          .withIndex("by_conversation", (q) => q.eq("conversationId", c._id))
          .unique();
        if (memory) await ctx.db.delete(memory._id);
        await ctx.db.delete(c._id);
        await ctx.scheduler.runAfter(
          0,
          makeFunctionReference<"mutation">("lifeor:purgeConversation"),
          { conversationId: c._id },
        );
      } else throw new Error("INVALID_INPUT");
      return null;
    }
    if (op === "run.start") {
      const c = await conversation(ctx, ownerId, str(p, "conversationId"));
      const memory =
        (await ctx.db
          .query("lifeorMemory")
          .withIndex("by_conversation", (q) => q.eq("conversationId", c._id))
          .unique()) ?? c.memory;
      const runs = await ctx.db
        .query("lifeorRuns")
        .withIndex("by_conversation", (q) =>
          q
            .eq("conversationId", c._id)
            .gt("_creationTime", memory?.through ?? 0),
        )
        .collect();
      const duplicate = await ctx.db
        .query("lifeorRuns")
        .withIndex("by_request", (q) =>
          q.eq("conversationId", c._id).eq("requestId", str(p, "requestId")),
        )
        .unique();
      if (duplicate) {
        if (duplicate.prompt !== p.prompt || duplicate.kind !== p.kind)
          throw new Error("IDEMPOTENCY_CONFLICT");
        return { run: duplicate, created: false };
      }
      if (
        !conn ||
        conn.status !== "connected" ||
        conn.identity !== c.connection
      )
        throw new Error("RECONNECT_REQUIRED");
      if (!conn.datasets.some((d) => d.id === c.datasetId))
        throw new Error("DATASET_DENIED");
      const owned = (
        await Promise.all(
          (["running", "waiting"] as const).map((status) =>
            ctx.db
              .query("lifeorRuns")
              .withIndex("by_owner_status", (q) =>
                q.eq("ownerId", ownerId).eq("status", status),
              )
              .take(1),
          ),
        )
      ).flat();
      if (owned.length) throw new Error("RUN_ACTIVE");
      const recent = await ctx.db
        .query("lifeorRuns")
        .withIndex("by_owner_created", (q) =>
          q.eq("ownerId", ownerId).gt("createdAt", Date.now() - 60000),
        )
        .take(10);
      if (recent.length >= 10) throw new Error("RATE_LIMITED");
      await rateLimit(ctx, {
        name: "mutationGlobal",
        key: ownerId,
        throws: true,
      });
      const prompt = str(p, "prompt");
      const id = await ctx.db.insert("lifeorRuns", {
        ownerId,
        conversationId: c._id,
        requestId: str(p, "requestId", 128),
        ...(p.kind === "compaction" ? { kind: "compaction" as const } : {}),
        instance: str(p, "instance"),
        status: "running",
        prompt,
        answer: "",
        events: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.patch(c._id, {
        title: runs.length || memory ? c.title : prompt.slice(0, 70),
        updatedAt: Date.now(),
      });
      return {
        run: await ctx.db.get(id),
        created: true,
        conversation: {
          ...c,
          ...(memory
            ? { memory: { messages: memory.messages, through: memory.through } }
            : {}),
        },
        history: runs,
      };
    }
    if (op.startsWith("run.")) {
      const r = await run(ctx, ownerId, str(p, "id"));
      if (op === "run.get") return r;
      if (op === "run.traffic") {
        const rows = await ctx.db
          .query("lifeorTraffic")
          .withIndex("by_run", (q) => q.eq("runId", r._id))
          .take(128);
        return {
          entries: rows.map((row) => row.entry),
          limited: rows.length === 128,
        };
      }
      if (!active(r)) throw new Error("RUN_FINISHED");
      if (op === "run.observe") {
        if ((r.observationCount ?? 0) < 128) {
          const entry = p.observation as Doc<"lifeorTraffic">["entry"];
          if (
            !entry ||
            typeof entry.body !== "string" ||
            new TextEncoder().encode(entry.body).length > 48000
          )
            throw new Error("INVALID_INPUT");
          await ctx.db.insert("lifeorTraffic", {
            ownerId,
            runId: r._id,
            entry,
          });
          await ctx.db.patch(r._id, {
            observationCount: (r.observationCount ?? 0) + 1,
          });
        }
      } else if (op === "run.event") {
        if (
          r.events.length >= 200 ||
          (p.type === "operation" && JSON.stringify(r.events).length > 400000)
        )
          throw new Error("TOOL_LIMIT");
        await ctx.db.patch(r._id, {
          events: [
            ...r.events,
            {
              id: str(p, "eventId"),
              type: str(p, "type"),
              text: str(p, "text"),
              ...(typeof p.data === "string"
                ? {
                    data:
                      p.data.length <= 32000
                        ? p.data
                        : JSON.stringify({
                            truncated: true,
                            preview: p.data.slice(0, 31000),
                          }),
                  }
                : {}),
            },
          ],
          updatedAt: Date.now(),
        });
      } else if (op === "run.confirm") {
        await ctx.db.patch(r._id, {
          status: "waiting",
          confirmation: {
            id: str(p, "confirmationId"),
            message: str(p, "message"),
            operation: str(p, "operation"),
            arguments: str(p, "arguments"),
            schema: str(p, "schema"),
            expiresAt: Date.now() + 120_000,
          },
          updatedAt: Date.now(),
        });
      } else if (op === "run.decision") {
        if (
          !r.confirmation ||
          r.confirmation.id !== p.confirmationId ||
          r.confirmation.expiresAt < Date.now() ||
          r.confirmation.decision
        )
          throw new Error("CONFIRMATION_EXPIRED");
        await ctx.db.patch(r._id, {
          confirmation: { ...r.confirmation, decision: str(p, "decision") },
          updatedAt: Date.now(),
        });
      } else if (op === "run.resume") {
        await ctx.db.patch(r._id, {
          status: "running",
          confirmation: undefined,
          updatedAt: Date.now(),
        });
      } else if (op === "run.finish") {
        const status = p.status as "completed" | "failed" | "canceled";
        if (!["completed", "failed", "canceled"].includes(status))
          throw new Error("INVALID_INPUT");
        if (
          typeof p.memory === "string" &&
          new TextEncoder().encode(p.memory).length <= 600000
        ) {
          const messages = JSON.parse(p.memory);
          if (!Array.isArray(messages)) throw new Error("INVALID_INPUT");
          const prior = await ctx.db
            .query("lifeorMemory")
            .withIndex("by_conversation", (q) =>
              q.eq("conversationId", r.conversationId),
            )
            .unique();
          const checkpoint = { messages: p.memory, through: r._creationTime };
          if (prior) await ctx.db.patch(prior._id, checkpoint);
          else
            await ctx.db.insert("lifeorMemory", {
              conversationId: r.conversationId,
              ...checkpoint,
            });
          // Migrate any early inline checkpoint without loading it into future history lists.
          await ctx.db.patch(r.conversationId, { memory: undefined });
        }
        await ctx.db.patch(r._id, {
          status,
          ...(p.context
            ? { context: p.context as Doc<"lifeorRuns">["context"] }
            : {}),
          answer: typeof p.answer === "string" ? p.answer.slice(0, 64000) : "",
          ...(typeof p.error === "string"
            ? { error: p.error.slice(0, 1000) }
            : {}),
          confirmation: undefined,
          updatedAt: Date.now(),
        });
      } else throw new Error("INVALID_INPUT");
      return null;
    }
    throw new Error("INVALID_INPUT");
  },
});

/** Keep deletion bounded regardless of conversation length or captured payload sizes. */
export const purgeConversation = internalMutation({
  args: { conversationId: v.id("lifeorConversations") },
  handler: async (ctx, { conversationId }) => {
    if (await ctx.db.get(conversationId)) return;
    const run = await ctx.db
      .query("lifeorRuns")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", conversationId),
      )
      .first();
    if (!run) return;
    const traffic = await ctx.db
      .query("lifeorTraffic")
      .withIndex("by_run", (q) => q.eq("runId", run._id))
      .take(10);
    for (const entry of traffic) await ctx.db.delete(entry._id);
    if (traffic.length < 10) await ctx.db.delete(run._id);
    await ctx.scheduler.runAfter(
      0,
      makeFunctionReference<"mutation">("lifeor:purgeConversation"),
      { conversationId },
    );
  },
});
