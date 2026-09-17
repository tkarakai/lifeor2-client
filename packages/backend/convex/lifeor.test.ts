import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
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
