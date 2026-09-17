import { makeFunctionReference } from "convex/server";
import { httpAction } from "./_generated/server";
import { createAuth } from "./auth";

// A private server-to-server gateway: no CORS, no public token queries/subscriptions.
// The shared key grants access only to this application, not Convex administration.
const dispatch = makeFunctionReference<"mutation">("lifeor:dispatch");
export const gateway = httpAction(async (ctx, request) => {
  const key = process.env.LIFEOR_STORE_SECRET;
  if (!key || key.length < 32 || request.headers.get("x-lifeor-key") !== key)
    return new Response(null, { status: 403 });
  try {
    const input = await request.json();
    const auth = createAuth(ctx);
    const session = await auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
    });
    const user = session?.user as
      | (Record<string, unknown> & { id: string })
      | undefined;
    let ownerId: string;
    if (!user || user.banned === true || user.emailVerified !== true) {
      // Finalization of already-started work must survive session expiry/logout.
      if (
        !["run.finish", "run.event"].includes(input.op) ||
        typeof input.finalizeOwner !== "string"
      )
        return new Response(null, { status: 401 });
      ownerId = input.finalizeOwner;
    } else ownerId = user.id;
    if (input.op === "session")
      return Response.json({ ownerId, sessionId: session!.session.id });
    const result = await ctx.runMutation(dispatch, {
      ownerId,
      op: input.op,
      payload: input.payload ?? {},
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code =
      [
        "NOT_FOUND",
        "OAUTH_INVALID",
        "RECONNECT_REQUIRED",
        "DATASET_DENIED",
        "HISTORY_LIMIT",
        "RUN_ACTIVE",
        "IDEMPOTENCY_CONFLICT",
        "RATE_LIMITED",
        "CONTEXT_LIMIT",
        "RUN_FINISHED",
        "TOOL_LIMIT",
        "CONFIRMATION_EXPIRED",
        "INVALID_INPUT",
      ].find((c) => message.includes(c)) ?? "STORAGE_UNAVAILABLE";
    return Response.json(
      { error: code },
      { status: code === "RATE_LIMITED" ? 429 : 400 },
    );
  }
});
