import { httpAction } from "./_generated/server";
import { createAuth } from "./auth";
import { getSessionCookie } from "better-auth/cookies";
import { AUTH_COOKIE_PREFIX } from "@repo/auth/cookies";
import { parseUserAgent } from "./parseUserAgent";
import type { DeviceInfo } from "./parseUserAgent";

// ---------------------------------------------------------------------------
// CORS helpers — mirrors http.ts origin checking
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>();
  const siteUrl = requireEnv("SITE_URL");
  for (const u of siteUrl.split(",")) {
    const trimmed = u.trim();
    if (trimmed) origins.add(trimmed);
  }
  const adminUrl = requireEnv("ADMIN_SITE_URL");
  for (const u of adminUrl.split(",")) {
    const trimmed = u.trim();
    if (trimmed) origins.add(trimmed);
  }
  return origins;
}

function corsHeaders(request: Request): Record<string, string> {
  const allowed = getAllowedOrigins();
  const origin = request.headers.get("Origin") ?? "";
  const allowOrigin = allowed.has(origin) ? origin : "";

  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

// ---------------------------------------------------------------------------
// Types — exported for use by frontend components
// ---------------------------------------------------------------------------

export type SessionInfo = {
  /** Better Auth session token (used as session ID for revocation). */
  token: string;
  /** Whether this is the caller's current session. */
  isCurrent: boolean;
  /** IP address from which the session was created. */
  ipAddress: string | null;
  /** Parsed device info from user agent. */
  device: DeviceInfo;
  /** Raw user agent string. */
  userAgent: string | null;
  /** When the session was created (ms since epoch). */
  createdAt: number;
  /** When the session was last active (ms since epoch). */
  lastActive: number;
  /** When the session expires (ms since epoch). */
  expiresAt: number;
};

// ---------------------------------------------------------------------------
// Helper: extract session token from request
// ---------------------------------------------------------------------------

function getSessionToken(request: Request): string | null {
  // Check Authorization header first
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  // Check cookie
  return getSessionCookie(request.headers, { cookiePrefix: AUTH_COOKIE_PREFIX });
}

// ---------------------------------------------------------------------------
// HTTP action: GET /api/sessions — list current user's sessions with device info
// ---------------------------------------------------------------------------

export const listSessionsHandler = httpAction(async (_ctx, request) => {
  const cors = corsHeaders(request);
  const sessionToken = getSessionToken(request);
  if (!sessionToken) {
    return new Response(JSON.stringify({ error: "NOT_AUTHENTICATED" }), {
      status: 401,
      headers: cors,
    });
  }

  const auth = createAuth(_ctx);
  const headers = new Headers({
    authorization: `Bearer ${sessionToken}`,
  });

  // Validate the session
  const session = await auth.api.getSession({ headers });
  if (!session?.user) {
    return new Response(JSON.stringify({ error: "NOT_AUTHENTICATED" }), {
      status: 401,
      headers: cors,
    });
  }

  // List all sessions for this user
  const result = await auth.api.listSessions({ headers });
  const sessions = Array.isArray(result) ? result : [];

  const enriched: SessionInfo[] = sessions.map(
    (s: Record<string, unknown>) => ({
      token: s.token as string,
      isCurrent: s.token === sessionToken,
      ipAddress: (s.ipAddress as string | null) ?? null,
      device: parseUserAgent(s.userAgent as string | null),
      userAgent: (s.userAgent as string | null) ?? null,
      createdAt: new Date(s.createdAt as string | number).getTime(),
      lastActive: new Date(
        (s.updatedAt as string | number) ??
          (s.createdAt as string | number),
      ).getTime(),
      expiresAt: new Date(s.expiresAt as string | number).getTime(),
    }),
  );

  return new Response(JSON.stringify({ sessions: enriched }), {
    status: 200,
    headers: cors,
  });
});

// ---------------------------------------------------------------------------
// HTTP action: POST /api/sessions/revoke — revoke a specific session
// ---------------------------------------------------------------------------

export const revokeSessionHandler = httpAction(async (_ctx, request) => {
  const cors = corsHeaders(request);
  const sessionToken = getSessionToken(request);
  if (!sessionToken) {
    return new Response(JSON.stringify({ error: "NOT_AUTHENTICATED" }), {
      status: 401,
      headers: cors,
    });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ error: "INVALID_BODY" }), {
      status: 400,
      headers: cors,
    });
  }

  const targetToken = body.token as string | undefined;
  if (!targetToken) {
    return new Response(JSON.stringify({ error: "MISSING_TOKEN" }), {
      status: 400,
      headers: cors,
    });
  }

  if (targetToken === sessionToken) {
    return new Response(
      JSON.stringify({ error: "CANNOT_REVOKE_CURRENT_SESSION" }),
      { status: 400, headers: cors },
    );
  }

  const auth = createAuth(_ctx);
  const headers = new Headers({
    authorization: `Bearer ${sessionToken}`,
  });

  // Validate the caller's session before revoking
  const session = await auth.api.getSession({ headers });
  if (!session?.user) {
    return new Response(JSON.stringify({ error: "NOT_AUTHENTICATED" }), {
      status: 401,
      headers: cors,
    });
  }

  await auth.api.revokeSession({
    headers,
    body: { token: targetToken },
  });

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: cors,
  });
});

// ---------------------------------------------------------------------------
// HTTP action: POST /api/sessions/revoke-others — revoke all other sessions
// ---------------------------------------------------------------------------

export const revokeOtherSessionsHandler = httpAction(async (_ctx, request) => {
  const cors = corsHeaders(request);
  const sessionToken = getSessionToken(request);
  if (!sessionToken) {
    return new Response(JSON.stringify({ error: "NOT_AUTHENTICATED" }), {
      status: 401,
      headers: cors,
    });
  }

  const auth = createAuth(_ctx);
  const headers = new Headers({
    authorization: `Bearer ${sessionToken}`,
  });

  // Validate the session first
  const session = await auth.api.getSession({ headers });
  if (!session?.user) {
    return new Response(JSON.stringify({ error: "NOT_AUTHENTICATED" }), {
      status: 401,
      headers: cors,
    });
  }

  await auth.api.revokeOtherSessions({ headers });

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: cors,
  });
});

// ---------------------------------------------------------------------------
// HTTP action: GET /api/two-factor/backup-codes — view existing backup codes
// ---------------------------------------------------------------------------
// Better Auth v1.4.12 has a bug where viewBackupCodes is registered without
// an HTTP path, making it inaccessible via the client. This endpoint wraps
// the server-side auth.api.viewBackupCodes() call.

export const viewBackupCodesHandler = httpAction(async (_ctx, request) => {
  const cors = corsHeaders(request);
  const sessionToken = getSessionToken(request);
  if (!sessionToken) {
    return new Response(JSON.stringify({ error: "NOT_AUTHENTICATED" }), {
      status: 401,
      headers: cors,
    });
  }

  const auth = createAuth(_ctx);
  const headers = new Headers({
    authorization: `Bearer ${sessionToken}`,
  });

  const session = await auth.api.getSession({ headers });
  if (!session?.user) {
    return new Response(JSON.stringify({ error: "NOT_AUTHENTICATED" }), {
      status: 401,
      headers: cors,
    });
  }

  try {
    const result = await auth.api.viewBackupCodes({
      body: { userId: session.user.id },
    });
    return new Response(
      JSON.stringify({ backupCodes: result.backupCodes ?? [] }),
      { status: 200, headers: cors },
    );
  } catch {
    return new Response(
      JSON.stringify({ error: "BACKUP_CODES_NOT_FOUND" }),
      { status: 400, headers: cors },
    );
  }
});
