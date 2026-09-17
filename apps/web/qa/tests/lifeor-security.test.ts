import { afterEach, describe, expect, mock, test } from "bun:test";
mock.module("server-only", () => ({}));
import { seal, unseal, canonical } from "../../src/lib/lifeor/crypto";
const { boundArguments } = await import("../../src/lib/lifeor/adapter");
import { endpoint, sameOrigin, modelConfig } from "../../src/lib/lifeor/config";
const { accessToken } = await import("../../src/lib/lifeor/oauth");
import type { Credentials, Store } from "../../src/lib/lifeor/types";
const originalEnv = { ...process.env },
  originalFetch = globalThis.fetch;
afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
});
function configure() {
  process.env.MCP_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.LIFEOR_MCP_URL = "http://localhost:3000/mcp";
  process.env.LIFEOR_OAUTH_CLIENT_ID =
    "http://localhost:3000/oauth/clients/client";
  process.env.LIFEOR_OAUTH_REDIRECT_URI =
    "http://localhost:3002/api/lifeor/oauth/callback";
  process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3002";
}
describe("LifeOR2 security boundaries", () => {
  test("token envelopes are authenticated and bound to their owner", () => {
    configure();
    const encrypted = seal({ access_token: "secret" }, "alice");
    expect(encrypted).not.toContain("secret");
    expect(unseal(encrypted, "alice")).toEqual({ access_token: "secret" });
    expect(() => unseal(encrypted, "bob")).toThrow();
    expect(() => unseal(encrypted.slice(0, -3) + "aaa", "alice")).toThrow();
  });
  test("dataset cannot be overridden and revision fields survive adaptation", () => {
    const schema = {
      properties: { datasetId: {}, requestKey: {}, expectedRevision: {} },
    };
    expect(() =>
      boundArguments(schema, { datasetId: "other" }, "current", "key"),
    ).toThrow("DATASET_DENIED");
    expect(
      boundArguments(
        schema,
        { expectedRevision: 7, requestKey: "model-key" },
        "current",
        "server-key",
      ),
    ).toEqual({
      datasetId: "current",
      expectedRevision: 7,
      requestKey: "server-key",
    });
    expect(canonical({ b: 2, a: 1 })).toBe(canonical({ a: 1, b: 2 }));
  });
  test("cookie mutations reject missing and foreign origins", () => {
    configure();
    expect(() =>
      sameOrigin(new Request("http://localhost:3002/api/lifeor/runs/start")),
    ).toThrow("ORIGIN_DENIED");
    expect(() =>
      sameOrigin(
        new Request("http://localhost:3002", {
          headers: { origin: "https://evil.example" },
        }),
      ),
    ).toThrow();
    expect(() =>
      sameOrigin(
        new Request("http://localhost:3002", {
          headers: { origin: "http://localhost:3002" },
        }),
      ),
    ).not.toThrow();
  });
  test("model destination and limits fail closed", () => {
    expect(() => endpoint("http://public.example/v1", "test")).toThrow();
    expect(() => endpoint("https://user:secret@example.com", "test")).toThrow();
    process.env.LLM_BASE_URL = "http://127.0.0.1:8000/v1";
    process.env.LLM_MODEL = "configured";
    process.env.LLM_MAX_OUTPUT_TOKENS = "999999";
    expect(() => modelConfig()).toThrow();
  });
  test("concurrent access refreshes once and lost responses never replay", async () => {
    configure();
    let c: Credentials = {
      identity: "grant",
      tokens: seal(
        {
          access_token: "old",
          refresh_token: "old-refresh",
          expiresAt: 0,
          scope: "data:read",
        },
        "alice",
      ),
      status: "connected",
      scopes: ["data:read"],
      datasets: [],
      refreshing: false,
    };
    const store: Store = async <T>(
      op: string,
      p: Record<string, unknown> = {},
    ) => {
      if (op === "credentials") return c as T;
      if (op === "connection.refresh.begin") {
        c = { ...c, refreshing: true };
        return true as T;
      }
      if (op === "connection.refresh.finish")
        c = { ...c, tokens: String(p.tokens), refreshing: false };
      if (op === "connection.invalidate")
        c = {
          ...c,
          tokens: "",
          status: "reconnect_required",
          refreshing: false,
        };
      return null as T;
    };
    let count = 0;
    globalThis.fetch = mock(async () => {
      count++;
      await new Promise((r) => setTimeout(r, 10));
      return Response.json({
        access_token: "new",
        refresh_token: "new-refresh",
        expires_in: 600,
        token_type: "Bearer",
        scope: "data:read",
      });
    }) as typeof fetch;
    expect(
      await Promise.all([
        accessToken(store, "alice", "grant"),
        accessToken(store, "alice", "grant"),
      ]),
    ).toEqual(["new", "new"]);
    expect(count).toBe(1);
    c = {
      ...c,
      tokens: seal(
        { access_token: "old", refresh_token: "lost", expiresAt: 0 },
        "alice",
      ),
    };
    globalThis.fetch = mock(async () => {
      count++;
      throw new Error("response lost");
    }) as typeof fetch;
    await expect(accessToken(store, "alice", "grant")).rejects.toThrow(
      "RECONNECT_REQUIRED",
    );
    await expect(accessToken(store, "alice", "grant")).rejects.toThrow(
      "RECONNECT_REQUIRED",
    );
    expect(count).toBe(2);
    expect(c.tokens).toBe("");
  });
});

test("OAuth binds PKCE, exact issuer, state and initiating session; callbacks are single-use", async () => {
  configure();
  const { beginOAuth, finishOAuth } = await import(
    "../../src/lib/lifeor/oauth"
  );
  const { hash } = await import("../../src/lib/lifeor/crypto");
  let attempt: Record<string, unknown> | null = null,
    saved: Record<string, unknown> | null = null,
    exchanges = 0;
  const identity = { ownerId: "oauth-user", sessionId: "session-a" };
  const store: Store = async <T>(
    op: string,
    p: Record<string, unknown> = {},
  ) => {
    if (op === "oauth.begin") attempt = p;
    if (op === "oauth.consume") {
      if (
        !attempt ||
        attempt.state !== p.state ||
        attempt.session !== p.session
      )
        throw new Error("OAUTH_INVALID");
      const sealed = attempt.sealed;
      attempt = null;
      return sealed as T;
    }
    if (op === "credentials") return null as T;
    if (op === "connection.save") saved = p;
    return null as T;
  };
  globalThis.fetch = mock(async (input, init) => {
    const url = String(input);
    if (url.includes("oauth-protected-resource"))
      return Response.json({
        resource: "http://localhost:3000/mcp",
        authorization_servers: ["http://localhost:3000"],
      });
    if (url.includes("oauth-authorization-server"))
      return Response.json({
        issuer: "http://localhost:3000",
        authorization_endpoint: "http://localhost:3000/oauth/authorize",
        token_endpoint: "http://localhost:3000/oauth/token",
        code_challenge_methods_supported: ["S256"],
      });
    if (url.endsWith("/oauth/token")) {
      exchanges++;
      const params = init!.body as URLSearchParams;
      expect(params.get("resource")).toBe("http://localhost:3000/mcp");
      expect(params.get("redirect_uri")).toBe(
        "http://localhost:3002/api/lifeor/oauth/callback",
      );
      return Response.json({
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        scope: "data:read data:write",
        token_type: "Bearer",
        expires_in: 600,
      });
    }
    throw new Error("Unexpected request");
  }) as typeof fetch;
  const authorization = new URL(await beginOAuth(store, identity, []));
  expect(authorization.searchParams.get("scope")).toBe("data:read data:write");
  const clear = unseal<{ verifier: string }>(
    String(attempt!.sealed),
    identity.ownerId,
  );
  expect(authorization.searchParams.get("code_challenge")).toBe(
    hash(clear.verifier),
  );
  expect(authorization.href).not.toContain(clear.verifier);
  const callback = new URL("http://localhost:3002/api/lifeor/oauth/callback");
  callback.search = new URLSearchParams({
    code: "one-use",
    state: authorization.searchParams.get("state")!,
    iss: "https://wrong.example",
  }).toString();
  await expect(finishOAuth(store, identity, callback)).rejects.toThrow(
    "OAUTH_INVALID",
  );
  expect(exchanges).toBe(0);
  callback.searchParams.set("iss", "http://localhost:3000");
  await expect(
    finishOAuth(store, { ...identity, sessionId: "other-session" }, callback),
  ).rejects.toThrow("OAUTH_INVALID");
  expect(exchanges).toBe(0);
  await finishOAuth(store, identity, callback);
  expect(exchanges).toBe(1);
  expect(JSON.stringify(saved)).not.toContain("access-secret");
  await expect(finishOAuth(store, identity, callback)).rejects.toThrow(
    "OAUTH_INVALID",
  );
  expect(exchanges).toBe(1);
});
