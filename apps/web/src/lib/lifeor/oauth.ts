import "server-only";
import { config, AppError } from "./config";
import { hash, random, seal, unseal, equal } from "./crypto";
import { serial, cancelConnection } from "./registry";
import type { Store, Credentials } from "./types";
import type { Identity } from "./store";
type Tokens = {
  access_token: string;
  refresh_token: string;
  expiresAt: number;
  scope: string;
};
const allowed = [
  "data:read",
  "data:write",
  "finance:write",
  "data:delete",
  "datasets:manage",
];
async function metadata() {
  const c = config();
  const response = await fetch(
    `${c.issuer}/.well-known/oauth-authorization-server`,
    {
      signal: AbortSignal.timeout(10000),
      redirect: "error",
      cache: "no-store",
    },
  );
  if (!response.ok) throw new AppError("MCP_UNAVAILABLE", 503);
  const m = await response.json();
  if (
    m.issuer !== c.issuer ||
    m.authorization_endpoint !== `${c.issuer}/oauth/authorize` ||
    m.token_endpoint !== `${c.issuer}/oauth/token` ||
    !m.code_challenge_methods_supported?.includes("S256")
  )
    throw new AppError("OAUTH_INVALID");
  const r = await fetch(
    `${c.issuer}/.well-known/oauth-protected-resource${new URL(c.mcp).pathname}`,
    {
      signal: AbortSignal.timeout(10000),
      redirect: "error",
      cache: "no-store",
    },
  );
  const resource = await r.json();
  if (
    !r.ok ||
    resource.resource !== c.mcp ||
    !resource.authorization_servers?.includes(c.issuer)
  )
    throw new AppError("OAUTH_INVALID");
  return c;
}
async function exchange(fields: Record<string, string>): Promise<Tokens> {
  const c = config();
  const response = await fetch(`${c.issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...fields,
      client_id: c.clientId,
      resource: c.mcp,
    }),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok) throw new AppError("RECONNECT_REQUIRED", 401);
  const t = await response.json();
  if (
    typeof t.access_token !== "string" ||
    typeof t.refresh_token !== "string" ||
    !Number.isFinite(t.expires_in) ||
    t.expires_in <= 0 ||
    t.token_type?.toLowerCase() !== "bearer" ||
    typeof t.scope !== "string"
  )
    throw new AppError("OAUTH_INVALID");
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expiresAt: Date.now() + t.expires_in * 1000,
    scope: t.scope,
  };
}
export async function beginOAuth(
  store: Store,
  identity: Identity,
  extra: unknown,
): Promise<string> {
  const c = await metadata();
  if (
    !Array.isArray(extra) ||
    extra.some((s) => typeof s !== "string" || !allowed.includes(s))
  )
    throw new AppError("INVALID_INPUT");
  const scopes = [...new Set(["data:read", "data:write", ...extra])],
    state = random(),
    verifier = random();
  await store("oauth.begin", {
    state: hash(state),
    session: hash(identity.sessionId),
    sealed: seal(
      {
        verifier,
        scopes,
        redirect: c.redirect,
        resource: c.mcp,
        issuer: c.issuer,
      },
      identity.ownerId,
    ),
  });
  const url = new URL(`${c.issuer}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: c.clientId,
    redirect_uri: c.redirect,
    resource: c.mcp,
    scope: scopes.join(" "),
    code_challenge: hash(verifier),
    code_challenge_method: "S256",
    state,
  }).toString();
  return url.href;
}
export async function finishOAuth(
  store: Store,
  identity: Identity,
  url: URL,
): Promise<void> {
  const c = config(),
    state = url.searchParams.get("state"),
    issuer = url.searchParams.get("iss");
  if (
    !state ||
    !issuer ||
    !equal(issuer, c.issuer) ||
    url.origin + url.pathname !== c.redirect
  )
    throw new AppError("OAUTH_INVALID");
  const sealed = await store<string>("oauth.consume", {
    state: hash(state),
    session: hash(identity.sessionId),
  });
  const attempt = unseal<{
    verifier: string;
    scopes: string[];
    redirect: string;
    resource: string;
    issuer: string;
  }>(sealed, identity.ownerId);
  if (
    attempt.redirect !== c.redirect ||
    attempt.resource !== c.mcp ||
    attempt.issuer !== c.issuer
  )
    throw new AppError("OAUTH_INVALID");
  if (url.searchParams.has("error")) throw new AppError("ACCESS_DENIED");
  const code = url.searchParams.get("code");
  if (!code) throw new AppError("OAUTH_INVALID");
  await serial(identity.ownerId, async () => {
    const tokens = await exchange({
      grant_type: "authorization_code",
      code,
      redirect_uri: c.redirect,
      code_verifier: attempt.verifier,
    });
    const granted = tokens.scope.split(" ").filter(Boolean);
    if (
      !granted.includes("data:read") ||
      granted.some((scope) => !attempt.scopes.includes(scope))
    ) {
      await revoke(tokens.refresh_token);
      throw new AppError("OAUTH_INVALID");
    }
    cancelConnection(identity.ownerId);
    const old = await store<Credentials | null>("credentials");
    // Invalidate old credentials before replacing a grant; old conversations keep their identity.
    if (old?.tokens) {
      await revoke(unseal<Tokens>(old.tokens, identity.ownerId).refresh_token);
    }
    await store("connection.save", {
      identity: random(),
      tokens: seal(tokens, identity.ownerId),
      scopes: tokens.scope.split(" ").filter((s) => allowed.includes(s)),
      datasets: [],
    });
  });
}
async function revoke(token: string): Promise<void> {
  const c = config();
  const r = await fetch(`${c.issuer}/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, client_id: c.clientId }),
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  if (!r.ok) throw new AppError("MCP_UNAVAILABLE", 503);
}
export async function disconnect(
  store: Store,
  identity: Identity,
): Promise<void> {
  cancelConnection(identity.ownerId);
  await serial(identity.ownerId, async () => {
    const c = await store<Credentials | null>("credentials");
    if (c?.tokens)
      await revoke(unseal<Tokens>(c.tokens, identity.ownerId).refresh_token);
    await store("connection.disconnect", {});
  });
}
export async function accessToken(
  store: Store,
  ownerId: string,
  connection: string,
): Promise<string> {
  return serial(ownerId, async () => {
    const c = await store<Credentials | null>("credentials");
    if (
      !c ||
      c.identity !== connection ||
      c.status !== "connected" ||
      !c.tokens
    )
      throw new AppError("RECONNECT_REQUIRED", 401);
    if (c.refreshing) {
      await store("connection.invalidate", { identity: connection });
      throw new AppError("RECONNECT_REQUIRED", 401);
    }
    const t = unseal<Tokens>(c.tokens, ownerId);
    if (t.expiresAt > Date.now() + 30000) return t.access_token;
    if (!(await store("connection.refresh.begin", { identity: connection })))
      throw new AppError("RECONNECT_REQUIRED", 401);
    try {
      // Never retry this exchange: a lost response makes reuse unsafe.
      const next = await exchange({
        grant_type: "refresh_token",
        refresh_token: t.refresh_token,
      });
      await store("connection.refresh.finish", {
        identity: connection,
        tokens: seal(next, ownerId),
      });
      return next.access_token;
    } catch {
      await store("connection.invalidate", { identity: connection });
      throw new AppError("RECONNECT_REQUIRED", 401);
    }
  });
}
