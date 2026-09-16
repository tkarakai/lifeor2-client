import { httpRouter } from "convex/server";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import {
  listSessionsHandler,
  revokeSessionHandler,
  revokeOtherSessionsHandler,
  viewBackupCodesHandler,
} from "./sessions";
import { getDevTotpCode } from "./devTotp";
import { createE2eUser } from "./e2eFixtures";
import {
  isSignupOnboarding,
  isWaitlistOnboarding,
  parseOnboardingType,
} from "./onboardingType";

const http = httpRouter();

authComponent.registerRoutes(http, createAuth);

// ---------------------------------------------------------------------------
// CORS helpers — dynamic origin checking
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
  const landingUrl = requireEnv("LANDING_URL");
  for (const u of landingUrl.split(",")) {
    const trimmed = u.trim();
    if (trimmed) origins.add(trimmed);
  }
  return origins;
}

function corsHeaders(request?: Request): Record<string, string> {
  const allowed = getAllowedOrigins();
  const origin = request?.headers.get("Origin") ?? "";
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
// GET /api/waitlist/status — check onboarding mode
// ---------------------------------------------------------------------------

http.route({
  path: "/api/waitlist/status",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const onboardingTypeRaw = await ctx.runQuery(
      internal.appSettings.getInternal,
      {
        key: "onboardingType",
      }
    );
    const onboardingType = parseOnboardingType(onboardingTypeRaw);
    const waitlistEnabled = isWaitlistOnboarding(onboardingType);
    const signupEnabled = isSignupOnboarding(onboardingType);

    return new Response(
      JSON.stringify({
        // Backward-compatible field for existing clients.
        enabled: waitlistEnabled,
        onboardingType,
        waitlistEnabled,
        signupEnabled,
      }),
      {
        status: 200,
        headers: corsHeaders(request),
      }
    );
  }),
});

http.route({
  path: "/api/waitlist/status",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }),
});

// ---------------------------------------------------------------------------
// POST /api/waitlist/join — join the waitlist
// ---------------------------------------------------------------------------

http.route({
  path: "/api/waitlist/join",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      const { email, meta } = body;

      // Basic input validation
      if (!email || typeof email !== "string" || !email.includes("@")) {
        return new Response(JSON.stringify({ error: "INVALID_EMAIL" }), {
          status: 400,
          headers: corsHeaders(request),
        });
      }

      // Forward IP for rate limiting
      const clientIp =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        request.headers.get("x-real-ip") ??
        "unknown";

      const result = await ctx.runMutation(internal.waitlist.join, {
        email: email.trim().toLowerCase(),
        meta: typeof meta === "string" ? meta : JSON.stringify(meta ?? {}),
        clientIp,
      });

      return new Response(JSON.stringify({ success: true, ...result }), {
        status: 200,
        headers: corsHeaders(request),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "UNKNOWN_ERROR";

      // Known client errors → 400; everything else → 500
      const clientErrors = [
        "WAITLIST_NOT_ENABLED",
        "INVALID_EMAIL",
        "INVALID_META",
        "RATE_LIMITED",
      ];
      const isClientError = clientErrors.some((code) =>
        message.includes(code)
      );

      return new Response(JSON.stringify({ error: message }), {
        status: isClientError ? 400 : 500,
        headers: corsHeaders(request),
      });
    }
  }),
});

http.route({
  path: "/api/waitlist/join",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }),
});

// ---------------------------------------------------------------------------
// GET /api/announcements/active — currently active announcement banner
// ---------------------------------------------------------------------------

http.route({
  path: "/api/announcements/active",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const announcement = await ctx.runQuery(internal.announcements.getActiveInternal, {});

    return new Response(
      JSON.stringify({
        announcement,
      }),
      {
        status: 200,
        headers: corsHeaders(request),
      }
    );
  }),
});

http.route({
  path: "/api/announcements/active",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }),
});

// ---------------------------------------------------------------------------
// Session management endpoints (authenticated)
// ---------------------------------------------------------------------------

http.route({
  path: "/api/sessions",
  method: "GET",
  handler: listSessionsHandler,
});

http.route({
  path: "/api/sessions",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(request),
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }),
});

http.route({
  path: "/api/sessions/revoke",
  method: "POST",
  handler: revokeSessionHandler,
});

http.route({
  path: "/api/sessions/revoke",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(request),
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }),
});

http.route({
  path: "/api/sessions/revoke-others",
  method: "POST",
  handler: revokeOtherSessionsHandler,
});

http.route({
  path: "/api/sessions/revoke-others",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(request),
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }),
});

// ---------------------------------------------------------------------------
// Two-factor backup codes (workaround for Better Auth bug — no HTTP path)
// ---------------------------------------------------------------------------

http.route({
  path: "/api/two-factor/backup-codes",
  method: "GET",
  handler: viewBackupCodesHandler,
});

http.route({
  path: "/api/two-factor/backup-codes",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(request),
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }),
});

// ---------------------------------------------------------------------------
// Dev TOTP helper (only active when DEV_SEED_ENABLED is set)
// ---------------------------------------------------------------------------

http.route({
  path: "/api/dev/totp-code",
  method: "GET",
  handler: getDevTotpCode,
});

// Disposable E2E user fixtures. Gated on DEV_SEED_ENABLED and a reserved
// e2e.local address — see e2eFixtures.ts for the full safety rationale.
http.route({
  path: "/api/dev/e2e-user",
  method: "POST",
  handler: createE2eUser,
});

export default http;
