import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
afterEach(() => vi.useRealTimers());
const modules = import.meta.glob("./**/*.*s");
function setup() {
  const t = convexTest(schema, modules);
  const call = (
    ownerId: string,
    op: string,
    payload: Record<string, unknown> = {},
  ) => t.mutation(internal.lifeor.dispatch, { ownerId, op, payload });
  return { t, call };
}
async function connected(
  call: ReturnType<typeof setup>["call"],
  owner = "alice",
) {
  await call(owner, "connection.save", {
    identity: "grant-a",
    tokens: "encrypted",
    scopes: ["data:read", "data:write"],
    datasets: [{ id: "dataset-a", name: "Personal" }],
  });
  return (await call(owner, "conversation.create", {
    datasetId: "dataset-a",
  })) as string;
}
describe("LifeOR2 persistence and isolation", () => {
  test("private gateway rejects browser access without its server key", async () => {
    const { t } = setup();
    const response = await t.fetch("/lifeor/store", {
      method: "POST",
      body: JSON.stringify({ op: "credentials", ownerId: "alice" }),
    });
    expect(response.status).toBe(403);
  });
  test("ownership checks cover history, rename, delete, run access and decisions", async () => {
    const { call } = setup();
    const id = await connected(call);
    for (const op of ["conversation.rename", "conversation.delete"])
      await expect(call("bob", op, { id, title: "Stolen" })).rejects.toThrow(
        "NOT_FOUND",
      );
    await expect(
      call("bob", "state", { instance: "one", conversationId: id }),
    ).rejects.toThrow("NOT_FOUND");
    const started = (await call("alice", "run.start", {
      conversationId: id,
      requestId: "send-1",
      prompt: "Hello",
      instance: "one",
    })) as { run: { _id: string } };
    for (const op of ["run.get", "run.finish", "run.decision"])
      await expect(call("bob", op, { id: started.run._id })).rejects.toThrow(
        "NOT_FOUND",
      );
  });
  test("conversations continue beyond 20 runs and checkpoints avoid reloading old model history", async () => {
    const { t, call } = setup();
    const id = await connected(call);
    await t.run(async (ctx) => {
      const conversationId = ctx.db.normalizeId("lifeorConversations", id)!;
      for (let i = 0; i < 35; i++)
        await ctx.db.insert("lifeorRuns", {
          ownerId: "alice",
          conversationId,
          requestId: `old-${i}`,
          instance: "one",
          status: "completed",
          prompt: `Message ${i}`,
          answer: "Done",
          events: [],
          createdAt: Date.now() - 120000,
          updatedAt: Date.now() - 120000,
        });
    });
    const started = await call("alice", "run.start", {
      conversationId: id,
      requestId: "26",
      prompt: "Continue",
      instance: "one",
    });
    expect(started.created).toBe(true);
    expect(started.history).toHaveLength(35);
    const memory = JSON.stringify([
      { role: "user", content: "Saved working memory", timestamp: 1 },
    ]);
    await call("alice", "run.finish", {
      id: started.run._id,
      status: "completed",
      answer: "Continued",
      memory,
      context: {
        tokens: 100,
        window: 4096,
        percent: 2,
        outputReserve: 256,
        estimated: true,
      },
    });
    const next = await call("alice", "run.start", {
      conversationId: id,
      requestId: "27",
      prompt: "Next",
      instance: "one",
    });
    expect(next.history).toHaveLength(0);
    expect(next.conversation.memory.messages).toBe(memory);
    // An older request remains idempotent even after its context has been compacted.
    const duplicate = await call("alice", "run.start", {
      conversationId: id,
      requestId: "26",
      prompt: "Continue",
      instance: "one",
    });
    expect(duplicate.created).toBe(false);
    const state = await call("alice", "state", {
      instance: "one",
      liveIds: [next.run._id],
      conversationId: id,
    });
    expect(state.runs).toHaveLength(30);
    const earlier = await call("alice", "conversation.history", {
      id,
      cursor: state.historyCursor,
    });
    expect(earlier.runs).toHaveLength(7);
    expect(earlier.cursor).toBeNull();
    await expect(
      call("bob", "conversation.history", { id, cursor: state.historyCursor }),
    ).rejects.toThrow("NOT_FOUND");
    expect(state.conversations[0].memory).toBeUndefined();
  });
  test("traffic is owner-scoped, bounded, and deleted with its conversation", async () => {
    vi.useFakeTimers();
    const { t, call } = setup();
    const id = await connected(call);
    const started = await call("alice", "run.start", {
      conversationId: id,
      requestId: "one",
      prompt: "Read",
      instance: "one",
    });
    const entry = {
      id: "entry",
      exchange: "exchange",
      channel: "model",
      direction: "request",
      label: "Generate",
      body: "{}",
      at: 1,
      truncated: false,
    };
    await call("alice", "run.observe", {
      id: started.run._id,
      observation: entry,
    });
    await expect(
      call("bob", "run.traffic", { id: started.run._id }),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      call("bob", "run.observe", { id: started.run._id, observation: entry }),
    ).rejects.toThrow("NOT_FOUND");
    expect(
      (await call("alice", "run.traffic", { id: started.run._id })).entries,
    ).toEqual([entry]);
    await expect(
      call("alice", "run.observe", {
        id: started.run._id,
        observation: { ...entry, body: "x".repeat(48001) },
      }),
    ).rejects.toThrow("INVALID_INPUT");
    for (let i = 1; i < 130; i++)
      await call("alice", "run.observe", {
        id: started.run._id,
        observation: { ...entry, id: `entry-${i}` },
      });
    const captured = await call("alice", "run.traffic", {
      id: started.run._id,
    });
    expect(captured.entries).toHaveLength(128);
    expect(captured.limited).toBe(true);
    await call("alice", "run.finish", {
      id: started.run._id,
      status: "completed",
      answer: "Done",
      memory: "[]",
    });
    await call("alice", "conversation.delete", { id });
    await expect(
      call("alice", "run.traffic", { id: started.run._id }),
    ).rejects.toThrow("NOT_FOUND");
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(
      await t.run((ctx) => ctx.db.query("lifeorTraffic").collect()),
    ).toHaveLength(0);
    expect(
      await t.run((ctx) => ctx.db.query("lifeorMemory").collect()),
    ).toHaveLength(0);
    expect(
      await t.run((ctx) => ctx.db.query("lifeorRuns").collect()),
    ).toHaveLength(0);
  });
  test("atomic duplicate send and competing tabs execute one turn", async () => {
    const { call } = setup();
    const id = await connected(call),
      args = {
        conversationId: id,
        requestId: "same-request",
        prompt: "Read records",
        instance: "one",
      };
    const first = (await call("alice", "run.start", args)) as {
      created: boolean;
      run: { _id: string };
    };
    const second = (await call("alice", "run.start", args)) as typeof first;
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run._id).toBe(first.run._id);
    await expect(
      call("alice", "run.start", { ...args, requestId: "competing-tab" }),
    ).rejects.toThrow("RUN_ACTIVE");
    await expect(
      call("alice", "run.start", { ...args, prompt: "Different write" }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  });
  test("restart interrupts without replay and keeps completed outcomes", async () => {
    const { call } = setup();
    const id = await connected(call);
    const { run } = (await call("alice", "run.start", {
      conversationId: id,
      requestId: "one",
      prompt: "Read",
      instance: "old",
    })) as { run: { _id: string } };
    await call("alice", "run.event", {
      id: run._id,
      eventId: "result",
      type: "assistant",
      text: "A completed answer",
    });
    const state = (await call("alice", "state", {
      instance: "new",
      conversationId: id,
    })) as { runs: { status: string; answer: string }[] };
    expect(state.runs[0].status).toBe("interrupted");
    expect(state.runs[0].answer).toBe("A completed answer");
  });
  test("reconnection never silently binds existing conversations", async () => {
    const { call } = setup();
    const id = await connected(call);
    await call("alice", "connection.save", {
      identity: "grant-b",
      tokens: "encrypted-new",
      scopes: ["data:read"],
      datasets: [{ id: "dataset-a", name: "Personal" }],
    });
    await expect(
      call("alice", "run.start", {
        conversationId: id,
        requestId: "new",
        prompt: "Read",
        instance: "one",
      }),
    ).rejects.toThrow("RECONNECT_REQUIRED");
  });
  test("confirmation is single-use, exact-id bound, and expires", async () => {
    const { call, t } = setup();
    const id = await connected(call);
    const { run } = (await call("alice", "run.start", {
      conversationId: id,
      requestId: "one",
      prompt: "Delete",
      instance: "one",
    })) as { run: { _id: string } };
    const confirmation = {
      id: run._id,
      confirmationId: "exact-operation",
      message: "Delete example?",
      operation: "trash.permanentlyDelete",
      arguments: '{"target":"a"}',
      schema: '{"type":"object"}',
    };
    await call("alice", "run.confirm", confirmation);
    await expect(
      call("alice", "run.decision", {
        id: run._id,
        confirmationId: "changed",
        decision: '{"action":"accept"}',
      }),
    ).rejects.toThrow("CONFIRMATION_EXPIRED");
    await call("alice", "run.decision", {
      id: run._id,
      confirmationId: "exact-operation",
      decision: '{"action":"cancel"}',
    });
    await expect(
      call("alice", "run.decision", {
        id: run._id,
        confirmationId: "exact-operation",
        decision: '{"action":"accept"}',
      }),
    ).rejects.toThrow("CONFIRMATION_EXPIRED");
    await call("alice", "run.confirm", {
      ...confirmation,
      confirmationId: "expired",
    });
    await t.run(async (ctx) => {
      const key = ctx.db.normalizeId("lifeorRuns", run._id)!;
      const r = await ctx.db.get(key);
      await ctx.db.patch(key, {
        confirmation: { ...r!.confirmation!, expiresAt: Date.now() - 1 },
      });
    });
    await expect(
      call("alice", "run.decision", {
        id: run._id,
        confirmationId: "expired",
        decision: '{"action":"accept"}',
      }),
    ).rejects.toThrow("CONFIRMATION_EXPIRED");
  });
  test("refresh crash invalidates the old credential rather than replaying it", async () => {
    const { call } = setup();
    await connected(call);
    expect(
      await call("alice", "connection.refresh.begin", { identity: "grant-a" }),
    ).toBe(true);
    expect(
      await call("alice", "connection.refresh.begin", { identity: "grant-a" }),
    ).toBe(false);
    const c = (await call("alice", "credentials")) as {
      status: string;
      tokens: string;
    };
    expect(c.status).toBe("reconnect_required");
    expect(c.tokens).toBe("");
    await expect(
      call("alice", "connection.refresh.finish", {
        identity: "grant-a",
        tokens: "stale",
      }),
    ).rejects.toThrow("RECONNECT_REQUIRED");
  });
});
