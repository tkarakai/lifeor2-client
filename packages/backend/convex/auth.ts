import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { requireActionCtx } from "@convex-dev/better-auth/utils";
import { convex } from "@convex-dev/better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { AUTH_COOKIE_PREFIX, SESSION_COOKIE_NAME } from "@repo/auth/cookies";
import { symmetricDecrypt } from "better-auth/crypto";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { admin, emailOTP, haveIBeenPwned, magicLink, twoFactor } from "better-auth/plugins";

import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { action, query } from "./_generated/server";
import authConfig from "./auth.config";
import { runAuditEvent } from "./auditTrailHelpers";
import type { AuditStatus } from "./auditTrailConstants";
import authSchema from "./betterAuth/schema";
import { sendAuthEmail } from "./sendAuthEmail";
import type { EmailTemplate } from "./emailTemplates";
import { renderVerificationEmailTemplate, formatDurationHuman } from "./emailTemplates";
import { isSignupOnboarding, parseOnboardingType } from "./onboardingType";
import { validatePasswordStrength } from "./passwordStrength";
import { USER_EMAIL_VERIFICATION_REQUIRED_KEY } from "./securityPolicies";

// ---------------------------------------------------------------------------
// Auth endpoint rate limiting via convex-helpers (persistent, OCC-safe).
// Better Auth's built-in rate limiting uses either "memory" (no-op in Convex
// HTTP actions) or "database" (causes OCC conflicts). This mapping lets a
// custom onRequest plugin enforce equivalent limits via convex-helpers'
// token-bucket implementation, which handles concurrent writes correctly.
// ---------------------------------------------------------------------------

type RateLimitKeySource = "ip" | "email";

const AUTH_RATE_LIMIT_MAP: Record<string, { name: string; keyFrom: RateLimitKeySource }> = {
  "/sign-in/email": { name: "authSignIn", keyFrom: "email" },
  "/sign-up/email": { name: "authSignUp", keyFrom: "ip" },
  "/request-password-reset": { name: "authPasswordResetRequest", keyFrom: "ip" },
  "/reset-password": { name: "authPasswordReset", keyFrom: "ip" },
  "/send-verification-email": { name: "authVerificationEmail", keyFrom: "ip" },
  "/email-otp/send-verification-otp": { name: "authEmailOtp", keyFrom: "ip" },
  "/magic-link/send-magic-link": { name: "authMagicLink", keyFrom: "ip" },
};

function extractIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

/**
 * Better Auth plugin that enforces persistent, OCC-safe rate limits via
 * convex-helpers' token-bucket system. Replaces Better Auth's built-in
 * rate limiting which cannot work reliably in Convex HTTP actions.
 */
const convexRateLimitPlugin = (
  convexCtx: GenericCtx<DataModel>,
): BetterAuthPlugin => ({
  id: "convex-rate-limit",
  async onRequest(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/auth/, "");
    const config = AUTH_RATE_LIMIT_MAP[path];
    if (!config) return;

    let key: string;
    if (config.keyFrom === "email") {
      try {
        const body = (await request.clone().json()) as Record<string, unknown>;
        const email = (body.email as string | undefined)?.trim().toLowerCase();
        key = email || extractIp(request);
      } catch {
        key = extractIp(request);
      }
    } else {
      key = extractIp(request);
    }

    const actionCtx = requireActionCtx(convexCtx);
    const result = await actionCtx.runMutation(
      internal.rateLimits.consumeAuthRateLimit,
      { name: config.name, key },
    );

    if (!result.ok) {
      const retryAfter = Math.ceil(((result.retryAt ?? Date.now() + 1000) - Date.now()) / 1000);
      return {
        response: new Response(
          JSON.stringify({
            error: { message: "Too many requests. Please try again later." },
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": String(retryAfter),
            },
          },
        ),
      };
    }
  },
});

/** Truncate a string to at most `max` characters. */
function truncate(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= max ? value : value.slice(0, max);
}

/** Parse an env var as a positive integer, falling back to a safe default. */
function positiveInt(envVar: string | undefined, defaultValue: number): number {
  const parsed = parseInt(envVar ?? "", 10);
  if (Number.isNaN(parsed) || parsed <= 0) return defaultValue;
  return parsed;
}

// Better Auth runs inside Convex, so env vars are set via `convex env set`.
// These helpers read env vars lazily (at runtime) rather than at module scope,
// because Convex's push/analysis phase loads all modules before env vars are available.

/** Read and validate SITE_URL at runtime.
 *  During Convex's push/analysis phase, env vars set via `convex env set` are
 *  not yet available, but `registerRoutes` in http.ts calls `createAuth` at
 *  module scope to discover routes. We return a placeholder so the push
 *  succeeds; real request handlers will have the env var populated. */
function getSiteUrls(): { siteUrl: string; siteUrls: string[] } {
  const siteUrlRaw = process.env.SITE_URL;
  if (!siteUrlRaw) {
    // Placeholder for push/analysis phase — never used for real requests.
    return { siteUrl: "http://placeholder.invalid", siteUrls: ["http://placeholder.invalid"] };
  }
  const siteUrls = siteUrlRaw.split(",").map((url) => url.trim()).filter(Boolean);
  return { siteUrl: siteUrls[0], siteUrls };
}

/** Optional override for passkey RP ID. Use a shared parent domain (hostname only)
 *  when web/admin should both register and use the same passkeys. */
function getPasskeyRpId(): string | undefined {
  const raw = process.env.PASSKEY_RP_ID?.trim();
  if (!raw) return undefined;
  try {
    return new URL(raw).hostname;
  } catch {
    return raw;
  }
}

// Custom plugin to set trusted origins for all app URLs
const multiOriginPlugin = (siteUrls: string[]): BetterAuthPlugin => ({
  id: "multi-origin",
  init() {
    return {
      options: {
        trustedOrigins: siteUrls,
      },
    };
  },
});

// Admin mutation paths that should be guarded for protected admins
const PROTECTED_ADMIN_PATHS = [
  "/admin/ban-user",
  "/admin/remove-user",
  "/admin/set-role",
];

// Plugin that prevents banning, deleting, or demoting users whose emails
// appear in the adminEmails table.
const protectedAdminPlugin = (
  convexCtx: GenericCtx<DataModel>,
): BetterAuthPlugin => ({
  id: "protected-admin",
  async onRequest(request, ctx) {
    const url = new URL(request.url);
    // Strip the base path prefix (e.g. /api/auth) to get the route path
    const path = url.pathname.replace(/^\/api\/auth/, "");

    if (!PROTECTED_ADMIN_PATHS.some((p) => path.endsWith(p))) return;

    let body: Record<string, unknown>;
    try {
      body = (await request.clone().json()) as Record<string, unknown>;
    } catch {
      return;
    }

    const userId = body.userId as string | undefined;
    if (!userId) return;

    const targetUser = await ctx.internalAdapter.findUserById(userId);
    if (!targetUser) return;

    const actionCtx = requireActionCtx(convexCtx);
    const adminEmailRows = await actionCtx.runQuery(internal.adminEmails.list);
    if (
      adminEmailRows.some(
        (row: { email: string }) => row.email === targetUser.email,
      )
    ) {
      return {
        response: new Response(
          JSON.stringify({
            error: { message: "Cannot modify a protected admin" },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
      };
    }
  },
});

// Endpoints that accept a password in the request body.
const PASSWORD_ENDPOINTS = ["/sign-up/email", "/reset-password", "/change-password"];

// Plugin that enforces password strength server-side on all password-accepting
// endpoints. Even if the client-side meter didn't load, the server will reject
// weak passwords before Better Auth processes them.
const passwordStrengthPlugin = (
  convexCtx: GenericCtx<DataModel>,
): BetterAuthPlugin => ({
  id: "password-strength",
  async onRequest(request, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/auth/, "");

    if (!PASSWORD_ENDPOINTS.some((p) => path.endsWith(p))) return;

    let body: Record<string, unknown>;
    try {
      body = (await request.clone().json()) as Record<string, unknown>;
    } catch {
      return;
    }

    const password =
      (body.password as string | undefined) ??
      (body.newPassword as string | undefined);
    let email = (body.email as string | undefined) ?? "";
    if (!password) return;

    // For /change-password: resolve email from the authenticated session
    // (body does not include email, so we must derive it from the session cookie)
    if (path.endsWith("/change-password") && !email) {
      try {
        const cookieHeader = request.headers.get("cookie");
        if (cookieHeader) {
          const cookieName = (ctx as { authCookies?: { sessionToken?: { name?: string } } })
            .authCookies?.sessionToken?.name ?? SESSION_COOKIE_NAME;
          const match = cookieHeader
            .split(";")
            .map((c) => c.trim())
            .find((c) => c.startsWith(cookieName + "="));
          if (match) {
            const sessionToken = decodeURIComponent(match.slice(cookieName.length + 1));
            const session = await ctx.internalAdapter.findSession(sessionToken);
            if (session?.user?.email) {
              email = session.user.email;
            }
          }
        }
      } catch {
        // If session resolution fails, fall through with empty email
      }
    }

    // For /reset-password: resolve email from the reset token owner
    // (body only contains token + newPassword, so we look up the verification record)
    if (path.endsWith("/reset-password") && !email) {
      try {
        const token = body.token as string | undefined;
        if (token) {
          const verification = await ctx.internalAdapter.findVerificationValue(
            `reset-password:${token}`,
          );
          if (verification?.value) {
            const user = await ctx.internalAdapter.findUserById(verification.value);
            if (user?.email) {
              email = user.email;
            }
          }
        }
      } catch {
        // If token resolution fails, fall through with empty email
      }
    }

    // Determine role: admin emails get the stricter threshold
    const actionCtx = requireActionCtx(convexCtx);
    const adminEmails = await actionCtx.runQuery(internal.adminEmails.list);
    const role =
      email && adminEmails.some((row: { email: string }) => row.email === email)
        ? "admin"
        : "user";

    const result = validatePasswordStrength(password, email, role);
    if (!result.valid) {
      return {
        response: new Response(
          JSON.stringify({ error: { message: result.reason } }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
      };
    }
  },
});

export const authComponent = createClient<DataModel, typeof authSchema>(
  components.betterAuth,
  {
    local: {
      schema: authSchema,
    },
  },
);

/** Build a TOTP issuer name that includes environment context.
 *  - Production: "Web App Starter"
 *  - Staging:    "Web App Starter (STAGING)"
 *  - Dev:        "Web App Starter (DEV: branch-name)" */
function getTotpIssuer(siteUrl: string): string {
  const base = "Web App Starter";
  const isDev = process.env.DEV_SEED_ENABLED === "true";
  const isLocalhost = siteUrl.includes("localhost") || siteUrl.includes("127.0.0.1");

  if (isDev || isLocalhost) {
    const branch = process.env.GIT_BRANCH;
    return branch ? `${base} (DEV: ${branch})` : `${base} (DEV)`;
  }

  const appEnv = process.env.APP_ENVIRONMENT;
  if (appEnv && appEnv.toLowerCase() === "staging") {
    return `${base} (STAGING)`;
  }

  return base;
}

type AuthEndpointAction =
  | "auth.sign_in.requested"
  | "auth.sign_up.requested"
  | "auth.password_reset.requested"
  | "auth.password_reset.completed"
  | "auth.email_verification.requested"
  | "auth.two_factor.setup_started"
  | "auth.two_factor.disabled"
  | "auth.two_factor.verify_totp"
  | "auth.two_factor.verify_backup_code"
  | "auth.two_factor.backup_codes_regenerated";

type AuthEndpointAuditConfig = {
  action: AuthEndpointAction;
  resource: (actor: string) => string;
};

const AUTH_ENDPOINT_AUDIT_CONFIG: Record<string, AuthEndpointAuditConfig> = {
  "/sign-in/email": {
    action: "auth.sign_in.requested",
    resource: (actor) => `user:${actor}`,
  },
  "/sign-up/email": {
    action: "auth.sign_up.requested",
    resource: (actor) => `user:${actor}`,
  },
  "/request-password-reset": {
    action: "auth.password_reset.requested",
    resource: (actor) => `user:${actor}`,
  },
  "/reset-password": {
    action: "auth.password_reset.completed",
    resource: () => "password-reset:self",
  },
  "/send-verification-email": {
    action: "auth.email_verification.requested",
    resource: (actor) => `user:${actor}`,
  },
  "/two-factor/enable": {
    action: "auth.two_factor.setup_started",
    resource: () => "user:self",
  },
  "/two-factor/disable": {
    action: "auth.two_factor.disabled",
    resource: () => "user:self",
  },
  "/two-factor/verify-totp": {
    action: "auth.two_factor.verify_totp",
    resource: () => "session:pending-2fa",
  },
  "/two-factor/verify-backup-code": {
    action: "auth.two_factor.verify_backup_code",
    resource: () => "session:pending-2fa",
  },
  "/two-factor/generate-backup-codes": {
    action: "auth.two_factor.backup_codes_regenerated",
    resource: () => "user:self",
  },
};

type ApiErrorLike = {
  statusCode: number;
  message?: string;
};

function normalizeAuthPath(path: string): string {
  return path.replace(/^\/api\/auth/, "");
}

function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function getApiErrorLike(value: unknown): ApiErrorLike | null {
  if (!value || typeof value !== "object") return null;
  const maybeError = value as {
    statusCode?: unknown;
    body?: { message?: unknown };
  };
  if (typeof maybeError.statusCode !== "number") return null;
  return {
    statusCode: maybeError.statusCode,
    message:
      typeof maybeError.body?.message === "string"
        ? maybeError.body.message
        : undefined,
  };
}

function mapEndpointErrorToStatus(
  path: string,
  error: ApiErrorLike | null,
): AuditStatus {
  if (!error) return "succeeded";

  const message = (error.message ?? "").toLowerCase();

  if (error.statusCode === 401) {
    if (
      path === "/two-factor/verify-totp" ||
      path === "/two-factor/verify-backup-code"
    ) {
      return "failed.invalid_code";
    }
    if (path === "/sign-in/email") return "failed.wrong_password";
    return "failed.unauthorized";
  }

  if (error.statusCode === 403) return "failed.blocked";
  if (error.statusCode === 404) return "failed.not_found";
  if (error.statusCode === 429) return "failed.rate_limited";

  if (error.statusCode === 400 || error.statusCode === 422) {
    if (message.includes("invalid_password")) {
      return "failed.wrong_password";
    }
    if (message.includes("invalid_token") || message.includes("expired")) {
      return "failed.expired";
    }
    if (
      (path === "/two-factor/verify-totp" ||
        path === "/two-factor/verify-backup-code") &&
      (message.includes("invalid") || message.includes("code"))
    ) {
      return "failed.invalid_code";
    }
    return "failed.validation_error";
  }

  if (error.statusCode >= 500) return "failed.internal_error";
  return "failed.unknown";
}

/** Email verification token lifetime in seconds (BetterAuth default: 3600 = 1 hour). */
const EMAIL_VERIFICATION_EXPIRY_SECONDS = positiveInt(
  process.env.AUTH_EMAIL_VERIFICATION_EXPIRY,
  3600,
);

/**
 * Plugin that captures the user ID from a reset-password token before
 * Better Auth consumes it. The ID is stored via the provided callback
 * so the top-level hooks.after can mark the email as verified.
 */
const emailVerifiedOnResetPlugin = (
  onUserIdCaptured: (userId: string) => void,
): BetterAuthPlugin => ({
  id: "email-verified-on-reset",
  async onRequest(request, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/auth/, "");
    if (!path.endsWith("/reset-password")) return;

    try {
      const body = (await request.clone().json()) as Record<string, unknown>;
      const token = body.token as string | undefined;
      if (token) {
        const verification = await ctx.internalAdapter.findVerificationValue(
          `reset-password:${token}`,
        );
        if (verification?.value) {
          onUserIdCaptured(verification.value);
        }
      }
    } catch {
      // Don't break the reset flow if token lookup fails.
    }
  },
});

export const createAuthOptions = (
  ctx: GenericCtx<DataModel>,
) => {
  const { siteUrl, siteUrls } = getSiteUrls();
  const passkeyRpId = getPasskeyRpId();

  // Shared across the plugin's onRequest and the top-level hooks.after within
  // this single request invocation.  Captured in onRequest (before the token is
  // consumed) so the after-hook can mark the email as verified.
  let pendingResetUserId: string | null = null;

  return {
    baseURL: siteUrl,
    database: authComponent.adapter(ctx),
    session: {
      // Spec §8.3: user sessions = 7 days / refresh every 1 hour.
      // Admin sessions (4 hours) are enforced at the middleware level.
      expiresIn: 60 * 60 * 24 * 7,  // 7 days
      updateAge: 60 * 60,            // 1 hour
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      // requireEmailVerification is kept false here so Better Auth does not
      // block sign-ins at the protocol level. Enforcement is done at the
      // app level (dashboard layout + AuthGuard) so the admin toggle works
      // without requiring an async createAuth factory.
      requireEmailVerification: false,
      sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
        await sendAuthEmail({
          to: user.email,
          type: "reset-password",
          urlOrCode: url,
        });
      },
    },
    emailVerification: {
      // Always trigger the callback on sign-up; the callback decides whether
      // to actually send based on the current admin setting.
      sendOnSignUp: true,
      // Verifying an email should update the user record only; it must not
      // create or refresh an authenticated session from the verification link.
      autoSignInAfterVerification: false,
      expiresIn: EMAIL_VERIFICATION_EXPIRY_SECONDS,
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
        // Read settings per-request — callbacks are async and have ctx.
        const actionCtx = requireActionCtx(ctx);
        const emailVerifRequired = await actionCtx.runQuery(
          internal.appSettings.getInternal,
          { key: USER_EMAIL_VERIFICATION_REQUIRED_KEY }
        );
        // If the admin has disabled email verification, skip sending.
        if (emailVerifRequired === false) return;

        const verificationTemplateSetting = await actionCtx.runQuery(
          internal.appSettings.getInternal,
          { key: "emailVerificationTemplate" }
        );
        const verificationTemplate: EmailTemplate | null =
          typeof verificationTemplateSetting === "string"
            ? (JSON.parse(verificationTemplateSetting) as EmailTemplate)
            : verificationTemplateSetting != null
            ? (verificationTemplateSetting as EmailTemplate)
            : null;

        const linkExpiry = formatDurationHuman(EMAIL_VERIFICATION_EXPIRY_SECONDS);

        if (verificationTemplate) {
          const rendered = renderVerificationEmailTemplate(verificationTemplate, {
            verification_link: url,
            link_expiry: linkExpiry,
          });
          await sendAuthEmail({
            to: user.email,
            type: "custom",
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
          });
        } else {
          await sendAuthEmail({
            to: user.email,
            type: "verification",
            urlOrCode: url,
            linkExpiry,
          });
        }
      },
    },
    hooks: {
      after: async (endpointCtx) => {
        const middlewareCtx = endpointCtx as unknown as {
          path?: string;
          body?: unknown;
          context?: {
            returned?: unknown;
            session?: { user?: { email?: unknown } };
            internalAdapter?: {
              updateUser: (id: string, data: Record<string, unknown>) => Promise<unknown>;
            };
          };
        };

        const rawPath =
          typeof middlewareCtx.path === "string" ? middlewareCtx.path : "";
        const path = normalizeAuthPath(rawPath);
        const config = AUTH_ENDPOINT_AUDIT_CONFIG[path];
        if (!config) return {};

        const body =
          middlewareCtx.body && typeof middlewareCtx.body === "object"
            ? (middlewareCtx.body as Record<string, unknown>)
            : {};
        const sessionUser = middlewareCtx.context?.session?.user;
        const actor =
          normalizeEmail(body.email) ??
          normalizeEmail(sessionUser?.email) ??
          "unknown";
        const error = getApiErrorLike(middlewareCtx.context?.returned);
        const status = mapEndpointErrorToStatus(path, error);

        const actionCtx = requireActionCtx(ctx);
        await runAuditEvent(actionCtx, {
          happenedAt: Date.now(),
          actor,
          sourceDetail: "auth-endpoint-hook",
          action: config.action,
          resource: config.resource(actor),
          status,
          reason: error?.message,
          meta: JSON.stringify({ endpoint: path }),
        });

        // After a successful email-link password reset, mark the email as
        // verified — completing the reset proves the user controls the address.
        if (path === "/reset-password" && !error && pendingResetUserId) {
          const userId = pendingResetUserId;
          pendingResetUserId = null;
          try {
            await middlewareCtx.context?.internalAdapter?.updateUser(userId, {
              emailVerified: true,
            });
          } catch {
            // Best-effort: don't break the reset response if this fails.
          }
        }

        return {};
      },
    },
    databaseHooks: {
      session: {
        create: {
          after: async (session) => {
            const actionCtx = requireActionCtx(ctx);
            const s = session as Record<string, unknown>;
            const userId = s.userId as string;
            const sessionId = (s.id ?? s._id ?? "") as string;

            // Look up user email via the Better Auth component
            const user = await authComponent.getAnyUserById(ctx, userId);

            const email = (user?.email as string) ?? "unknown";
            const ip = truncate(s.ipAddress as string | undefined, 200);
            const userAgent = truncate(s.userAgent as string | undefined, 500);
            const meta: Record<string, string> = {};
            if (ip) meta.ip = ip;
            if (userAgent) meta.userAgent = userAgent;

            await runAuditEvent(actionCtx, {
              happenedAt: Date.now(),
              actor: email,
              authenticatedUserId: userId,
              sourceDetail: "auth-hook",
              action: "auth.sign_in",
              resource: `session:${sessionId}`,
              status: "succeeded",
              meta: Object.keys(meta).length > 0 ? JSON.stringify(meta) : undefined,
            });
          },
        },
        delete: {
          before: async (session) => {
            const actionCtx = requireActionCtx(ctx);
            const s = session as Record<string, unknown>;
            const userId = s.userId as string;
            const sessionId = (s.id ?? s._id ?? "") as string;

            const user = await authComponent.getAnyUserById(ctx, userId);

            const email = (user?.email as string) ?? "unknown";
            const ip = truncate(s.ipAddress as string | undefined, 200);
            const userAgent = truncate(s.userAgent as string | undefined, 500);
            const meta: Record<string, string> = {};
            if (ip) meta.ip = ip;
            if (userAgent) meta.userAgent = userAgent;

            await runAuditEvent(actionCtx, {
              happenedAt: Date.now(),
              actor: email,
              authenticatedUserId: userId,
              sourceDetail: "auth-hook",
              action: "auth.sign_out",
              resource: `session:${sessionId}`,
              status: "succeeded",
              meta: Object.keys(meta).length > 0 ? JSON.stringify(meta) : undefined,
            });
          },
        },
      },
      user: {
        create: {
          before: async (user) => {
            const actionCtx = requireActionCtx(ctx);

            // Public signup is allowed only in signup onboarding mode.
            // Invitation-based signups remain allowed regardless of mode.
            const onboardingTypeRaw = await actionCtx.runQuery(
              internal.appSettings.getInternal,
              { key: "onboardingType" },
            );
            const onboardingType = parseOnboardingType(onboardingTypeRaw);
            const hasWaitlistInvitation = await actionCtx.runQuery(
              internal.waitlistTokens.hasValidInvitation,
              { email: user.email },
            );
            const hasAdminInvitation = await actionCtx.runQuery(
              internal.adminInvitations.hasValidAdminInvitation,
              { email: user.email },
            );
            if (!isSignupOnboarding(onboardingType) && !hasWaitlistInvitation && !hasAdminInvitation) {
              throw new Error("SIGNUP_DISABLED");
            }

            // Auto-assign "admin" role to users whose email is in the adminEmails table.
            const adminEmails = await actionCtx.runQuery(
              internal.adminEmails.list,
            );
            if (adminEmails.some((row: { email: string }) => row.email === user.email)) {
              return { data: { ...user, role: "admin", emailVerified: true } };
            }
            return { data: user };
          },
          after: async (user) => {
            const actionCtx = requireActionCtx(ctx);
            const userId = (user as Record<string, unknown>).id as string ?? "";

            await runAuditEvent(actionCtx, {
              happenedAt: Date.now(),
              actor: user.email,
              authenticatedUserId: userId || undefined,
              sourceDetail: "auth-hook",
              action: "auth.sign_up",
              resource: `user:${userId}`,
              status: "succeeded",
            });
          },
        },
      },
    },
    plugins: [
      convexRateLimitPlugin(ctx),
      emailVerifiedOnResetPlugin((id) => { pendingResetUserId = id; }),
      multiOriginPlugin(siteUrls),
      protectedAdminPlugin(ctx),
      passwordStrengthPlugin(ctx),
      admin(),
      twoFactor({
        issuer: getTotpIssuer(siteUrl),
        totpOptions: {
          period: 30,
          digits: 6,
        },
        otpOptions: {
          async sendOTP({ user, otp }) {
            await sendAuthEmail({
              to: user.email,
              type: "email-otp",
              urlOrCode: otp,
            });
          },
        },
      }),
      emailOTP({
        sendVerificationOTP: async ({ email, otp }) => {
          await sendAuthEmail({
            to: email,
            type: "email-otp",
            urlOrCode: otp,
          });
        },
      }),
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          await sendAuthEmail({
            to: email,
            type: "magic-link",
            urlOrCode: url,
          });
        },
      }),
      passkey(passkeyRpId ? { rpID: passkeyRpId } : undefined),
      haveIBeenPwned(),
      convex({ authConfig }),
    ],
    // Better Auth's built-in rate limiting is disabled because neither storage
    // option works reliably in Convex HTTP actions:
    //   - "database" causes OCC conflicts under concurrent requests
    //   - "memory" is a no-op (state doesn't persist between invocations)
    // Instead, the convexRateLimitPlugin above enforces equivalent per-endpoint
    // limits via convex-helpers' token-bucket system, which is OCC-safe.
    rateLimit: { enabled: false },
    advanced: {
      cookiePrefix: AUTH_COOKIE_PREFIX,
      ipAddress: {
        ipAddressHeaders: ["x-forwarded-for", "x-real-ip"],
      },
    },
  } satisfies BetterAuthOptions;
};

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  return betterAuth(createAuthOptions(ctx));
};

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    try {
      return await authComponent.getAuthUser(ctx);
    } catch {
      return null;
    }
  },
});

/**
 * Fetch the current user's 2FA backup codes via the authenticated WebSocket
 * connection. This avoids cross-origin HTTP / httpOnly cookie issues that
 * affect direct fetches to the Convex site URL.
 *
 * We query the Better Auth adapter directly instead of calling
 * `auth.api.viewBackupCodes()` because the `@convex-dev/better-auth` convex
 * plugin has a bug where its afterHook matcher accesses `ctx.path.startsWith()`
 * without optional chaining, crashing when there is no HTTP request context.
 */
export const viewBackupCodes = action({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const user = await authComponent.getAuthUser(ctx);
    if (!user) throw new Error("NOT_AUTHENTICATED");

    const result = await ctx.runQuery(
      components.betterAuth.adapter.findMany,
      {
        model: "twoFactor" as const,
        where: [
          {
            field: "userId",
            operator: "eq" as const,
            value: user._id as string,
          },
        ],
        paginationOpts: { cursor: null, numItems: 1 },
      },
    );

    const page =
      (result as { page?: Array<{ backupCodes: string }> }).page ?? [];
    if (page.length === 0) return [];

    const raw = page[0].backupCodes;

    // Try plain JSON first (freshly generated codes).
    // Fall back to symmetric decryption (Better Auth encrypts codes after
    // any backup code is consumed, and some versions encrypt by default).
    try {
      const plain = JSON.parse(raw);
      if (Array.isArray(plain)) return plain as string[];
    } catch {
      // not plain JSON — try decryption
    }

    const secret = process.env.BETTER_AUTH_SECRET;
    if (!secret) throw new Error("BETTER_AUTH_SECRET not configured");

    const decrypted = await symmetricDecrypt({ key: secret, data: raw });
    return JSON.parse(decrypted) as string[];
  },
});
