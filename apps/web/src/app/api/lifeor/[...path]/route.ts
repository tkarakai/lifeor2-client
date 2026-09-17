import {
  AppError,
  body,
  config,
  publicError,
  sameOrigin,
} from "@/lib/lifeor/config";
import { storeFor, type Identity } from "@/lib/lifeor/store";
import { registry, cancelConnection } from "@/lib/lifeor/registry";
import { beginOAuth, finishOAuth, disconnect } from "@/lib/lifeor/oauth";
import { connectMcp, authorizedDatasets } from "@/lib/lifeor/mcp";
import { startRun } from "@/lib/lifeor/runtime";
import type { Credentials, Run, Workspace } from "@/lib/lifeor/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
async function route(request: Request, context: Context): Promise<Response> {
  const path = (await context.params).path.join("/"),
    url = new URL(request.url);
  try {
    if (request.method !== "GET") sameOrigin(request);
    const initial = storeFor(request),
      identity = await initial<Identity>("session");
    const store = storeFor(request, identity.ownerId);
    if (path === "oauth/callback" && request.method === "GET") {
      try {
        await finishOAuth(store, identity, url);
        return Response.redirect(
          `${config().site}/dashboard?connection=connected`,
          303,
        );
      } catch (error) {
        return Response.redirect(
          `${config().site}/dashboard?connection=${publicError(error).code}`,
          303,
        );
      }
    }
    if (path === "state" && request.method === "GET") {
      const state = await store<Workspace>("state", {
        instance: registry.instance,
        liveIds: [...registry.runs.keys()],
        ...(url.searchParams.get("conversation")
          ? { conversationId: url.searchParams.get("conversation") }
          : {}),
      });
      return Response.json(
        {
          ...state,
          server: process.env.LIFEOR_MCP_URL
            ? new URL(process.env.LIFEOR_MCP_URL).host
            : "Not configured",
          configured: !!(
            process.env.LIFEOR_MCP_URL &&
            process.env.LIFEOR_OAUTH_CLIENT_ID &&
            process.env.MCP_TOKEN_ENCRYPTION_KEY
          ),
          live: Object.fromEntries(
            [...registry.runs]
              .filter(([, r]) => r.ownerId === identity.ownerId)
              .map(([id, r]) => [
                id,
                { answer: r.answer, stage: r.stage, context: r.context },
              ]),
          ),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (path === "history" && request.method === "GET") {
      const id = url.searchParams.get("conversation");
      if (!id) throw new AppError("INVALID_INPUT");
      return Response.json(
        await store("conversation.history", {
          id,
          cursor: url.searchParams.get("cursor"),
        }),
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (path === "traffic" && request.method === "GET") {
      const id = url.searchParams.get("run");
      if (!id) throw new AppError("INVALID_INPUT");
      return Response.json(await store("run.traffic", { id }), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path === "stream" && request.method === "GET") {
      const id = url.searchParams.get("run");
      if (!id) throw new AppError("INVALID_INPUT");
      await store<Run>("run.get", { id });
      const encoder = new TextEncoder();
      let timer: ReturnType<typeof setTimeout> | undefined,
        closed = false;
      const stream = new ReadableStream({
        start(controller) {
          const push = async () => {
            if (closed) return;
            try {
              const run = await store<Run>("run.get", { id });
              const live = registry.runs.get(id);
              if (closed) return;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ run, answer: live?.answer ?? run.answer, stage: live?.stage ?? run.status, context: live?.context ?? run.context })}\n\n`,
                ),
              );
              if (!["running", "waiting"].includes(run.status) || !live) {
                closed = true;
                controller.close();
                return;
              }
              timer = setTimeout(push, 500);
            } catch {
              if (!closed) {
                closed = true;
                controller.close();
              }
            }
          };
          void push();
        },
        cancel() {
          closed = true;
          if (timer) clearTimeout(timer);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          Connection: "keep-alive",
        },
      });
    }
    if (request.method !== "POST") throw new AppError("NOT_FOUND", 404);
    const input = await body(request);
    if (path === "oauth/start")
      return Response.json({
        url: await beginOAuth(store, identity, input.scopes ?? []),
      });
    if (path === "disconnect") {
      await disconnect(store, identity);
      return Response.json({ ok: true });
    }
    if (path === "datasets") {
      const c = await store<Credentials | null>("credentials");
      if (!c || c.status !== "connected")
        throw new AppError("RECONNECT_REQUIRED", 401);
      const client = await connectMcp(store, identity.ownerId, c.identity);
      try {
        const datasets = await authorizedDatasets(client);
        await store("connection.datasets", { identity: c.identity, datasets });
        return Response.json({ datasets });
      } finally {
        await client.close();
      }
    }
    if (path === "conversations/create")
      return Response.json({
        id: await store("conversation.create", { datasetId: input.datasetId }),
      });
    if (path === "conversations/rename" || path === "conversations/delete") {
      await store(
        path.endsWith("rename") ? "conversation.rename" : "conversation.delete",
        { id: input.id, title: input.title },
      );
      return Response.json({ ok: true });
    }
    if (path === "runs/compact")
      return Response.json(await startRun(store, identity, input, true));
    if (path === "runs/start")
      return Response.json(await startRun(store, identity, input));
    if (path === "runs/stop") {
      const run = await store<Run>("run.get", { id: input.id });
      const live = registry.runs.get(run._id);
      if (live?.ownerId === identity.ownerId) live.controller.abort();
      return Response.json({ ok: true });
    }
    if (path === "runs/confirm") {
      if (!["accept", "decline", "cancel"].includes(String(input.action)))
        throw new AppError("INVALID_INPUT");
      const r = await store<Run>("run.get", { id: input.id });
      const live = registry.runs.get(r._id);
      if (
        !live ||
        live.ownerId !== identity.ownerId ||
        live.controller.signal.aborted
      )
        throw new AppError("CONFIRMATION_EXPIRED");
      await store("run.decision", {
        id: input.id,
        confirmationId: input.confirmationId,
        decision: JSON.stringify({
          action: input.action,
          ...(input.action === "accept" ? { content: input.content } : {}),
        }),
      });
      return Response.json({ ok: true });
    }
    if (path === "signout") {
      cancelConnection(identity.ownerId);
      return Response.json({ ok: true });
    }
    throw new AppError("NOT_FOUND", 404);
  } catch (error) {
    const e = publicError(error);
    return Response.json(
      { error: e.message, code: e.code },
      {
        status: e.status,
        headers: {
          "Cache-Control": "no-store",
          ...(e.status === 429 ? { "Retry-After": "60" } : {}),
        },
      },
    );
  }
}
export const GET = route;
export const POST = route;
